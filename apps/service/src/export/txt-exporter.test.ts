import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HEMOGRAM_PARAMS } from "@xs20/shared";
import type { HemogramParam, HemogramResult, HemogramValue } from "@xs20/shared";

import { Logger } from "../logger.js";
import { ExportStatusTracker, exportStatus } from "./export-status.js";
import {
  EXPORT_FORMAT,
  EXPORT_ORDER,
  exportFileName,
  formatHemogramTxt,
  missingFromExportOrder,
  TxtExporter,
  unexpectedUnits,
  writeFileAtomic,
} from "./txt-exporter.js";

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

/**
 * Hemograma con los valores de la nota del laboratorio (el .txt real que mandaron
 * de muestra). Los datos del paciente van vacios a proposito: el archivo original
 * es un resultado real y no se versiona.
 */
function fullHemogram(
  overrides: Partial<Record<HemogramParam, HemogramValue>> = {},
): HemogramResult {
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

/** El hemograma del golden file: valores inventados, prolijos, todos presentes. */
function goldenHemogram(): HemogramResult {
  return {
    ...fullHemogram(),
    sample: { ...fullHemogram().sample, sampleId: "000123" },
    values: {
      wbc: value(6.2, "10*9/L"),
      lym_abs: value(2.1, "10*9/L"),
      lym_pct: value(33.9, "%"),
      mid_abs: value(0.5, "10*9/L"),
      mid_pct: value(8.1, "%"),
      gran_abs: value(3.6, "10*9/L"),
      gran_pct: value(58, "%"),
      rbc: value(4.85, "10*12/L"),
      hgb: value(142, "g/L"),
      hct: value(42.6, "%"),
      mcv: value(87.8, "fL"),
      mch: value(29.3, "pg"),
      mchc: value(333, "g/L"),
      rdw_cv: value(12.9, "%"),
      rdw_sd: value(40.2, "fL"),
      plt: value(245, "10*9/L"),
      mpv: value(9.4, "fL"),
      pdw: value(15.8, ""),
      pct: value(0.23, "%"),
    },
  };
}

describe("EXPORT_ORDER / EXPORT_FORMAT", () => {
  test("cubre TODOS los parametros del contrato (nada se pierde por olvido)", () => {
    expect(missingFromExportOrder()).toEqual([]);
    expect(EXPORT_ORDER.length).toBe(HEMOGRAM_PARAMS.length);
  });

  test("no repite parametros", () => {
    expect(new Set(EXPORT_ORDER).size).toBe(EXPORT_ORDER.length);
  });

  test("los primeros 17 titulos son los de la nota, en su orden, mas LINFOCITOS%", () => {
    expect(EXPORT_ORDER.map((p) => EXPORT_FORMAT[p].title)).toEqual([
      "LEUCOCITOS",
      "LINFOCITOS#",
      "LINFOCITOS%",
      "MEDIOS#",
      "MEDIOS%",
      "GRANULOCITOS#",
      "GRANULOCITOS%",
      "ERITROCITOS",
      "HEMOGLOBINA",
      "HEMATOCRITO",
      "VCM",
      "CHCM",
      "RDW-CV",
      "RDW-SD",
      "PLAQUETAS",
      "VPM",
      "PDW",
      "PLAQUETOCRITO",
      "HCM",
    ]);
  });
});

describe("formatHemogramTxt", () => {
  test("golden file: un hemograma completo byte por byte", () => {
    const golden = readFileSync(
      join(import.meta.dir, "fixtures", "hemograma-completo.txt"),
      "utf-8",
    );
    expect(formatHemogramTxt(goldenHemogram())).toBe(golden);
  });

  test("el golden file esta guardado con CRLF (si no, el test de arriba no prueba nada)", () => {
    const bytes = readFileSync(join(import.meta.dir, "fixtures", "hemograma-completo.txt"));
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(true);
  });

  test("reproduce la muestra del laboratorio: titulos, orden, decimales y CRLF", () => {
    expect(formatHemogramTxt(fullHemogram())).toBe(
      "LEUCOCITOS: 7.3\r\n" +
        "LINFOCITOS#: 1.7\r\n" +
        "LINFOCITOS%: 22.8\r\n" +
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
        "PLAQUETOCRITO: 0.117\r\n" +
        "HCM: 27.5\r\n",
    );
  });

  test("los decimales son los de la muestra real del laboratorio", () => {
    const txt = formatHemogramTxt(fullHemogram());
    expect(txt).toContain("LEUCOCITOS: 7.3\r\n"); // 1 decimal
    expect(txt).toContain("ERITROCITOS: 3.24\r\n"); // 2 decimales
    expect(txt).toContain("PLAQUETAS: 110\r\n"); // sin decimales
    expect(txt).toContain("PLAQUETOCRITO: 0.117\r\n"); // 3 decimales
  });

  test("cada linea termina en CRLF, incluida la ultima, y no hay \\n suelto", () => {
    const txt = formatHemogramTxt(fullHemogram());
    expect(txt.endsWith("\r\n")).toBe(true);
    expect(txt.replace(/\r\n/g, "")).not.toContain("\n");
    // 19 lineas + el "" que queda despues del ultimo CRLF.
    expect(txt.split("\r\n")).toHaveLength(EXPORT_ORDER.length + 1);
  });

  // ── Parametros faltantes ──────────────────────────────────────────────────

  test("un parametro ausente igual escribe su linea, con el valor vacio", () => {
    const h = fullHemogram();
    delete h.values.mcv;
    const txt = formatHemogramTxt(h);
    expect(txt).toContain("VCM: \r\n");
    expect(txt).toContain("CHCM: 31.4\r\n");
  });

  test("todos los archivos tienen la misma cantidad de lineas, falte lo que falte", () => {
    const completo = formatHemogramTxt(fullHemogram()).split("\r\n").length;

    const sinPlaquetas = fullHemogram();
    delete sinPlaquetas.values.plt;
    delete sinPlaquetas.values.mpv;
    delete sinPlaquetas.values.pdw;
    delete sinPlaquetas.values.pct;

    const vacio: HemogramResult = { ...fullHemogram(), values: {} };

    expect(formatHemogramTxt(sinPlaquetas).split("\r\n").length).toBe(completo);
    expect(formatHemogramTxt(vacio).split("\r\n").length).toBe(completo);
  });

  test("un hemograma sin ningun valor escribe los titulos igual", () => {
    const txt = formatHemogramTxt({ ...fullHemogram(), values: {} });
    expect(txt.startsWith("LEUCOCITOS: \r\n")).toBe(true);
    expect(txt.endsWith("HCM: \r\n")).toBe(true);
  });

  test("un valor no numerico sale vacio, nunca como 'NaN'", () => {
    const txt = formatHemogramTxt(fullHemogram({ wbc: value(NaN, "10*9/L") }));
    expect(txt).toContain("LEUCOCITOS: \r\n");
    expect(txt).not.toContain("NaN");
  });

  test("valores enteros conservan los decimales del formato (7.0, no 7)", () => {
    const txt = formatHemogramTxt(fullHemogram({ wbc: value(7, "10*9/L") }));
    expect(txt).toContain("LEUCOCITOS: 7.0\r\n");
  });

  // ── Conversion de unidades (un 10x de mas es un dato clinico peligroso) ────

  test("hemoglobina y CHCM en g/L se dividen por 10", () => {
    const txt = formatHemogramTxt(
      fullHemogram({ hgb: value(145, "g/L"), mchc: value(330, "g/L") }),
    );
    expect(txt).toContain("HEMOGLOBINA: 14.5\r\n");
    expect(txt).toContain("CHCM: 33.0\r\n");
  });

  test("hemoglobina y CHCM en g/dL se escriben tal cual, sin dividir", () => {
    const txt = formatHemogramTxt(
      fullHemogram({ hgb: value(8.9, "g/dL"), mchc: value(31.4, "g/dL") }),
    );
    expect(txt).toContain("HEMOGLOBINA: 8.9\r\n");
    expect(txt).toContain("CHCM: 31.4\r\n");
  });

  test("la unidad se compara sin importar mayusculas ni espacios", () => {
    const txt = formatHemogramTxt(
      fullHemogram({ hgb: value(145, " G/L "), mchc: value(330, "g/l") }),
    );
    expect(txt).toContain("HEMOGLOBINA: 14.5\r\n");
    expect(txt).toContain("CHCM: 33.0\r\n");
  });

  test("la conversion es SOLO para hemoglobina y CHCM", () => {
    // Un g/L en otro parametro (no deberia pasar) no se toca.
    const txt = formatHemogramTxt(fullHemogram({ rbc: value(3.24, "g/L") }));
    expect(txt).toContain("ERITROCITOS: 3.24\r\n");
  });

  test("una unidad que no sabemos convertir se escribe tal cual y se reporta", () => {
    const h = fullHemogram({ hgb: value(5.5, "mmol/L") });
    expect(formatHemogramTxt(h)).toContain("HEMOGLOBINA: 5.5\r\n");
    expect(unexpectedUnits(h)).toEqual([{ param: "hgb", unit: "mmol/L" }]);
  });

  test("unidad vacia no se reporta como inesperada", () => {
    expect(unexpectedUnits(fullHemogram({ hgb: value(14.2, "") }))).toEqual([]);
  });
});

describe("exportFileName", () => {
  test("id numerico queda igual (es el caso real: 000015.txt)", () => {
    expect(exportFileName("000015")).toBe("000015.txt");
  });

  test("caracteres peligrosos se reemplazan por _", () => {
    expect(exportFileName("S/2026:04*27?")).toBe("S_2026_04_27_.txt");
  });

  test("escapes HL7 en el id no rompen el nombre", () => {
    expect(exportFileName("S\\T\\1")).toBe("S_T_1.txt");
  });

  test("id vacio o solo espacios no genera '.txt' pelado", () => {
    expect(exportFileName("")).toBe("sin_id.txt");
    expect(exportFileName("   ")).toBe("sin_id.txt");
  });

  test("un id de puntos no escribe fuera de la carpeta", () => {
    expect(exportFileName("..")).toBe("sin_id.txt");
    expect(exportFileName(".")).toBe("sin_id.txt");
    expect(exportFileName("../../etc/passwd")).toBe(".._.._etc_passwd.txt");
  });

  test("Windows recorta los puntos finales: los sacamos nosotros", () => {
    expect(exportFileName("15.")).toBe("15.txt");
  });

  test("nombres reservados de Windows (CON, NUL, COM1) se desarman", () => {
    expect(exportFileName("CON")).toBe("_CON.txt");
    expect(exportFileName("nul")).toBe("_nul.txt");
    expect(exportFileName("COM1")).toBe("_COM1.txt");
    // CONSULTA no es reservado: solo el nombre exacto.
    expect(exportFileName("CONSULTA")).toBe("CONSULTA.txt");
  });

  test("un id absurdamente largo se recorta", () => {
    expect(exportFileName("9".repeat(400))).toBe(`${"9".repeat(64)}.txt`);
  });
});

describe("TxtExporter", () => {
  const created: string[] = [];

  function tmpDirPath(): string {
    const d = mkdtempSync(join(tmpdir(), "xs20-export-"));
    created.push(d);
    return d;
  }

  function exporter(dir: string, status = new ExportStatusTracker()) {
    return {
      exporter: new TxtExporter({
        getDir: () => dir,
        logger: silentLogger(),
        status,
        probeOnStart: false,
      }),
      status,
    };
  }

  afterEach(() => {
    for (const d of created.splice(0)) {
      try {
        chmodSync(d, 0o700);
      } catch {
        // puede no existir o no ser un dir: lo importante es el rm de abajo
      }
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("escribe <muestra>.txt y crea la carpeta si no existe", () => {
    const dir = join(tmpDirPath(), "sub", "exportes");
    const { exporter: exp } = exporter(dir);
    const res = exp.export(fullHemogram());
    expect(res).toEqual({ ok: true, skipped: false, path: join(dir, "000015.txt") });
    expect(readFileSync(join(dir, "000015.txt"), "utf-8")).toBe(
      formatHemogramTxt(fullHemogram()),
    );
  });

  test("no deja archivos temporales tirados en la carpeta", () => {
    const dir = tmpDirPath();
    const { exporter: exp } = exporter(dir);
    exp.export(fullHemogram());
    expect(readdirSync(dir)).toEqual(["000015.txt"]);
  });

  test("carpeta vacia = deshabilitado, no escribe nada", () => {
    const dir = tmpDirPath();
    const { exporter: exp, status } = exporter("");
    expect(exp.export(fullHemogram())).toEqual({ ok: true, skipped: true });
    expect(existsSync(join(dir, "000015.txt"))).toBe(false);
    expect(status.snapshot("").healthy).toBe(true);
    expect(status.snapshot("").enabled).toBe(false);
  });

  test("re-corrida de la misma muestra pisa el archivo con lo ultimo", () => {
    const dir = tmpDirPath();
    const { exporter: exp } = exporter(dir);
    exp.export(fullHemogram());
    exp.export(fullHemogram({ wbc: value(9.9, "10*9/L") }));
    expect(readFileSync(join(dir, "000015.txt"), "utf-8")).toContain("LEUCOCITOS: 9.9\r\n");
    expect(readdirSync(dir)).toEqual(["000015.txt"]);
  });

  test("un destino roto no lanza, lo devuelve y lo deja registrado", () => {
    // Un archivo comun como "directorio" destino fuerza el error de escritura.
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const { exporter: exp, status } = exporter(notADir);

    // Si lanzara, el test falla aca mismo: el ACK al equipo no puede depender
    // de que el disco este bien.
    const res = exp.export(fullHemogram());
    expect(res.ok).toBe(false);
    const snap = status.snapshot(notADir);
    expect(snap.healthy).toBe(false);
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorSampleId).toBe("000015");
    expect(snap.lastError).toBeTruthy();
  });

  test("los fallos seguidos se cuentan y un exito los resetea", () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const status = new ExportStatusTracker();
    const roto = exporter(notADir, status).exporter;

    roto.export(fullHemogram());
    roto.export(fullHemogram());
    roto.export(fullHemogram());
    expect(status.snapshot(notADir).consecutiveFailures).toBe(3);
    expect(status.snapshot(notADir).failedSinceStart).toBe(3);

    // La operadora corrige la carpeta: el estado se recupera.
    const bueno = exporter(base, status).exporter;
    bueno.export(fullHemogram());
    const snap = status.snapshot(base);
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.healthy).toBe(true);
    expect(snap.writtenSinceStart).toBe(1);
    expect(snap.lastWritePath).toBe(join(base, "000015.txt"));
  });

  test("cambiar la carpeta destino no arrastra el error de la anterior", () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const status = new ExportStatusTracker();
    exporter(notADir, status).exporter.export(fullHemogram());

    // /api/health pregunta por la carpeta NUEVA, todavia sin chequear.
    expect(status.snapshot(join(base, "otra")).healthy).toBe(true);
    expect(status.snapshot(join(base, "otra")).lastError).toBeNull();
  });

  test("una carpeta sin permiso de escritura se detecta como fallo", () => {
    // En Windows chmod no aplica, y como root todo permiso se ignora.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = tmpDirPath();
    chmodSync(dir, 0o500); // r-x: no se puede crear el temporal
    const { exporter: exp, status } = exporter(dir);
    const res = exp.export(fullHemogram());
    expect(res.ok).toBe(false);
    expect(status.snapshot(dir).healthy).toBe(false);
    expect(existsSync(join(dir, "000015.txt"))).toBe(false);
  });

  test("el chequeo al construir el exporter ya marca una carpeta rota", () => {
    const base = tmpDirPath();
    const notADir = join(base, "ocupado");
    writeFileSync(notADir, "x");
    const status = new ExportStatusTracker();
    new TxtExporter({ getDir: () => notADir, logger: silentLogger(), status });
    const snap = status.snapshot(notADir);
    expect(snap.dirOk).toBe(false);
    expect(snap.healthy).toBe(false);
    expect(snap.dirError).toBeTruthy();
  });

  test("sin tracker inyectado reporta al global, que es el que lee /api/health", () => {
    // main.ts construye el exporter SIN pasarle status: si el default no fuera
    // el tracker global, /api/health mostraria "todo bien" para siempre.
    const base = tmpDirPath();
    const notADir = join(base, "ocupado-global");
    writeFileSync(notADir, "x");
    new TxtExporter({
      getDir: () => notADir,
      logger: silentLogger(),
      probeOnStart: false,
    }).export(fullHemogram());
    expect(exportStatus.snapshot(notADir).healthy).toBe(false);
  });

  test("el chequeo al construir crea la carpeta que falta y la deja limpia", () => {
    const dir = join(tmpDirPath(), "exportes-nuevos");
    const status = new ExportStatusTracker();
    new TxtExporter({ getDir: () => dir, logger: silentLogger(), status });
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(status.snapshot(dir).healthy).toBe(true);
  });
});

describe("writeFileAtomic", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpDirPath(): string {
    const d = mkdtempSync(join(tmpdir(), "xs20-atomic-"));
    created.push(d);
    return d;
  }

  test("escribe el contenido completo", () => {
    const dir = tmpDirPath();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "hola\r\nchau\r\n");
    expect(readFileSync(path, "utf-8")).toBe("hola\r\nchau\r\n");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("pisa el archivo existente sin dejar restos", () => {
    const dir = tmpDirPath();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "viejo\r\n");
    writeFileAtomic(path, "nuevo\r\n");
    expect(readFileSync(path, "utf-8")).toBe("nuevo\r\n");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("si no puede escribir, lanza y NO toca el archivo que ya estaba", () => {
    const dir = tmpDirPath();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "bueno\r\n");

    // Carpeta inexistente: el temporal ni se puede crear.
    expect(() => writeFileAtomic(join(dir, "no-existe", "a.txt"), "x")).toThrow();
    expect(readFileSync(path, "utf-8")).toBe("bueno\r\n");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });
});
