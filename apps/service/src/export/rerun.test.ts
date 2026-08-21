import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HemogramParam, HemogramResult, HemogramValue } from "@xs20/shared";

import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { ExportStatusTracker } from "./export-status.js";
import { rerunExports } from "./rerun.js";

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
  receivedAt = new Date("2026-08-12T12:00:00Z"),
): HemogramResult {
  return {
    id,
    receivedAt,
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
  const d = mkdtempSync(join(tmpdir(), "xs20-rerun-"));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(...results: HemogramResult[]): XsRepo {
  const repo = new XsRepo(openDb({ path: ":memory:" }));
  for (const h of results) {
    repo.insertResult({ hemogram: h, rawHl7: "MSH|...", senderAddress: null });
  }
  return repo;
}

describe("rerunExports", () => {
  test("regenera los .txt de lo que ya estaba guardado en la base", () => {
    const repo = repoWith(
      hemogram("r1", "000015", { wbc: value(7.3, "10*9/L") }),
      hemogram("r2", "000016", { wbc: value(5.1, "10*9/L") }),
    );
    const dir = tmpDirPath();

    const res = rerunExports({ repo, logger: silentLogger(), dir });

    expect(res.dirError).toBeNull();
    expect(res.attempted).toBe(2);
    expect(res.written).toBe(2);
    expect(res.failed).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["000015.txt", "000016.txt"]);
    expect(readFileSync(join(dir, "000015.txt"), "utf-8")).toContain("LEUCOCITOS: 7.3\r\n");
  });

  test("el archivo regenerado es identico al que se hubiera escrito en vivo", () => {
    // Incluye la conversion g/L → g/dL: si se perdiera al regenerar, el .txt
    // diria 142 de hemoglobina en lugar de 14.2.
    const repo = repoWith(
      hemogram("r1", "000015", {
        wbc: value(6.2, "10*9/L"),
        hgb: value(142, "g/L"),
        mchc: value(333, "g/L"),
        plt: value(245, "10*9/L"),
      }),
    );
    const dir = tmpDirPath();

    rerunExports({ repo, logger: silentLogger(), dir });

    const txt = readFileSync(join(dir, "000015.txt"), "utf-8");
    expect(txt).toContain("HEMOGLOBINA: 14.2\r\n");
    expect(txt).toContain("CHCM: 33.3\r\n");
    expect(txt).toContain("PLAQUETAS: 245\r\n");
    // Los que no vinieron salen igual, vacios.
    expect(txt).toContain("VCM: \r\n");
    expect(txt.split("\r\n")).toHaveLength(20); // 19 lineas + ""
  });

  test("acepta ids puntuales y reporta los que no existen", () => {
    const repo = repoWith(hemogram("r1", "000015", { wbc: value(7.3, "10*9/L") }));
    const dir = tmpDirPath();

    const res = rerunExports({
      repo,
      logger: silentLogger(),
      dir,
      ids: ["r1", "no-existe"],
    });

    expect(res.written).toBe(1);
    expect(res.notFound).toEqual(["no-existe"]);
    expect(existsSync(join(dir, "000015.txt"))).toBe(true);
  });

  test("respeta el limite pedido (los mas nuevos primero)", () => {
    const repo = repoWith(
      hemogram("r1", "000015", { wbc: value(1, "") }, new Date("2026-08-10T10:00:00Z")),
      hemogram("r2", "000016", { wbc: value(2, "") }, new Date("2026-08-11T10:00:00Z")),
      hemogram("r3", "000017", { wbc: value(3, "") }, new Date("2026-08-12T10:00:00Z")),
    );
    const dir = tmpDirPath();

    const res = rerunExports({ repo, logger: silentLogger(), dir, limit: 2 });

    expect(res.written).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["000016.txt", "000017.txt"]);
  });

  test("filtra por rango de fechas (el caso 'la carpeta estuvo mal una semana')", () => {
    const repo = repoWith(
      hemogram("r1", "000015", { wbc: value(1, "") }, new Date("2026-08-01T10:00:00Z")),
      hemogram("r2", "000016", { wbc: value(2, "") }, new Date("2026-08-11T10:00:00Z")),
    );
    const dir = tmpDirPath();

    const res = rerunExports({
      repo,
      logger: silentLogger(),
      dir,
      fromDate: "2026-08-05T00:00:00.000Z",
    });

    expect(res.written).toBe(1);
    expect(readdirSync(dir)).toEqual(["000016.txt"]);
  });

  test("carpeta inaccesible: corta antes de empezar y explica por que", () => {
    const repo = repoWith(hemogram("r1", "000015", { wbc: value(7.3, "") }));
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");

    const res = rerunExports({ repo, logger: silentLogger(), dir: notADir });

    expect(res.dirError).toBeTruthy();
    expect(res.attempted).toBe(0);
    expect(res.written).toBe(0);
  });

  test("exportacion deshabilitada: no inventa una carpeta", () => {
    const repo = repoWith(hemogram("r1", "000015", { wbc: value(7.3, "") }));
    const res = rerunExports({ repo, logger: silentLogger(), dir: "" });
    expect(res.dirError).toContain("deshabilitada");
    expect(res.attempted).toBe(0);
  });

  test("una regeneracion exitosa deja el estado de exportacion sano", () => {
    const repo = repoWith(hemogram("r1", "000015", { wbc: value(7.3, "") }));
    const dir = tmpDirPath();
    const status = new ExportStatusTracker();
    status.recordFailure(dir, "000009", "ENOENT: no such file or directory");
    expect(status.snapshot(dir).healthy).toBe(false);

    rerunExports({ repo, logger: silentLogger(), dir, status });

    expect(status.snapshot(dir).healthy).toBe(true);
  });
});
