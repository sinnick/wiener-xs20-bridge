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
 *  PUT  /api/config
 *  GET  /api/update/status
 *  POST /api/update/check
 *  POST /api/update/download
 *  POST /api/update/skip
 *  POST /api/export/rerun
 *  POST /api/maintenance/wipe-database
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
  ExportRerunRequest,
  ExportRerunResponse,
  WipeDatabaseRequest,
  WipeDatabaseResponse,
} from "@xs20/shared";
import { encodeHistogramBase64, WIPE_CONFIRMATION } from "@xs20/shared";

import { exportStatus, probeAndRecord } from "../export/export-status.js";
import { rerunExports, RERUN_MAX_LIMIT } from "../export/rerun.js";
import type { XsRepo } from "../db/repo.js";
import type { LogLevel } from "../logger.js";
import type { Logger } from "../logger.js";
import type { AnalyzerClient } from "../listener/analyzer-client.js";
import type { TcpServer } from "../listener/tcp-server.js";
import type { ResolvedConfig } from "../config.js";
import type { PersistedSettings } from "../settings-store.js";
import { saveSettings } from "../settings-store.js";
import type { UpdateChecker } from "../update/update-checker.js";

/**
 * Headers CORS: la UI Tauri corre en origen https://tauri.localhost y hace
 * fetch cross-origin a este servidor (http://127.0.0.1:7700) con el header
 * custom X-XS20-Token, lo que dispara un preflight OPTIONS.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "X-XS20-Token, Content-Type",
};

export interface HttpServerOptions {
  repo: XsRepo;
  logger: Logger;
  tcp: TcpServer;
  /**
   * Cliente saliente (modo "connect"). Opcional para que los tests que solo
   * ejercitan el modo listener no tengan que construirlo.
   */
  analyzerClient?: AnalyzerClient;
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
  /**
   * Chequeo de updates. Opcional para que los tests que no lo ejercitan no
   * tengan que construirlo (los endpoints /api/update/* responden 503).
   */
  updateChecker?: UpdateChecker;
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
      // Preflight CORS: nunca lleva el token, se responde antes de cualquier
      // chequeo de auth (asi lo exige el estandar).
      if (req.method === "OPTIONS") {
        res = new Response(null, { status: 204, headers: CORS_HEADERS });
      } else if (path === "/api/health" && req.method === "GET") {
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
      } else if (path === "/api/update/status" && req.method === "GET") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = this.updateStatus();
      } else if (path === "/api/update/check" && req.method === "POST") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = await this.updateCheck();
      } else if (path === "/api/update/download" && req.method === "POST") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = this.updateDownload();
      } else if (path === "/api/update/skip" && req.method === "POST") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = await this.updateSkip(req);
      } else if (path === "/api/export/rerun" && req.method === "POST") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = await this.exportRerun(req);
      } else if (path === "/api/maintenance/wipe-database" && req.method === "POST") {
        if (!this.checkAuth(req, url)) return this.unauthorized();
        res = await this.wipeDatabase(req);
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
    const mode = this.opts.config.connectionMode;
    const client = this.opts.analyzerClient;

    // En modo "connect" el transporte activo es el cliente saliente, asi que el
    // health tiene que reflejar SU estado y no el del listener (que esta parado
    // a proposito). "ok" pide conexion establecida con el equipo: si el XS 20
    // esta apagado, queda "degraded" y la app lo muestra.
    const transport =
      mode === "connect" && client
        ? (() => {
            const s = client.getStatus();
            return {
              healthy: s.connected,
              listening: s.listening,
              address: s.address,
              port: s.port,
              activeConnections: s.activeConnections,
              totalConnectionsSinceStart: s.totalConnectionsSinceStart,
              lastMessageAt: s.lastMessageAt,
            };
          })()
        : (() => {
            const s = this.opts.tcp.getStatus();
            return {
              healthy: s.listening,
              listening: s.listening,
              address: s.address,
              port: s.port,
              activeConnections: s.activeConnections,
              totalConnectionsSinceStart: s.totalConnectionsSinceStart,
              lastMessageAt: s.lastMessageAt,
            };
          })();

    // Chequeo real de escritura: si la DB quedo de solo lectura, el servicio
    // parece sano pero no guarda nada. Ver XsRepo.probeWritable().
    const dbWritable = this.opts.repo.probeWritable().ok;

    // Estado de la exportacion a .txt. Es una foto en memoria a proposito: NO
    // se chequea la carpeta en cada /api/health porque una unidad de red caida
    // puede colgar la escritura de prueba varios segundos y este endpoint lo
    // llama la app cada 3s. La carpeta se prueba al arrancar, al cambiarla y en
    // cada exportacion real. Ver apps/service/src/export/export-status.ts.
    const exportSnapshot = exportStatus.snapshot(this.opts.config.exportDir);

    const clientStatus = client?.getStatus();
    const body: HealthResponse = {
      // El .txt es el producto que mira el laboratorio: si no se esta pudiendo
      // escribir, el servicio NO esta sano aunque el resto funcione.
      status: transport.healthy && dbWritable && exportSnapshot.healthy ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - this.opts.startedAt.getTime()) / 1000),
      connectionMode: mode,
      tcpListener: {
        listening: transport.listening,
        address: transport.address,
        port: transport.port,
        activeConnections: transport.activeConnections,
        totalConnectionsSinceStart: transport.totalConnectionsSinceStart,
      },
      analyzerClient:
        mode === "connect" && clientStatus
          ? {
              active: clientStatus.listening,
              connected: clientStatus.connected,
              address: clientStatus.address,
              port: clientStatus.port,
              connectedAt: clientStatus.connectedAt?.toISOString() ?? null,
              lastError: clientStatus.lastError,
            }
          : null,
      database: {
        ok: dbWritable,
        sizeBytes: this.opts.repo.databaseSizeBytes(),
        resultCount: this.opts.repo.countResults(),
      },
      export: exportSnapshot,
      lastMessageAt: transport.lastMessageAt?.toISOString() ?? null,
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
      connectionMode: c.connectionMode,
      analyzerHost: c.analyzerHost,
      analyzerPort: c.analyzerPort,
      tcpPort: c.tcpPort,
      tcpHost: c.tcpHost,
      httpPort: c.httpPort,
      dbPath: c.dbPath,
      logDir: c.logDir,
      logLevel: c.logLevel,
      rawRetentionDays: c.rawRetentionDays,
      exportDir: c.exportDir,
      updateCheckEnabled: c.updateCheckEnabled,
    };
  }

  /** Snapshot completo de los settings persistibles, para saveSettings. */
  private persistedSettings(): PersistedSettings {
    const c = this.opts.config;
    return {
      connectionMode: c.connectionMode,
      analyzerHost: c.analyzerHost,
      analyzerPort: c.analyzerPort,
      tcpPort: c.tcpPort,
      tcpHost: c.tcpHost,
      logLevel: c.logLevel,
      rawRetentionDays: c.rawRetentionDays,
      exportDir: c.exportDir,
      updateCheckEnabled: c.updateCheckEnabled,
      skippedVersion: c.skippedVersion,
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

    let newMode = cfg.connectionMode;
    if (body.connectionMode !== undefined) {
      if (body.connectionMode !== "listen" && body.connectionMode !== "connect") {
        errors.push("El modo de conexión debe ser 'listen' o 'connect'");
      } else {
        newMode = body.connectionMode;
      }
    }

    let newAnalyzerHost = cfg.analyzerHost;
    if (body.analyzerHost !== undefined) {
      const h = String(body.analyzerHost).trim();
      // Vacio se acepta: es como se "limpia" la IP del equipo estando en modo
      // listen. La validacion de que haga falta para 'connect' va mas abajo.
      if (h.length > 0 && (!isValidHost(h) || h === "0.0.0.0")) {
        errors.push("La IP del analizador debe ser una IPv4 válida (ej 192.168.100.15)");
      } else {
        newAnalyzerHost = h;
      }
    }

    let newAnalyzerPort = cfg.analyzerPort;
    if (body.analyzerPort !== undefined) {
      if (
        !Number.isInteger(body.analyzerPort) ||
        body.analyzerPort < 1 ||
        body.analyzerPort > 65535
      ) {
        errors.push("El puerto del analizador debe ser un entero entre 1 y 65535");
      } else {
        newAnalyzerPort = body.analyzerPort;
      }
    }

    // En modo 'connect' la IP del equipo es obligatoria: sin ella no hay a donde
    // discar y el servicio quedaria sin transporte activo.
    if (newMode === "connect" && newAnalyzerHost.length === 0) {
      errors.push(
        "Para el modo 'connect' hace falta la IP del analizador (ej 192.168.100.15)",
      );
    }

    // Vacio se acepta: deshabilita la exportacion a .txt.
    let newExportDir = cfg.exportDir;
    if (body.exportDir !== undefined) {
      if (typeof body.exportDir !== "string") {
        errors.push("La carpeta de exportación debe ser un texto (o vacío para deshabilitar)");
      } else {
        newExportDir = body.exportDir.trim();
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

    let newUpdateCheckEnabled = cfg.updateCheckEnabled;
    if (body.updateCheckEnabled !== undefined) {
      if (typeof body.updateCheckEnabled !== "boolean") {
        errors.push("updateCheckEnabled debe ser true o false");
      } else {
        newUpdateCheckEnabled = body.updateCheckEnabled;
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

    // Cambio de modo / direccion del analizador, en caliente.
    const modeChanged = newMode !== cfg.connectionMode;
    const analyzerChanged =
      newAnalyzerHost !== cfg.analyzerHost || newAnalyzerPort !== cfg.analyzerPort;

    if (modeChanged || analyzerChanged) {
      const client = this.opts.analyzerClient;
      if (newMode === "connect" && !client) {
        return json(
          {
            error: {
              code: "MODE_SWITCH_UNAVAILABLE",
              message:
                "Este servicio se inició sin cliente saliente. Reiniciá la aplicación para usar el modo 'connect'.",
            },
          },
          409,
        );
      }

      if (newMode === "connect") {
        // Cortamos el listener (en este modo no se usa) y apuntamos el cliente.
        if (this.opts.tcp.getStatus().listening) this.opts.tcp.stop();
        cfg.connectionMode = "connect";
        cfg.analyzerHost = newAnalyzerHost;
        cfg.analyzerPort = newAnalyzerPort;
        // reconfigure() no lanza: si el equipo esta apagado entra en reintentos.
        client!.reconfigure(newAnalyzerHost, newAnalyzerPort);
        if (!client!.getStatus().listening) client!.start();
      } else {
        // Volvemos a modo listener: paramos el cliente y bindeamos.
        client?.stop();
        try {
          if (!this.opts.tcp.getStatus().listening) this.opts.tcp.start();
        } catch (e) {
          // El bind fallo (puerto ocupado). Nos quedamos donde estabamos para no
          // dejar el servicio sin ningun transporte activo.
          if (cfg.connectionMode === "connect" && client) client.start();
          return json(
            {
              error: {
                code: "TCP_BIND_FAILED",
                message: `No se pudo escuchar en ${cfg.tcpHost}:${cfg.tcpPort}. ${(e as Error).message}`,
              },
            },
            409,
          );
        }
        cfg.connectionMode = "listen";
        cfg.analyzerHost = newAnalyzerHost;
        cfg.analyzerPort = newAnalyzerPort;
      }
    }

    // Nivel de log en caliente.
    if (newLogLevel !== cfg.logLevel) {
      cfg.logLevel = newLogLevel;
      this.opts.logger.setLevel(newLogLevel as LogLevel);
    }

    // Retencion: se aplica en la proxima corrida de purga.
    cfg.rawRetentionDays = newRetention;

    // Carpeta de exportacion: aplica en el proximo resultado recibido. La
    // probamos ACA, no cuando llegue la muestra: si el destino tiene un typo o
    // la unidad de red no esta, se ve en /api/health al instante y no dentro de
    // una semana cuando alguien note que faltan archivos.
    const exportDirChanged = newExportDir !== cfg.exportDir;
    cfg.exportDir = newExportDir;
    if (exportDirChanged) probeAndRecord(newExportDir, this.opts.logger);

    // Chequeo de updates: el UpdateChecker lo lee en vivo via isEnabled().
    cfg.updateCheckEnabled = newUpdateCheckEnabled;

    // Persistir para que sobreviva a reinicios.
    try {
      saveSettings(cfg.settingsPath, this.persistedSettings());
    } catch (e) {
      this.opts.logger.error("config.persist_failed", { error: (e as Error).message });
    }

    this.opts.logger.info("config.updated", {
      connectionMode: cfg.connectionMode,
      analyzerHost: cfg.analyzerHost,
      analyzerPort: cfg.analyzerPort,
      tcpHost: cfg.tcpHost,
      tcpPort: cfg.tcpPort,
      logLevel: cfg.logLevel,
      rawRetentionDays: cfg.rawRetentionDays,
      exportDir: cfg.exportDir,
      updateCheckEnabled: cfg.updateCheckEnabled,
    });

    const resp: UpdateConfigResponse = {
      config: this.configPayload(),
      restartRequired: false,
    };
    return json(resp);
  }

  // ─── Updates ──────────────────────────────────────────────────────────────

  private updaterUnavailable(): Response {
    return json(
      {
        error: {
          code: "UPDATER_UNAVAILABLE",
          message: "Este servicio se inició sin el chequeo de actualizaciones.",
        },
      },
      503,
    );
  }

  private updateStatus(): Response {
    const checker = this.opts.updateChecker;
    if (!checker) return this.updaterUnavailable();
    return json(checker.getStatus());
  }

  private async updateCheck(): Promise<Response> {
    const checker = this.opts.updateChecker;
    if (!checker) return this.updaterUnavailable();
    return json(await checker.checkNow());
  }

  private updateDownload(): Response {
    const checker = this.opts.updateChecker;
    if (!checker) return this.updaterUnavailable();
    const phase = checker.getStatus().phase;
    if (phase === "idle" || phase === "checking") {
      return json(
        {
          error: {
            code: "DOWNLOAD_NOT_READY",
            message: "No hay una actualización disponible para descargar.",
          },
        },
        409,
      );
    }
    return json(checker.startDownload());
  }

  /** POST /api/update/skip {version} — "omitir esta versión" del banner. */
  private async updateSkip(req: Request): Promise<Response> {
    const checker = this.opts.updateChecker;
    if (!checker) return this.updaterUnavailable();

    let body: { version?: unknown };
    try {
      body = (await req.json()) as { version?: unknown };
    } catch {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "El cuerpo no es JSON válido" } },
        400,
      );
    }
    if (typeof body.version !== "string" || body.version.trim().length === 0) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "Falta el campo 'version'" } },
        400,
      );
    }

    const cfg = this.opts.config;
    cfg.skippedVersion = body.version.trim();
    try {
      saveSettings(cfg.settingsPath, this.persistedSettings());
    } catch (e) {
      this.opts.logger.error("config.persist_failed", { error: (e as Error).message });
    }
    this.opts.logger.info("update.version_skipped", { version: cfg.skippedVersion });
    return json(checker.getStatus());
  }

  // ─── Exportacion a .txt ───────────────────────────────────────────────────

  /**
   * POST /api/export/rerun — regenera los .txt de resultados ya guardados.
   *
   * Es la salida del escenario caro: la carpeta destino estuvo mal configurada
   * unos dias, los resultados se guardaron igual pero los .txt no existen. Sin
   * esto habria que volver a correr las muestras en el analizador.
   *
   * Body (todo opcional): { ids, fromDate, toDate, limit }.
   */
  private async exportRerun(req: Request): Promise<Response> {
    let body: ExportRerunRequest = {};
    // Sin cuerpo tambien vale: regenera los ultimos por default.
    const rawBody = await req.text();
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody) as ExportRerunRequest;
      } catch {
        return json(
          { error: { code: "VALIDATION_ERROR", message: "El cuerpo no es JSON válido" } },
          400,
        );
      }
    }
    if (typeof body !== "object" || body === null) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "Se esperaba un objeto" } },
        400,
      );
    }

    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
        return json(
          { error: { code: "VALIDATION_ERROR", message: "'ids' debe ser una lista de textos" } },
          400,
        );
      }
    }
    if (
      body.limit !== undefined &&
      (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > RERUN_MAX_LIMIT)
    ) {
      return json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `El límite debe ser un entero entre 1 y ${RERUN_MAX_LIMIT}`,
          },
        },
        400,
      );
    }

    const dir = this.opts.config.exportDir;
    if (dir.length === 0) {
      return json(
        {
          error: {
            code: "EXPORT_DISABLED",
            message:
              "La exportación a .txt está deshabilitada. Configurá una carpeta en " +
              "Estado → Configuración y volvé a intentar.",
          },
        },
        409,
      );
    }

    const result = rerunExports({
      repo: this.opts.repo,
      logger: this.opts.logger,
      dir,
      ids: body.ids,
      fromDate: body.fromDate,
      toDate: body.toDate,
      limit: body.limit,
    });

    // Carpeta inaccesible: un solo error claro en lugar de 200 iguales.
    if (result.dirError !== null) {
      return json(
        {
          error: {
            code: "EXPORT_DIR_UNAVAILABLE",
            message: `No se puede escribir en ${dir}. ${result.dirError}`,
          },
        },
        409,
      );
    }

    const resp: ExportRerunResponse = {
      dir: result.dir,
      attempted: result.attempted,
      written: result.written,
      failed: result.failed,
      notFound: result.notFound,
      errors: result.errors,
    };
    return json(resp);
  }

  /**
   * POST /api/maintenance/wipe-database — borra TODOS los resultados guardados.
   *
   * Para que el analizador pueda reenviar todo desde cero con su funcion "enviar
   * todo": como deduplicamos por muestra + instante de analisis, un reenvio del
   * historico no reescribe lo que ya esta. Ver XsRepo.wipeClinicalData.
   *
   * ── Por que POST y no DELETE ──────────────────────────────────────────────
   * El Allow-Methods de CORS_HEADERS no incluye DELETE, asi que un
   * fetch(method:"DELETE") desde el origen de la UI Tauri muere en el preflight
   * sin llegar nunca aca. Antes de "arreglar" esto agregando DELETE al header,
   * tener en cuenta que POST ya es el patron de todas las acciones de esta API.
   *
   * ── Por que el body tiene que traer la confirmacion ───────────────────────
   * La confirmacion de la UI (escribir BORRAR) vive del lado del cliente: un
   * refactor de StatusView o un `disabled` mal puesto la evapora sin que ningun
   * test del servicio se entere. Ademas este endpoint es alcanzable por
   * cualquier cosa que tenga el token — un curl de diagnostico, alguien copiando
   * el ejemplo del doc — y sin `confirm` un body vacio borraria el laboratorio
   * entero. Exigirlo cuesta seis lineas y hace que solo borre quien quiso borrar.
   *
   * OJO: esto protege contra el accidente, no contra un atacante. Cualquier
   * proceso local que pueda leer config/api-token.txt puede mandar la palabra.
   */
  private async wipeDatabase(req: Request): Promise<Response> {
    let body: WipeDatabaseRequest;
    const rawBody = await req.text();
    try {
      body = JSON.parse(rawBody) as WipeDatabaseRequest;
    } catch {
      return json(
        { error: { code: "VALIDATION_ERROR", message: "El cuerpo no es JSON válido" } },
        400,
      );
    }
    if (typeof body !== "object" || body === null || body.confirm !== WIPE_CONFIRMATION) {
      return json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Para borrar la base hay que enviar 'confirm' con el texto ${WIPE_CONFIRMATION}.`,
          },
        },
        400,
      );
    }

    // Antes de intentar el borrado: si la base no acepta escrituras, un 409 con
    // una instruccion sirve mucho mas que un 500 con un mensaje de SQLite crudo.
    const writable = this.opts.repo.probeWritable();
    if (!writable.ok) {
      return json(
        {
          error: {
            code: "DB_READONLY",
            message:
              "La base no acepta escrituras, así que no se puede borrar. Cerrá la " +
              "app y volvé a abrirla; si sigue igual, revisá los permisos de la " +
              "carpeta C:\\ProgramData\\WienerXS20\\db.",
          },
        },
        409,
      );
    }

    const resp: WipeDatabaseResponse = this.opts.repo.wipeClinicalData();

    // A nivel warn a proposito: sobrevive a logLevel "warn", aparece en la
    // pantalla Actividad y viaja por SSE, que es como la UI se entera de que
    // tiene que refrescar. El msg coincide con el eventType del audit_log para
    // que grepear el log y consultar la base den lo mismo.
    this.opts.logger.warn("db.wiped", {
      deletedResults: resp.deletedResults,
      deletedRawMessages: resp.deletedRawMessages,
      deletedPatients: resp.deletedPatients,
      sizeBefore: resp.sizeBefore,
      sizeAfter: resp.sizeAfter,
      vacuumed: resp.vacuumed,
      durationMs: resp.durationMs,
      detail:
        "Borrado pedido desde la app. Los .txt ya exportados NO se tocaron: se " +
        "pisan a medida que el equipo reenvía cada muestra.",
    });

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
        ...CORS_HEADERS,
      },
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
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
