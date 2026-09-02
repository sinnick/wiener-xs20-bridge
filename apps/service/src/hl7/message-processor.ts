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
import { ACK_DEADLINE_MS, MAX_MLLP_FRAME_BYTES } from "./protocol-map.js";
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
export interface MllpPushResult {
  messages: string[];
  controlBytes: number[];
  /**
   * True si el frame parcial supero el tope de bytes y se descarto.
   *
   * El transporte tiene que cerrar la conexion cuando esto pasa: el emisor esta
   * roto (mando un 0x0B y nunca su cierre) y seguir leyendolo solo acumula mas
   * basura. Al reconectar arrancamos limpios.
   */
  overflow: boolean;
}

export class MllpBuffer {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private maxBytes: number = MAX_MLLP_FRAME_BYTES) {}

  /** Cuantos bytes hay esperando el cierre del frame (para logs/tests). */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** Suma bytes nuevos y devuelve los mensajes completos que quedaron armados. */
  push(data: Uint8Array): MllpPushResult {
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer, 0);
    combined.set(data, this.buffer.length);

    const result = unframeMllp(combined);
    this.buffer = result.remaining;

    // El remanente son bytes de un frame ABIERTO (vimos el 0x0B pero todavia no
    // el FS+CR). Si crece sin control, el proceso se muere por falta de memoria
    // y NSSM lo reinicia en loop. Cortamos por lo sano: tiramos el frame.
    let overflow = false;
    if (this.buffer.length > this.maxBytes) {
      overflow = true;
      this.reset();
    }

    return { messages: result.messages, controlBytes: result.controlBytes, overflow };
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
   *
   * ── Por que el ACK va DESPUES de persistir (y no antes) ────────────────────
   * Mandar el ACK primero haria el ciclo practicamente instantaneo, pero un
   * "AA" es una promesa: le dice al equipo que el resultado quedo guardado y
   * que puede olvidarse de el. Si despues falla el insert, ese hemograma se
   * perdio y NADIE se entera — ni el equipo (que ya lo dio por entregado) ni la
   * operadora (que no tiene como saber que faltaba una muestra). En un
   * laboratorio, un resultado que desaparece en silencio es peor que uno que
   * hay que repetir.
   *
   * Persistiendo primero, un problema de base termina en un "AE": el equipo se
   * entera, puede reintentar, y el reintento es seguro porque la insercion
   * deduplica por muestra + instante de analisis (ver XsRepo.insertResult; NO
   * por MSH-10, que este equipo reinicia en 1 en cada arranque). La verdad le
   * llega al que puede hacer algo al respecto.
   *
   * Lo que si hicimos es sacarle al camino critico todo lo que no sea guardar:
   *   - `busy_timeout` de SQLite bajo a 2500ms (< ACK_DEADLINE_MS): si la base
   *     esta trabada por el antivirus o un backup, fallamos rapido y el AE
   *     llega DENTRO del plazo, en vez de un AA tarde que el equipo ya descarto.
   *   - La exportacion del .txt corre DESPUES de escribir el ACK. Es un
   *     artefacto derivado, y si exportDir apunta a una carpeta de red caida un
   *     writeFileSync se puede colgar segundos — mucho mas riesgoso para el
   *     plazo que la propia base.
   *   - Medimos el ciclo completo y avisamos si igual se pasa del deadline, asi
   *     el problema aparece en el log antes de que el equipo empiece a dar
   *     mensajes por fallidos.
   */
  process(hl7Text: string, peer: string, writeAck: AckWriter): void {
    const receivedAt = new Date();
    const startedAt = performance.now();
    this.lastMessageAt = receivedAt;

    this.opts.logger.debug("mllp.frame.received", { peer, bytes: hl7Text.length });

    let messageControlId = "";
    let ackStatus: "AA" | "AE" = "AA";
    let ackError: string | undefined;
    // Se exporta recien despues del ACK; null = no hay nada nuevo que exportar
    // (mensaje no-ORU, duplicado, o fallo el insert).
    let persisted: HemogramResult | null = null;
    let persistMs = 0;

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
          const insertStartedAt = performance.now();
          this.opts.repo.insertResult({
            hemogram,
            rawHl7: hl7Text,
            senderAddress: peer,
          });
          persistMs = Math.round(performance.now() - insertStartedAt);
          this.opts.logger.info("hl7.parsed", {
            peer,
            sampleId: hemogram.sample.sampleId,
            messageControlId,
            valuesCount: Object.keys(hemogram.values).length,
            histogramsCount: hemogram.histograms.length,
            persistMs,
          });
          this.opts.onResultReceived?.(id);
          // Solo tras un insert exitoso: un duplicado no debe re-exportar.
          // La exportacion en si va despues del ACK (ver el comentario grande
          // arriba): escribir un .txt a una carpeta de red no puede demorar la
          // respuesta que el equipo esta esperando.
          persisted = hemogram;
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

    // El equipo abandona el mensaje si el ACK no llega dentro de su plazo. Que
    // lleguemos cerca es un aviso temprano de que algo esta frenando la base
    // (antivirus escaneando el .sqlite, un backup corriendo, el disco al palo):
    // hoy se nota, en unos meses ya no llega a tiempo y el equipo empieza a dar
    // mensajes por fallidos sin motivo aparente.
    const ackMs = Math.round(performance.now() - startedAt);
    if (ackMs > ACK_DEADLINE_MS) {
      this.opts.logger.warn("ack.deadline_exceeded", {
        peer,
        messageControlId: ackControlIdRef || "(desconocido)",
        ackMs,
        persistMs,
        deadlineMs: ACK_DEADLINE_MS,
        detail:
          "El ACK salio despues del plazo que espera el equipo: puede haber " +
          "dado el mensaje por fallido. Causa habitual: la base SQLite trabada " +
          "por el antivirus o un backup. Excluir la carpeta db del antivirus.",
      });
    }

    // Recien ahora, con el equipo ya respondido, el artefacto derivado.
    //
    // Va en su propio try: este callback corre FUERA del try grande de arriba,
    // asi que si tirara, el error saldria de `process()` hacia el handler del
    // socket — y `process()` no puede lanzar nunca. Ademas, a esta altura el
    // resultado ya esta guardado y el ACK ya salio: un problema exportando no
    // cambia nada de eso, solo hay que dejarlo anotado.
    if (persisted) {
      try {
        this.opts.onHemogramPersisted?.(persisted);
      } catch (e) {
        this.opts.logger.error("export.failed", {
          peer,
          sampleId: persisted.sample.sampleId,
          error: (e as Error).message,
          detail:
            "El resultado SI quedo guardado y el equipo recibio su ACK; lo que " +
            "fallo es la copia a .txt. Revisar la carpeta de exportacion.",
        });
      }
    }
  }

  private generateResultId(): string {
    if (this.opts.generateId) return this.opts.generateId();
    return `r_${Date.now()}_${(this.idCounter++).toString(36)}`;
  }
}
