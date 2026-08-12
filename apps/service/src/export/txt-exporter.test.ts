import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HemogramParam, HemogramResult, HemogramValue } from "@xs20/shared";

import { Logger } from "../logger.js";
import { exportFileName, formatHemogramTxt, TxtExporter } from "./txt-exporter.js";

// Logger que no escribe a disco ni consola (buffer en memoria a /tmp efimero).
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

/** Hemograma con los valores exactos de la nota del laboratorio. */
function fullHemogram(overrides: Partial<Record<HemogramParam, HemogramValue>> = {}): HemogramResult {
  return {
    id: "r_test_1",
    receivedAt: new Date("2026-08-12T12:00:00Z"),
    messageControlId: "1001",
    patient: { patientId: null, name: null, birthDate: null, sex: null, ageYears: null },
    sample: {
      sampleId: "000015",
      takeMode: null,
      bloodMode: null,
      testMode: null,
      drawnAt: null,
      analyzedAt: null,
      operator: null,
      refGroup: null,
      comments: null,
    },
    values: {
      wbc: value(7.3, "10*9/L"),
      lym_abs: value(1.7, "10*9/L"),
      lym_pct: value(22.8, "%"),
      mid_abs: value(0.7, "10*9/L"),
      mid_pct: value(9.1, "%"),
      gran_abs: value(4.9, "10*9/L"),
      gran_pct: value(68.1, "%"),
      rbc: value(3.24, "10*12/L"),
      hgb: value(89, "g/L"),
      hct: value(28.4, "%"),
      mcv: value(87.5, "fL"),
      mch: value(27.5, "pg"),
      mchc: value(314, "g/L"),
      rdw_cv: value(13.3, "%"),
      rdw_sd: value(41.5, "fL"),
      plt: value(110, "10*9/L"),
      mpv: value(10.7, "fL"),
      pdw: value(16.6, ""),
      pct: value(0.117, "%"),
      ...overrides,
    },
    histograms: [],
    morphologyFlags: [],
  };
}

describe("formatHemogramTxt", () => {
  test("reproduce la nota del laboratorio: titulos, orden, decimales y CRLF", () => {
    expect(formatHemogramTxt(fullHemogram())).toBe(
      "LEUCOCITOS: 7.3\r\n" +
        "LINFOCITOS#: 1.7\r\n" +
        "MEDIOS#: 0.7\r\n" +
        "MEDIOS%: 9.1\r\n" +
        "GRANULOCITOS#: 4.9\r\n" +
        "GRANULOCITOS%: 68.1\r\n" +
        "ERITROCITOS: 3.24\r\n" +
        "HEMOGLOBINA: 8.9\r\n" +
        "HEMATOCRITO: 28.4\r\n" +
        "VCM: 87.5\r\n" +
        "CHCM: 31.4\r\n" +
        "RDW-CV: 13.3\r\n" +
        "RDW-SD: 41.5\r\n" +
        "PLAQUETAS: 110\r\n" +
        "VPM: 10.7\r\n" +
        "PDW: 16.6\r\n" +
        "PLAQUETOCRITO: 0.117\r\n",
    );
  });

  test("hemoglobina y CHCM en g/dL se escriben tal cual, sin dividir", () => {
    const txt = formatHemogramTxt(
      fullHemogram({ hgb: value(8.9, "g/dL"), mchc: value(31.4, "g/dL") }),
    );
    expect(txt).toContain("HEMOGLOBINA: 8.9\r\n");
    expect(txt).toContain("CHCM: 31.4\r\n");
  });

  test("un parametro ausente omite la linea, el resto sigue en orden", () => {
    const h = fullHemogram();
    delete h.values.plt;
    const txt = formatHemogramTxt(h);
    expect(txt).not.toContain("PLAQUETAS");
    expect(txt).toContain("PDW: 16.6\r\n");
    expect(txt.split("\r\n")).toHaveLength(17); // 16 lineas + "" final
  });

  test("valores enteros conservan los decimales del formato (7.0, no 7)", () => {
    const txt = formatHemogramTxt(fullHemogram({ wbc: value(7, "10*9/L") }));
    expect(txt).toContain("LEUCOCITOS: 7.0\r\n");
  });
});

describe("exportFileName", () => {
  test("id numerico queda igual", () => {
    expect(exportFileName("000015")).toBe("000015.txt");
  });

  test("caracteres peligrosos se reemplazan por _", () => {
    expect(exportFileName("S/2026:04*27?")).toBe("S_2026_04_27_.txt");
  });

  test("id vacio no genera '.txt' pelado", () => {
    expect(exportFileName("")).toBe("sin_id.txt");
  });
});

describe("TxtExporter", () => {
  const created: string[] = [];

  function tmpDirPath(): string {
    const d = mkdtempSync(join(tmpdir(), "xs20-export-"));
    created.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of created.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("escribe <muestra>.txt y crea la carpeta si no existe", () => {
    const dir = join(tmpDirPath(), "sub", "exportes");
    const exporter = new TxtExporter({ getDir: () => dir, logger: silentLogger() });
    exporter.export(fullHemogram());
    const content = readFileSync(join(dir, "000015.txt"), "utf-8");
    expect(content).toContain("LEUCOCITOS: 7.3\r\n");
  });

  test("carpeta vacia = deshabilitado, no escribe nada", () => {
    const dir = tmpDirPath();
    const exporter = new TxtExporter({ getDir: () => "", logger: silentLogger() });
    exporter.export(fullHemogram());
    expect(existsSync(join(dir, "000015.txt"))).toBe(false);
  });

  test("re-corrida de la misma muestra pisa el archivo con lo ultimo", () => {
    const dir = tmpDirPath();
    const exporter = new TxtExporter({ getDir: () => dir, logger: silentLogger() });
    exporter.export(fullHemogram());
    exporter.export(fullHemogram({ wbc: value(9.9, "10*9/L") }));
    expect(readFileSync(join(dir, "000015.txt"), "utf-8")).toContain("LEUCOCITOS: 9.9\r\n");
  });

  test("un destino roto no lanza (el ACK no puede depender del disco)", () => {
    // Un archivo comun como "directorio" destino fuerza el error de escritura.
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const exporter = new TxtExporter({ getDir: () => notADir, logger: silentLogger() });
    expect(() => exporter.export(fullHemogram())).not.toThrow();
  });
});
