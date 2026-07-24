/**
 * HTTP API local del servicio.
 *
 * Solo escucha en 127.0.0.1 + token en header X-XS20-Token.
 *
 * Endpoints:
 *  GET  /api/health
 *  GET  /api/results?...
 *  GET  /api/results/:id
 *  GET  /api/logs/stream  (SSE)
 *  GET  /api/config
 */

import type { Server } from "bun";

import type {
  GetResultResponse,
  HealthResponse,
  ListResultsResponse,
  LogEvent,
  ResultSummary,
  ServiceConfig,
  UpdateConfigRequest,
  UpdateConfigResponse,
} from "@xs20/shared";
import { encodeHistogramBase64 } from "@xs20/shared";

import type { XsRepo } from "../db/repo.js";
import type { LogLevel } from "../logger.js";
import type { Logger } from "../logger.js";
import type { TcpServer } from "../listener/tcp-server.js";
import type { ResolvedConfig } from "../config.js";
import { saveSettings } from "../settings-store.js";

export interface HttpServerOptions {
  repo: XsRepo;
  logger: Logger;
  tcp: TcpServer;
  config: ResolvedConfig;
  /** Token requerido en X-XS20-Token (excepto /api/health). */
  apiToken: string;
  /** Host (default 127.0.0.1). */
  host?: string;
  /** Puerto. */
  port: number;
  /** Hora de arranque (para uptime). */
  startedAt: Date;
  /** Version del servicio (para health). */
  version: string;
}

export class HttpServer {
  private server: Server<unknown> | null = null;

  constructor(private opts: HttpServerOptions) {}

  start(): void {
    this.server = Bun.serve({
      hostname: this.opts.host ?? "127.0.0.1",
      port: this.opts.port,
      fetch: (req) => this.handle(req),
    });
    this.opts.logger.info("http.listener.up", {
      host: this.server.hostname,
      port: this.server.port,
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const t0 = performance.now();

    let res: Response;
    try {
      // /api/health no requiere token
      if (path === "/api/health" && req.method === "GET") {
        res = this.health();
      } else if (path === "/api/logs/stream" && req.method === "GET") {
        // SSE acepta token via query param o header
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = this.logStream();
      } else if (path === "/api/results" && req.method === "GET") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = this.listResults(url);
      } else if (path.match(/^\/api\/results\/[^/]+$/) && req.method === "GET") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        const id = path.split("/").pop()!;
        res = this.getResult(id, url);
      } else if (path === "/api/config" && req.method === "GET") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = this.getConfig();
      } else if (
        path === "/api/config" &&
        (req.method === "PUT" || req.method === "POST")
      ) {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = await this.updateConfig(req);
      } else {
        res = json({ error: { code: "NOT_FOUND", message: path } }, 404);
      }
    } catch (e) {
      this.opts.logger.error("http.handler_error", {
        path,
        error: (e as Error).message,
      });
      res = json(
        { error: { code: "INTERNAL", message: (e as Error).message } },
        500,
      );
    }

    const dur = performance.now() - t0;
    this.opts.logger.debug("http.request", {
      method: req.method,
      path,
      status: res.status,
      durationMs: Math.round(dur),
    });
    return res;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  private checkAuth(req: Request, url: URL): boolean {
    const tokenHeader = req.headers.get("X-XS20-Token");
    const tokenQuery = url.searchParams.get("token");
    return tokenHeader === this.opts.apiToken || tokenQuery === this.opts.apiToken;
  }

