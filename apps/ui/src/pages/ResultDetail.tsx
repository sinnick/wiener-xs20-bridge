/**
 * Detalle de un resultado: valores del hemograma + histogramas + alarmas.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, FlaskConical, Printer, User } from "lucide-react";

import {
  apiErrorMessage,
  getResult,
  isConnectionError,
  type GetResultResponse,
} from "../lib/api";
import { Histogram } from "../components/Histogram";
import {
  ConnectingState,
  ErrorState,
  FlagChip,
  PARAM_LABELS,
  PARAM_SHORT,
  formatDateTime,
} from "../components/primitives";
import {
  bloodModeLabel,
  isSuspicionFlag,
  morphologyFlagLabel,
  sexLabel,
} from "../lib/dictionaries";

interface Props {
  id: string;
  onBack: () => void;
}

// Orden de presentacion agrupado por bloque clinico.
const GROUPS: { title: string; params: string[] }[] = [
  { title: "Serie blanca", params: ["wbc", "lym_abs", "lym_pct", "mid_abs", "mid_pct", "gran_abs", "gran_pct"] },
  { title: "Serie roja", params: ["rbc", "hgb", "hct", "mcv", "mch", "mchc", "rdw_cv", "rdw_sd"] },
  { title: "Plaquetas", params: ["plt", "mpv", "pdw", "pct"] },
];

export function ResultDetail({ id, onBack }: Props) {
  const [result, setResult] = useState<GetResultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOffline(false);
    getResult(id)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isConnectionError(e)) setOffline(true);
        else setError(apiErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  const plainText = useMemo(() => (result ? formatResultAsText(result) : ""), [result]);

  const onCopy = () => {
    void navigator.clipboard
      ?.writeText(plainText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => {
        /* portapapeles no disponible */
      });
  };

  const patientAge = result ? patientAgeYears(result) : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 no-print">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-text-muted hover:bg-accent-soft hover:text-accent"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            Volver a resultados
          </button>

          {result && (
            <div className="flex items-center gap-2">
              <button
                onClick={onCopy}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:bg-accent-soft"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-normal-text" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
                )}
                {copied ? "Copiado" : "Copiar valores"}
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:bg-accent-soft"
              >
                <Printer className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
                Imprimir
              </button>
            </div>
          )}
        </div>

        {result && (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-mono text-2xl font-medium text-text-strong">
                {result.sample.sampleId}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-text">
                <User className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
                <span>{result.patient.name ?? "Paciente sin identificar"}</span>
                {result.patient.patientId && (
                  <span className="font-mono text-sm text-text-muted">
                    · {result.patient.patientId}
                  </span>
                )}
                {/* Sexo y edad condicionan los rangos de referencia que se
                    muestran abajo: tienen que estar a la vista. */}
                {sexLabel(result.patient.sex) && (
                  <span className="text-sm text-text-muted">
                    · {sexLabel(result.patient.sex)}
                  </span>
                )}
                {patientAge !== null && (
                  <span className="text-sm text-text-muted tnum">· {patientAge} años</span>
                )}
              </div>
            </div>
            <dl className="flex flex-wrap gap-6 text-sm">
              {result.sample.analyzedAt && (
                <Meta label="Procesado" value={formatDateTime(result.sample.analyzedAt)} />
              )}
              <Meta label="Recibido" value={formatDateTime(result.receivedAt)} />
              {result.sample.testMode && <Meta label="Modo" value={result.sample.testMode} />}
              {bloodModeLabel(result.sample.bloodMode) && (
                <Meta label="Muestra" value={bloodModeLabel(result.sample.bloodMode)!} />
              )}
              {result.sample.operator && <Meta label="Operador" value={result.sample.operator} />}
            </dl>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto px-8 py-6">
        {loading && (
          <div className="h-64 animate-pulse rounded-xl bg-border/40" role="status" aria-label="Cargando el resultado" />
        )}
        {!loading && offline && (
          <ConnectingState
            message="Sin conexión con el servicio"
            detail="El resultado está guardado, pero no podemos leerlo hasta que el servicio responda. Se reintenta solo."
          />
        )}
        {!loading && !offline && error && (
          <ErrorState
            title="No se pudo abrir el resultado"
            message={error}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}
        {!loading && result && (
          <div className="space-y-8">
            {/* Alarmas morfologicas */}
            {result.morphologyFlags.length > 0 && (
              <section className="rounded-lg border border-warn-text/20 bg-warn-bg/40 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-warn-text" strokeWidth={1.5} aria-hidden="true" />
                  <h2 className="font-mono text-xs uppercase tracking-wider text-warn-text">
                    Alarmas del analizador
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  {result.morphologyFlags.map((f) => (
                    <span
                      key={f.code}
                      // El codigo crudo queda en el title: si alguna vez hay
                      // que hablar con soporte de Wiener, es lo que buscan.
                      title={f.code}
                      className="rounded-full bg-surface px-3 py-1 text-sm text-text-strong"
                    >
                      {morphologyFlagLabel(f.code)}
                      {isSuspicionFlag(f.code) && (
                        <span className="ml-1 text-text-muted">(a confirmar)</span>
                      )}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-warn-text/80">
                  Son avisos del equipo sobre la muestra, no un diagnóstico. Las que dicen
                  “a confirmar” el equipo las marcó como sospecha.
                </p>
              </section>
            )}

            {/* Comentarios del equipo */}
            {result.sample.comments && (
              <section className="rounded-lg border border-border bg-surface p-4">
                <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-text-muted">
                  Comentarios del equipo
                </h2>
                <p className="whitespace-pre-wrap text-sm text-text">{result.sample.comments}</p>
              </section>
            )}

            {/* Valores por grupo */}
            <section className="grid gap-6 lg:grid-cols-3">
              {GROUPS.map((g) => (
                <div key={g.title} className="rounded-lg border border-border bg-surface">
                  <div className="border-b border-border px-4 py-3">
                    <h2 className="font-medium text-text-strong">{g.title}</h2>
                  </div>
                  <table className="w-full">
                    <caption className="sr-only">{g.title}</caption>
                    <tbody>
                      {g.params.map((p) => {
                        const v = result.values[p as keyof typeof result.values];
                        if (!v) return null;
                        const abnormal = v.flags.some((f) => f !== "N");
                        return (
                          <tr key={p} className="border-b border-border/50 last:border-0">
                            <td className="py-2.5 pl-4 pr-2">
                              <div className="text-sm text-text-strong">{PARAM_LABELS[p] ?? p}</div>
                              <div className="font-mono text-xs text-text-muted">{PARAM_SHORT[p] ?? p}</div>
                            </td>
                            <td className="py-2.5 pr-2 text-right">
                              <span className={`font-mono text-base tnum ${abnormal ? "text-high-text" : "text-text-strong"}`}>
                                {v.value}
                              </span>
                              <span className="ml-1 text-xs text-text-muted">{v.unit}</span>
                            </td>
                            <td className="py-2.5 pr-2 text-right">
                              <div className="font-mono text-xs text-text-muted tnum">{v.refRange ?? ""}</div>
                            </td>
                            <td className="py-2.5 pr-4 text-right">
                              {abnormal &&
                                v.flags
                                  .filter((f) => f !== "N")
                                  .map((f) => <FlagChip key={f} flag={f} />)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </section>

            {/* Histogramas */}
            {result.histograms.length > 0 && (
              <section>
                <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-text-muted">
                  Histogramas
                </h2>
                <div className="grid gap-4 lg:grid-cols-3">
                  {result.histograms.map((h) => (
                    <Histogram
                      key={h.type}
                      type={h.type}
                      channelsBase64={h.channels as unknown as string}
                      discriminators={h.discriminators}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-text-strong tnum">{value}</dd>
    </div>
  );
}

/**
 * Edad del paciente. El servicio no persiste `ageYears` (queda en null), asi
 * que la calculamos de la fecha de nacimiento (PID-7, formato YYYYMMDD).
 */
function patientAgeYears(result: GetResultResponse): number | null {
  if (typeof result.patient.ageYears === "number") return result.patient.ageYears;

  const raw = result.patient.birthDate;
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  const born = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(raw);
  if (Number.isNaN(born.getTime())) return null;

  const ref = new Date(result.receivedAt);
  let age = ref.getFullYear() - born.getFullYear();
  const beforeBirthday =
    ref.getMonth() < born.getMonth() ||
    (ref.getMonth() === born.getMonth() && ref.getDate() < born.getDate());
  if (beforeBirthday) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Version en texto plano del resultado, para "Copiar valores". */
function formatResultAsText(r: GetResultResponse): string {
  const lines: string[] = [];
  const age = patientAgeYears(r);

  lines.push(`Muestra: ${r.sample.sampleId}`);
  lines.push(`Paciente: ${r.patient.name ?? "sin identificar"}`);
  if (r.patient.patientId) lines.push(`ID paciente: ${r.patient.patientId}`);
  const sex = sexLabel(r.patient.sex);
  if (sex) lines.push(`Sexo: ${sex}`);
  if (age !== null) lines.push(`Edad: ${age} años`);
  if (r.sample.analyzedAt) lines.push(`Procesado: ${formatDateTime(r.sample.analyzedAt)}`);
  lines.push(`Recibido: ${formatDateTime(r.receivedAt)}`);
  if (r.sample.testMode) lines.push(`Modo: ${r.sample.testMode}`);
  const blood = bloodModeLabel(r.sample.bloodMode);
  if (blood) lines.push(`Muestra: ${blood}`);
  if (r.sample.operator) lines.push(`Operador: ${r.sample.operator}`);
  lines.push("");

  for (const g of GROUPS) {
    const rows = g.params
      .map((p) => [p, r.values[p as keyof typeof r.values]] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => !!entry[1]);
    if (rows.length === 0) continue;
    lines.push(g.title.toUpperCase());
    for (const [p, v] of rows) {
      const flags = v.flags.filter((f) => f !== "N");
      const label = (PARAM_SHORT[p] ?? p).padEnd(8);
      const value = `${v.value} ${v.unit}`.padEnd(16);
      const range = v.refRange ? `(ref ${v.refRange})` : "";
      lines.push(`  ${label}${value}${range}${flags.length > 0 ? `  [${flags.join(",")}]` : ""}`);
    }
    lines.push("");
  }

  if (r.morphologyFlags.length > 0) {
    lines.push("ALARMAS DEL ANALIZADOR");
    for (const f of r.morphologyFlags) lines.push(`  - ${morphologyFlagLabel(f.code)}`);
    lines.push("");
  }

  if (r.sample.comments) {
    lines.push("COMENTARIOS DEL EQUIPO");
    lines.push(`  ${r.sample.comments}`);
    lines.push("");
  }

  return lines.join("\n");
}
