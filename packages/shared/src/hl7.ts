/**
 * Tipos del HL7 v2.3.1 que habla el Wiener XS 20 (Mindray BC-20s).
 *
 * Referencia: "BC-20S & 30S Communication Protocol V1.0 EN" (Mindray)
 * + Mensajes capturados/de ejemplo del fabricante OEM.
 */

// ─── Delimitadores estandar HL7 ─────────────────────────────────────────────
// Estos son fijos en HL7 v2.x. NO los configuramos: vienen en MSH-1 y MSH-2 del
// propio mensaje y los validamos al parsear.
export const HL7_DELIMITERS = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
  segment: "\r", // CR (0x0D)
} as const;

// ─── MLLP framing ────────────────────────────────────────────────────────────
// Minimal Lower Layer Protocol: cada mensaje HL7 va envuelto en VT...FS CR
export const MLLP = {
  START: 0x0b, // <VT>
  END: 0x1c, // <FS>
  CR: 0x0d, // <CR>
} as const;

// ─── Estructura de un mensaje parseado ───────────────────────────────────────

/** Un campo HL7 puede tener repeticiones (`~`) y cada repeticion componentes (`^`). */
export type Hl7Field = Hl7Repetition[];
export type Hl7Repetition = Hl7Component[];
export type Hl7Component = Hl7Subcomponent[];
export type Hl7Subcomponent = string;

/** Un segmento es un nombre (3 letras) + sus campos en orden. */
export interface Hl7Segment {
  name: string; // "MSH" | "PID" | "OBR" | "OBX" | "PV1" | etc.
  fields: Hl7Field[]; // fields[0] sera el primer campo despues del nombre del segmento
  raw: string; // linea original (para auditoria y debug)
}

/** Un mensaje completo es una lista ordenada de segmentos. */
export interface Hl7Message {
  segments: Hl7Segment[];
  raw: string; // mensaje completo sin framing MLLP
  receivedAt: Date;
}

// ─── Helpers tipados para acceder a los segmentos comunes ────────────────────

export interface MshHeader {
  fieldSeparator: string; // siempre "|"
  encodingChars: string; // siempre "^~\\&"
  sendingApp: string; // MSH-3 (puede venir vacio)
  sendingFacility: string; // MSH-4
  receivingApp: string; // MSH-5
  receivingFacility: string; // MSH-6
  timestamp: string; // MSH-7, formato YYYYMMDDHHMMSS
  messageType: string; // MSH-9, ej "ORU^R01"
  messageControlId: string; // MSH-10 — lo necesitamos para construir el ACK
  processingId: string; // MSH-11, "P" produccion / "T" test
  versionId: string; // MSH-12, "2.3.1"
  characterSet: string; // MSH-18, esperado "UNICODE" (UTF-8)
}

/** OBX (observacion individual) — el segmento que carga cada parametro. */
export interface ObxSegment {
  setId: number; // OBX-1
  valueType: ObxValueType; // OBX-2
  observationCode: string; // OBX-3.1, ej "6690-2"
  observationName: string; // OBX-3.2, ej "WBC"
  observationCodingSystem: string; // OBX-3.3, ej "LN" (LOINC) o "99MRC" (Mindray)
  value: string; // OBX-5 — valor crudo, parsear segun valueType
  units: string; // OBX-6, ej "10*9/L"
  referenceRange: string; // OBX-7, ej "4.0-10.0"
  abnormalFlags: string[]; // OBX-8, separados por ~ (N, H, L, A, etc.)
  resultStatus: string; // OBX-11, "F" final / "P" preliminar
}

export type ObxValueType =
  | "NM" // numerico
  | "IS" // codigo de tabla
  | "ST" // string
  | "ED"; // encapsulated data (histogramas, base64)

/** Datos encapsulados (histogramas): OBX-5 con valueType=ED. */
export interface EncapsulatedData {
  sourceApp: string; // primer campo del OBX-5 (puede ser "")
  typeOfData: string; // "Application"
  dataSubtype: string; // "Octer-stream" (sic, asi viene en el doc)
  encoding: string; // "Base64"
  data: string; // payload base64 — decodificar a Uint8Array de 256 bytes
}
