/**
 * Generador de mensajes HL7 realistas para testing sin equipo fisico.
 *
 * Produce ORU^R01 con datos plausibles y variados: pacientes con nombres
 * reales, sample IDs unicos, valores dentro o fuera de rango (con sus flags),
 * histogramas sinteticos, y flags morfologicas coherentes con los valores.
 *
 * Esto es tu "equipo virtual": permite generar el volumen y la variedad que
 * un dia de laboratorio produciria, para probar la UI, la paginacion, los
 * filtros y la performance de la DB.
 */

import { encodeHistogramBase64 } from "./hemogram.js";

const CR = "\r";

// ─── Datos base para variar ──────────────────────────────────────────────────

const APELLIDOS = [
  "Perez", "Gonzalez", "Rodriguez", "Fernandez", "Lopez", "Martinez", "Garcia",
  "Sanchez", "Romero", "Diaz", "Alvarez", "Torres", "Ruiz", "Ramirez", "Flores",
  "Benitez", "Acosta", "Medina", "Herrera", "Aguirre", "Gimenez", "Sosa",
];
const NOMBRES_M = ["Juan", "Carlos", "Jose", "Luis", "Miguel", "Jorge", "Pedro", "Diego", "Pablo", "Martin"];
const NOMBRES_F = ["Maria", "Ana", "Laura", "Sofia", "Lucia", "Carmen", "Elena", "Julia", "Paula", "Valentina"];
const OPERADORES = ["tecnico1", "tecnico2", "bioquimica1", "guardia"];
const TEST_MODES = ["CBC", "CBC+DIFF"];

// ─── Definicion de cada parametro: rango normal + unidad + codigo OBX ─────────
// Rangos de referencia tipicos de adulto (solo para generar datos plausibles).

interface ParamDef {
  code: string;
  name: string;
  coding: "LN" | "99MRC";
  unit: string;
  refLow: number;
  refHigh: number;
  decimals: number;
}

const PARAM_DEFS: ParamDef[] = [
  { code: "6690-2", name: "WBC", coding: "LN", unit: "10*9/L", refLow: 4.0, refHigh: 10.0, decimals: 1 },
  { code: "731-0", name: "LYM#", coding: "LN", unit: "10*9/L", refLow: 0.8, refHigh: 4.0, decimals: 1 },
  { code: "736-9", name: "LYM%", coding: "LN", unit: "%", refLow: 20.0, refHigh: 40.0, decimals: 1 },
  { code: "10027", name: "MID#", coding: "99MRC", unit: "10*9/L", refLow: 0.1, refHigh: 1.5, decimals: 1 },
  { code: "10029", name: "MID%", coding: "99MRC", unit: "%", refLow: 3.0, refHigh: 15.0, decimals: 1 },
  { code: "10028", name: "GRAN#", coding: "99MRC", unit: "10*9/L", refLow: 2.0, refHigh: 7.0, decimals: 1 },
  { code: "10030", name: "GRAN%", coding: "99MRC", unit: "%", refLow: 50.0, refHigh: 70.0, decimals: 1 },
  { code: "789-8", name: "RBC", coding: "LN", unit: "10*12/L", refLow: 4.0, refHigh: 5.5, decimals: 2 },
  { code: "718-7", name: "HGB", coding: "LN", unit: "g/L", refLow: 120, refHigh: 160, decimals: 0 },
  { code: "4544-3", name: "HCT", coding: "LN", unit: "%", refLow: 36.0, refHigh: 50.0, decimals: 1 },
  { code: "787-2", name: "MCV", coding: "LN", unit: "fL", refLow: 80.0, refHigh: 99.0, decimals: 1 },
  { code: "785-6", name: "MCH", coding: "LN", unit: "pg", refLow: 26.0, refHigh: 32.0, decimals: 1 },
  { code: "786-4", name: "MCHC", coding: "LN", unit: "g/L", refLow: 320, refHigh: 360, decimals: 0 },
  { code: "788-0", name: "RDW-CV", coding: "LN", unit: "%", refLow: 11.0, refHigh: 16.0, decimals: 1 },
  { code: "21000-5", name: "RDW-SD", coding: "LN", unit: "fL", refLow: 35.0, refHigh: 56.0, decimals: 1 },
  { code: "777-3", name: "PLT", coding: "LN", unit: "10*9/L", refLow: 100, refHigh: 300, decimals: 0 },
  { code: "32623-1", name: "MPV", coding: "LN", unit: "fL", refLow: 6.5, refHigh: 12.0, decimals: 1 },
  { code: "32207-3", name: "PDW", coding: "LN", unit: "", refLow: 9.0, refHigh: 17.0, decimals: 1 },
  { code: "10002", name: "PCT", coding: "99MRC", unit: "%", refLow: 0.1, refHigh: 0.3, decimals: 2 },
];

