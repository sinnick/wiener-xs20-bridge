/**
 * TCP listener: recibe conexiones del XS 20, parsea HL7, persiste, ACK.
 *
 * DiseÃ±o:
 *  - Una conexion del XS 20 puede vivir varios minutos/horas (heartbeats).
 *  - Por cada conexion mantenemos un buffer de bytes acumulados.
 *  - Cuando llega data, intentamos `unframeMllp` y procesamos los mensajes
 *    completos extraidos.
 *  - El frame parcial queda en el buffer hasta que lleguen los proximos bytes.
 *
 * Manejo de bytes de control (ENQ/heartbeat):
 *  - Por ahora los logueamos a debug. El XS 20 los emite como handshake/ping
 *    pero no requieren respuesta especifica para MLLP/HL7 â€” el ACK^R01 es
 *    suficiente para que el equipo confirme que el LIS esta vivo.
 */

import type { Socket, TCPSocketListener } from "bun";

import { MessageProcessor, MllpBuffer } from "../hl7/message-processor.js";
import {
  CONNECTION_IDLE_TIMEOUT_MS,
  IDLE_SWEEP_INTERVAL_MS,
  MAX_MLLP_FRAME_BYTES,
} from "../hl7/protocol-map.js";
import type { Logger } from "../logger.js";
import type { XsRepo } from "../db/repo.js";

export interface TcpServerOptions {
  host: string;
  port: number;
  repo: XsRepo;
  logger: Logger;
  /** Genera un ID unico para cada resultado. Default: Date.now() + counter. */
  generateId?: () => string;
  /** Callback cuando se recibe un resultado nuevo (para los SSE / metricas). */
  onResultReceived?: (id: string) => void;
  /**
   * Procesador compartido. Si no se pasa, se arma uno con repo/logger.
   * main.ts pasa el mismo para los dos transportes (listener y cliente) de modo
   * que `lastMessageAt` sea coherente sin importar por donde entro el mensaje.
   */
  processor?: MessageProcessor;
}

interface ConnectionState {
  buffer: MllpBuffer;
  peer: string;
  connectedAt: Date;
  lastActivityAt: number; // epoch ms del ultimo byte recibido
  bytesReceived: number;
  messagesProcessed: number;
}

export class TcpServer {
  private listener: TCPSocketListener<ConnectionState> | null = null;
  private connections = new Set<Socket<ConnectionState>>();
  private totalConnections = 0;
  private idleSweeper: ReturnType<typeof setInterval> | null = null;
  private processor: MessageProcessor;

  constructor(private opts: TcpServerOptions) {
    this.processor =
      opts.processor ??
      new MessageProcessor({
        repo: opts.repo,
        logger: opts.logger,
        generateId: opts.generateId,
        onResultReceived: opts.onResultReceived,
      });
  }

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
    // socket y dejo de mandar nada â€” red caida, equipo apagado a mitad, etc.).
    this.idleSweeper = setInterval(() => this.sweepIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
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

  /**
   * Cambia host/puerto del listener en caliente, sin reiniciar el servicio.
   * Cierra las conexiones actuales (el equipo reconecta solo) y vuelve a
   * escuchar en la nueva direccion. Si el bind nuevo falla (puerto ocupado,
   * IP invalida), revierte a la direccion anterior y relanza el error para
   * que el HTTP handler devuelva 409.
   */
  reconfigure(host: string, port: number): void {
    if (host === this.opts.host && port === this.opts.port && this.listener) {
      return; // sin cambios
    }

    const prevHost = this.opts.host;
    const prevPort = this.opts.port;
    const wasListening = this.listener !== null;

    if (wasListening) this.stop();
    this.opts.host = host;
    this.opts.port = port;

    if (!wasListening) return; // estaba con --no-listen: solo guardamos los valores

    try {
      this.start();
    } catch (e) {
      // Rollback: volvemos a la direccion previa para no dejar el listener caido.
      this.opts.host = prevHost;
      this.opts.port = prevPort;
      try {
        this.start();
      } catch {
        // Si tambien falla lo previo, ya no hay listener; se refleja en health.
      }
      throw e;
    }
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

  // â”€â”€â”€ Estado para el endpoint de health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  getStatus() {
    return {
      listening: this.listener !== null,
      address: this.opts.host,
      port: this.opts.port,
      activeConnections: this.connections.size,
      totalConnectionsSinceStart: this.totalConnections,
      lastMessageAt: this.processor.getLastMessageAt(),
    };
  }

  // â”€â”€â”€ Handlers de socket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private onOpen(socket: Socket<ConnectionState>): void {
    const peer = `${socket.remoteAddress}`;
    socket.data = {
      buffer: new MllpBuffer(),
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

    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const { messages, controlBytes, overflow } = state.buffer.push(bytes);

    // El emisor abrio un frame MLLP y nunca lo cerro. Cualquiera que se conecte
    // al puerto y escriba basura llega aca, asi que cortamos: descartamos lo
    // acumulado y le cerramos la conexion. Si es el equipo, reconecta solo.
    if (overflow) {
      this.opts.logger.error("mllp.frame.too_large", {
        peer: state.peer,
        maxBytes: MAX_MLLP_FRAME_BYTES,
        bytesReceived: state.bytesReceived,
        detail:
          "Se recibio un frame MLLP sin cierre (FS+CR) que supero el tope. Se " +
          "descarto y se cerro la conexion para no quedarnos sin memoria.",
      });
      try {
        socket.end();
      } catch {
        // ignore
      }
      return;
    }

    // Loguear bytes de control (sin actuar)
    if (controlBytes.length > 0) {
      this.opts.logger.debug("mllp.control_bytes", {
        peer: state.peer,
        bytes: controlBytes.map((b) => "0x" + b.toString(16).padStart(2, "0")),
      });
    }

    for (const hl7Text of messages) {
      this.processor.process(hl7Text, state.peer, (framed) => {
        socket.write(framed);
      });
      state.messagesProcessed++;
    }
  }
}
