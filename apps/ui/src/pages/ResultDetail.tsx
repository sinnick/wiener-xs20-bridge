/**
 * Detalle de un resultado: valores del hemograma + histogramas + alarmas.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, User, FlaskConical } from "lucide-react";

import { getResult, type GetResultResponse } from "../lib/api";
import { Histogram } from "../components/Histogram";
import {
  FlagChip,
  PARAM_LABELS,
  PARAM_SHORT,
  formatDateTime,
} from "../components/primitives";

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getResult(id)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? "Error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-6">
        <button
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-text-muted hover:bg-accent-soft hover:text-accent"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
          Volver a resultados
        </button>

        {result && (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-mono text-2xl font-medium text-text-strong">
                {result.sample.sampleId}
              </h1>
              <div className="mt-2 flex items-center gap-2 text-text">
                <User className="h-4 w-4 text-text-muted" strokeWidth={1.5} />
                <span>{result.patient.name ?? "Paciente sin identificar"}</span>
                {result.patient.patientId && (
                  <span className="font-mono text-sm text-text-muted">
                    · {result.patient.patientId}
                  </span>
                )}
              </div>
            </div>
            <dl className="flex gap-6 text-sm">
              <Meta label="Recibido" value={formatDateTime(result.receivedAt)} />
              {result.sample.testMode && <Meta label="Modo" value={result.sample.testMode} />}
              {result.sample.operator && <Meta label="Operador" value={result.sample.operator} />}
            </dl>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto px-8 py-6">
        {loading && <div className="h-64 animate-pulse rounded-xl bg-border/40" />}
        {error && <p className="text-high-text">{error}</p>}
        {result && (
          <div className="space-y-8">
            {/* Alarmas morfologicas */}
            {result.morphologyFlags.length > 0 && (
              <section className="rounded-lg border border-warn-text/20 bg-warn-bg/40 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-warn-text" strokeWidth={1.5} />
                  <span className="font-mono text-xs uppercase tracking-wider text-warn-text">
                    Alarmas del analizador
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {result.morphologyFlags.map((f) => (
                    <span
                      key={f.code}
                      className="rounded-full bg-surface px-3 py-1 text-sm text-text-strong"
                    >
                      {f.code}
                    </span>
                  ))}
                </div>
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
