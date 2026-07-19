/**
 * MLLP (Minimal Lower Layer Protocol) — framing para HL7 sobre TCP.
 *
 * Cada mensaje HL7 va envuelto en: <VT> ...payload UTF-8... <FS><CR>
 *  - VT = 0x0B (start)
 *  - FS = 0x1C (end)
 *  - CR = 0x0D (terminator del end)
 *
 * El XS 20 tambien puede enviar bytes de control fuera del frame:
 *  - ENQ = 0x05 (handshake)
 *  - ACK = 0x06 (OK)
 *  - 0x02 = heartbeat
 */

export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

export const ENQ = 0x05;
export const ACK_BYTE = 0x06;
export const HEARTBEAT = 0x02;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const TEXT_ENCODER = new TextEncoder();

export function frameMllp(hl7: string): Uint8Array {
  const payload = TEXT_ENCODER.encode(hl7);
  const out = new Uint8Array(payload.length + 3);
  out[0] = VT;
  out.set(payload, 1);
  out[out.length - 2] = FS;
  out[out.length - 1] = CR;
  return out;
}

export interface UnframeResult {
  /** Mensajes HL7 completos extraidos (sin framing MLLP). */
  messages: string[];
  /** Bytes de control conocidos (ENQ/ACK/HEARTBEAT) hallados fuera de frame. */
  controlBytes: number[];
  /** Buffer remanente — el caller lo concatena con los proximos bytes y vuelve a llamar. */
  remaining: Uint8Array;
}

/**
 * Procesa un buffer con potencialmente:
 *  - cero o mas frames MLLP completos
 *  - un frame parcial al final (sin FS+CR todavia)
 *  - bytes de control fuera de frame (ENQ/ACK/heartbeat)
 *  - basura suelta entre frames (la descartamos silenciosamente)
 */
export function unframeMllp(buffer: Uint8Array): UnframeResult {
  const messages: string[] = [];
  const controlBytes: number[] = [];

  let i = 0;
  let consumedUpTo = 0;

  outer: while (i < buffer.length) {
    if (buffer[i] !== VT) {
      // Fuera de frame.
      const byte = buffer[i]!;
      if (byte === ENQ || byte === ACK_BYTE || byte === HEARTBEAT) {
        controlBytes.push(byte);
      }
      i++;
      consumedUpTo = i;
      continue;
    }

    // Dentro de frame: i apunta al VT.
    const frameStart = i;

    for (let j = i + 1; j < buffer.length - 1; j++) {
      if (buffer[j] === VT) {
        // VT anidado: descartamos el frame previo, reiniciamos desde el nuevo VT.
        i = j;
        consumedUpTo = j;
        continue outer;
      }
      if (buffer[j] === FS && buffer[j + 1] === CR) {
        // Frame completo: payload va de frameStart+1 a j (exclusivo).
        messages.push(TEXT_DECODER.decode(buffer.subarray(frameStart + 1, j)));
        i = j + 2;
        consumedUpTo = i;
        continue outer;
      }
    }

    // No encontramos FS+CR — frame incompleto, queda en remaining.
    break;
  }

  return {
    messages,
    controlBytes,
    remaining: buffer.subarray(consumedUpTo),
  };
}