// ─── PRNG deterministico (para reproducibilidad con seed) ────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

// ─── Opciones de generacion ──────────────────────────────────────────────────

export interface GenerateOptions {
  /** Control ID del mensaje (MSH-10). Si no se da, se genera uno unico. */
  messageControlId?: string;
  /** Sample ID (OBR-3). Si no se da, se genera uno unico. */
  sampleId?: string;
  /** Seed para reproducibilidad. Si no se da, usa Date.now + random. */
  seed?: number;
  /** Probabilidad [0..1] de que un parametro dado salga fuera de rango. Default 0.15. */
  abnormalRate?: number;
  /** Incluir los 3 histogramas. Default true. */
  withHistograms?: boolean;
  /** Timestamp del analisis. Default: ahora. */
  analyzedAt?: Date;
}

let globalCounter = 0;

/**
 * Genera un mensaje ORU^R01 completo y realista.
 */
export function generateOruMessage(opts: GenerateOptions = {}): string {
  const seed = opts.seed ?? (Date.now() ^ (globalCounter++ << 16)) >>> 0;
  const rng = makeRng(seed);
  const abnormalRate = opts.abnormalRate ?? 0.15;
  const withHistograms = opts.withHistograms ?? true;
  const now = opts.analyzedAt ?? new Date();

  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const isFemale = rng() < 0.5;
  const apellido = pick(APELLIDOS);
  const nombre = isFemale ? pick(NOMBRES_F) : pick(NOMBRES_M);
  const sexHl7 = isFemale ? "Female" : "Male";

  const controlId = opts.messageControlId ?? `MSG-${Date.now()}-${globalCounter}`;
  const sampleId = opts.sampleId ?? `S${formatDate(now)}-${String(Math.floor(rng() * 9999)).padStart(4, "0")}`;
  const mrn = `MR${String(Math.floor(rng() * 900000) + 100000)}`;
  const birthYear = 1940 + Math.floor(rng() * 70);
  const birthDate = `${birthYear}${String(1 + Math.floor(rng() * 12)).padStart(2, "0")}${String(1 + Math.floor(rng() * 28)).padStart(2, "0")}000000`;
  const operator = pick(OPERADORES);
  const testMode = pick(TEST_MODES);
  const ts = formatDateTime(now);

  const segments: string[] = [];
  segments.push(
    `MSH|^~\\&|||||${ts}||ORU^R01|${controlId}|P|2.3.1||||||UNICODE`,
  );
  segments.push(
    `PID|1||${mrn}^^^^MR||${apellido}^${nombre}||${birthDate}|${sexHl7}`,
  );
  segments.push(
    `OBR|1||${sampleId}|00001^Automated Count^99MRC||${ts}|${ts}|||${operator}||||||||||||||HM`,
  );

  let setId = 1;
  segments.push(`OBX|${setId++}|IS|08001^Take Mode^99MRC||O||||||F`);
  segments.push(`OBX|${setId++}|IS|08002^Blood Mode^99MRC||W||||||F`);
  segments.push(`OBX|${setId++}|IS|08003^Test Mode^99MRC||${testMode}||||||F`);
  segments.push(`OBX|${setId++}|ST|01001^Ref Group^99MRC||General||||||F`);

  // Parametros numericos
  const outOfRange: Record<string, "H" | "L"> = {};
  for (const p of PARAM_DEFS) {
    const range = p.refHigh - p.refLow;
    let value: number;
    let flag = "N";

    if (rng() < abnormalRate) {
      // Fuera de rango: arriba o abajo
      if (rng() < 0.5) {
        value = p.refHigh + range * (0.1 + rng() * 0.5);
        flag = "H";
        outOfRange[p.name] = "H";
      } else {
        value = Math.max(0, p.refLow - range * (0.1 + rng() * 0.4));
        flag = "L";
        outOfRange[p.name] = "L";
      }
    } else {
      // Dentro de rango
      value = p.refLow + range * (0.15 + rng() * 0.7);
    }

    const valStr = value.toFixed(p.decimals);
    const refStr = `${p.refLow}-${p.refHigh}`;
    segments.push(
      `OBX|${setId++}|NM|${p.code}^${p.name}^${p.coding}||${valStr}|${p.unit}|${refStr}|${flag}|||F`,
    );
  }

  // Flags morfologicas coherentes con los valores fuera de rango
  const morphFlags = deriveMorphologyFlags(outOfRange);
  for (const flag of morphFlags) {
    segments.push(`OBX|${setId++}|ST|^${flag}^99MRC||${flag}||||||F`);
  }

  // Histogramas
  if (withHistograms) {
    const wbc = encodeHistogramBase64(gaussianHistogram(rng, 120, 35, 200));
    const rbc = encodeHistogramBase64(gaussianHistogram(rng, 150, 25, 220));
    const plt = encodeHistogramBase64(gaussianHistogram(rng, 40, 15, 180));
    segments.push(`OBX|${setId++}|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^${wbc}|||||F`);
    segments.push(`OBX|${setId++}|NM|15001^WBC Left Line^99MRC||${40 + Math.floor(rng() * 10)}||||||F`);
    segments.push(`OBX|${setId++}|NM|15002^WBC Mid Line^99MRC||${110 + Math.floor(rng() * 20)}||||||F`);
    segments.push(`OBX|${setId++}|NM|15003^WBC Right Line^99MRC||${210 + Math.floor(rng() * 20)}||||||F`);
    segments.push(`OBX|${setId++}|ED|15010^RBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^${rbc}|||||F`);
    segments.push(`OBX|${setId++}|NM|15011^RBC Left Line^99MRC||${45 + Math.floor(rng() * 10)}||||||F`);
    segments.push(`OBX|${setId++}|NM|15012^RBC Right Line^99MRC||${220 + Math.floor(rng() * 15)}||||||F`);
    segments.push(`OBX|${setId++}|ED|15020^PLT Histogram. Binary^99MRC||^Application^Octer-stream^Base64^${plt}|||||F`);
    segments.push(`OBX|${setId++}|NM|15021^PLT Left Line^99MRC||${8 + Math.floor(rng() * 6)}||||||F`);
    segments.push(`OBX|${setId++}|NM|15022^PLT Right Line^99MRC||${75 + Math.floor(rng() * 15)}||||||F`);
  }

  return segments.join(CR);
}

