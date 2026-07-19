/**
 * Parser HL7 v2.3.1 generico.
 *
 * Convierte un mensaje HL7 textual (sin framing MLLP) en un AST tipado.
 * No interpreta los datos: eso es trabajo del obx-mapper.
 *
 * Reglas HL7 v2.3.1 estandar:
 *  - Segmentos separados por \r (CR).
 *  - Dentro de cada segmento, el primer "campo" es el nombre (3 letras).
 *  - Los campos siguientes se separan por |
 *  - Los componentes dentro de un campo por ^
 *  - Las repeticiones de un campo por ~
 *  - Los subcomponentes por &
 *  - El caracter de escape es \
 *
 * Caso especial: el segmento MSH es raro porque MSH-1 ES el separador (|) y
 * MSH-2 son los caracteres de codificacion (^~\&). Lo manejamos como excepcion.
 */

import type {
  Hl7Component,
  Hl7Field,
  Hl7Message,
  Hl7Repetition,
  Hl7Segment,
} from "@xs20/shared";

export class Hl7ParseError extends Error {
  constructor(
    message: string,
    public readonly position?: number,
  ) {
    super(message);
    this.name = "Hl7ParseError";
  }
}

const DEFAULT_DELIMS = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
};

interface Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

/**
 * Parsea un mensaje HL7 completo (sin framing MLLP).
 *
 * Acepta tanto separador de segmentos \r como \n y \r\n (tolerante).
 */
export function parseHl7(text: string): Hl7Message {
  if (!text || text.length === 0) {
    throw new Hl7ParseError("Mensaje vacio");
  }

  // Validar y extraer delimitadores del MSH.
  if (!text.startsWith("MSH")) {
    throw new Hl7ParseError(`Mensaje debe empezar con MSH, empieza con "${text.slice(0, 3)}"`);
  }
  if (text.length < 8) {
    throw new Hl7ParseError("MSH demasiado corto para contener delimitadores");
  }

  const fieldSep = text[3]!; // tipicamente "|"
  const compSep = text[4]!; // tipicamente "^"
  const repSep = text[5]!; // tipicamente "~"
  const escChar = text[6]!; // tipicamente "\"
  const subSep = text[7]!; // tipicamente "&"

  const delims: Delimiters = {
    field: fieldSep,
    component: compSep,
    repetition: repSep,
    escape: escChar,
    subcomponent: subSep,
  };

  // Normalizar separadores de linea: aceptamos \r, \n y \r\n.
  // El estandar es \r pero a veces el transporte intermedio los cambia.
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");

  const segmentTexts = normalized.split("\r").filter((s) => s.length > 0);
  const segments: Hl7Segment[] = segmentTexts.map((raw) => parseSegment(raw, delims));

  return {
    segments,
    raw: text,
    receivedAt: new Date(),
  };
}

function parseSegment(rawSegment: string, delims: Delimiters): Hl7Segment {
  if (rawSegment.length < 3) {
    throw new Hl7ParseError(`Segmento demasiado corto: "${rawSegment}"`);
  }

  const name = rawSegment.slice(0, 3);

  // Caso especial MSH:
  //  rawSegment = "MSH|^~\\&|...rest"
  //  fields[0] debe ser "^~\\&" (segun convencion HL7 hapi/nhapi)
  //  los siguientes campos se parsean a partir de la posicion 8.
  if (name === "MSH") {
    const encodingChars = rawSegment.slice(4, 8); // "^~\\&"
    const rest = rawSegment.slice(8); // empieza con el separador de campo

    // El primer caracter de "rest" es el field separator. Si lo hay, splitamos a partir de ahi.
    const restFields = rest.length > 0 && rest[0] === delims.field
      ? rest.slice(1).split(delims.field)
      : rest.split(delims.field);

    // MSH-1 (field separator) y MSH-2 (encoding chars) son strings opacos:
    // NO se sub-parsean por componente/repeticion/etc., porque ESOS son los
    // mismos caracteres especiales. Los guardamos como single-component fields.
    const fields: Hl7Field[] = [
      [[[delims.field]]], // MSH-1
      [[[encodingChars]]], // MSH-2
      ...restFields.map((f) => parseField(f, delims)),
    ];

    return { name, fields, raw: rawSegment };
  }

  // Caso general: split por field separator.
  const parts = rawSegment.split(delims.field);
  // parts[0] es el nombre del segmento; los campos van desde parts[1].
  const fields = parts.slice(1).map((f) => parseField(f, delims));

  return { name, fields, raw: rawSegment };
}

function parseField(text: string, delims: Delimiters): Hl7Field {
  // Un campo puede tener repeticiones separadas por ~
  if (text.length === 0) {
    return [[[""]]];
  }
  const reps = text.split(delims.repetition);
  return reps.map((rep) => parseRepetition(rep, delims));
}

function parseRepetition(text: string, delims: Delimiters): Hl7Repetition {
  // Una repeticion tiene componentes separados por ^
  const comps = text.split(delims.component);
  return comps.map((c) => parseComponent(c, delims));
}

function parseComponent(text: string, delims: Delimiters): Hl7Component {
  // Un componente tiene subcomponentes separados por &
  return text.split(delims.subcomponent);
}

// ─── Helpers de acceso tipado ────────────────────────────────────────────────

/**
 * Devuelve todos los segmentos con un nombre dado, en orden de aparicion.
 */
export function getSegments(msg: Hl7Message, name: string): Hl7Segment[] {
  return msg.segments.filter((s) => s.name === name);
}

/**
 * Devuelve el primer segmento con un nombre dado, o undefined.
 */
export function getSegment(msg: Hl7Message, name: string): Hl7Segment | undefined {
  return msg.segments.find((s) => s.name === name);
}

/**
 * Devuelve el campo n-esimo de un segmento (1-indexed, segun convencion HL7).
 * fieldIndex=1 => primer campo despues del nombre del segmento.
 */
export function getField(seg: Hl7Segment, fieldIndex: number): Hl7Field | undefined {
  return seg.fields[fieldIndex - 1];
}

/**
 * Atajo: devuelve el componente compIndex (1-indexed) de la primera repeticion
 * del campo fieldIndex (1-indexed) del segmento, como string crudo.
 *
 * Si algo no existe, devuelve undefined (NO string vacio: distinguimos "campo
 * presente pero vacio" de "campo ausente").
 */
export function getString(
  seg: Hl7Segment,
  fieldIndex: number,
  compIndex = 1,
  subIndex = 1,
): string | undefined {
  const field = getField(seg, fieldIndex);
  if (!field) return undefined;
  const rep = field[0];
  if (!rep) return undefined;
  const comp = rep[compIndex - 1];
  if (!comp) return undefined;
  const sub = comp[subIndex - 1];
  return sub;
}

/**
 * Devuelve todas las repeticiones de un campo como strings (componente 1).
 */
export function getRepeats(seg: Hl7Segment, fieldIndex: number): string[] {
  const field = getField(seg, fieldIndex);
  if (!field) return [];
  return field.map((rep) => rep[0]?.[0] ?? "");
}