  private unauthorized(): Response {
    return json(
      { error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } },
      401,
    );
  }

  // ─── Endpoints ────────────────────────────────────────────────────────────

  private health(): Response {
    const tcp = this.opts.tcp.getStatus();
    const body: HealthResponse = {
      status: tcp.listening ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - this.opts.startedAt.getTime()) / 1000),
      tcpListener: {
        listening: tcp.listening,
        address: tcp.address,
        port: tcp.port,
        activeConnections: tcp.activeConnections,
        totalConnectionsSinceStart: tcp.totalConnectionsSinceStart,
      },
      database: {
        ok: true,
        sizeBytes: this.opts.repo.databaseSizeBytes(),
        resultCount: this.opts.repo.countResults(),
      },
      lastMessageAt: tcp.lastMessageAt?.toISOString() ?? null,
      version: this.opts.version,
    };
    return json(body);
  }

  private listResults(url: URL): Response {
    const search = url.searchParams.get("search") ?? undefined;
    const fromDate = url.searchParams.get("fromDate") ?? undefined;
    const toDate = url.searchParams.get("toDate") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

    const results: ResultSummary[] = this.opts.repo.listResults({
      search,
      fromDate,
      toDate,
      limit,
    });
    const body: ListResultsResponse = { results, nextCursor: null };
    return json(body);
  }

  private getResult(id: string, url: URL): Response {
    const r = this.opts.repo.getResult(id);
    if (!r) {
      return json({ error: { code: "RESULT_NOT_FOUND", message: id } }, 404);
    }
    const includeRaw = url.searchParams.get("includeRaw") === "true";
    const body: GetResultResponse = {
      ...r,
      // Histogramas: convertir Uint8Array a base64 para que viaje en JSON.
      histograms: r.histograms.map((h) => ({
        ...h,
        // En el shape API, channels viene como base64 en lugar de Uint8Array.
        // Hack: castamos pq el tipo dice Uint8Array pero la UI lo recibe como string.
        channels: encodeHistogramBase64(h.channels) as unknown as Uint8Array,
      })),
      ...(includeRaw
        ? { rawHl7: this.opts.repo.getResultRawHl7(id) ?? "" }
        : {}),
    };
    return json(body);
  }

  private configPayload(): ServiceConfig {
    const c = this.opts.config;
    return {
      tcpPort: c.tcpPort,
      tcpHost: c.tcpHost,
      httpPort: c.httpPort,
      dbPath: c.dbPath,
      logDir: c.logDir,
      logLevel: c.logLevel,
      rawRetentionDays: c.rawRetentionDays,
    };
  }

  private getConfig(): Response {
    return json(this.configPayload());
  }

  /**
   * PUT /api/config — cambia la config editable desde la app.
   *
   * Aplica en caliente: host/puerto del listener TCP se reconfiguran sin
   * reiniciar el servicio, el nivel de log cambia al instante y la retencion
   * se usa en la proxima purga. Persiste el resultado en settings.json para
   * que sobreviva a reinicios. Devuelve restartRequired=false porque nada de
   * esto necesita reiniciar.
   */
  private async updateConfig(req: Request): Promise<Response> {
    let body: UpdateConfigRequest;
    try {
      body = (await req.json()) as UpdateConfigRequest;
    } catch {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "El cuerpo no es JSON válido" } },
        400,
      );
    }
    if (typeof body !== "object" || body === null) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "Se esperaba un objeto" } },
        400,
      );
    }

    const cfg = this.opts.config;
    const errors: string[] = [];

    let newTcpHost = cfg.tcpHost;
    if (body.tcpHost !== undefined) {
      const h = String(body.tcpHost).trim();
      if (!isValidHost(h)) {
        errors.push("La IP a escuchar debe ser una IPv4 válida, 0.0.0.0 o localhost");
      } else {
        newTcpHost = h;
      }
    }

    let newTcpPort = cfg.tcpPort;
    if (body.tcpPort !== undefined) {
      if (!Number.isInteger(body.tcpPort) || body.tcpPort < 1 || body.tcpPort > 65535) {
        errors.push("El puerto TCP debe ser un entero entre 1 y 65535");
      } else if (body.tcpPort === cfg.httpPort) {
        errors.push(`El puerto TCP no puede ser el mismo que el de la API (${cfg.httpPort})`);
      } else {
        newTcpPort = body.tcpPort;
      }
    }

    let newLogLevel = cfg.logLevel;
    if (body.logLevel !== undefined) {
      if (!["debug", "info", "warn", "error"].includes(body.logLevel)) {
        errors.push("El nivel de log debe ser debug, info, warn o error");
      } else {
        newLogLevel = body.logLevel;
      }
    }

    let newRetention = cfg.rawRetentionDays;
    if (body.rawRetentionDays !== undefined) {
      if (
        !Number.isInteger(body.rawRetentionDays) ||
        body.rawRetentionDays < 0 ||
        body.rawRetentionDays > 3650
      ) {
        errors.push("La retención debe ser un entero entre 0 y 3650 días");
      } else {
        newRetention = body.rawRetentionDays;
      }
    }

    if (errors.length > 0) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: errors.join(". ") } },
        400,
      );
    }

    // Reconfigurar el listener TCP en caliente si cambio host o puerto.
    if (newTcpHost !== cfg.tcpHost || newTcpPort !== cfg.tcpPort) {
      try {
        this.opts.tcp.reconfigure(newTcpHost, newTcpPort);
      } catch (e) {
        return json(
          {
            error: {
              code: "TCP_BIND_FAILED",
              message: `No se pudo escuchar en ${newTcpHost}:${newTcpPort}. ${(e as Error).message}`,
            },
          },
          409,
        );
      }
      cfg.tcpHost = newTcpHost;
      cfg.tcpPort = newTcpPort;
    }

    // Nivel de log en caliente.
    if (newLogLevel !== cfg.logLevel) {
      cfg.logLevel = newLogLevel;
      this.opts.logger.setLevel(newLogLevel as LogLevel);
    }

    // Retencion: se aplica en la proxima corrida de purga.
    cfg.rawRetentionDays = newRetention;

    // Persistir para que sobreviva a reinicios.
    try {
      saveSettings(cfg.settingsPath, {
        tcpPort: cfg.tcpPort,
        tcpHost: cfg.tcpHost,
        logLevel: cfg.logLevel,
        rawRetentionDays: cfg.rawRetentionDays,
      });
    } catch (e) {
      this.opts.logger.error("config.persist_failed", { error: (e as Error).message });
    }

    this.opts.logger.info("config.updated", {
      tcpHost: cfg.tcpHost,
      tcpPort: cfg.tcpPort,
      logLevel: cfg.logLevel,
      rawRetentionDays: cfg.rawRetentionDays,
    });

    const resp: UpdateConfigResponse = {
      config: this.configPayload(),
      restartRequired: false,
    };
    return json(resp);
  }

  private logStream(): Response {
    const logger = this.opts.logger;
    let unsubscribe: (() => void) | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send initial buffer
        for (const e of logger.getRecent()) {
          controller.enqueue(encoder.encode(formatSse(e)));
        }

        unsubscribe = logger.subscribe((e: LogEvent) => {
          try {
            controller.enqueue(encoder.encode(formatSse(e)));
          } catch {
            // controller closed
          }
        });

        heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            // ignore
          }
        }, 30000);
      },
      cancel() {
        if (unsubscribe) unsubscribe();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Valida un host para el listener TCP: aceptamos "localhost", "0.0.0.0"
 * (todas las interfaces) o una IPv4 con octetos 0-255. No aceptamos hostnames
 * arbitrarios porque el listener bindea una interfaz local concreta.
 */
function isValidHost(host: string): boolean {
  if (host === "localhost") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1, 5).every((oct) => {
    const n = Number(oct);
    return n >= 0 && n <= 255 && String(n) === oct;
  });
}

function formatSse(e: LogEvent): string {
  return `event: log\ndata: ${JSON.stringify(e)}\n\n`;
}
