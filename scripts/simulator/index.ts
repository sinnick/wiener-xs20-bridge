/**
 * Simulador del XS 20 — tu "equipo virtual".
 *
 * Hace de cliente TCP: se conecta al servicio, envia mensajes HL7 enmarcados
 * en MLLP y espera el ACK^R01.
 *
 * Modos:
 *   --mode=single    Un mensaje generado al azar (default).
 *   --mode=batch     N mensajes de golpe (--count=N).
 *   --mode=loop      Un mensaje cada --interval=ms, infinito (simula un dia).
 *   --mode=fixture   Uno de los fixtures fijos (--fixture=normal|anormal|histogramas|duplicado).
 *
 * Ejemplos:
 *   bun run scripts/simulator/index.ts
 *   bun run scripts/simulator/index.ts --mode=batch --count=50
 *   bun run scripts/simulator/index.ts --mode=loop --interval=3000
 *   bun run scripts/simulator/index.ts --mode=fixture --fixture=anormal
 *   bun run scripts/simulator/index.ts --mode=batch --count=20 --abnormal-rate=0.4
 */

import { connect } from "node:net";

import { generateOruMessage } from "@xs20/shared";
import { ENQ, frameMllp, unframeMllp } from "../../apps/service/src/hl7/mllp.js";
import {
  ORU_ANORMAL,
  ORU_NORMAL,
  buildOruWithHistograms,
} from "../fixtures/messages.js";

type Mode = "single" | "batch" | "loop" | "fixture";
type FixtureName = "normal" | "anormal" | "histogramas" | "duplicado";

interface CliArgs {
  host: string;
  port: number;
  mode: Mode;
  fixture: FixtureName;
  count: number;
  intervalMs: number;
  abnormalRate: number;
  sendEnq: boolean;
  timeoutMs: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    host: "127.0.0.1",
    port: 5100,
    mode: "single",
    fixture: "normal",
    count: 10,
    intervalMs: 3000,
    abnormalRate: 0.15,
    sendEnq: false,
    timeoutMs: 5000,
    quiet: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--host=")) out.host = arg.split("=")[1] ?? out.host;
    else if (arg.startsWith("--port=")) out.port = parseInt(arg.split("=")[1] ?? "5100", 10);
    else if (arg.startsWith("--mode=")) {
      const m = arg.split("=")[1] as Mode;
      if (["single", "batch", "loop", "fixture"].includes(m)) out.mode = m;
    } else if (arg.startsWith("--fixture=")) {
      const f = arg.split("=")[1] as FixtureName;
      if (["normal", "anormal", "histogramas", "duplicado"].includes(f)) {
        out.fixture = f;
        out.mode = "fixture"; // atajo: --fixture implica modo fixture
      }
    } else if (arg.startsWith("--count=")) out.count = parseInt(arg.split("=")[1] ?? "10", 10);
    else if (arg.startsWith("--interval=")) out.intervalMs = parseInt(arg.split("=")[1] ?? "3000", 10);
    else if (arg.startsWith("--abnormal-rate=")) out.abnormalRate = parseFloat(arg.split("=")[1] ?? "0.15");
    else if (arg === "--send-enq") out.sendEnq = true;
    else if (arg.startsWith("--timeout=")) out.timeoutMs = parseInt(arg.split("=")[1] ?? "5000", 10);
    else if (arg === "--quiet") out.quiet = true;
  }
  return out;
}

function fixtureMessage(name: FixtureName): string {
  if (name === "normal") return ORU_NORMAL;
  if (name === "anormal") return ORU_ANORMAL;
  if (name === "histogramas") return buildOruWithHistograms("SIM-HIST-" + Date.now());
  return ORU_NORMAL; // duplicado
}

function extractMsh10(hl7: string): string {
  const firstLine = hl7.split("\r")[0] ?? "";
  return firstLine.split("|")[9] ?? "(?)";
}

/** Envia un mensaje enmarcado y espera el ACK. Devuelve el ACK (o lanza en timeout). */
function sendMessage(args: CliArgs, hl7: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: args.host, port: args.port });
    let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error(`timeout esperando ACK (${args.timeoutMs}ms)`));
      }
    }, args.timeoutMs);

    sock.on("connect", () => {
      if (args.sendEnq) sock.write(Buffer.from([ENQ]));
      sock.write(frameMllp(hl7));
    });

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

    sock.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    sock.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error("conexion cerrada antes del ACK"));
      }
    });
  });
}

function ackStatus(ack: string): string {
  const msa = ack.split("\r").find((l) => l.startsWith("MSA")) ?? "";
  return msa.split("|")[1] ?? "?";
}

async function runSingle(args: CliArgs): Promise<void> {
  const hl7 = generateOruMessage({ abnormalRate: args.abnormalRate });
  const ack = await sendMessage(args, hl7, "single");
  console.log(`enviado MSH-10=${extractMsh10(hl7)} → ACK ${ackStatus(ack)}`);
}

async function runFixture(args: CliArgs): Promise<void> {
  if (args.fixture === "duplicado") {
    const hl7 = fixtureMessage("duplicado");
    const a1 = await sendMessage(args, hl7, "dup1");
    console.log(`envio 1 MSH-10=${extractMsh10(hl7)} → ACK ${ackStatus(a1)}`);
    await new Promise((r) => setTimeout(r, 200));
    const a2 = await sendMessage(args, hl7, "dup2");
    console.log(`envio 2 (mismo MSH-10) → ACK ${ackStatus(a2)} (idempotencia: no se re-persiste)`);
    return;
  }
  const hl7 = fixtureMessage(args.fixture);
  const ack = await sendMessage(args, hl7, args.fixture);
  console.log(`fixture '${args.fixture}' MSH-10=${extractMsh10(hl7)} → ACK ${ackStatus(ack)}`);
}

async function runBatch(args: CliArgs): Promise<void> {
  console.log(`Enviando ${args.count} mensajes (abnormal-rate=${args.abnormalRate})...`);
  const base = Date.now();
  let ok = 0;
  let fail = 0;
  const t0 = Date.now();
  for (let i = 0; i < args.count; i++) {
    const hl7 = generateOruMessage({
      messageControlId: `BATCH-${base}-${i}`,
      abnormalRate: args.abnormalRate,
    });
    try {
      const ack = await sendMessage(args, hl7, `batch-${i}`);
      ok++;
      if (!args.quiet) {
        process.stdout.write(`  [${i + 1}/${args.count}] ${extractMsh10(hl7)} → ${ackStatus(ack)}\n`);
      }
    } catch (e) {
      fail++;
      console.error(`  [${i + 1}/${args.count}] ERROR: ${(e as Error).message}`);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nListo: ${ok} OK, ${fail} fallidos en ${secs}s`);
}

async function runLoop(args: CliArgs): Promise<void> {
  console.log(`Modo loop: un mensaje cada ${args.intervalMs}ms. Ctrl+C para parar.`);
  let n = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hl7 = generateOruMessage({ abnormalRate: args.abnormalRate });
    try {
      const ack = await sendMessage(args, hl7, `loop-${n}`);
      n++;
      console.log(`[${new Date().toLocaleTimeString()}] #${n} ${extractMsh10(hl7)} → ${ackStatus(ack)}`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ERROR: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, args.intervalMs));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Simulador XS 20 → ${args.host}:${args.port} (modo: ${args.mode})\n`);

  switch (args.mode) {
    case "single":
      await runSingle(args);
      break;
    case "fixture":
      await runFixture(args);
      break;
    case "batch":
      await runBatch(args);
      break;
    case "loop":
      await runLoop(args);
      break;
  }
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
