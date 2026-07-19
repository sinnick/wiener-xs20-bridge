import { describe, expect, test } from "bun:test";
import {
  Hl7ParseError,
  getField,
  getRepeats,
  getSegment,
  getSegments,
  getString,
  parseHl7,
} from "./parser.js";

describe("parseHl7", () => {
  test("rechaza mensaje vacio", () => {
    expect(() => parseHl7("")).toThrow(Hl7ParseError);
  });

  test("rechaza mensaje que no empieza con MSH", () => {
    expect(() => parseHl7("FOO|bar")).toThrow(/MSH/);
  });

  test("rechaza MSH demasiado corto", () => {
    expect(() => parseHl7("MSH|")).toThrow(/MSH demasiado corto/);
  });

  test("parsea MSH minimo", () => {
    const m = parseHl7("MSH|^~\\&|app|fac|recv|recvfac|20260427153211||ORU^R01|1001|P|2.3.1");
    const msh = m.segments[0]!;
    expect(msh.name).toBe("MSH");
    // MSH-1 debe ser "|"
    expect(getString(msh, 1)).toBe("|");
    // MSH-2 debe ser "^~\\&" intacto, sin sub-parsear
    expect(getString(msh, 2)).toBe("^~\\&");
    // MSH-3 = sending app
    expect(getString(msh, 3)).toBe("app");
    expect(getString(msh, 9, 1)).toBe("ORU");
    expect(getString(msh, 9, 2)).toBe("R01");
    expect(getString(msh, 10)).toBe("1001");
    expect(getString(msh, 12)).toBe("2.3.1");
  });

  test("parsea PID con nombre compuesto", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "PID|1||MR123^^^^MR||Perez^Juan||19820123|Male",
    );
    const pid = getSegment(m, "PID")!;
    expect(getString(pid, 3, 1)).toBe("MR123");
    expect(getString(pid, 5, 1)).toBe("Perez");
    expect(getString(pid, 5, 2)).toBe("Juan");
    expect(getString(pid, 8)).toBe("Male");
  });

  test("parsea OBX numerico tipico", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "OBX|6|NM|6690-2^WBC^LN||5.2|10*9/L|4.0-10.0|N|||F",
    );
    const obx = getSegment(m, "OBX")!;
    expect(getString(obx, 1)).toBe("6");
    expect(getString(obx, 2)).toBe("NM");
    expect(getString(obx, 3, 1)).toBe("6690-2");
    expect(getString(obx, 3, 2)).toBe("WBC");
    expect(getString(obx, 3, 3)).toBe("LN");
    // OBX-4 vacio
    expect(getString(obx, 4)).toBe("");
    expect(getString(obx, 5)).toBe("5.2");
    expect(getString(obx, 6)).toBe("10*9/L");
    expect(getString(obx, 7)).toBe("4.0-10.0");
    expect(getString(obx, 8)).toBe("N");
    expect(getString(obx, 11)).toBe("F");
  });

  test("OBX con valor ED (histograma): el ^ dentro de OBX-5 se parsea como componentes", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "OBX|33|ED|15000^WBC Histogram^99MRC||^Application^Octer-stream^Base64^AAAA|||||F",
    );
    const obx = getSegment(m, "OBX")!;
    expect(getString(obx, 2)).toBe("ED");
    // OBX-5 tiene 5 componentes
    expect(getString(obx, 5, 1)).toBe(""); // source app
    expect(getString(obx, 5, 2)).toBe("Application");
    expect(getString(obx, 5, 3)).toBe("Octer-stream");
    expect(getString(obx, 5, 4)).toBe("Base64");
    expect(getString(obx, 5, 5)).toBe("AAAA");
  });

  test("flags multiples en OBX-8 (separados por ~)", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "OBX|14|NM|718-7^HGB^LN||92|g/L|120-160|L~A|||F",
    );
    const obx = getSegment(m, "OBX")!;
    const flags = getRepeats(obx, 8);
    expect(flags).toEqual(["L", "A"]);
  });

  test("getSegments devuelve todos los OBX en orden", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "OBX|1|NM|A^A^L||1\r" +
        "OBX|2|NM|B^B^L||2\r" +
        "OBX|3|NM|C^C^L||3",
    );
    const obxs = getSegments(m, "OBX");
    expect(obxs.length).toBe(3);
    expect(getString(obxs[0]!, 5)).toBe("1");
    expect(getString(obxs[1]!, 5)).toBe("2");
    expect(getString(obxs[2]!, 5)).toBe("3");
  });

  test("acepta separadores \\r\\n y \\n (tolerante)", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r\n" +
        "PID|1||MR123\n" +
        "OBR|1||S001",
    );
    expect(m.segments.length).toBe(3);
    expect(m.segments.map((s) => s.name)).toEqual(["MSH", "PID", "OBR"]);
  });

  test("getString devuelve undefined para campos ausentes", () => {
    const m = parseHl7("MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1");
    const msh = m.segments[0]!;
    expect(getString(msh, 99)).toBeUndefined();
  });

  test("getString devuelve string vacio para campo presente pero vacio", () => {
    const m = parseHl7(
      "MSH|^~\\&|||||20260427153211||ORU^R01|1|P|2.3.1\r" +
        "OBX|1|NM|A^A^L||",
    );
    const obx = getSegment(m, "OBX")!;
    expect(getString(obx, 5)).toBe("");
  });
});
