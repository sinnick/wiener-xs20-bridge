/**
 * Mapper OBX → HemogramResult.
 *
 * Toma un Hl7Message ya parseado y produce la estructura de dominio que el
 * resto del sistema (DB, API, UI) consume.
 *
 * Tabla autoritativa: ver docs/04-mapeo-obx.md
 */

import type {
  AbnormalFlag,
  HemogramParam,
  HemogramResult,
  HemogramValue,
  Histogram,
  Hl7Message,
  Hl7Segment,
  MorphologyFlag,
  PatientInfo,
  SampleInfo,
} from "@xs20/shared";
import { getRepeats, getSegment, getSegments, getString } from "./parser.js";
import { decodeHistogramPayload, parseEncapsulatedData } from "./histogram.js";
import {
  ABNORMAL_FLAG_CODES,
  BLOOD_MODE_VALUES,
  DISCRIMINATOR_CODES,
  HISTOGRAM_CHANNEL_COUNT,
  HISTOGRAM_CODES,
  OBR_FIELD,
  PARAM_CODE_TO_CANON,
  SAMPLE_META_CODES,
  SAMPLE_META_CODE_SET,
  SEX_MAP,
} from "./protocol-map.js";

// ─── Resultado del mapeo (incluye warnings para que el caller los loggee) ────

export interface MapResult {
  hemogram: HemogramResult;
  /** Warnings no fatales: codigos OBX desconocidos, valores raros, etc. */
  warnings: MapWarning[];
}

export interface MapWarning {
  type: "unknown_obx_code" | "invalid_number" | "histogram_decode_error" | "missing_segment";
  message: string;
  context?: Record<string, unknown>;
}

// ─── Funcion principal ───────────────────────────────────────────────────────

export function mapMessageToHemogram(
  msg: Hl7Message,
  opts: { id: string; receivedAt: Date },
): MapResult {
  const warnings: MapWarning[] = [];

  const msh = getSegment(msg, "MSH");
  if (!msh) {
    throw new Error("Mensaje sin MSH — no debiera pasar (validar antes)");
  }

  const messageControlId = getString(msh, 10) ?? "";

  const pid = getSegment(msg, "PID");
  const obr = getSegment(msg, "OBR");

  if (!obr) {
    warnings.push({
      type: "missing_segment",
      message: "Mensaje sin segmento OBR — sample_id no disponible",
    });
  }

  const patient = extractPatient(pid);
  const sample = extractSample(obr, msg);

  // Procesamos los OBX:
  //  - parametros numericos → values
  //  - histogramas → histograms (acumulan discriminadores adyacentes)
  //  - flags morfologicas → morphologyFlags
  //  - todo lo demas (metadata) ya fue extraido en extractSample/extractPatient
  const obxs = getSegments(msg, "OBX");
  const values: Partial<Record<HemogramParam, HemogramValue>> = {};
  const histogramsByType = new Map<Histogram["type"], Histogram>();
  const morphologyFlags: MorphologyFlag[] = [];

  for (const obx of obxs) {
    const code = getString(obx, 3, 1);
    const valueType = getString(obx, 2);

    // Caso especial: flags morfologicas pueden venir con OBX-3.1 vacio
    // y la flag en OBX-3.2 o OBX-5 (formato "^Anemia^99MRC"). Detectarlo
    // antes del "if (!code) continue".
    if (valueType === "ST" && (!code || code === "")) {
      const flagName = getString(obx, 3, 2) || getString(obx, 5);
      if (flagName) {
        morphologyFlags.push({ code: flagName, raised: true });
      }
      continue;
    }

    if (!code) continue;

    // Parametros numericos del hemograma
    if (code in PARAM_CODE_TO_CANON && valueType === "NM") {
      const canon = PARAM_CODE_TO_CANON[code]!;
      const v = parseNumericObx(obx, warnings);
      if (v) values[canon] = v;
      continue;
    }

    // Histograma (valueType=ED)
    if (code in HISTOGRAM_CODES && valueType === "ED") {
      const type = HISTOGRAM_CODES[code]!;
      const ed = parseEncapsulatedData(obx);
      if (!ed) {
        warnings.push({
          type: "histogram_decode_error",
          message: `OBX ${code}: no se pudo extraer EncapsulatedData`,
        });
        continue;
      }
      try {
        const channels = decodeHistogramPayload(ed);
        histogramsByType.set(type, {
          type,
          channels,
          discriminators: histogramsByType.get(type)?.discriminators ?? {},
        });
      } catch (e) {
        warnings.push({
          type: "histogram_decode_error",
          message: (e as Error).message,
          context: { code },
        });
      }
      continue;
    }

    // Discriminadores de histograma (NM)
    if (code in DISCRIMINATOR_CODES && valueType === "NM") {
      const meta = DISCRIMINATOR_CODES[code]!;
      const value = parseFloat(getString(obx, 5) ?? "");
      if (!Number.isFinite(value)) continue;
      const existing = histogramsByType.get(meta.type) ?? {
        type: meta.type,
        channels: new Uint8Array(0),
        discriminators: {},
      };
      existing.discriminators[meta.line] = Math.round(value);
      histogramsByType.set(meta.type, existing);
      continue;
    }

    // Metadata de muestra ya manejada
    if (SAMPLE_META_CODE_SET.has(code)) continue;

    // Flag morfologica (suele venir con valueType=ST y nombre en OBX-3.2 o OBX-5)
    if (valueType === "ST") {
      // El nombre de la flag puede venir en OBX-3 componente 2 o en OBX-5.
      const flagName = getString(obx, 3, 2) || getString(obx, 5);
      if (flagName) {
        morphologyFlags.push({ code: flagName, raised: true });
      }
      continue;
    }

    // OBX no reconocido: warn pero no fail.
    warnings.push({
      type: "unknown_obx_code",
      message: `OBX-3 no reconocido: code="${code}" valueType="${valueType ?? "?"}"`,
      context: { setId: getString(obx, 1) },
    });
  }

  // Solo devolvemos histogramas con channels reales (no solo discriminadores)
  const histograms: Histogram[] = [];
  for (const h of histogramsByType.values()) {
    if (h.channels.length === HISTOGRAM_CHANNEL_COUNT) histograms.push(h);
  }

  const hemogram: HemogramResult = {
    id: opts.id,
    receivedAt: opts.receivedAt,
    messageControlId,
    patient,
    sample,
    values,
    histograms,
    morphologyFlags,
  };

  return { hemogram, warnings };
}

