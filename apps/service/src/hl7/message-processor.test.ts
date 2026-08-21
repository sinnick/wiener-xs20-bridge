import { describe, expect, test } from "bun:test";

import { ORU_NORMAL } from "../../../../scripts/fixtures/messages.js";
import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { MessageProcessor, MllpBuffer } from "./message-processor.js";
import { frameMllp, VT } from "./mllp.js";
import { MAX_MLLP_FRAME_BYTES } from "./protocol-map.js";

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

  test("la exportacion del .txt corre DESPUES de mandar el ACK", () => {
    // El equipo espera el ACK dentro de ~4s. Exportar el .txt puede ser un
    // writeFileSync a una carpeta de red caida, que se cuelga varios segundos:
    // no puede estar en el camino de la respuesta.
    const repo = new XsRepo(openDb({ path: ":memory:" }));
    const orden: string[] = [];
    const processor = new MessageProcessor({
      repo,
      logger: silentLogger(),
      onHemogramPersisted: () => orden.push("export"),
    });

    processor.process(ORU_NORMAL, "127.0.0.1", () => orden.push("ack"));

    expect(orden).toEqual(["ack", "export"]);
  });

  test("un fallo al exportar no puede voltear el procesamiento (el ACK ya salio)", () => {
    const repo = new XsRepo(openDb({ path: ":memory:" }));
    const acks: Uint8Array[] = [];
    const processor = new MessageProcessor({
      repo,
      logger: silentLogger(),
      onHemogramPersisted: () => {
        throw new Error("carpeta de red caida");
      },
    });

    // process() no puede lanzar nunca: el error sale por el handler del socket.
    // Y el resultado quedo guardado con su ACK ya mandado.
    expect(() =>
      processor.process(ORU_NORMAL, "127.0.0.1", (f) => acks.push(f)),
    ).not.toThrow();
    expect(acks).toHaveLength(1);
    expect(repo.countResults()).toBe(1);
  });
});

describe("MllpBuffer - tope de bytes por frame", () => {
  test("un frame que nunca cierra se descarta en vez de comerse la memoria", () => {
    // Alguien abre un frame (0x0B) y sigue mandando sin el cierre FS+CR. Antes
    // esto acumulaba indefinidamente hasta voltear el proceso.
    const buffer = new MllpBuffer(1024);

    const abrir = new Uint8Array([VT]);
    expect(buffer.push(abrir).overflow).toBe(false);

    const relleno = new Uint8Array(600).fill(0x41); // "A"
    expect(buffer.push(relleno).overflow).toBe(false);
    expect(buffer.pendingBytes).toBe(601);

    const result = buffer.push(relleno);
    expect(result.overflow).toBe(true);
    expect(result.messages).toHaveLength(0);
    // Y quedo limpio para la proxima conexion.
    expect(buffer.pendingBytes).toBe(0);
  });

  test("despues del descarte, un mensaje normal se sigue procesando", () => {
    const buffer = new MllpBuffer(512);
    buffer.push(new Uint8Array([VT]));
    expect(buffer.push(new Uint8Array(600).fill(0x41)).overflow).toBe(true);

    const ok = buffer.push(frameMllp("MSH|^~\\&|XS20|||||20250101||ORU^R01|1|P|2.3.1"));
    expect(ok.overflow).toBe(false);
    expect(ok.messages).toHaveLength(1);
  });

  test("un mensaje real esta lejisimos del tope", () => {
    const buffer = new MllpBuffer();
    const r = buffer.push(frameMllp(ORU_NORMAL));
    expect(r.overflow).toBe(false);
    expect(r.messages).toHaveLength(1);
    expect(ORU_NORMAL.length).toBeLessThan(MAX_MLLP_FRAME_BYTES / 10);
  });

  test("basura fuera de frame no cuenta para el tope (se descarta al vuelo)", () => {
    // Solo los bytes de un frame ABIERTO se acumulan. Ruido suelto no.
    const buffer = new MllpBuffer(1024);
    for (let i = 0; i < 10; i++) {
      expect(buffer.push(new Uint8Array(600).fill(0x41)).overflow).toBe(false);
    }
    expect(buffer.pendingBytes).toBe(0);
  });
});
