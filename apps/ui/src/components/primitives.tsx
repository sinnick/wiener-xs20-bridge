/**
 * Primitivas chicas reutilizables de la UI.
 */

import type { AbnormalFlag } from "@xs20/shared";

// ─── Chip de flag de anormalidad ─────────────────────────────────────────────

const FLAG_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  H: { bg: "bg-high-bg", text: "text-high-text", label: "Alto" },
  HH: { bg: "bg-high-bg", text: "text-high-text", label: "Crítico ↑" },
  L: { bg: "bg-low-bg", text: "text-low-text", label: "Bajo" },
  LL: { bg: "bg-low-bg", text: "text-low-text", label: "Crítico ↓" },
  A: { bg: "bg-warn-bg", text: "text-warn-text", label: "Anormal" },
  N: { bg: "bg-normal-bg", text: "text-normal-text", label: "Normal" },
};

export function FlagChip({ flag }: { flag: AbnormalFlag }) {
  const s = FLAG_STYLE[flag] ?? FLAG_STYLE.A!;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}
    >
      {s.label}
    </span>
  );
}

// ─── Dot marker (para leyendas / categorias) ─────────────────────────────────

export function Dot({ className = "bg-accent" }: { className?: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${className}`} />;
}

// ─── Formateo de valores ─────────────────────────────────────────────────────

/** Nombre legible de cada parametro canonico. */
export const PARAM_LABELS: Record<string, string> = {
  wbc: "Leucocitos",
  lym_abs: "Linfocitos #",
  lym_pct: "Linfocitos %",
  mid_abs: "Medios #",
  mid_pct: "Medios %",
  gran_abs: "Granulocitos #",
  gran_pct: "Granulocitos %",
  rbc: "Eritrocitos",
  hgb: "Hemoglobina",
  hct: "Hematocrito",
  mcv: "VCM",
  mch: "HCM",
  mchc: "CHCM",
  rdw_cv: "RDW-CV",
  rdw_sd: "RDW-SD",
  plt: "Plaquetas",
  mpv: "VPM",
  pdw: "PDW",
  pct: "Plaquetocrito",
};

/** Sigla corta (para tablas densas). */
export const PARAM_SHORT: Record<string, string> = {
  wbc: "WBC",
  lym_abs: "LYM#",
  lym_pct: "LYM%",
  mid_abs: "MID#",
  mid_pct: "MID%",
  gran_abs: "GRAN#",
  gran_pct: "GRAN%",
  rbc: "RBC",
  hgb: "HGB",
  hct: "HCT",
  mcv: "MCV",
  mch: "MCH",
  mchc: "MCHC",
  rdw_cv: "RDW-CV",
  rdw_sd: "RDW-SD",
  plt: "PLT",
  mpv: "MPV",
  pdw: "PDW",
  pct: "PCT",
};

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
