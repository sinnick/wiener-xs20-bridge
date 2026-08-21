/**
 * Tests de la resolucion de configuracion.
 *
 * El foco esta en que ningun valor invalido pase en silencio: antes un
 * `--port=abc` producia NaN, ese NaN llegaba a Bun.listen y el error resultante
 * no decia nada del origen. Y un archivo de config corrupto se descartaba
 * entero sin avisar, dejando el servicio corriendo con valores que el usuario
 * nunca configuro.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "./config.js";

const created: string[] = [];
const envKeys = [
  "XS20_TCP_PORT",
  "XS20_HTTP_PORT",
  "XS20_ANALYZER_PORT",
  "XS20_LOG_RETENTION_DAYS",
];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xs20-config-"));
  created.push(d);
  return d;
}

/** Resuelve contra un dataDir descartable, sin tocar la config real de la PC. */
function resolveIn(dir: string, ...args: string[]) {
  return resolveConfig([`--data-dir=${dir}`, ...args]);
}

afterEach(() => {
  for (const d of created.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  for (const k of envKeys) delete process.env[k];
});

describe("resolveConfig - puertos invalidos", () => {
  test("--port=abc no produce NaN: se ignora y avisa", () => {
    const cfg = resolveIn(tmpDir(), "--port=abc");

    expect(Number.isNaN(cfg.tcpPort)).toBe(false);
    expect(cfg.tcpPort).toBe(5100);
    expect(cfg.warnings?.join(" ")).toContain("--port");
  });

  test("un puerto fuera de rango tampoco pasa", () => {
    const cfg = resolveIn(tmpDir(), "--http-port=99999");

    expect(cfg.httpPort).toBe(7700);
    expect(cfg.warnings?.join(" ")).toContain("--http-port");
  });

  test("XS20_TCP_PORT=abc se ignora y avisa", () => {
    process.env.XS20_TCP_PORT = "abc";
    const cfg = resolveIn(tmpDir());

    expect(Number.isNaN(cfg.tcpPort)).toBe(false);
    expect(cfg.tcpPort).toBe(5100);
    expect(cfg.warnings?.join(" ")).toContain("XS20_TCP_PORT");
  });

  test("un puerto valido si se aplica (no rompimos el camino feliz)", () => {
    process.env.XS20_HTTP_PORT = "7800";
    const cfg = resolveIn(tmpDir(), "--port=5200");

    expect(cfg.tcpPort).toBe(5200);
    expect(cfg.httpPort).toBe(7800);
    expect(cfg.warnings).toHaveLength(0);
  });

  test("un puerto no numerico metido a mano en el archivo de config cae al default", () => {
    const dir = tmpDir();
    const cfgPath = join(dir, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ tcpPort: "5100" }));

    const cfg = resolveIn(dir, `--config=${cfgPath}`);

    expect(cfg.tcpPort).toBe(5100);
    expect(cfg.warnings?.join(" ")).toContain("tcpPort");
  });
});

describe("resolveConfig - archivo de config ilegible", () => {
  test("JSON corrupto no se traga en silencio", () => {
    const dir = tmpDir();
    const cfgPath = join(dir, "cfg.json");
    writeFileSync(cfgPath, '{"tcpPort": 5200, ');

    const cfg = resolveIn(dir, `--config=${cfgPath}`);

    expect(cfg.tcpPort).toBe(5100); // no se aplico nada del archivo
    expect(cfg.warnings?.join(" ")).toContain(cfgPath);
  });

  test("un --config que no existe tambien avisa", () => {
    const dir = tmpDir();
    const cfg = resolveIn(dir, `--config=${join(dir, "no-existe.json")}`);
    expect(cfg.warnings?.join(" ")).toContain("no existe");
  });
});

describe("resolveConfig - conflicto de puertos", () => {
  test("tcpPort == httpPort avisa al arrancar, no recien al fallar el bind", () => {
    const cfg = resolveIn(tmpDir(), "--port=7700");

    expect(cfg.tcpPort).toBe(7700);
    expect(cfg.httpPort).toBe(7700);
    const w = cfg.warnings?.join(" ") ?? "";
    expect(w).toContain("mismo que el de la API");
  });

  test("puertos distintos no generan ningun aviso", () => {
    const cfg = resolveIn(tmpDir(), "--port=5100", "--http-port=7700");
    expect(cfg.warnings).toHaveLength(0);
  });
});

describe("resolveConfig - retencion de logs", () => {
  test("default 30 dias", () => {
    expect(resolveIn(tmpDir()).logRetentionDays).toBe(30);
  });

  test("XS20_LOG_RETENTION_DAYS la sobreescribe", () => {
    process.env.XS20_LOG_RETENTION_DAYS = "7";
    expect(resolveIn(tmpDir()).logRetentionDays).toBe(7);
  });

  test("0 es valido: significa no borrar nunca", () => {
    process.env.XS20_LOG_RETENTION_DAYS = "0";
    const cfg = resolveIn(tmpDir());
    expect(cfg.logRetentionDays).toBe(0);
    expect(cfg.warnings).toHaveLength(0);
  });

  test("un valor invalido se ignora y avisa", () => {
    process.env.XS20_LOG_RETENTION_DAYS = "-5";
    const cfg = resolveIn(tmpDir());
    expect(cfg.logRetentionDays).toBe(30);
    expect(cfg.warnings?.join(" ")).toContain("XS20_LOG_RETENTION_DAYS");
  });
});
