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
  ANALYZER_CLIENT_IDLE_TIMEOUT_MS,
  ANALYZER_CONNECT_TIMEOUT_MS,
  ANALYZER_KEEPALIVE_IDLE_MS,
  IDLE_SWEEP_INTERVAL_MS,
  MAX_MLLP_FRAME_BYTES,
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
  /** Silencio maximo tolerado antes de dar la conexion por muerta. */
  idleTimeoutMs?: number;
  /** Cuanto esperamos a que la conexion se establezca. */
  connectTimeoutMs?: number;
  /** Cada cuanto corre el barrido de conexion ociosa. */
  sweepIntervalMs?: number;
}

interface ClientState {
  buffer: MllpBuffer;
}

export class AnalyzerClient {
  private socket: Socket<ClientState> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSweeper: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  private stopped = true;
  /** True mientras hay un intento de conexion en vuelo. */
  private connecting = false;
  /**
   * Numero de intento de conexion.
   *
   * Un `Bun.connect` en vuelo no se puede abortar: si lo damos por vencido por
   * timeout y despues resuelve igual, nos llega un `open` de un intento que ya
   * dimos por muerto. Comparando la generacion descartamos ese socket zombie en
   * vez de quedar con dos.
   */
  private attemptGeneration = 0;

  /** Epoch ms del ultimo byte recibido (o de la apertura del socket). */
  private lastActivityAt = 0;

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
    // Barrido de conexion muerta. Sin esto, un cable cortado o el equipo
    // apagado de golpe (sin FIN) dejan el socket "vivo" para siempre: health
    // dice ok, no reconectamos nunca, y no entra un solo resultado mas.
    if (!this.idleSweeper) {
      this.idleSweeper = setInterval(
        () => this.sweepIdleConnection(),
        this.opts.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS,
      );
    }
    void this.tryConnect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.idleSweeper) {
      clearInterval(this.idleSweeper);
      this.idleSweeper = null;
    }
    // Invalidamos cualquier intento en vuelo: si resuelve despues del stop, su
    // `open` se descarta en vez de dejar un socket huerfano.
    this.attemptGeneration++;
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
    const generation = ++this.attemptGeneration;
    const connectTimeoutMs = this.opts.connectTimeoutMs ?? ANALYZER_CONNECT_TIMEOUT_MS;

    try {
      const attempt = connect<ClientState>({
        hostname: this.opts.host,
        port: this.opts.port,
        socket: {
          open: (socket) => this.onOpen(socket, generation),
          data: (socket, data) => this.onData(socket, data),
          close: (socket) => this.onClose(socket),
          error: (socket, error) => this.onSocketError(socket, error),
        },
        data: { buffer: new MllpBuffer() },
      });

      // Sin este timeout, una IP que existe pero descarta los paquetes (equipo
      // apagado con la IP todavia ruteada, o un firewall en DROP) deja el
      // intento colgado minutos, hasta que se rinde el SO. Durante todo ese
      // rato no reintentamos ni aparece nada en el log.
      await this.withTimeout(attempt, connectTimeoutMs, peer);
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

  /** Rechaza si la promesa no resuelve dentro del plazo. */
  private withTimeout<T>(promise: Promise<T>, ms: number, peer: string): Promise<T> {
    if (ms <= 0) return promise;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout de conexion a ${peer} tras ${ms}ms`)),
        ms,
      );
    });
    // El `catch` vacio evita un unhandledRejection si el connect falla despues
    // de que ya ganamos por timeout.
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  /**
   * Cierra la conexion si el equipo no mando NADA en mucho tiempo.
   *
   * Es el equivalente de `sweepIdleConnections` de TcpServer para el lado
   * cliente. La deteccion primaria es el keepalive de TCP (ver onOpen), pero si
   * el SO no nos deja habilitarlo — o el peer quedo medio-abierto igual — este
   * barrido es lo unico que evita quedarse "conectado" a un equipo que ya no
   * esta. Al cerrar, `onClose` reprograma la reconexion sola.
   */
  private sweepIdleConnection(): void {
    if (this.stopped || !this.socket) return;
    const idleMs = Date.now() - this.lastActivityAt;
    const limit = this.opts.idleTimeoutMs ?? ANALYZER_CLIENT_IDLE_TIMEOUT_MS;
    if (idleMs <= limit) return;

    this.opts.logger.warn("analyzer.client.idle_timeout", {
      peer: this.peerLabel(),
      idleMs,
      limitMs: limit,
      detail:
        "El equipo no mando un solo byte en todo ese tiempo. Damos la conexion " +
        "por muerta (cable, switch o equipo apagado sin cerrar) y reconectamos.",
    });
    try {
      this.socket.end();
    } catch {
      // ignore
    }
  }

  // ─── Handlers de socket ─────────────────────────────────────────────────────

  private onOpen(socket: Socket<ClientState>, generation: number): void {
    // Llego tarde: este intento ya se dio por vencido (timeout) o hubo un
    // stop()/reconfigure() mientras tanto. Lo cerramos y nos olvidamos, sino
    // quedariamos con dos sockets contra el mismo equipo.
    if (generation !== this.attemptGeneration || this.stopped) {
      this.opts.logger.debug("analyzer.client.stale_socket_discarded", {
        peer: this.peerLabel(),
        generation,
        currentGeneration: this.attemptGeneration,
      });
      try {
        socket.end();
      } catch {
        // ignore
      }
      return;
    }

    this.socket = socket;
    this.connectedAt = new Date();
    this.lastActivityAt = Date.now();
    this.totalConnections++;
    this.lastErrorMessage = null;
    // Conexion buena: reseteamos el backoff para que una caida futura reintente
    // rapido de nuevo.
    this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;

    // Keepalive de TCP: es la unica forma de enterarse de que el peer se murio
    // sin avisar (cable cortado, equipo apagado de golpe) sin mandarle nada a
    // nivel aplicacion — que en MLLP no tenemos como hacer sin arriesgarnos a
    // confundir al equipo. Con lo que fija Bun (KEEPCNT=10, KEEPINTVL=1s), un
    // peer muerto se detecta ~40s despues del ultimo byte.
    let keepAliveOk = false;
    try {
      keepAliveOk = socket.setKeepAlive(true, ANALYZER_KEEPALIVE_IDLE_MS) !== false;
      socket.setNoDelay(true);
    } catch {
      keepAliveOk = false;
    }
    if (!keepAliveOk) {
      // No es fatal: queda el barrido por inactividad como respaldo. Pero
      // conviene que se vea, porque cambia cuanto tardamos en detectar la caida.
      this.opts.logger.warn("analyzer.client.keepalive_unavailable", {
        peer: this.peerLabel(),
        detail:
          "El sistema no acepto habilitar keepalive de TCP. La deteccion de " +
          "conexion muerta queda solo a cargo del barrido por inactividad.",
      });
    }

    this.opts.logger.info("analyzer.client.connected", {
      peer: this.peerLabel(),
      totalConnectionsSinceStart: this.totalConnections,
      keepAlive: keepAliveOk,
    });
  }

  private onData(socket: Socket<ClientState>, data: Buffer): void {
    this.bytesReceived += data.length;
    // Cualquier byte cuenta como señal de vida, incluido el heartbeat.
    this.lastActivityAt = Date.now();
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const { messages, controlBytes, overflow } = socket.data.buffer.push(bytes);

    if (overflow) {
      this.opts.logger.error("mllp.frame.too_large", {
        peer: this.peerLabel(),
        maxBytes: MAX_MLLP_FRAME_BYTES,
        detail:
          "El equipo abrio un frame MLLP y nunca lo cerro (FS+CR). Se descarto " +
          "y se corta la conexion para no quedarnos sin memoria; reconectamos.",
      });
      try {
        socket.end();
      } catch {
        // ignore
      }
      return;
    }

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
    socket.data.buffer.reset();

    // Puede ser el cierre de un socket descartado por generacion vieja. Si el
    // socket bueno sigue vivo, no hay nada que hacer: no toca el estado ni
    // dispara una reconexion que no hace falta.
    if (this.socket !== null && this.socket !== socket) return;

    const wasConnected = this.socket !== null;
    this.socket = null;
    this.connectedAt = null;

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
