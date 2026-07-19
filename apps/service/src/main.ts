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
import { XsRepo } from "./db/repo.js";
import { HttpServer } from "./http/server.js";
import { TcpServer } from "./listener/tcp-server.js";
import { Logger } from "./logger.js";

const VERSION = "0.1.0";

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
    tcpPort: config.tcpPort,
    tcpHost: config.tcpHost,
    httpPort: config.httpPort,
    dbPath: config.dbPath,
    logDir: config.logDir,
    noListen: config.noListen,
  });

  // DB
  const db = openDb({ path: config.dbPath });
  const repo = new XsRepo(db);
  logger.info("db.ready", { resultCount: repo.countResults() });

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

  // TCP listener
  const tcp = new TcpServer({
    host: config.tcpHost,
    port: config.tcpPort,
    repo,
    logger,
  });
  if (!config.noListen) {
    tcp.start();
  } else {
    logger.warn("tcp.disabled", { reason: "--no-listen flag" });
  }

  // HTTP API
  const http = new HttpServer({
    repo,
    logger,
    tcp,
    config,
    apiToken,
    port: config.httpPort,
    startedAt,
    version: VERSION,
  });
  http.start();

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
