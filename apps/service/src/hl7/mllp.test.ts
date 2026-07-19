import { describe, expect, test } from "bun:test";
import {
  ACK_BYTE,
  CR,
  ENQ,
  FS,
  HEARTBEAT,
  VT,
  frameMllp,
  unframeMllp,
} from "./mllp.js";

describe("frameMllp", () => {
  test("envuelve un mensaje vacio", () => {
    const r = frameMllp("");
    expect(r).toEqual(new Uint8Array([VT, FS, CR]));
  });

  test("envuelve un mensaje ASCII", () => {
    const r = frameMllp("ABC");
    expect(r).toEqual(new Uint8Array([VT, 0x41, 0x42, 0x43, FS, CR]));
  });

  test("envuelve UTF-8 (acentos)", () => {
    const r = frameMllp("Pérez");
    // 'é' en UTF-8 = 0xC3 0xA9
    expect(r[0]).toBe(VT);
    expect(r[r.length - 2]).toBe(FS);
    expect(r[r.length - 1]).toBe(CR);
    // P=0x50, é=0xC3 0xA9, r=0x72, e=0x65, z=0x7A => total 6 bytes payload
    expect(r.length).toBe(6 + 3);
  });
});

describe("unframeMllp", () => {
  test("buffer vacio", () => {
    const r = unframeMllp(new Uint8Array([]));
    expect(r.messages).toEqual([]);
    expect(r.controlBytes).toEqual([]);
    expect(r.remaining.length).toBe(0);
  });

  test("un mensaje completo", () => {
    const buf = frameMllp("MSH|^~\\&|hola");
    const r = unframeMllp(buf);
    expect(r.messages).toEqual(["MSH|^~\\&|hola"]);
    expect(r.remaining.length).toBe(0);
  });

  test("dos mensajes seguidos", () => {
    const a = frameMllp("MSG1");
    const b = frameMllp("MSG2");
    const buf = new Uint8Array(a.length + b.length);
    buf.set(a, 0);
    buf.set(b, a.length);
    const r = unframeMllp(buf);
    expect(r.messages).toEqual(["MSG1", "MSG2"]);
    expect(r.remaining.length).toBe(0);
  });

  test("mensaje incompleto (sin FS+CR) queda en remaining", () => {
    // Solo tenemos VT + payload, sin FS+CR todavia.
    const buf = new Uint8Array([VT, 0x41, 0x42, 0x43]);
    const r = unframeMllp(buf);
    expect(r.messages).toEqual([]);
    expect(r.remaining).toEqual(buf);
  });

  test("mensaje completo + parcial: extrae el primero, deja el segundo en remaining", () => {
    const a = frameMllp("DONE");
    const partial = new Uint8Array([VT, 0x58, 0x59]); // "XY" sin cerrar
    const buf = new Uint8Array(a.length + partial.length);
    buf.set(a, 0);
    buf.set(partial, a.length);

    const r = unframeMllp(buf);
    expect(r.messages).toEqual(["DONE"]);
    expect(r.remaining).toEqual(partial);
  });

  test("reensamble: pasar el remaining + nuevos bytes da el segundo mensaje", () => {
    const a = frameMllp("FIRST");
    const b = frameMllp("SECOND");

    // Cortamos b por la mitad.
    const half = Math.floor(b.length / 2);
    const part1 = new Uint8Array(a.length + half);
    part1.set(a, 0);
    part1.set(b.subarray(0, half), a.length);

    const r1 = unframeMllp(part1);
    expect(r1.messages).toEqual(["FIRST"]);

    // Concatenamos remaining con la otra mitad.
    const rest = b.subarray(half);
    const part2 = new Uint8Array(r1.remaining.length + rest.length);
    part2.set(r1.remaining, 0);
    part2.set(rest, r1.remaining.length);

    const r2 = unframeMllp(part2);
    expect(r2.messages).toEqual(["SECOND"]);
    expect(r2.remaining.length).toBe(0);
  });

  test("byte de control ENQ fuera de frame", () => {
    const m = frameMllp("HOLA");
    const buf = new Uint8Array(1 + m.length);
    buf[0] = ENQ;
    buf.set(m, 1);
    const r = unframeMllp(buf);
    expect(r.controlBytes).toEqual([ENQ]);
    expect(r.messages).toEqual(["HOLA"]);
  });

  test("multiples bytes de control y heartbeat", () => {
    const buf = new Uint8Array([ENQ, ACK_BYTE, HEARTBEAT, HEARTBEAT]);
    const r = unframeMllp(buf);
    expect(r.controlBytes).toEqual([ENQ, ACK_BYTE, HEARTBEAT, HEARTBEAT]);
    expect(r.messages).toEqual([]);
  });

  test("basura desconocida fuera de frame se descarta", () => {
    const m = frameMllp("OK");
    const buf = new Uint8Array(2 + m.length);
    buf[0] = 0x77; // 'w' suelto
    buf[1] = 0x21; // '!' suelto
    buf.set(m, 2);
    const r = unframeMllp(buf);
    expect(r.messages).toEqual(["OK"]);
    expect(r.controlBytes).toEqual([]); // no son bytes de control conocidos
  });

  test("VT anidado: descarta el frame corrupto y empieza nuevo", () => {
    // VT, "AAA", VT, "BBB", FS, CR  → solo el segundo es valido
    const buf = new Uint8Array([
      VT, 0x41, 0x41, 0x41,
      VT, 0x42, 0x42, 0x42, FS, CR,
    ]);
    const r = unframeMllp(buf);
    expect(r.messages).toEqual(["BBB"]);
  });

  test("mensaje con UTF-8 multibyte", () => {
    const m = frameMllp("José");
    const r = unframeMllp(m);
    expect(r.messages).toEqual(["José"]);
  });

  test("mensaje con CR dentro del payload (separador de segmentos HL7)", () => {
    // HL7 usa CR como separador de segmentos. Eso NO debe confundir al unframer
    // porque el unframer busca FS+CR juntos, no CR solo.
    const hl7 = "MSH|^~\\&|\rPID|1||\rOBR|1||";
    const m = frameMllp(hl7);
    const r = unframeMllp(m);
    expect(r.messages).toEqual([hl7]);
  });
});
