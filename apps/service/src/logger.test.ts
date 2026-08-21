/**
 * Tests de la retencion de logs.
 *
 * El archivo rota por dia desde siempre, pero nadie borraba los viejos: una PC
 * encendida 24/7 con logLevel=debug llenaba el disco de a poco hasta que el
 * servicio no podia ni escribir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "./logger.js";

const created: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xs20-logs-"));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** Nombre de log del dia `daysAgo` dias atras. */
function logNameDaysAgo(daysAgo: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  return `service-${date}.log`;
}

describe("Logger - retencion de archivos", () => {
  test("borra los logs mas viejos que la retencion y conserva los de adentro", () => {
    const dir = tmpDir();
    const viejo = logNameDaysAgo(45);
    const limite = logNameDaysAgo(10);
    for (const f of [viejo, limite]) writeFileSync(join(dir, f), "{}\n");

    const logger = new Logger({ logDir: dir, level: "error", console: false, retentionDays: 30 });

    expect(existsSync(join(dir, viejo))).toBe(false);
    expect(existsSync(join(dir, limite))).toBe(true);
    // El del dia en curso lo crea el propio logger y nunca se borra.
    logger.error("hola");
    expect(existsSync(join(dir, logNameDaysAgo(0)))).toBe(true);
  });

  test("retentionDays = 0 desactiva la purga (no borra nada)", () => {
    const dir = tmpDir();
    const viejo = logNameDaysAgo(400);
    writeFileSync(join(dir, viejo), "{}\n");

    new Logger({ logDir: dir, level: "error", console: false, retentionDays: 0 });

    expect(existsSync(join(dir, viejo))).toBe(true);
  });

  test("NO toca archivos que no sean nuestros logs del dia", () => {
    const dir = tmpDir();
    // logDir es una carpeta del usuario: la purga tiene que ser quirurgica.
    const ajenos = [
      "notas.txt",
      "service.log",
      "service-2020-01-01.log.bak",
      "service-viejo.log",
      "otra-cosa-2020-01-01.log",
    ];
    for (const f of ajenos) writeFileSync(join(dir, f), "contenido");

    new Logger({ logDir: dir, level: "error", console: false, retentionDays: 1 });

    for (const f of ajenos) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  test("purgeOldLogs es explicito sobre cuantos borro", () => {
    const dir = tmpDir();
    for (const d of [100, 90, 80]) writeFileSync(join(dir, logNameDaysAgo(d)), "{}\n");
    // Con retencion larga no borra nada en el constructor.
    const logger = new Logger({ logDir: dir, level: "error", console: false, retentionDays: 365 });
    expect(readdirSync(dir).filter((f) => f.startsWith("service-"))).toHaveLength(3);

    // Adelantamos el reloj dos años: ahi los tres quedan fuera de la ventana.
    const dentroDeDosAños = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000);
    expect(logger.purgeOldLogs(dentroDeDosAños)).toBe(3);
  });

  test("el default es 30 dias (no infinito)", () => {
    const dir = tmpDir();
    const viejo = logNameDaysAgo(60);
    writeFileSync(join(dir, viejo), "{}\n");

    new Logger({ logDir: dir, level: "error", console: false });

    expect(existsSync(join(dir, viejo))).toBe(false);
  });
});
