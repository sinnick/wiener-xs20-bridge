import { describe, expect, test } from "bun:test";
import { ORU_ANORMAL, ORU_NORMAL, buildOruWithHistograms } from "../../../../scripts/fixtures/messages.js";
import { mapMessageToHemogram } from "../hl7/obx-mapper.js";
import { parseHl7 } from "../hl7/parser.js";
import { openDb } from "./migrate.js";
import { InsertResultDuplicateError, XsRepo } from "./repo.js";

function makeRepo() {
  // Bun:sqlite acepta ":memory:" para una DB efimera.
  const db = openDb({ path: ":memory:" });
  return new XsRepo(db);
}

const T0 = new Date("2026-04-27T15:32:11Z");

describe("XsRepo - probeWritable", () => {
  test("una DB normal reporta que acepta escrituras", () => {
    const repo = makeRepo();
    expect(repo.probeWritable()).toEqual({ ok: true });
  });

  test("no deja transaccion abierta (se puede insertar despues)", () => {
    const repo = makeRepo();
    repo.probeWritable();
    repo.probeWritable();

    // Si el probe hubiera dejado un BEGIN colgado, este insert fallaria.
    const msg = parseHl7(ORU_NORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "probe_1", receivedAt: T0 });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: "127.0.0.1" });
    expect(repo.countResults()).toBe(1);
  });

  test("una DB de solo lectura se detecta como no escribible", () => {
    // Es el fallo que vimos en produccion: la DB abre bien y se puede leer, pero
    // cada escritura falla. El probe tiene que verlo sin necesidad de insertar.
    const db = openDb({ path: ":memory:" });
    const repo = new XsRepo(db);
    db.exec("PRAGMA query_only = ON");

    const res = repo.probeWritable();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });
});

