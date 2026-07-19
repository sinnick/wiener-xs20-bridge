/**
 * Tipos de dominio del hemograma (CBC + 3-DIFF) que produce el XS 20.
 *
 * Esta es la estructura que el resto del sistema (DB, API, UI) consume.
 * Es independiente de HL7: el parser convierte HL7 → este tipo.
 */

// ─── Parametros del hemograma ────────────────────────────────────────────────

/** Codigo canonico de cada parametro. Los usamos como id internos. */
export const HEMOGRAM_PARAMS = [
  "wbc",
  "lym_abs",
  "lym_pct",
  "mid_abs",
  "mid_pct",
  "gran_abs",
  "gran_pct",
  "rbc",
  "hgb",
  "hct",
  "mcv",
  "mch",
  "mchc",
  "rdw_cv",
  "rdw_sd",
  "plt",
  "mpv",
  "pdw",
  "pct",
] as const;

export type HemogramParam = (typeof HEMOGRAM_PARAMS)[number];

/** Bandera de anormalidad por parametro. Se mapea desde OBX-8. */
export type AbnormalFlag =
  | "N" // normal
  | "H" // alto
  | "L" // bajo
  | "HH" // critico alto
  | "LL" // critico bajo
  | "A"; // anormal generico

/** Valor de un parametro individual. */
export interface HemogramValue {
  value: number; // OBX-5 parseado a numero
  unit: string; // OBX-6 (ej "10*9/L", "g/L", "fL", "%")
  refRange: string | null; // OBX-7 (ej "4.0-10.0")
  flags: AbnormalFlag[]; // OBX-8 (multiples flags posibles)
}

/** Histograma crudo: 256 canales, cada canal es un byte 0-255. */
export interface Histogram {
  type: "wbc" | "rbc" | "plt";
  channels: Uint8Array; // exactamente 256 elementos
  // Discriminadores opcionales del equipo (lineas que separan poblaciones)
  discriminators: {
    leftLine?: number;
    midLine?: number;
    rightLine?: number;
  };
}

/**
 * Codifica un Uint8Array de 256 bytes a Base64.
 * Util para tests, simulador, y serializacion API.
 */
export function encodeHistogramBase64(channels: Uint8Array): string {
  if (channels.length !== 256) {
    throw new Error(`Histograma debe tener 256 bytes, tiene ${channels.length}`);
  }
  let binStr = "";
  for (let i = 0; i < channels.length; i++) {
    binStr += String.fromCharCode(channels[i]!);
  }
  return btoa(binStr);
}

/**
 * Decodifica un payload Base64 a un Uint8Array de 256 bytes.
 */
export function decodeHistogramBase64(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  if (bytes.length !== 256) {
    throw new Error(`Histograma debe tener 256 bytes, tiene ${bytes.length}`);
  }
  return bytes;
}

/** Flag morfologica del segmento OBX 99MRC (sospechas/alarmas). */
export interface MorphologyFlag {
  code: string; // ej "Leukocytosis", "Anisocytosis", "Imm Granulocytes?"
  raised: boolean; // true si el equipo levanto la alarma
}

// ─── Resultado completo de una corrida ────────────────────────────────────────

export interface PatientInfo {
  patientId: string | null; // PID-3 (numero de historia clinica)
  name: string | null; // PID-5 (apellido^nombre)
  birthDate: string | null; // PID-7 (YYYYMMDD)
  sex: "M" | "F" | "U" | null; // PID-8
  ageYears: number | null; // del OBX 30525-0 si viene
}

export interface SampleInfo {
  sampleId: string; // OBR-3 — identificador unico de la muestra
  takeMode: string | null; // O = open tube, etc.
  bloodMode: "W" | "P" | null; // Whole / Predilute
  testMode: string | null; // CBC, CBC+DIFF, etc.
  drawnAt: Date | null; // OBR-7
  analyzedAt: Date | null; // OBR-8
  operator: string | null; // OBR-10
  refGroup: string | null; // grupo de referencia usado
  comments: string | null;
}

export interface HemogramResult {
  /** ID unico generado por el servicio (ULID/UUID). */
  id: string;

  /** Cuando llego al servicio. */
  receivedAt: Date;

  /** Identificacion del mensaje HL7 (MSH-10) — sirve para idempotencia. */
  messageControlId: string;

  patient: PatientInfo;
  sample: SampleInfo;

  /** Valores numericos. La key es el codigo canonico (HemogramParam). */
  values: Partial<Record<HemogramParam, HemogramValue>>;

  /** Histogramas crudos (puede haber 0 a 3). */
  histograms: Histogram[];

  /** Alarmas/sospechas morfologicas levantadas por el equipo. */
  morphologyFlags: MorphologyFlag[];
}
