import { describe, expect, test } from "bun:test";
import { generateBatch, generateOruMessage } from "@xs20/shared";
import { parseHl7 } from "./parser.js";
import { mapMessageToHemogram } from "./obx-mapper.js";

const T0 = new Date("2026-04-27T15:32:11Z");

describe("generateOruMessage", () => {
  test("produce un mensaje que parsea sin warnings", () => {
    const hl7 = generateOruMessage({ seed: 42 });
    const msg = parseHl7(hl7);
    const { hemogram, warnings } = mapMessageToHemogram(msg, { id: "g1", receivedAt: T0 });
    expect(warnings).toEqual([]);
    expect(Object.keys(hemogram.values).length).toBe(19);
    expect(hemogram.histograms.length).toBe(3);
    expect(hemogram.patient.name).toBeTruthy();
    expect(hemogram.sample.sampleId).toBeTruthy();
  });

  test("es deterministico con el mismo seed", () => {
    const a = generateOruMessage({ seed: 123, messageControlId: "X", sampleId: "Y", analyzedAt: T0 });
    const b = generateOruMessage({ seed: 123, messageControlId: "X", sampleId: "Y", analyzedAt: T0 });
    expect(a).toBe(b);
  });

  test("distintos seeds dan distintos pacientes", () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const msg = parseHl7(generateOruMessage({ seed: 500 + i }));
      const { hemogram } = mapMessageToHemogram(msg, { id: `s${i}`, receivedAt: T0 });
      if (hemogram.patient.name) names.add(hemogram.patient.name);
    }
    // No exigimos 10 unicos (puede haber colision), pero si varios distintos.
    expect(names.size).toBeGreaterThan(3);
  });

  test("abnormalRate=1 genera muchos valores fuera de rango", () => {
    const msg = parseHl7(generateOruMessage({ seed: 7, abnormalRate: 1 }));
    const { hemogram } = mapMessageToHemogram(msg, { id: "ab", receivedAt: T0 });
    const abnormal = Object.values(hemogram.values).filter((v) => v.flags.some((f) => f !== "N"));
    expect(abnormal.length).toBeGreaterThan(10);
  });

  test("abnormalRate=0 genera todo normal", () => {
    const msg = parseHl7(generateOruMessage({ seed: 7, abnormalRate: 0 }));
    const { hemogram } = mapMessageToHemogram(msg, { id: "nm", receivedAt: T0 });
    const abnormal = Object.values(hemogram.values).filter((v) => v.flags.some((f) => f !== "N"));
    expect(abnormal.length).toBe(0);
    expect(hemogram.morphologyFlags.length).toBe(0);
  });

  test("withHistograms=false omite los histogramas", () => {
    const msg = parseHl7(generateOruMessage({ seed: 7, withHistograms: false }));
    const { hemogram } = mapMessageToHemogram(msg, { id: "nh", receivedAt: T0 });
    expect(hemogram.histograms.length).toBe(0);
  });
});

describe("generateBatch", () => {
  test("genera N mensajes con control IDs unicos", () => {
    const batch = generateBatch(20, { seed: 1 });
    expect(batch.length).toBe(20);
    const ids = batch.map((hl7) => hl7.split("\r")[0]!.split("|")[9]);
    expect(new Set(ids).size).toBe(20); // todos unicos
  });

  test("todos los mensajes del batch parsean limpio", () => {
    const batch = generateBatch(10, { seed: 99 });
    for (const hl7 of batch) {
      const { warnings } = mapMessageToHemogram(parseHl7(hl7), { id: "b", receivedAt: T0 });
      expect(warnings).toEqual([]);
    }
  });
});
