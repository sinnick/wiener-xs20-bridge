/**
 * TCP listener: recibe conexiones del XS 20, parsea HL7, persiste, ACK.
 *
 * Diseño:
 *  - Una conexion del XS 20 puede vivir varios minutos/horas (heartbeats).
 *  - Por cada conexion mantenemos un buffer de bytes acumulados.
 *  - Cuando llega data, intentamos `unframeMllp` y procesamos los mensajes
 *    completos extraidos.
 *  - El frame parcial queda en el buffer hasta que lleguen los proximos bytes.
 *
 * Manejo de bytes de control (ENQ/heartbeat):
 *  - Por ahora los logueamos a debug. El XS 20 los emite como handshake/ping
 *    pero no requieren respuesta especifica para MLLP/HL7 — el ACK^R01 es
 *    suficiente para que el equipo confirme que el LIS esta vivo.
 */

import type { Socket, TCPSocketListener } from "bun";

import { Hl7ParseError } from "../hl7/parser.js";
import { buildAck } from "../hl7/ack.js";
import { frameMllp, unframeMllp } from "../hl7/mllp.js";
import { CONNECTION_IDLE_TIMEOUT_MS } from "../hl7/protocol-map.js";
import { parseHl7 } from "../hl7/parser.js";
import { mapMessageToHemogram } from "../hl7/obx-mapper.js";
import { getString, getSegment } from "../hl7/parser.js";
import type { Logger } from "../logger.js";
import type { XsRepo } from "../db/repo.js";
import { InsertResultDuplicateError } from "../db/repo.js";

export interface TcpServerOptions {
  host: string;
  port: number;
  repo: XsRepo;
  logger: Logger;
  /** Genera un ID unico para cada resultado. Default: Date.now() + counter. */
  generateId?: () => string;
  /** Callback cuando se recibe un resultado nuevo (para los SSE / metricas). */
  onResultReceived?: (id: string) => void;
}

interface ConnectionState {
  buffer: Uint8Array;
  peer: string;
  connectedAt: Date;
  lastActivityAt: number; // epoch ms del ultimo byte recibido
  bytesReceived: number;
  messagesProcessed: number;
}

