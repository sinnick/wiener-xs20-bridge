/**
 * Decoder de histogramas embebidos en OBX con valueType=ED.
 *
 * El XS 20 envia tres histogramas (WBC, RBC, PLT) cada uno como 256 bytes
 * (uno por canal del ADC) codificados en Base64 dentro del componente 5
 * del campo OBX-5.
 *
 * Estructura del OBX-5 con valueType=ED:
 *   <sourceApp>^<typeOfData>^<dataSubtype>^<encoding>^<base64payload>
 *
 * Ejemplo:
 *   ^Application^Octer-stream^Base64^AAAAAAABAwk...
 *
 * Notas:
 *  - "Octer-stream" es un typo del fabricante (deberia ser "Octet-stream").
 *    Lo aceptamos asi porque asi viene en el documento Mindray.
 *  - El payload deberia decodificar a EXACTAMENTE 256 bytes; si no, error.
 */

import type { EncapsulatedData } from "@xs20/shared";
import { getString } from "./parser.js";
import type { Hl7Segment } from "@xs20/shared";
import { HISTOGRAM_CHANNEL_COUNT } from "./protocol-map.js";

export class HistogramDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistogramDecodeError";
  }
}

/**
 * Extrae los componentes del OBX-5 como `EncapsulatedData`.
 * Devuelve undefined si el OBX no tiene el formato esperado.
 */
export function parseEncapsulatedData(seg: Hl7Segment): EncapsulatedData | undefined {
  const sourceApp = getString(seg, 5, 1);
  const typeOfData = getString(seg, 5, 2);
  const dataSubtype = getString(seg, 5, 3);
  const encoding = getString(seg, 5, 4);
  const data = getString(seg, 5, 5);

  if (typeOfData === undefined || encoding === undefined || data === undefined) {
    return undefined;
  }

  return {
    sourceApp: sourceApp ?? "",
    typeOfData,
    dataSubtype: dataSubtype ?? "",
    encoding,
    data,
  };
}

/**
 * Decodifica el payload Base64 a un Uint8Array de exactamente 256 bytes.
 *
 * @throws HistogramDecodeError si el encoding no es Base64 o el resultado
 * no tiene exactamente 256 bytes.
 */
export function decodeHistogramPayload(ed: EncapsulatedData): Uint8Array {
  if (ed.encoding.toLowerCase() !== "base64") {
    throw new HistogramDecodeError(
      `Encoding no soportado: "${ed.encoding}" (se esperaba Base64)`,
    );
  }

  let bytes: Uint8Array;
  try {
    // atob produce una string binaria; la convertimos a bytes.
    const binStr = atob(ed.data);
    bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
  } catch (e) {
    throw new HistogramDecodeError(`Base64 invalido: ${(e as Error).message}`);
  }

  if (bytes.length !== HISTOGRAM_CHANNEL_COUNT) {
    throw new HistogramDecodeError(
      `Histograma debe tener ${HISTOGRAM_CHANNEL_COUNT} bytes, tiene ${bytes.length}`,
    );
  }

  return bytes;
}

/**
 * Codifica un Uint8Array de 256 bytes a Base64 (para tests/simulator).
 */
export function encodeHistogramPayload(channels: Uint8Array): string {
  if (channels.length !== HISTOGRAM_CHANNEL_COUNT) {
    throw new HistogramDecodeError(
      `Histograma debe tener ${HISTOGRAM_CHANNEL_COUNT} bytes, tiene ${channels.length}`,
    );
  }
  let binStr = "";
  for (let i = 0; i < channels.length; i++) {
    binStr += String.fromCharCode(channels[i]!);
  }
  return btoa(binStr);
}
