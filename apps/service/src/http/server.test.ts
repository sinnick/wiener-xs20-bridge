import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { TcpServer } from "../listener/tcp-server.js";
import type { ResolvedConfig } from "../config.js";
import { HttpServer } from "./server.js";

// Logger que no escribe a disco ni consola (buffer en memoria a /tmp efimero).
function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

const API_TOKEN = "test-token-123";

describe("HttpServer - CORS", () => {
  let httpServer: HttpServer;
  let tcpServer: TcpServer;
  let port: number;
  let baseUrl: string;

  beforeEach(() => {
    port = 21000 + Math.floor(Math.random() * 2000);
    baseUrl = `http://127.0.0.1:${port}`;
    const db = openDb({ path: ":memory:" });
    const repo = new XsRepo(db);
    const logger = silentLogger();

    // TcpServer no arrancado: solo necesitamos su getStatus() para /api/health.
    tcpServer = new TcpServer({
      host: "127.0.0.1",
      port: port + 1,
      repo,
      logger,
    });

    const config: ResolvedConfig = {
      tcpPort: port + 1,
      tcpHost: "127.0.0.1",
      httpPort: port,
      dbPath: ":memory:",
      logDir: "/tmp",
      logLevel: "error",
      rawRetentionDays: 90,
      console: false,
      noListen: false,
      apiToken: API_TOKEN,
    };

    httpServer = new HttpServer({
      repo,
      logger,
      tcp: tcpServer,
      config,
      apiToken: API_TOKEN,
      port,
      startedAt: new Date(),
      version: "test",
    });
    httpServer.start();
  });

  afterEach(() => {
    httpServer.stop();
  });

  test("OPTIONS /api/health → 204 con Access-Control-Allow-Origin *", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("GET /api/health → incluye Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("OPTIONS /api/results (ruta con auth) → 204 sin token", async () => {
    const res = await fetch(`${baseUrl}/api/results`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
