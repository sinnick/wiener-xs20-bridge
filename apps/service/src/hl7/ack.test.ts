import { describe, expect, test } from "bun:test";
import { buildAck } from "./ack.js";

describe("buildAck", () => {
  const fakeNow = new Date("2026-04-27T15:32:11Z");

  test("AA basico", () => {
    const ack = buildAck({
      originalMessageControlId: "1001",
      status: "AA",
      now: fakeNow,
      ackControlId: "ACK-1",
    });
    const lines = ack.split("\r");
    expect(lines[0]).toBe("MSH|^~\\&|||||20260427153211||ACK^R01|ACK-1|P|2.3.1||||||UNICODE");
    expect(lines[1]).toBe("MSA|AA|1001");
  });

  test("AE con texto de error", () => {
    const ack = buildAck({
      originalMessageControlId: "999",
      status: "AE",
      errorText: "Parse failed: missing OBR",
      now: fakeNow,
      ackControlId: "ACK-2",
    });
    expect(ack).toContain("MSA|AE|999|Parse failed: missing OBR");
  });

  test("sanitiza delimitadores en errorText", () => {
    const ack = buildAck({
      originalMessageControlId: "X",
      status: "AE",
      errorText: "Bad|input^with~delims\\here",
      now: fakeNow,
      ackControlId: "ACK-3",
    });
    expect(ack).toContain("Bad input with delims here");
  });
});