// ─── Sub-extractores ─────────────────────────────────────────────────────────

function extractPatient(pid: Hl7Segment | undefined): PatientInfo {
  if (!pid) {
    return {
      patientId: null,
      name: null,
      birthDate: null,
      sex: null,
      ageYears: null,
    };
  }
  const lastName = getString(pid, 5, 1);
  const firstName = getString(pid, 5, 2);
  const name = lastName || firstName ? [lastName, firstName].filter(Boolean).join(", ") : null;

  const sexRaw = getString(pid, 8);
  const sex: "M" | "F" | "U" | null = sexRaw ? SEX_MAP[sexRaw] ?? null : null;

  return {
    patientId: getString(pid, 3, 1) || null,
    name,
    birthDate: parseHl7DateToIso(getString(pid, 7)),
    sex,
    ageYears: null, // se completa abajo si viene OBX 30525-0
  };
}

function extractSample(obr: Hl7Segment | undefined, msg: Hl7Message): SampleInfo {
  const sampleInfo: SampleInfo = {
    sampleId: obr ? getString(obr, OBR_FIELD.sampleId, 1) ?? "" : "",
    takeMode: null,
    bloodMode: null,
    testMode: null,
    drawnAt: null,
    analyzedAt: null,
    operator: obr ? getString(obr, OBR_FIELD.operator) ?? null : null,
    refGroup: null,
    comments: null,
  };

  if (obr) {
    // Que campo del OBR trae cada timestamp esta marcado [SOSPECHA] en
    // protocol-map.ts — si salen cruzados con el equipo real, se ajusta alli.
    sampleInfo.drawnAt = parseHl7DateTimeToDate(getString(obr, OBR_FIELD.drawnAt));
    sampleInfo.analyzedAt = parseHl7DateTimeToDate(getString(obr, OBR_FIELD.analyzedAt));
  }

  // Recorremos los OBX de metadata.
  for (const obx of getSegments(msg, "OBX")) {
    const code = getString(obx, 3, 1);
    if (code === SAMPLE_META_CODES.takeMode) sampleInfo.takeMode = getString(obx, 5) ?? null;
    else if (code === SAMPLE_META_CODES.bloodMode) {
      const v = getString(obx, 5);
      if (v && BLOOD_MODE_VALUES.has(v)) sampleInfo.bloodMode = v as "W" | "P";
    } else if (code === SAMPLE_META_CODES.testMode) sampleInfo.testMode = getString(obx, 5) ?? null;
    else if (code === SAMPLE_META_CODES.refGroup) sampleInfo.refGroup = getString(obx, 5) ?? null;
  }

  return sampleInfo;
}

function parseNumericObx(obx: Hl7Segment, warnings: MapWarning[]): HemogramValue | null {
  const valueStr = getString(obx, 5);
  if (valueStr === undefined || valueStr === "") return null;

  const value = parseFloat(valueStr);
  if (!Number.isFinite(value)) {
    warnings.push({
      type: "invalid_number",
      message: `OBX-5 no parseable como numero: "${valueStr}"`,
      context: { code: getString(obx, 3, 1) },
    });
    return null;
  }

  const unit = getString(obx, 6) ?? "";
  const refRange = getString(obx, 7) || null;

  // OBX-8 puede tener multiples flags separadas por ~
  const rawFlags = getRepeats(obx, 8).filter((f) => f.length > 0);
  const flags = rawFlags.filter((f): f is AbnormalFlag => ABNORMAL_FLAG_CODES.has(f));

  return { value, unit, refRange, flags };
}

// ─── Helpers de fecha ────────────────────────────────────────────────────────

/**
 * Convierte "YYYYMMDD" o "YYYYMMDDHHMMSS" a "YYYY-MM-DD".
 * Devuelve null si no parsea.
 */
function parseHl7DateToIso(hl7: string | undefined): string | null {
  if (!hl7 || hl7.length < 8) return null;
  const y = hl7.slice(0, 4);
  const m = hl7.slice(4, 6);
  const d = hl7.slice(6, 8);
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  return `${y}-${m}-${d}`;
}

function parseHl7DateTimeToDate(hl7: string | undefined): Date | null {
  if (!hl7 || hl7.length < 8) return null;
  const y = hl7.slice(0, 4);
  const mo = hl7.slice(4, 6);
  const d = hl7.slice(6, 8);
  const h = hl7.length >= 10 ? hl7.slice(8, 10) : "00";
  const mi = hl7.length >= 12 ? hl7.slice(10, 12) : "00";
  const s = hl7.length >= 14 ? hl7.slice(12, 14) : "00";
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
