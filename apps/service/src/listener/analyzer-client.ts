/**
 * Cliente TCP saliente: NOSOTROS nos conectamos al XS 20.
 *
 * Este es el modo en el que el analizador actua como servidor TCP y espera que
 * el LIS se conecte a el (verificado en campo: `TcpClient.Connect(ip, 5100)`
 * contra el equipo devuelve conexion establecida). Es el inverso de TcpServer,
 * donde nosotros escuchamos y el equipo disca.
 *
 * Una vez que hay socket, el tratamiento de los bytes es identico en los dos
 * modos: lo hace MessageProcessor.
 *
 * Reconexion: el equipo se apaga de noche, se reinicia, o la red se cae. El
 * cliente reintenta indefinidamente con backoff exponencial y deja el estado
 * visible en /api/health para que la app muestre "conectado" o "esperando al
 * equipo" sin que el usuario tenga que mirar logs.
 */

import type { Socket } from "bun";

import { MessageProcessor, MllpBuffer } from "../hl7/message-processor.js";
import {
  RECONNECT_BACKOFF_FACTOR,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "../hl7/protocol-map.js";
import type { Logger } from "../logger.js";

export interface AnalyzerClientOptions {
  /** IP del analizador (ej "192.168.100.15"). */
  host: string;
  /** Puerto donde escucha el analizador (default 5100). */
  port: number;
  processor: MessageProcessor;
  logger: Logger;
  /** Inyectable para los tests: por defecto usa Bun.connect. */
  connectFn?: typeof Bun.connect;
}

interface ClientState {
  buffer: MllpBuffer;
}

export class AnalyzerClient {
  private socket: Socket<ClientState> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  private stopped = true;
  /** True mientras hay un intento de conexion en vuelo. */
  private connecting = false;

  private connectedAt: Date | null = null;
  private totalConnections = 0;
  private lastErrorMessage: string | null = null;
  private bytesReceived = 0;
  private messagesProcessed = 0;

  constructor(private opts: AnalyzerClientOptions) {}

  /** Arranca el cliente. No espera la conexion: si el equipo esta apagado,
   *  reintenta en background y el servicio sigue arrancando normalmente. */
  start(): void {
    this.stopped = false;
    this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
    this.opts.logger.info("analyzer.client.starting", {
      host: this.opts.host,
      port: this.opts.port,
    });
    void this.tryConnect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.connectedAt = null;
    this.opts.logger.info("analyzer.client.stopped");
  }

  /**
   * Cambia la direccion del analizador en caliente. Corta la conexion actual
   * (si hay) y reconecta contra la nueva. No lanza: si la direccion nueva no
   * responde, entra en el ciclo de reintentos igual que al arrancar.
   */
  reconfigure(host: string, port: number): void {
    if (host === this.opts.host && port === this.opts.port) return;

    const wasRunning = !this.stopped;
    if (wasRunning) this.stop();

    this.opts.host = host;
    this.opts.port = port;
    this.lastErrorMessage = null;

    if (wasRunning) this.start();
  }

  /** Estado para /api/health. */
  getStatus() {
    return {
      /** En modo connect, "listening" significa "el cliente esta activo". */
      listening: !this.stopped,
      connected: this.socket !== null,
      address: this.opts.host,
      port: this.opts.port,
      activeConnections: this.socket !== null ? 1 : 0,
      totalConnectionsSinceStart: this.totalConnections,
      connectedAt: this.connectedAt,
      lastError: this.lastErrorMessage,
      lastMessageAt: this.opts.processor.getLastMessageAt(),
    };
  }

  // ─── Conexion y reintentos ──────────────────────────────────────────────────

  private async tryConnect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;

    const connect = this.opts.connectFn ?? Bun.connect;
    const peer = `${this.opts.host}:${this.opts.port}`;

    try {
      await connect<ClientState>({
        hostname: this.opts.host,
        port: this.opts.port,
        socket: {
          open: (socket) => this.onOpen(socket),
          data: (socket, data) => this.onData(socket, data),
          close: (socket) => this.onClose(socket),
          error: (socket, error) => this.onSocketError(socket, error),
        },
        data: { buffer: new MllpBuffer() },
      });
      // El handler `open` ya marco el estado conectado.
    } catch (e) {
      const message = (e as Error).message;
      // Solo logueamos el primer fallo de cada racha a nivel warn; los
      // reintentos siguientes van a debug para no llenar el log cuando el
      // equipo pasa la noche apagado.
      const isNewFailure = this.lastErrorMessage !== message;
      this.lastErrorMessage = message;
      const ctx = { peer, error: message, retryInMs: this.reconnectDelayMs };
      if (isNewFailure) this.opts.logger.warn("analyzer.client.connect_failed", ctx);
      else this.opts.logger.debug("analyzer.client.connect_failed", ctx);

      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, delay);

    // Backoff para el proximo intento, con techo.
    this.reconnectDelayMs = Math.min(
      Math.floor(this.reconnectDelayMs * RECONNECT_BACKOFF_FACTOR),
      RECONNECT_MAX_DELAY_MS,
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Handlers de socket ─────────────────────────────────────────────────────

  private onOpen(socket: Socket<ClientState>): void {
    this.socket = socket;
    this.connectedAt = new Date();
    this.totalConnections++;
    this.lastErrorMessage = null;
    // Conexion buena: reseteamos el backoff para que una caida futura reintente
    // rapido de nuevo.
    this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
    this.opts.logger.info("analyzer.client.connected", {
      peer: this.peerLabel(),
      totalConnectionsSinceStart: this.totalConnections,
    });
  }

  private onData(socket: Socket<ClientState>, data: Buffer): void {
    this.bytesReceived += data.length;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const { messages, controlBytes } = socket.data.buffer.push(bytes);

    if (controlBytes.length > 0) {
      this.opts.logger.debug("mllp.control_bytes", {
        peer: this.peerLabel(),
        bytes: controlBytes.map((b) => "0x" + b.toString(16).padStart(2, "0")),
      });
    }

    for (const hl7Text of messages) {
      this.opts.processor.process(hl7Text, this.peerLabel(), (framed) => {
        socket.write(framed);
      });
      this.messagesProcessed++;
    }
  }

  private onClose(socket: Socket<ClientState>): void {
    const wasConnected = this.socket !== null;
    this.socket = null;
    this.connectedAt = null;
    socket.data.buffer.reset();

    if (wasConnected) {
      this.opts.logger.warn("analyzer.client.disconnected", {
        peer: this.peerLabel(),
        bytesReceived: this.bytesReceived,
        messagesProcessed: this.messagesProcessed,
      });
    }
    // Si no fue un stop() deliberado, volvemos a intentar.
    if (!this.stopped) this.scheduleReconnect();
  }

  private onSocketError(_socket: Socket<ClientState>, error: Error): void {
    this.lastErrorMessage = error.message;
    this.opts.logger.error("analyzer.client.socket_error", {
      peer: this.peerLabel(),
      error: error.message,
    });
    // `close` llega despues y se encarga de reprogramar la reconexion.
  }

  private peerLabel(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }
}
