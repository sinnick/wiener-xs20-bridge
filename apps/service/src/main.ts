/**
 * Entrypoint del servicio.
 *
 * Resuelve config → arma logger → abre DB → arranca TCP listener + HTTP API
 * → maneja senales para shutdown limpio.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { resolveConfig } from "./config.js";
import { openDb } from "./db/migrate.js";
import { TxtExporter } from "./export/txt-exporter.js";
import { XsRepo } from "./db/repo.js";
import { MessageProcessor } from "./hl7/message-processor.js";
import { HttpServer } from "./http/server.js";
import { AnalyzerClient } from "./listener/analyzer-client.js";
import { TcpServer } from "./listener/tcp-server.js";
import { Logger } from "./logger.js";
import { UpdateChecker } from "./update/update-checker.js";
import { VERSION } from "./version.js";

/** Repo publico de GitHub contra el que se chequean versiones nuevas. */
const UPDATE_REPO_SLUG = "sinnick/wiener-xs20-bridge";

function loadOrCreateApiToken(dataDir: string): string {
  const tokenDir = join(dataDir, "config");
  const tokenPath = join(tokenDir, "api-token.txt");

  if (existsSync(tokenPath)) {
    const t = readFileSync(tokenPath, "utf-8").trim();
    if (t.length > 0) return t;
  }

  if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

async function main(): Promise<void> {
  const config = resolveConfig(process.argv.slice(2));

  // El token vive en el mismo dataDir que la DB (mismo padre).
  const dataDir = dirname(dirname(config.dbPath));
  const apiToken = loadOrCreateApiToken(dataDir);
  config.apiToken = apiToken;

  const logger = new Logger({
    logDir: config.logDir,
    level: config.logLevel,
    console: config.console,
  });

  const startedAt = new Date();
  logger.info("service.starting", {
    version: VERSION,
    pid: process.pid,
    platform: process.platform,
    connectionMode: config.connectionMode,
    analyzerHost: config.analyzerHost,
    analyzerPort: config.analyzerPort,
    tcpPort: config.tcpPort,
    tcpHost: config.tcpHost,
    httpPort: config.httpPort,
    dbPath: config.dbPath,
    logDir: config.logDir,
    exportDir: config.exportDir,
    noListen: config.noListen,
  });

  // DB
  const db = openDb({ path: config.dbPath });
  const repo = new XsRepo(db);
  logger.info("db.ready", { resultCount: repo.countResults() });

  // Verificamos que la DB acepte escrituras ANTES de decir que arrancamos. Si no,
  // el servicio queda vivo (la API y los logs sirven para diagnosticar) pero lo
  // gritamos: sin esto, el sintoma es "el equipo manda y no se guarda nada".
  const writable = repo.probeWritable();
  if (!writable.ok) {
    logger.error("db.not_writable", {
      dbPath: config.dbPath,
      error: writable.error,
      detail:
        "La base rechaza escrituras: NO se van a guardar resultados. Causa " +
        "habitual en Windows: el .sqlite o sus archivos -wal/-shm quedaron de " +
        "otro usuario (por haber corrido el servicio como administrador alguna " +
        "vez). Solucion: cerrar la app y borrar " +
        `${config.dbPath}-wal y ${config.dbPath}-shm, o darle permiso de ` +
        "modificacion al usuario sobre la carpeta db.",
    });
  }

  // Retencion: purga el HL7 crudo viejo al arranque y despues cada 24h.
  // Los resultados estructurados NUNCA se borran; solo el payload pesado.
  const runPurge = () => {
    try {
      const purged = repo.purgeOldRawMessages(config.rawRetentionDays);
      if (purged > 0) {
        logger.info("retention.purged", {
          rawMessagesPurged: purged,
          retentionDays: config.rawRetentionDays,
        });
      }
    } catch (e) {
      logger.error("retention.purge_failed", { error: (e as Error).message });
    }
  };
  runPurge();
  const purgeTimer = setInterval(runPurge, 24 * 60 * 60 * 1000);

  // Exportacion a .txt por muestra. Lee exportDir del config vivo, asi el
  // cambio de carpeta desde la app aplica sin reiniciar.
  const txtExporter = new TxtExporter({ getDir: () => config.exportDir, logger });

  // Procesamiento HL7 compartido por los dos transportes, para que el estado
  // (lastMessageAt, contador de IDs) sea uno solo sin importar quien disco.
  const processor = new MessageProcessor({
    repo,
    logger,
    onHemogramPersisted: (h) => txtExporter.export(h),
  });

  // Los dos transportes se construyen siempre — asi la API puede cambiar de
  // modo en caliente sin reiniciar — pero solo arranca el del modo activo.
  const tcp = new TcpServer({
    host: config.tcpHost,
    port: config.tcpPort,
    repo,
    logger,
    processor,
  });
  const analyzerClient = new AnalyzerClient({
    host: config.analyzerHost,
    port: config.analyzerPort,
    processor,
    logger,
  });

  if (config.noListen) {
    logger.warn("tcp.disabled", { reason: "--no-listen flag" });
  } else if (config.connectionMode === "connect") {
    if (config.analyzerHost.length === 0) {
      logger.error("analyzer.client.no_host", {
        detail:
          "Modo 'connect' sin IP del analizador. Configurala en la app " +
          "(Estado → Configuración) o arranca con --analyzer-host=<ip>.",
      });
    } else {
      analyzerClient.start();
    }
  } else {
    tcp.start();
  }

  // Chequeo de versiones nuevas contra GitHub Releases. Lee los settings en
  // vivo, asi el toggle y el "omitir version" de la app aplican sin reiniciar.
  const updateChecker = new UpdateChecker({
    currentVersion: VERSION,
    repoSlug: UPDATE_REPO_SLUG,
    updatesDir: join(dataDir, "updates"),
    logger,
    isEnabled: () => config.updateCheckEnabled,
    getSkippedVersion: () => config.skippedVersion,
  });

  // HTTP API
  const http = new HttpServer({
    repo,
    logger,
    tcp,
    analyzerClient,
    config,
    apiToken,
    port: config.httpPort,
    startedAt,
    version: VERSION,
    updateChecker,
  });
  http.start();
  updateChecker.start();

  logger.info("service.started", {
    uptimeStartedAt: startedAt.toISOString(),
    apiTokenPath: join(dataDir, "config", "api-token.txt"),
  });

  // Shutdown handlers
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("service.stopping", { signal });
    clearInterval(purgeTimer);
    try {
      updateChecker.stop();
    } catch {
      /* ignore */
    }
    try {
      http.stop();
    } catch {
      /* ignore */
    }
    try {
      tcp.stop();
    } catch {
      /* ignore */
    }
    try {
      analyzerClient.stop();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    logger.info("service.stopped");
    // Damos tiempo a que el log se escriba a disco antes de salir.
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    logger.error("uncaught_exception", { error: e.message, stack: e.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { reason: String(reason) });
  });
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