export class TcpServer {
  private listener: TCPSocketListener<ConnectionState> | null = null;
  private connections = new Set<Socket<ConnectionState>>();
  private idCounter = 0;
  private totalConnections = 0;
  private lastMessageAt: Date | null = null;
  private idleSweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: TcpServerOptions) {}

  start(): void {
    this.listener = Bun.listen<ConnectionState>({
      hostname: this.opts.host,
      port: this.opts.port,
      socket: {
        open: (socket) => this.onOpen(socket),
        data: (socket, data) => this.onData(socket, data),
        close: (socket) => this.onClose(socket),
        error: (socket, error) => this.onError(socket, error),
      },
    });
    // Barrido periodico para cerrar conexiones colgadas (equipo que abrio el
    // socket y dejo de mandar nada — red caida, equipo apagado a mitad, etc.).
    this.idleSweeper = setInterval(() => this.sweepIdleConnections(), 15_000);
    this.opts.logger.info("tcp.listener.up", {
      host: this.opts.host,
      port: this.opts.port,
    });
  }

  stop(): void {
    if (this.idleSweeper) {
      clearInterval(this.idleSweeper);
      this.idleSweeper = null;
    }
    for (const s of this.connections) {
      try {
        s.end();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.listener?.stop(true);
    this.listener = null;
    this.opts.logger.info("tcp.listener.down");
  }

  /** Cierra conexiones sin actividad por mas de CONNECTION_IDLE_TIMEOUT_MS. */
  private sweepIdleConnections(): void {
    const now = Date.now();
    for (const socket of this.connections) {
      const state = socket.data;
      if (!state) continue;
      const idleMs = now - state.lastActivityAt;
      if (idleMs > CONNECTION_IDLE_TIMEOUT_MS) {
        this.opts.logger.warn("tcp.connection.idle_timeout", {
          peer: state.peer,
          idleMs,
        });
        try {
          socket.end();
        } catch {
          // ignore
        }
      }
    }
  }

  // ─── Estado para el endpoint de health ──────────────────────────────────────

  getStatus() {
    return {
      listening: this.listener !== null,
      address: this.opts.host,
      port: this.opts.port,
      activeConnections: this.connections.size,
      totalConnectionsSinceStart: this.totalConnections,
      lastMessageAt: this.lastMessageAt,
    };
  }

  // ─── Handlers de socket ─────────────────────────────────────────────────────

  private onOpen(socket: Socket<ConnectionState>): void {
    const peer = `${socket.remoteAddress}`;
    socket.data = {
      buffer: new Uint8Array(0),
      peer,
      connectedAt: new Date(),
      lastActivityAt: Date.now(),
      bytesReceived: 0,
      messagesProcessed: 0,
    };
    this.connections.add(socket);
    this.totalConnections++;
    this.opts.logger.info("tcp.connection.opened", { peer });
  }

  private onClose(socket: Socket<ConnectionState>): void {
    const state = socket.data;
    this.connections.delete(socket);
    this.opts.logger.info("tcp.connection.closed", {
      peer: state.peer,
      durationMs: Date.now() - state.connectedAt.getTime(),
      bytesReceived: state.bytesReceived,
      messagesProcessed: state.messagesProcessed,
    });
  }

  private onError(socket: Socket<ConnectionState>, error: Error): void {
    this.opts.logger.error("tcp.connection.error", {
      peer: socket.data?.peer,
      error: error.message,
    });
  }

  private onData(socket: Socket<ConnectionState>, data: Buffer): void {
    const state = socket.data;
    state.bytesReceived += data.length;
    state.lastActivityAt = Date.now();

    // Concatenar al buffer existente.
    const combined = new Uint8Array(state.buffer.length + data.length);
    combined.set(state.buffer, 0);
    combined.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), state.buffer.length);

    const result = unframeMllp(combined);
    state.buffer = result.remaining;

    // Loguear bytes de control (sin actuar)
    if (result.controlBytes.length > 0) {
      this.opts.logger.debug("mllp.control_bytes", {
        peer: state.peer,
        bytes: result.controlBytes.map((b) => "0x" + b.toString(16).padStart(2, "0")),
      });
    }

    for (const hl7Text of result.messages) {
      this.processMessage(socket, hl7Text);
      state.messagesProcessed++;
    }
  }

  private processMessage(socket: Socket<ConnectionState>, hl7Text: string): void {
    const state = socket.data;
    const receivedAt = new Date();
    this.lastMessageAt = receivedAt;

    this.opts.logger.debug("mllp.frame.received", {
      peer: state.peer,
      bytes: hl7Text.length,
    });

    // Intentar parsear
    let messageControlId = "";
    let ackStatus: "AA" | "AE" = "AA";
    let ackError: string | undefined;

    try {
      const msg = parseHl7(hl7Text);
      const msh = getSegment(msg, "MSH");
      messageControlId = msh ? (getString(msh, 10) ?? "") : "";
      const messageType = msh ? (getString(msh, 9, 1) ?? "?") : "?";

      if (messageType !== "ORU") {
        // Solo procesamos resultados. Para ACKs/otros, respondemos AA pero no persistimos.
        this.opts.logger.info("hl7.non_oru_received", {
          peer: state.peer,
          messageType,
          messageControlId,
        });
      } else {
        const id = this.generateResultId();
        const { hemogram, warnings } = mapMessageToHemogram(msg, { id, receivedAt });

        for (const w of warnings) {
          this.opts.logger.warn(`hl7.${w.type}`, {
            peer: state.peer,
            messageControlId,
            ...w.context,
            detail: w.message,
          });
        }

        try {
          this.opts.repo.insertResult({
            hemogram,
            rawHl7: hl7Text,
            senderAddress: state.peer,
          });
          this.opts.logger.info("hl7.parsed", {
            peer: state.peer,
            sampleId: hemogram.sample.sampleId,
            messageControlId,
            valuesCount: Object.keys(hemogram.values).length,
            histogramsCount: hemogram.histograms.length,
          });
          this.opts.onResultReceived?.(id);
        } catch (e) {
          if (e instanceof InsertResultDuplicateError) {
            this.opts.logger.info("hl7.duplicate", {
              peer: state.peer,
              messageControlId,
            });
            // Respondemos AA igual: el equipo cumplio su parte, no necesita reintentar.
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      ackStatus = "AE";
      ackError = (e as Error).message;
      this.opts.logger.error("hl7.parse_error", {
        peer: state.peer,
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
          senderAddress: state.peer,
          error: ackError,
        });
      } catch {
        // ignore — si la DB falla aca, ya se logueo arriba
      }
    }

    // Enviar ACK SIEMPRE. Aunque el parseo falle antes de poder extraer el
    // MSH-10, el XS 20 espera una respuesta: si no la mandamos, su conexion
    // queda colgada hasta su propio timeout (~4s) en CADA mensaje malformado.
    // En ese caso usamos un control id vacio ("") — HL7 lo permite en el MSA
    // cuando el original no pudo determinarse.
    const ackControlIdRef = messageControlId || "";
    const ackText = buildAck({
      originalMessageControlId: ackControlIdRef,
      status: ackStatus,
      errorText: ackError,
    });
    const framed = frameMllp(ackText);
    try {
      socket.write(framed);
      this.opts.logger.debug("ack.sent", {
        peer: state.peer,
        messageControlId: ackControlIdRef || "(desconocido)",
        status: ackStatus,
      });
    } catch (e) {
      this.opts.logger.error("ack.send_failed", {
        peer: state.peer,
        error: (e as Error).message,
      });
    }
  }

  private generateResultId(): string {
    if (this.opts.generateId) return this.opts.generateId();
    return `r_${Date.now()}_${(this.idCounter++).toString(36)}`;
  }
}
