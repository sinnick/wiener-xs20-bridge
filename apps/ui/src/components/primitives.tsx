/**
 * Primitivas chicas reutilizables de la UI.
 */

import { AlertTriangle, Loader2, PlugZap, RefreshCw } from "lucide-react";

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

// ─── Estados de pantalla compartidos ─────────────────────────────────────────
//
// Las cuatro vistas tienen que contar la misma historia con las mismas
// palabras. Antes cada una improvisaba: Resultados tenia un estado de error
// cuidado y Detalle un <p> pelado.

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <Loader2
      className={`animate-spin text-text-muted ${className}`}
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

/** "No pudimos hablar con el servicio". Distinto de un error de datos. */
export function ConnectingState({
  message = "Conectando con el servicio…",
  detail,
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center py-24 text-center"
    >
      <PlugZap className="h-12 w-12 text-text-muted" strokeWidth={1.25} aria-hidden="true" />
      <p className="mt-4 inline-flex items-center gap-2 text-lg text-text-strong">
        <Spinner className="h-4 w-4" />
        {message}
      </p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">
        {detail ??
          "El servicio puede tardar unos segundos en arrancar. Si no aparece nada en un minuto, cerrá y abrí la aplicación."}
      </p>
    </div>
  );
}

/** Error de datos: el servicio contesto, pero con un problema. */
export function ErrorState({
  title = "No se pudo cargar",
  message,
  hint,
  onRetry,
}: {
  title?: string;
  message: string;
  hint?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center py-24 text-center">
      <AlertTriangle className="h-12 w-12 text-high-text" strokeWidth={1.25} aria-hidden="true" />
      <p className="mt-4 text-lg text-text-strong">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">{message}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-text-muted">{hint}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-5 inline-flex items-center gap-2 rounded-sm bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-hover"
        >
          <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Reintentar
        </button>
      )}
    </div>
  );
}
