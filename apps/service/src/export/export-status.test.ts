import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../logger.js";
import { ExportStatusTracker, probeAndRecord, probeExportDir } from "./export-status.js";

function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

const created: string[] = [];

function tmpDirPath(): string {
  const d = mkdtempSync(join(tmpdir(), "xs20-status-"));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // el rm de abajo es lo que importa
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("probeExportDir", () => {
  test("carpeta vacia (exportacion apagada) no es un error", () => {
    expect(probeExportDir("")).toEqual({ ok: true });
  });

  test("crea la carpeta si falta y no deja el archivo de prueba", () => {
    const dir = join(tmpDirPath(), "exportes");
    expect(probeExportDir(dir)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("una ruta que no es carpeta se detecta antes de que llegue una muestra", () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const res = probeExportDir(notADir);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });

  test("una carpeta de solo lectura se detecta como no escribible", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = tmpDirPath();
    chmodSync(dir, 0o500);
    expect(probeExportDir(dir).ok).toBe(false);
  });
});

describe("ExportStatusTracker", () => {
  test("recien arrancado, sin exportaciones, esta sano", () => {
    const t = new ExportStatusTracker();
    const snap = t.snapshot("/tmp/exportes");
    expect(snap.healthy).toBe(true);
    expect(snap.enabled).toBe(true);
    expect(snap.lastWriteAt).toBeNull();
    expect(snap.consecutiveFailures).toBe(0);
  });

  test("un chequeo fallido lo deja enfermo hasta que la carpeta vuelva", () => {
    const t = new ExportStatusTracker();
    t.recordProbe("/x", { ok: false, error: "ENOENT" });
    expect(t.snapshot("/x").healthy).toBe(false);
    expect(t.snapshot("/x").dirError).toBe("ENOENT");

    t.recordProbe("/x", { ok: true });
    expect(t.snapshot("/x").healthy).toBe(true);
  });

  test("cuenta escrituras y fallos desde el arranque", () => {
    const t = new ExportStatusTracker();
    t.recordSuccess("/x", "/x/1.txt");
    t.recordFailure("/x", "000016", "ENOSPC: no space left on device");
    t.recordFailure("/x", "000017", "ENOSPC: no space left on device");

    const snap = t.snapshot("/x");
    expect(snap.writtenSinceStart).toBe(1);
    expect(snap.failedSinceStart).toBe(2);
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.lastError).toContain("ENOSPC");
    expect(snap.lastErrorSampleId).toBe("000017");
    expect(snap.healthy).toBe(false);
  });

  test("cambiar de carpeta no arrastra los fallos de la anterior", () => {
    // Si el contador siguiera corriendo, la app quedaria en rojo despues de que
    // la operadora corrigio el destino.
    const t = new ExportStatusTracker();
    t.recordFailure("/vieja", "000015", "ENOENT");
    t.recordFailure("/vieja", "000016", "ENOENT");

    t.recordFailure("/nueva", "000017", "ENOSPC");
    expect(t.snapshot("/nueva").consecutiveFailures).toBe(1);

    t.recordSuccess("/nueva", "/nueva/000018.txt");
    expect(t.snapshot("/nueva").healthy).toBe(true);
    expect(t.snapshot("/nueva").failedSinceStart).toBe(3);
  });

  test("la exportacion deshabilitada cuenta como sana", () => {
    const t = new ExportStatusTracker();
    t.recordFailure("/x", "000015", "ENOENT");
    const snap = t.snapshot("");
    expect(snap.enabled).toBe(false);
    expect(snap.healthy).toBe(true);
  });
});

describe("probeAndRecord", () => {
  test("deja el resultado del chequeo en el tracker", () => {
    const t = new ExportStatusTracker();
    const dir = join(tmpDirPath(), "exportes");

    expect(probeAndRecord(dir, silentLogger(), t)).toEqual({ ok: true });
    expect(t.snapshot(dir).dirOk).toBe(true);

    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    expect(probeAndRecord(notADir, silentLogger(), t).ok).toBe(false);
    expect(t.snapshot(notADir).healthy).toBe(false);
  });
});
