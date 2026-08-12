/**
 * Procesamiento de un mensaje HL7 recibido, independiente del transporte.
 *
 * El XS 20 se puede hablar de dos formas (ver protocol-map.ts):
 *  - modo "listen"  → nosotros escuchamos y el equipo se conecta (TcpServer).
 *  - modo "connect" → el equipo escucha y nosotros nos conectamos (AnalyzerClient).
 *
 * En ambos casos, una vez que hay un socket con bytes MLLP adentro, lo que sigue
 * es identico: desframear, parsear, mapear a hemograma, persistir y responder el
 * ACK por el mismo socket. Esa parte vive aca para que los dos transportes
 * compartan exactamente el mismo camino y no se desincronicen.
 */

import type { HemogramResult } from "@xs20/shared";

import { buildAck } from "./ack.js";
import { frameMllp, unframeMllp } from "./mllp.js";
import { mapMessageToHemogram } from "./obx-mapper.js";
import { getSegment, getString, parseHl7 } from "./parser.js";
import type { Logger } from "../logger.js";
import type { XsRepo } from "../db/repo.js";
import { InsertResultDuplicateError } from "../db/repo.js";

/**
 * Acumulador de bytes de una conexion MLLP.
 *
 * Un mensaje puede llegar partido en varios paquetes TCP, y un paquete puede
 * traer varios mensajes. Esta clase guarda el remanente parcial entre llamadas
 * y devuelve solo los mensajes completos.
 */
export class MllpBuffer {
  private buffer: Uint8Array = new Uint8Array(0);

  /** Suma bytes nuevos y devuelve los mensajes completos que quedaron armados. */
  push(data: Uint8Array): { messages: string[]; controlBytes: number[] } {
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer, 0);
    combined.set(data, this.buffer.length);

    const result = unframeMllp(combined);
    this.buffer = result.remaining;
    return { messages: result.messages, controlBytes: result.controlBytes };
  }

  /** Descarta el remanente parcial (al reconectar, por ejemplo). */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

export interface MessageProcessorOptions {
  repo: XsRepo;
  logger: Logger;
  /** Genera un ID unico para cada resultado. Default: Date.now() + counter. */
  generateId?: () => string;
  /** Callback cuando se persiste un resultado nuevo (para los SSE / metricas). */
  onResultReceived?: (id: string) => void;
  /** Callback con el hemograma ya persistido (para la exportacion a .txt). */
  onHemogramPersisted?: (hemogram: HemogramResult) => void;
}

/** Como el procesador le devuelve el ACK al transporte que lo llamo. */
export type AckWriter = (framed: Uint8Array) => void;

export class MessageProcessor {
  private idCounter = 0;
  private lastMessageAt: Date | null = null;

  constructor(private opts: MessageProcessorOptions) {}

  /** Ultima vez que entro un mensaje (para /api/health). */
  getLastMessageAt(): Date | null {
    return this.lastMessageAt;
  }

  /**
   * Procesa un mensaje HL7 completo (ya desframeado) y escribe el ACK.
   *
   * Nunca lanza: cualquier error se loguea y se responde AE, porque el equipo
   * espera una respuesta por cada mensaje — si no la mandamos, su conexion
   * queda colgada hasta su propio timeout (~4s) en CADA mensaje malformado.
   */
  process(hl7Text: string, peer: string, writeAck: AckWriter): void {
    const receivedAt = new Date();
    this.lastMessageAt = receivedAt;

    this.opts.logger.debug("mllp.frame.received", { peer, bytes: hl7Text.length });

    let messageControlId = "";
    let ackStatus: "AA" | "AE" = "AA";
    let ackError: string | undefined;

    try {
      const msg = parseHl7(hl7Text);
      const msh = getSegment(msg, "MSH");
      messageControlId = msh ? (getString(msh, 10) ?? "") : "";
      const messageType = msh ? (getString(msh, 9, 1) ?? "?") : "?";

      if (messageType !== "ORU") {
        // Solo procesamos resultados. Para ACKs/otros respondemos AA sin persistir.
        this.opts.logger.info("hl7.non_oru_received", {
          peer,
          messageType,
          messageControlId,
        });
      } else {
        const id = this.generateResultId();
        const { hemogram, warnings } = mapMessageToHemogram(msg, { id, receivedAt });

        for (const w of warnings) {
          this.opts.logger.warn(`hl7.${w.type}`, {
            peer,
            messageControlId,
            ...w.context,
            detail: w.message,
          });
        }

        try {
          this.opts.repo.insertResult({
            hemogram,
            rawHl7: hl7Text,
            senderAddress: peer,
          });
          this.opts.logger.info("hl7.parsed", {
            peer,
            sampleId: hemogram.sample.sampleId,
            messageControlId,
            valuesCount: Object.keys(hemogram.values).length,
            histogramsCount: hemogram.histograms.length,
          });
          this.opts.onResultReceived?.(id);
          // Solo tras un insert exitoso: un duplicado no debe re-exportar.
          this.opts.onHemogramPersisted?.(hemogram);
        } catch (e) {
          if (e instanceof InsertResultDuplicateError) {
            this.opts.logger.info("hl7.duplicate", { peer, messageControlId });
            // Respondemos AA igual: el equipo cumplio su parte, no reintenta.
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      ackStatus = "AE";
      ackError = (e as Error).message;
      this.opts.logger.error("hl7.parse_error", {
        peer,
        error: ackError,
        snippet: hl7Text.slice(0, 200),
      });

      // Persistimos el raw como failed para auditoria.
      try {
        const rawId = `raw_failed_${Date.now()}_${this.idCounter++}`;
        this.opts.repo.insertFailedRaw({
          rawMessageId: rawId,
          rawHl7: hl7Text,
          receivedAt,
          messageControlId: messageControlId || `unknown_${rawId}`,
          senderAddress: peer,
          error: ackError,
        });
      } catch {
        // ignore — si la DB falla aca, ya se logueo arriba
      }
    }

    // ACK SIEMPRE. Si el parseo fallo antes de poder extraer MSH-10, usamos un
    // control id vacio ("") — HL7 lo permite cuando el original no se pudo
    // determinar.
    const ackControlIdRef = messageControlId || "";
    const framed = frameMllp(
      buildAck({
        originalMessageControlId: ackControlIdRef,
        status: ackStatus,
        errorText: ackError,
      }),
    );
    try {
      writeAck(framed);
      this.opts.logger.debug("ack.sent", {
        peer,
        messageControlId: ackControlIdRef || "(desconocido)",
        status: ackStatus,
      });
    } catch (e) {
      this.opts.logger.error("ack.send_failed", { peer, error: (e as Error).message });
    }
  }

  private generateResultId(): string {
    if (this.opts.generateId) return this.opts.generateId();
    return `r_${Date.now()}_${(this.idCounter++).toString(36)}`;
  }
}