/**
 * Genera N mensajes, cada uno con su control ID y sample ID unicos.
 */
export function generateBatch(count: number, baseOpts: GenerateOptions = {}): string[] {
  const out: string[] = [];
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    out.push(
      generateOruMessage({
        ...baseOpts,
        messageControlId: `MSG-${base}-${i}`,
        seed: baseOpts.seed !== undefined ? baseOpts.seed + i : undefined,
      }),
    );
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deriva flags morfologicas coherentes con que parametros salieron fuera de rango. */
function deriveMorphologyFlags(outOfRange: Record<string, "H" | "L">): string[] {
  const flags: string[] = [];
  if (outOfRange["WBC"] === "H") flags.push("Leukocytosis");
  if (outOfRange["WBC"] === "L") flags.push("Leukopenia");
  if (outOfRange["GRAN#"] === "H") flags.push("Neutrophilia");
  if (outOfRange["LYM#"] === "H") flags.push("Lymphocytosis");
  if (outOfRange["HGB"] === "L") flags.push("Anemia");
  if (outOfRange["MCV"] === "L") flags.push("Microcytes");
  if (outOfRange["MCV"] === "H") flags.push("Macrocytes");
  if (outOfRange["PLT"] === "H") flags.push("Thrombocytosis");
  if (outOfRange["PLT"] === "L") flags.push("Thrombopenia");
  return flags;
}

/** Histograma con forma gaussiana + ruido, usando el RNG del mensaje. */
function gaussianHistogram(
  rng: () => number,
  mean: number,
  stdDev: number,
  scale: number,
): Uint8Array {
  const channels = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const z = (i - mean) / stdDev;
    const base = Math.exp(-0.5 * z * z) * scale;
    const noise = (rng() - 0.5) * 8;
    channels[i] = Math.max(0, Math.min(255, Math.round(base + noise)));
  }
  return channels;
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(d)}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
