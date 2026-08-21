import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { Logger } from "../logger.js";
import { frameMllp, unframeMllp, VT } from "../hl7/mllp.js";
import { TcpServer } from "./tcp-server.js";
import { ORU_NORMAL } from "../../../../scripts/fixtures/messages.js";

// Logger que no escribe a disco ni consola (buffer en memoria a /tmp efimero).
function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

/** Envia un payload HL7 crudo (lo enmarca) y espera un ACK, devolviendo su texto. */
function sendAndAwaitAck(port: number, hl7: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error("TIMEOUT: no llego ACK"));
      }
    }, timeoutMs);

    sock.on("connect", () => sock.write(frameMllp(hl7)));
    sock.on("data", (chunk: Buffer) => {
      const incoming = Uint8Array.from(chunk);
      const combined = new Uint8Array(buf.length + incoming.length);
      combined.set(buf, 0);
      combined.set(incoming, buf.length);
      const r = unframeMllp(combined);
      buf = r.remaining;
      if (r.messages.length > 0 && !done) {
        done = true;
        clearTimeout(timer);
        sock.end();
        resolve(r.messages[0]!);
      }
    });
    sock.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

describe("TcpServer (integracion)", () => {
  let server: TcpServer;
  let repo: XsRepo;
  let port: number;
  let counter = 0;

  beforeEach(() => {
    port = 19000 + Math.floor(Math.random() * 2000);
    const db = openDb({ path: ":memory:" });
    repo = new XsRepo(db);
    server = new TcpServer({
      host: "127.0.0.1",
      port,
      repo,
      logger: silentLogger(),
      generateId: () => `test_${counter++}`,
    });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  test("mensaje ORU valido → ACK AA + persiste", async () => {
    const ack = await sendAndAwaitAck(port, ORU_NORMAL);
    expect(ack).toContain("MSA|AA|1001");
    expect(repo.countResults()).toBe(1);
  });

  test("basura (no empieza con MSH) → ACK AE, no crashea, no persiste", async () => {
    const ack = await sendAndAwaitAck(port, "GARBAGE NOT HL7 AT ALL");
    expect(ack).toContain("MSA|AE|");
    expect(repo.countResults()).toBe(0);
  });

  test("MSH truncado → ACK AE (siempre responde, no cuelga al analizador)", async () => {
    const ack = await sendAndAwaitAck(port, "MSH|^~");
    expect(ack).toContain("MSA|AE|");
  });

  test("el servidor sigue vivo despues de un mensaje malformado", async () => {
    // Primero basura, despues un mensaje valido en una conexion nueva.
    await sendAndAwaitAck(port, "BASURA");
    const ack = await sendAndAwaitAck(port, ORU_NORMAL);
    expect(ack).toContain("MSA|AA|1001");
    expect(repo.countResults()).toBe(1);
  });

  test("mensaje no-ORU (ej ACK entrante) → responde AA sin persistir", async () => {
    const ackMsg = "MSH|^~\\&|||||20260427153211||ACK^R01|999|P|2.3.1\rMSA|AA|1";
    const ack = await sendAndAwaitAck(port, ackMsg);
    expect(ack).toContain("MSA|AA|999");
    expect(repo.countResults()).toBe(0);
  });

  test("reconfigure mueve el listener a un puerto nuevo en caliente", async () => {
    const newPort = 22000 + Math.floor(Math.random() * 2000);
    server.reconfigure("127.0.0.1", newPort);

    // El puerto nuevo acepta y procesa.
    const ack = await sendAndAwaitAck(newPort, ORU_NORMAL);
    expect(ack).toContain("MSA|AA|1001");
    expect(repo.countResults()).toBe(1);

    // getStatus refleja la direccion nueva.
    expect(server.getStatus().port).toBe(newPort);
    expect(server.getStatus().listening).toBe(true);
  });

  test("reconfigure a un puerto ocupado revierte y mantiene el listener previo", async () => {
    const blockerPort = 24000 + Math.floor(Math.random() * 2000);
    const blocker = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: blockerPort,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });

    try {
      expect(() => server.reconfigure("127.0.0.1", blockerPort)).toThrow();

      // El listener previo sigue vivo y funcional tras el rollback.
      expect(server.getStatus().port).toBe(port);
      const ack = await sendAndAwaitAck(port, ORU_NORMAL);
      expect(ack).toContain("MSA|AA|1001");
    } finally {
      blocker.stop(true);
    }
  });

  test("un frame MLLP que nunca cierra corta la conexion en vez de tumbar el proceso", async () => {
    // Cualquiera que se conecte al 5100 puede mandar un 0x0B y despues seguir
    // escribiendo sin cerrar el frame. Antes eso se acumulaba en memoria hasta
    // voltear el servicio — y NSSM lo reiniciaba en loop.
    const cerrado = await new Promise<boolean>((resolve) => {
      const sock = connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 8000);

      sock.on("connect", () => {
        sock.write(Uint8Array.from([VT])); // abre el frame...
        const relleno = new Uint8Array(256 * 1024).fill(0x41);
        // ...y nunca lo cierra (sin FS+CR), pasandose del tope de 1 MB.
        for (let i = 0; i < 6; i++) sock.write(relleno);
      });
      sock.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      sock.on("error", () => {
        clearTimeout(timer);
        resolve(true); // ECONNRESET tambien cuenta como cierre
      });
    });

    expect(cerrado).toBe(true);

    // Y el listener sigue en pie para el proximo mensaje legitimo.
    const ack = await sendAndAwaitAck(port, ORU_NORMAL);
    expect(ack).toContain("MSA|AA|1001");
  }, 15000);
});
