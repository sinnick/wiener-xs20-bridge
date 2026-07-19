import { describe, expect, test } from "bun:test";
import { ORU_ANORMAL, ORU_NORMAL, buildOruWithHistograms } from "../../../../scripts/fixtures/messages.js";
import { parseHl7 } from "./parser.js";
import { mapMessageToHemogram } from "./obx-mapper.js";

const T0 = new Date("2026-04-27T15:32:11Z");

describe("mapMessageToHemogram - normal CBC", () => {
  const msg = parseHl7(ORU_NORMAL);
  const { hemogram, warnings } = mapMessageToHemogram(msg, { id: "r1", receivedAt: T0 });

  test("sin warnings", () => {
    expect(warnings).toEqual([]);
  });

  test("messageControlId extraido", () => {
    expect(hemogram.messageControlId).toBe("1001");
  });

  test("paciente extraido", () => {
    expect(hemogram.patient.patientId).toBe("MR123456");
    expect(hemogram.patient.name).toBe("Perez, Juan");
    expect(hemogram.patient.birthDate).toBe("1982-01-23");
    expect(hemogram.patient.sex).toBe("M");
  });

  test("muestra extraida", () => {
    expect(hemogram.sample.sampleId).toBe("S20260427-0001");
    expect(hemogram.sample.takeMode).toBe("O");
    expect(hemogram.sample.bloodMode).toBe("W");
    expect(hemogram.sample.testMode).toBe("CBC+DIFF");
    expect(hemogram.sample.refGroup).toBe("General");
    expect(hemogram.sample.operator).toBe("operador1");
    expect(hemogram.sample.analyzedAt).toBeInstanceOf(Date);
  });

  test("los 19 parametros del CBC vienen presentes", () => {
    const params = Object.keys(hemogram.values).sort();
    expect(params).toEqual(
      [
        "wbc", "lym_abs", "lym_pct", "mid_abs", "mid_pct", "gran_abs", "gran_pct",
        "rbc", "hgb", "hct", "mcv", "mch", "mchc", "rdw_cv", "rdw_sd",
        "plt", "mpv", "pdw", "pct",
      ].sort(),
    );
  });

  test("WBC parseado correctamente", () => {
    expect(hemogram.values.wbc).toEqual({
      value: 7.2,
      unit: "10*9/L",
      refRange: "4.0-10.0",
      flags: ["N"],
    });
  });

  test("HGB en g/L", () => {
    expect(hemogram.values.hgb?.value).toBe(145);
    expect(hemogram.values.hgb?.unit).toBe("g/L");
    expect(hemogram.values.hgb?.flags).toEqual(["N"]);
  });

  test("sin histogramas en este fixture", () => {
    expect(hemogram.histograms).toEqual([]);
  });

  test("sin morphology flags en CBC normal", () => {
    expect(hemogram.morphologyFlags).toEqual([]);
  });
});

describe("mapMessageToHemogram - anormal con flags", () => {
  const msg = parseHl7(ORU_ANORMAL);
  const { hemogram } = mapMessageToHemogram(msg, { id: "r2", receivedAt: T0 });

  test("HGB con flag L", () => {
    expect(hemogram.values.hgb?.value).toBe(92);
    expect(hemogram.values.hgb?.flags).toEqual(["L"]);
  });

  test("WBC con flag H", () => {
    expect(hemogram.values.wbc?.value).toBe(14.8);
    expect(hemogram.values.wbc?.flags).toEqual(["H"]);
  });

  test("paciente femenino", () => {
    expect(hemogram.patient.sex).toBe("F");
    expect(hemogram.patient.name).toBe("Gonzalez, Maria");
  });

  test("morphology flags presentes", () => {
    const codes = hemogram.morphologyFlags.map((f) => f.code).sort();
    expect(codes).toEqual([
      "Anemia",
      "Leukocytosis",
      "Microcytes",
      "Neutrophilia",
      "Thrombocytosis",
    ]);
  });
});

describe("mapMessageToHemogram - con histogramas", () => {
  const msg = parseHl7(buildOruWithHistograms("3001"));
  const { hemogram, warnings } = mapMessageToHemogram(msg, { id: "r3", receivedAt: T0 });

  test("3 histogramas presentes", () => {
    expect(hemogram.histograms.length).toBe(3);
  });

  test("cada histograma tiene 256 bytes", () => {
    for (const h of hemogram.histograms) {
      expect(h.channels.length).toBe(256);
    }
  });

  test("WBC histogram tiene los 3 discriminadores", () => {
    const wbc = hemogram.histograms.find((h) => h.type === "wbc")!;
    expect(wbc.discriminators).toEqual({ leftLine: 40, midLine: 120, rightLine: 220 });
  });

  test("RBC histogram tiene 2 discriminadores", () => {
    const rbc = hemogram.histograms.find((h) => h.type === "rbc")!;
    expect(rbc.discriminators.leftLine).toBe(50);
    expect(rbc.discriminators.rightLine).toBe(230);
  });

  test("PLT histogram tiene 2 discriminadores", () => {
    const plt = hemogram.histograms.find((h) => h.type === "plt")!;
    expect(plt.discriminators.leftLine).toBe(10);
    expect(plt.discriminators.rightLine).toBe(80);
  });

  test("sin warnings", () => {
    expect(warnings).toEqual([]);
  });
});

describe("mapMessageToHemogram - tolerancia a OBX desconocidos", () => {
  test("OBX con codigo desconocido genera warning pero no fail", () => {
    const msg = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|9999|P|2.3.1\r" +
        "OBR|1||S-X|00001^Automated Count^99MRC\r" +
        "OBX|1|NM|99999^FAKE^XX||3.14|||||F",
    );
    const { hemogram, warnings } = mapMessageToHemogram(msg, { id: "rX", receivedAt: T0 });
    expect(hemogram.values).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.type).toBe("unknown_obx_code");
  });
});
