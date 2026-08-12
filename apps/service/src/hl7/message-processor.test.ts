import { describe, expect, test } from "bun:test";

import { ORU_NORMAL } from "../../../../scripts/fixtures/messages.js";
import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { MessageProcessor } from "./message-processor.js";

// Logger que no escribe a disco ni consola (buffer en memoria a /tmp efimero).
function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

describe("MessageProcessor - onHemogramPersisted", () => {
  test("se llama con el hemograma tras persistir, y NO en un duplicado", () => {
    const repo = new XsRepo(openDb({ path: ":memory:" }));
    const persisted: string[] = [];
    const processor = new MessageProcessor({
      repo,
      logger: silentLogger(),
      onHemogramPersisted: (h) => persisted.push(h.sample.sampleId),
    });

    const acks: Uint8Array[] = [];
    processor.process(ORU_NORMAL, "127.0.0.1", (framed) => acks.push(framed));
    expect(persisted).toHaveLength(1);

    // El mismo mensaje otra vez (mismo MSH-10) es duplicado: ACK AA pero sin
    // re-persistir ni re-exportar.
    processor.process(ORU_NORMAL, "127.0.0.1", (framed) => acks.push(framed));
    expect(persisted).toHaveLength(1);
    expect(acks).toHaveLength(2);
  });
});