describe("XsRepo - insertResult", () => {
  test("inserta un hemograma normal y lo recupera", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "test-1", receivedAt: T0 });

    const id = repo.insertResult({
      hemogram,
      rawHl7: ORU_NORMAL,
      senderAddress: "192.168.1.50:54321",
    });
    expect(id).toBe("test-1");

    const list = repo.listResults({});
    expect(list.length).toBe(1);
    expect(list[0]!.sampleId).toBe("S20260427-0001");
    expect(list[0]!.patientName).toBe("Perez, Juan");
    expect(list[0]!.abnormalCount).toBe(0);

    const fetched = repo.getResult(id)!;
    expect(fetched.values.wbc?.value).toBe(7.2);
    expect(fetched.values.hgb?.value).toBe(145);
    expect(fetched.patient.name).toBe("Perez, Juan");
    expect(fetched.histograms.length).toBe(0);
  });

  test("rechaza duplicado con InsertResultDuplicateError", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "test-1", receivedAt: T0 });

    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });

    // Intento de re-insertar con otro id pero mismo messageControlId
    const { hemogram: h2 } = mapMessageToHemogram(msg, { id: "test-2", receivedAt: T0 });
    expect(() =>
      repo.insertResult({ hemogram: h2, rawHl7: ORU_NORMAL, senderAddress: null }),
    ).toThrow(InsertResultDuplicateError);
  });

  // ── Regresion: el MSH-10 del XS 20 se reinicia en 1 en cada arranque ──────
  //
  // Deduplicar por MSH-10 hacia que los primeros N resultados de cada jornada
  // se descartaran en silencio (N = cuantos habia mandado la jornada anterior).
  // En el laboratorio se perdieron 25 hemogramas el 01/09 y 35 el 02/09 antes
  // de que el contador pasara la marca del dia anterior. Ver XsRepo.insertResult.

  /** Variante de ORU_NORMAL con otro MSH-10 / muestra / instante de analisis. */
  function oruVariante(opts: {
    controlId?: string;
    sampleId?: string;
    analyzedAt?: string;
  }): string {
    let hl7 = ORU_NORMAL;
    if (opts.controlId !== undefined) {
      hl7 = hl7.replace("|ORU^R01|1001|", `|ORU^R01|${opts.controlId}|`);
    }
    if (opts.sampleId !== undefined) {
      hl7 = hl7.replace("S20260427-0001", opts.sampleId);
    }
    if (opts.analyzedAt !== undefined) {
      hl7 = hl7.replace("|20260427153100|", `|${opts.analyzedAt}|`);
    }
    return hl7;
  }

  function insertar(repo: XsRepo, id: string, hl7: string): void {
    const { hemogram } = mapMessageToHemogram(parseHl7(hl7), { id, receivedAt: T0 });
    repo.insertResult({ hemogram, rawHl7: hl7, senderAddress: null });
  }

  test("mismo MSH-10 pero otra muestra: se guarda (el equipo reinicio el contador)", () => {
    const repo = makeRepo();
    insertar(repo, "dia1-1", oruVariante({ controlId: "1", sampleId: "perez" }));

    // Dia siguiente: el equipo arranca de cero y vuelve a numerar desde 1, pero
    // es un paciente distinto. Antes esto se descartaba y no salia el .txt.
    insertar(
      repo,
      "dia2-1",
      oruVariante({ controlId: "1", sampleId: "gomez", analyzedAt: "20260428101500" }),
    );

    expect(repo.countResults()).toBe(2);
    expect(repo.listResults({}).map((r) => r.sampleId).sort()).toEqual(["gomez", "perez"]);
  });

  test("mismo resultado con otro MSH-10: se deduplica (reenvio del historico)", () => {
    const repo = makeRepo();
    insertar(repo, "orig", oruVariante({ controlId: "7", sampleId: "perez" }));

    // "Enviar todo" desde el analizador reenvia lo ya guardado con numeracion
    // nueva. Es la forma en que el laboratorio recupera lo que se perdio, asi
    // que tiene que ser seguro correrlo las veces que haga falta.
    const { hemogram } = mapMessageToHemogram(
      parseHl7(oruVariante({ controlId: "312", sampleId: "perez" })),
      { id: "reenvio", receivedAt: new Date("2026-04-28T09:00:00Z") },
    );
    expect(() =>
      repo.insertResult({ hemogram, rawHl7: "", senderAddress: null }),
    ).toThrow(InsertResultDuplicateError);
    expect(repo.countResults()).toBe(1);
  });

  test("un MSH-10 repetido no rompe el UNIQUE y se lee sin el sufijo interno", () => {
    const repo = makeRepo();
    insertar(repo, "dia1-1", oruVariante({ controlId: "1", sampleId: "perez" }));
    insertar(
      repo,
      "dia2-1",
      oruVariante({ controlId: "1", sampleId: "gomez", analyzedAt: "20260428101500" }),
    );

    // La app muestra el MSH-10; tiene que ver el que mando el equipo, no el
    // valor con el que lo guardamos para esquivar el UNIQUE del schema v1.
    expect(repo.getResult("dia1-1")!.messageControlId).toBe("1");
    expect(repo.getResult("dia2-1")!.messageControlId).toBe("1");
  });

  test("una jornada entera despues de que el equipo reinicio no pierde nada", () => {
    const repo = makeRepo();
    // Jornada 1: el equipo numera 1, 2, 3.
    for (const [i, sample] of ["perez", "gomez", "lopez"].entries()) {
      insertar(repo, `d1-${i}`, oruVariante({ controlId: String(i + 1), sampleId: sample }));
    }
    // Jornada 2: arranca de nuevo en 1 con pacientes distintos.
    for (const [i, sample] of ["diaz", "sosa", "rios"].entries()) {
      insertar(
        repo,
        `d2-${i}`,
        oruVariante({
          controlId: String(i + 1),
          sampleId: sample,
          analyzedAt: `2026042810${String(i).padStart(2, "0")}00`,
        }),
      );
    }
    expect(repo.countResults()).toBe(6);
  });

  test("sin instante de analisis se inserta igual (mejor repetido que perdido)", () => {
    const repo = makeRepo();
    const sinFecha = ORU_NORMAL.replace("|20260427153100|", "||");
    insertar(repo, "sf-1", sinFecha);
    insertar(repo, "sf-2", sinFecha);
    expect(repo.countResults()).toBe(2);
  });

  test("anomalias: WBC=H, HGB=L cuentan como abnormal_count", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_ANORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "test-3", receivedAt: T0 });
    repo.insertResult({ hemogram, rawHl7: ORU_ANORMAL, senderAddress: null });

    const list = repo.listResults({});
    expect(list[0]!.abnormalCount).toBeGreaterThan(0);
    expect(list[0]!.morphologyFlagCount).toBe(5);
  });

  test("histogramas se guardan y se leen como Uint8Array de 256 bytes", () => {
    const repo = makeRepo();
    const raw = buildOruWithHistograms("4001");
    const msg = parseHl7(raw);
    const { hemogram } = mapMessageToHemogram(msg, { id: "test-4", receivedAt: T0 });

    repo.insertResult({ hemogram, rawHl7: raw, senderAddress: null });
    const fetched = repo.getResult("test-4")!;

    expect(fetched.histograms.length).toBe(3);
    for (const h of fetched.histograms) {
      expect(h.channels).toBeInstanceOf(Uint8Array);
      expect(h.channels.length).toBe(256);
    }
    const wbc = fetched.histograms.find((h) => h.type === "wbc")!;
    expect(wbc.discriminators.midLine).toBe(120);
  });

  test("paciente se deduplica por external_id", () => {
    const repo = makeRepo();

    // Insertamos dos resultados del mismo paciente
    const msg1 = parseHl7(ORU_NORMAL);
    const { hemogram: h1 } = mapMessageToHemogram(msg1, { id: "a", receivedAt: T0 });
    repo.insertResult({ hemogram: h1, rawHl7: ORU_NORMAL, senderAddress: null });

    // Mismo external_id pero distinto messageControlId.
    const otherRaw = ORU_NORMAL.replace("|1001|", "|1099|").replace("S20260427-0001", "S20260427-9999");
    const msg2 = parseHl7(otherRaw);
    const { hemogram: h2 } = mapMessageToHemogram(msg2, { id: "b", receivedAt: T0 });
    repo.insertResult({ hemogram: h2, rawHl7: otherRaw, senderAddress: null });

    const all = repo.listResults({});
    expect(all.length).toBe(2);
    expect(all.every((r) => r.patientId === "MR123456")).toBe(true);
  });

  test("listResults filtra por search en sample_id", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "s1", receivedAt: T0 });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });

    expect(repo.listResults({ search: "0001" }).length).toBe(1);
    expect(repo.listResults({ search: "9999" }).length).toBe(0);
  });

  test("countResults", () => {
    const repo = makeRepo();
    expect(repo.countResults()).toBe(0);

    const msg = parseHl7(ORU_NORMAL);
    const { hemogram } = mapMessageToHemogram(msg, { id: "c1", receivedAt: T0 });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });
    expect(repo.countResults()).toBe(1);
  });

  test("purgeOldRawMessages vacia el raw viejo pero conserva el resultado", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    // Recibido hace 100 dias.
    const old = new Date(T0.getTime() - 100 * 24 * 60 * 60 * 1000);
    const { hemogram } = mapMessageToHemogram(msg, { id: "old1", receivedAt: old });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });

    // Purga con retencion de 90 dias (referencia = T0).
    const purged = repo.purgeOldRawMessages(90, T0);
    expect(purged).toBe(1);

    // El resultado estructurado sigue estando.
    expect(repo.countResults()).toBe(1);
    // Pero el raw HL7 ya no.
    expect(repo.getResultRawHl7("old1")).toBe("");
  });

  test("purgeOldRawMessages NO toca mensajes dentro de la retencion", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    // Recibido hace 10 dias.
    const recent = new Date(T0.getTime() - 10 * 24 * 60 * 60 * 1000);
    const { hemogram } = mapMessageToHemogram(msg, { id: "recent1", receivedAt: recent });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });

    const purged = repo.purgeOldRawMessages(90, T0);
    expect(purged).toBe(0);
    expect(repo.getResultRawHl7("recent1")).toContain("MSH");
  });

  test("purgeOldRawMessages con retentionDays=0 no borra nada", () => {
    const repo = makeRepo();
    const msg = parseHl7(ORU_NORMAL);
    const old = new Date(T0.getTime() - 1000 * 24 * 60 * 60 * 1000);
    const { hemogram } = mapMessageToHemogram(msg, { id: "keep1", receivedAt: old });
    repo.insertResult({ hemogram, rawHl7: ORU_NORMAL, senderAddress: null });

    expect(repo.purgeOldRawMessages(0, T0)).toBe(0);
    expect(repo.getResultRawHl7("keep1")).toContain("MSH");
  });

  test("databaseSizeBytes devuelve un tamano > 0", () => {
    const repo = makeRepo();
    expect(repo.databaseSizeBytes()).toBeGreaterThan(0);
  });
});
