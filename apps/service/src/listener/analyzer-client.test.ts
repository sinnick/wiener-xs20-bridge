/**
 * Tests del cliente saliente (modo "connect": el XS 20 escucha, nosotros discamos).
 *
 * Levantamos un servidor TCP que hace de analizador, empuja mensajes MLLP y
 * lee los ACKs, para ejercitar el camino completo sin el equipo fisico.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import { openDb } from "../db/migrate.js";
import { XsRepo } from "../db/repo.js";
import { MessageProcessor } from "../hl7/message-processor.js";
import { frameMllp, unframeMllp } from "../hl7/mllp.js";
import { Logger } from "../logger.js";
import { ORU_NORMAL } from "../../../../scripts/fixtures/messages.js";
import { AnalyzerClient } from "./analyzer-client.js";

function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

/** Analizador de mentira: escucha, empuja mensajes y junta los ACKs recibidos. */
class FakeAnalyzer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  readonly acksReceived: string[] = [];
  connectionCount = 0;

  async listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((sock) => {
        this.connectionCount++;
        this.sockets.add(sock);
        let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        sock.on("data", (chunk: Buffer) => {
          const incoming = Uint8Array.from(chunk);
          const combined = new Uint8Array(buf.length + incoming.length);
          combined.set(buf, 0);
          combined.set(incoming, buf.length);
          const r = unframeMllp(combined);
          buf = r.remaining;
          this.acksReceived.push(...r.messages);
        });
        sock.on("close", () => this.sockets.delete(sock));
        sock.on("error", () => this.sockets.delete(sock));
      });
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  /** Empuja un mensaje HL7 enmarcado a todos los clientes conectados. */
  push(hl7: string): void {
    const framed = frameMllp(hl7);
    for (const s of this.sockets) s.write(framed);
  }

  hasConnection(): boolean {
    return this.sockets.size > 0;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}

/** Espera hasta que `check` sea true o se agote el tiempo. */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor: no se cumplio en ${timeoutMs}ms`);
}

describe("AnalyzerClient (modo connect)", () => {
  let analyzer: FakeAnalyzer;
  let client: AnalyzerClient | null = null;
  let repo: XsRepo;
  let port: number;

  beforeEach(async () => {
    port = 23000 + Math.floor(Math.random() * 2000);
    analyzer = new FakeAnalyzer();
    await analyzer.listen(port);

    const db = openDb({ path: ":memory:" });
    repo = new XsRepo(db);
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    await analyzer.close();
  });

  function makeClient(overridePort?: number): AnalyzerClient {
    const processor = new MessageProcessor({ repo, logger: silentLogger() });
    return new AnalyzerClient({
      host: "127.0.0.1",
      port: overridePort ?? port,
      processor,
      logger: silentLogger(),
    });
  }

  test("se conecta al analizador, persiste el resultado y devuelve ACK AA", async () => {
    client = makeClient();
    client.start();

    await waitFor(() => client!.getStatus().connected);
    expect(analyzer.connectionCount).toBe(1);

    analyzer.push(ORU_NORMAL);

    await waitFor(() => analyzer.acksReceived.length === 1);
    const ack = analyzer.acksReceived[0]!;
    const msa = ack.split("\r").find((l) => l.startsWith("MSA")) ?? "";
    expect(msa.split("|")[1]).toBe("AA");

    // El resultado quedo persistido.
    expect(repo.countResults()).toBe(1);
  });

  test("reconecta solo cuando el analizador se cae y vuelve", async () => {
    client = makeClient();
    client.start();
    await waitFor(() => client!.getStatus().connected);

    // El equipo "se apaga": cerramos el servidor entero.
    await analyzer.close();
    await waitFor(() => !client!.getStatus().connected);

    // Y vuelve a estar disponible en la misma direccion.
    analyzer = new FakeAnalyzer();
    await analyzer.listen(port);

    // El backoff arranca en 1s, asi que damos margen.
    await waitFor(() => client!.getStatus().connected, 8000);
    expect(client!.getStatus().totalConnectionsSinceStart).toBeGreaterThanOrEqual(2);

    // Y sigue procesando despues de reconectar.
    analyzer.push(ORU_NORMAL);
    await waitFor(() => analyzer.acksReceived.length === 1);
    expect(repo.countResults()).toBe(1);
  }, 15000);

  test("si el analizador esta apagado, reintenta sin tirar el servicio", async () => {
    // Puerto sin nadie escuchando: simula el equipo apagado al arrancar.
    const deadPort = port + 500;
    client = makeClient(deadPort);
    client.start();

    // El cliente queda activo (no crashea) pero sin conexion.
    await new Promise((r) => setTimeout(r, 500));
    const status = client.getStatus();
    expect(status.listening).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.lastError).not.toBeNull();
  });

  test("reconfigure apunta a otra direccion en caliente", async () => {
    // Arranca contra un puerto muerto y despues lo mandamos al analizador real.
    client = makeClient(port + 501);
    client.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(client.getStatus().connected).toBe(false);

    client.reconfigure("127.0.0.1", port);
    await waitFor(() => client!.getStatus().connected);
    expect(client.getStatus().port).toBe(port);
  }, 10000);

  test("stop() corta la conexion y no reconecta", async () => {
    client = makeClient();
    client.start();
    await waitFor(() => client!.getStatus().connected);

    client.stop();
    expect(client.getStatus().listening).toBe(false);

    // Damos tiempo a que un reintento hubiera ocurrido si el stop no frenara.
    await new Promise((r) => setTimeout(r, 1500));
    expect(client.getStatus().connected).toBe(false);
  });
});
