import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { TcpServer } from "../listener/tcp-server.js";
import type { ResolvedConfig } from "../config.js";
import { loadSettings } from "../settings-store.js";
import { UpdateChecker } from "../update/update-checker.js";
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
      connectionMode: "listen",
      analyzerHost: "",
      analyzerPort: 5100,
      tcpPort: port + 1,
      tcpHost: "127.0.0.1",
      httpPort: port,
      dbPath: ":memory:",
      logDir: "/tmp",
      logLevel: "error",
      rawRetentionDays: 90,
      exportDir: "",
      updateCheckEnabled: true,
      skippedVersion: "",
      console: false,
      noListen: false,
      apiToken: API_TOKEN,
      settingsPath: join(tmpdir(), `xs20-test-settings-${port}.json`),
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

  test("los endpoints de update responden 503 si el servicio arranco sin checker", async () => {
    const res = await fetch(`${baseUrl}/api/update/status`, {
      headers: { "X-XS20-Token": API_TOKEN },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPDATER_UNAVAILABLE");
  });
});

describe("HttpServer - updates", () => {
  let httpServer: HttpServer;
  let tcpServer: TcpServer;
  let config: ResolvedConfig;
  let checker: UpdateChecker;
  let baseUrl: string;

  beforeEach(async () => {
    const port = 23000 + Math.floor(Math.random() * 2000);
    baseUrl = `http://127.0.0.1:${port}`;
    const db = openDb({ path: ":memory:" });
    const repo = new XsRepo(db);
    const logger = silentLogger();

    tcpServer = new TcpServer({ host: "127.0.0.1", port: port + 1, repo, logger });

    config = {
      connectionMode: "listen",
      analyzerHost: "",
      analyzerPort: 5100,
      tcpPort: port + 1,
      tcpHost: "127.0.0.1",
      httpPort: port,
      dbPath: ":memory:",
      logDir: "/tmp",
      logLevel: "error",
      rawRetentionDays: 90,
      exportDir: "",
      updateCheckEnabled: true,
      skippedVersion: "",
      console: false,
      noListen: false,
      apiToken: API_TOKEN,
      settingsPath: join(tmpdir(), `xs20-test-upd-settings-${port}.json`),
    };

    // Checker con fetch mockeado: siempre hay una 9.9.9 publicada.
    checker = new UpdateChecker({
      currentVersion: "0.1.0",
      manifestUrl: "https://example.com/update/latest.json",
      updatesDir: join(tmpdir(), `xs20-test-upd-${port}`),
      logger,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            version: "9.9.9",
            notes: "notas",
            publishedAt: "2026-08-13T00:00:00Z",
            installer: {
              url: "https://example.com/update/wiener-xs20-bridge_9.9.9_x64-setup.exe",
              sha256: "a".repeat(64),
              size: 4,
            },
          }),
          { status: 200 },
        ),
      isEnabled: () => config.updateCheckEnabled,
      getSkippedVersion: () => config.skippedVersion,
    });

    httpServer = new HttpServer({
      repo,
      logger,
      tcp: tcpServer,
      config,
      apiToken: API_TOKEN,
      port,
      startedAt: new Date(),
      version: "0.1.0",
      updateChecker: checker,
    });
    httpServer.start();
  });

  afterEach(() => {
    httpServer.stop();
    checker.stop();
  });

  test("GET /api/update/status sin token → 401", async () => {
    const res = await fetch(`${baseUrl}/api/update/status`);
    expect(res.status).toBe(401);
  });

  test("POST /api/update/check → encuentra la version nueva", async () => {
    const res = await fetch(`${baseUrl}/api/update/check`, {
      method: "POST",
      headers: { "X-XS20-Token": API_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string; latestVersion: string };
    expect(body.phase).toBe("update-available");
    expect(body.latestVersion).toBe("9.9.9");
  });

  test("POST /api/update/download sin update disponible → 409", async () => {
    const res = await fetch(`${baseUrl}/api/update/download`, {
      method: "POST",
      headers: { "X-XS20-Token": API_TOKEN },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DOWNLOAD_NOT_READY");
  });

  test("POST /api/update/skip persiste la version omitida y el status pasa a idle", async () => {
    await checker.checkNow();
    const res = await fetch(`${baseUrl}/api/update/skip`, {
      method: "POST",
      headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ version: "9.9.9" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string; skippedVersion: string };
    expect(body.phase).toBe("idle");
    expect(body.skippedVersion).toBe("9.9.9");
    // Quedo persistido en settings.json junto al resto de la config.
    expect(loadSettings(config.settingsPath).skippedVersion).toBe("9.9.9");
  });

  test("POST /api/update/skip sin version → 400", async () => {
    const res = await fetch(`${baseUrl}/api/update/skip`, {
      method: "POST",
      headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("PUT /api/config acepta updateCheckEnabled y lo refleja el checker", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ updateCheckEnabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { updateCheckEnabled: boolean } };
    expect(body.config.updateCheckEnabled).toBe(false);
    // El checker lo lee en vivo: con el chequeo apagado no consulta.
    const st = await checker.checkNow();
    expect(st.updateCheckEnabled).toBe(false);
    expect(st.phase).toBe("idle");
  });
});
