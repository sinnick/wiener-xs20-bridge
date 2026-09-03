/**
 * Tests del endpoint destructivo: POST /api/maintenance/wipe-database.
 *
 * Viven aca y no en http/server.test.ts para no pisarnos con el resto del
 * trabajo sobre ese archivo, siguiendo el mismo criterio que
 * export/export-api.test.ts.
 *
 * Lo que se prueba no es solo el status que devuelve: en cada caso que tiene que
 * fallar se verifica ADEMAS que la base quedo intacta. Un 400 que igual borro
 * todo seria el peor bug posible de esta funcionalidad.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HealthResponse, WipeDatabaseResponse } from "@xs20/shared";
import { WIPE_CONFIRMATION } from "@xs20/shared";

import type { ResolvedConfig } from "../config.js";
import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { HttpServer } from "./server.js";
import { TcpServer } from "../listener/tcp-server.js";
import { Logger } from "../logger.js";
import { mapMessageToHemogram } from "../hl7/obx-mapper.js";
import { parseHl7 } from "../hl7/parser.js";
import { ORU_ANORMAL, ORU_NORMAL } from "../../../../scripts/fixtures/messages.js";

const API_TOKEN = "test-token-maintenance";

function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

interface Harness {
  baseUrl: string;
  repo: XsRepo;
  db: ReturnType<typeof openDb>;
  stop: () => void;
}

const running: Harness[] = [];

/** Levanta el server con dos resultados ya cargados. */
function start(): Harness {
  const port = 27000 + Math.floor(Math.random() * 2000);
  const db = openDb({ path: ":memory:" });
  const repo = new XsRepo(db);
  const logger = silentLogger();

  for (const [i, raw] of [ORU_NORMAL, ORU_ANORMAL].entries()) {
    const { hemogram } = mapMessageToHemogram(parseHl7(raw), {
      id: `seed-${i}`,
      receivedAt: new Date("2026-04-27T15:32:11Z"),
    });
    repo.insertResult({ hemogram, rawHl7: raw, senderAddress: null });
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
    exportDir: "",
    updateCheckEnabled: false,
    skippedVersion: "",
    console: false,
    noListen: false,
    apiToken: API_TOKEN,
    settingsPath: join(tmpdir(), `xs20-maintenance-settings-${port}.json`),
  };

  const tcp = new TcpServer({ host: "127.0.0.1", port: port + 1, repo, logger });
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
    repo,
    db,
    stop: () => http.stop(),
  };
  running.push(harness);
  return harness;
}

afterEach(() => {
  for (const h of running.splice(0)) h.stop();
});

const RUTA = "/api/maintenance/wipe-database";

function post(h: Harness, body?: unknown, token: string | null = API_TOKEN): Promise<Response> {
  return fetch(`${h.baseUrl}${RUTA}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { "X-XS20-Token": token }),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

describe("POST /api/maintenance/wipe-database", () => {
  test("sin token: 401 y la base sigue entera", async () => {
    const h = start();
    const res = await post(h, { confirm: WIPE_CONFIRMATION }, null);
    expect(res.status).toBe(401);
    expect(h.repo.countResults()).toBe(2);
  });

  test("sin 'confirm': 400 y la base sigue entera", async () => {
    const h = start();
    const res = await post(h, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain(WIPE_CONFIRMATION);
    expect(h.repo.countResults()).toBe(2);
  });

  test("'confirm' equivocado: 400 y la base sigue entera", async () => {
    const h = start();
    const res = await post(h, { confirm: "borrar la base" });
    expect(res.status).toBe(400);
    expect(h.repo.countResults()).toBe(2);
  });

  test("cuerpo que no es JSON: 400 y la base sigue entera", async () => {
    const h = start();
    const res = await post(h, "esto no es json");
    expect(res.status).toBe(400);
    expect(h.repo.countResults()).toBe(2);
  });

  test("con la palabra correcta: borra y devuelve los contadores", async () => {
    const h = start();
    const res = await post(h, { confirm: WIPE_CONFIRMATION });
    expect(res.status).toBe(200);

    const body = (await res.json()) as WipeDatabaseResponse;
    expect(body.deletedResults).toBe(2);
    expect(body.deletedRawMessages).toBe(2);
    expect(body.vacuumed).toBe(true);
    expect(h.repo.countResults()).toBe(0);
  });

  test("GET a la misma ruta: 404 (no se dispara desde una barra de direcciones)", async () => {
    const h = start();
    const res = await fetch(`${h.baseUrl}${RUTA}`, {
      headers: { "X-XS20-Token": API_TOKEN },
    });
    expect(res.status).toBe(404);
    expect(h.repo.countResults()).toBe(2);
  });

  test("el preflight permite POST (por eso la ruta no es DELETE)", async () => {
    const h = start();
    const res = await fetch(`${h.baseUrl}${RUTA}`, { method: "OPTIONS" });
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("despues del borrado /api/health informa cero resultados", async () => {
    const h = start();
    await post(h, { confirm: WIPE_CONFIRMATION });

    const health = (await (await fetch(`${h.baseUrl}/api/health`)).json()) as HealthResponse;
    expect(health.database.resultCount).toBe(0);
  });

  test("queda el rastro en audit_log", async () => {
    const h = start();
    await post(h, { confirm: WIPE_CONFIRMATION });

    const filas = h.db
      .prepare(`SELECT event_type, level FROM audit_log WHERE event_type = 'db.wiped'`)
      .all() as { event_type: string; level: string }[];
    expect(filas.length).toBe(1);
    expect(filas[0]!.level).toBe("warn");
  });
});
