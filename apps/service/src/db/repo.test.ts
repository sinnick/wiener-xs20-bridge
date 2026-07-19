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
