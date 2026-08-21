/**
 * Tests de los endpoints de exportacion (/api/health → export, POST
 * /api/export/rerun).
 *
 * Viven aca y no en http/server.test.ts para no pisarnos con el resto del
 * trabajo sobre ese archivo: lo que se prueba es la exportacion, no el server.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExportRerunResponse,
  HealthResponse,
  HemogramParam,
  HemogramResult,
  HemogramValue,
} from "@xs20/shared";

import type { ResolvedConfig } from "../config.js";
import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { HttpServer } from "../http/server.js";
import { TcpServer } from "../listener/tcp-server.js";
import { Logger } from "../logger.js";
import { exportStatus } from "./export-status.js";
import { TxtExporter } from "./txt-exporter.js";

const API_TOKEN = "test-token-export";

function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

function value(v: number, unit = ""): HemogramValue {
  return { value: v, unit, refRange: null, flags: ["N"] };
}

function hemogram(
  id: string,
  sampleId: string,
  values: Partial<Record<HemogramParam, HemogramValue>>,
): HemogramResult {
  return {
    id,
    receivedAt: new Date("2026-08-12T12:00:00Z"),
    messageControlId: `mc_${id}`,
    patient: { patientId: null, name: null, birthDate: null, sex: null, ageYears: null },
    sample: {
      sampleId,
      takeMode: null,
      bloodMode: null,
      testMode: null,
      drawnAt: null,
      analyzedAt: null,
      operator: null,
      refGroup: null,
      comments: null,
    },
    values,
    histograms: [],
    morphologyFlags: [],
  };
}

const created: string[] = [];

function tmpDirPath(): string {
  const d = mkdtempSync(join(tmpdir(), "xs20-export-api-"));
  created.push(d);
  return d;
}

interface Harness {
  baseUrl: string;
  config: ResolvedConfig;
  repo: XsRepo;
  logger: Logger;
  stop: () => void;
}

const running: Harness[] = [];

function start(exportDir: string, results: HemogramResult[] = []): Harness {
  const port = 25000 + Math.floor(Math.random() * 2000);
  const db = openDb({ path: ":memory:" });
  const repo = new XsRepo(db);
  const logger = silentLogger();
  for (const h of results) {
    repo.insertResult({ hemogram: h, rawHl7: "MSH|...", senderAddress: null });
  }

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
    exportDir,
    updateCheckEnabled: false,
    skippedVersion: "",
    console: false,
    noListen: false,
    apiToken: API_TOKEN,
    settingsPath: join(tmpdir(), `xs20-export-api-settings-${port}.json`),
  };

  // El listener SI arranca: asi /api/health da "ok" cuando todo esta bien y
  // "degraded" solo por lo que estamos probando (la exportacion).
  const tcp = new TcpServer({ host: "127.0.0.1", port: port + 1, repo, logger });
  tcp.start();
  const http = new HttpServer({
    repo,
    logger,
    tcp,
    config,
    apiToken: API_TOKEN,
    port,
    startedAt: new Date(),
    version: "test",
  });
  http.start();

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    repo,
    logger,
    stop: () => {
      http.stop();
      tcp.stop();
    },
  };
  running.push(harness);
  return harness;
}

afterEach(() => {
  for (const h of running.splice(0)) h.stop();
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function post(h: Harness, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /api/health - estado de la exportacion", () => {
  test("con la exportacion apagada informa 'deshabilitada' y el servicio sigue ok", async () => {
    const h = start("");
    const body = (await (await fetch(`${h.baseUrl}/api/health`)).json()) as HealthResponse;
    expect(body.export?.enabled).toBe(false);
    expect(body.export?.healthy).toBe(true);
    expect(body.status).toBe("ok");
  });

  test("un fallo de escritura se ve en /api/health y degrada el servicio", async () => {
    // Este es el bug que motivo todo: antes el fallo solo iba al log y la app
    // seguia diciendo que todo estaba bien mientras no aparecia ningun .txt.
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const h = start(notADir);

    const exporter = new TxtExporter({
      getDir: () => notADir,
      logger: h.logger,
      status: exportStatus,
      probeOnStart: false,
    });
    exporter.export(hemogram("r1", "000015", { wbc: value(7.3, "10*9/L") }));

    const body = (await (await fetch(`${h.baseUrl}/api/health`)).json()) as HealthResponse;
    expect(body.export?.healthy).toBe(false);
    expect(body.export?.lastError).toBeTruthy();
    expect(body.export?.lastErrorSampleId).toBe("000015");
    expect(body.export?.consecutiveFailures).toBe(1);
    expect(body.status).toBe("degraded");
  });
});

describe("POST /api/export/rerun", () => {
  test("sin token no deja regenerar nada", async () => {
    const h = start(tmpDirPath());
    const res = await fetch(`${h.baseUrl}/api/export/rerun`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("regenera los .txt de los resultados guardados", async () => {
    const dir = tmpDirPath();
    const h = start(dir, [
      hemogram("r1", "000015", { wbc: value(7.3, "10*9/L"), hgb: value(89, "g/L") }),
      hemogram("r2", "000016", { wbc: value(5.1, "10*9/L") }),
    ]);

    const res = await post(h, "/api/export/rerun");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportRerunResponse;
    expect(body).toMatchObject({ attempted: 2, written: 2, failed: 0, notFound: [] });
    expect(readdirSync(dir).sort()).toEqual(["000015.txt", "000016.txt"]);
    expect(readFileSync(join(dir, "000015.txt"), "utf-8")).toContain("HEMOGLOBINA: 8.9\r\n");
  });

  test("acepta ids puntuales", async () => {
    const dir = tmpDirPath();
    const h = start(dir, [
      hemogram("r1", "000015", { wbc: value(7.3, "") }),
      hemogram("r2", "000016", { wbc: value(5.1, "") }),
    ]);

    const body = (await (await post(h, "/api/export/rerun", { ids: ["r2"] })).json()) as
      ExportRerunResponse;
    expect(body.written).toBe(1);
    expect(readdirSync(dir)).toEqual(["000016.txt"]);
  });

  test("con la exportacion deshabilitada responde 409 y lo explica", async () => {
    const h = start("");
    const res = await post(h, "/api/export/rerun");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("EXPORT_DISABLED");
  });

  test("carpeta inaccesible: 409 con el motivo, no 200 con 200 errores", async () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const h = start(notADir, [hemogram("r1", "000015", { wbc: value(7.3, "") })]);

    const res = await post(h, "/api/export/rerun");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("EXPORT_DIR_UNAVAILABLE");
    expect(body.error.message).toContain(notADir);
  });

  test("un limite invalido se rechaza con 400", async () => {
    const h = start(tmpDirPath());
    const res = await post(h, "/api/export/rerun", { limit: 0 });
    expect(res.status).toBe(400);
  });

  test("un cuerpo que no es JSON se rechaza con 400", async () => {
    const h = start(tmpDirPath());
    const res = await fetch(`${h.baseUrl}/api/export/rerun`, {
      method: "POST",
      headers: { "X-XS20-Token": API_TOKEN },
      body: "{ esto no es json",
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/config - carpeta de exportacion", () => {
  test("al cambiar la carpeta se chequea al instante y se refleja en health", async () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const h = start("");

    const res = await fetch(`${h.baseUrl}/api/config`, {
      method: "PUT",
      headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ exportDir: notADir }),
    });
    expect(res.status).toBe(200);

    const health = (await (await fetch(`${h.baseUrl}/api/health`)).json()) as HealthResponse;
    expect(health.export?.dir).toBe(notADir);
    expect(health.export?.dirOk).toBe(false);
    expect(health.export?.dirError).toBeTruthy();
    expect(health.status).toBe("degraded");
  });

  test("una carpeta buena queda sana (y se crea si no existia)", async () => {
    const dir = join(tmpDirPath(), "exportes");
    const h = start("");

    await fetch(`${h.baseUrl}/api/config`, {
      method: "PUT",
      headers: { "X-XS20-Token": API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ exportDir: dir }),
    });

    const health = (await (await fetch(`${h.baseUrl}/api/health`)).json()) as HealthResponse;
    expect(health.export?.dirOk).toBe(true);
    expect(health.export?.healthy).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
