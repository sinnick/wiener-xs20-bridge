/**
 * Pagina principal: lista de resultados recibidos.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, AlertTriangle, FlaskConical, ChevronRight } from "lucide-react";

import { listResults, type ResultSummary } from "../lib/api";
import { formatDateTime } from "../components/primitives";

interface Props {
  onSelect: (id: string) => void;
  /** Cambia cuando llega un resultado nuevo por SSE, para refrescar. */
  refreshKey: number;
}

export function ResultsList({ onSelect, refreshKey }: Props) {
  const [results, setResults] = useState<ResultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listResults({ search: search || undefined, limit: 200 })
      .then((res) => {
        if (!cancelled) setResults(res.results);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? "Error al cargar");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, refreshKey]);

  const onSearchChange = (v: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(v), 250);
  };

  const stats = useMemo(() => {
    const total = results.length;
    const abnormal = results.filter((r) => r.abnormalCount > 0).length;
    const flagged = results.filter((r) => r.morphologyFlagCount > 0).length;
    return { total, abnormal, flagged };
  }, [results]);

  return (
    <div className="flex h-full flex-col">
      {/* Header con KPIs */}
      <header className="border-b border-border px-8 py-6">
        <h1 className="text-2xl font-medium text-text-strong">Resultados</h1>
        <div className="mt-4 flex gap-8">
          <Kpi label="Recibidos" value={stats.total} />
          <Kpi label="Con anormalidades" value={stats.abnormal} tone="high" />
          <Kpi label="Con alarmas" value={stats.flagged} tone="warn" />
        </div>
      </header>

      {/* Buscador */}
      <div className="border-b border-border px-8 py-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" strokeWidth={1.5} />
          <input
            type="text"
            placeholder="Buscar por muestra, paciente o ID…"
            defaultValue={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full rounded-full border border-border bg-surface py-2.5 pl-11 pr-4 text-text placeholder:text-text-muted"
          />
        </div>
      </div>

      {/* Tabla / estados */}
      <div className="flex-1 overflow-auto px-8 py-4">
        {loading && <SkeletonRows />}
        {error && !loading && <ErrorState message={error} />}
        {!loading && !error && results.length === 0 && <EmptyState hasSearch={!!search} />}
        {!loading && !error && results.length > 0 && (
          <ResultsTable results={results} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "high" | "warn" }) {
  const color = tone === "high" ? "text-high-text" : tone === "warn" ? "text-warn-text" : "text-text-strong";
  return (
    <div>
      <div className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-3xl font-normal tnum ${color}`}>{value}</div>
    </div>
  );
}

function ResultsTable({ results, onSelect }: { results: ResultSummary[]; onSelect: (id: string) => void }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-border text-left">
          <Th>Muestra</Th>
          <Th>Paciente</Th>
          <Th>ID Paciente</Th>
          <Th>Recibido</Th>
          <Th className="text-center">Estado</Th>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {results.map((r) => (
          <tr
            key={r.id}
            onClick={() => onSelect(r.id)}
            className="cursor-pointer border-b border-border/60 hover:bg-accent-soft"
          >
            <td className="py-3 pr-4 font-mono text-sm text-text-strong">{r.sampleId}</td>
            <td className="py-3 pr-4 text-sm">{r.patientName ?? <span className="text-text-muted">—</span>}</td>
            <td className="py-3 pr-4 font-mono text-sm text-text-muted">{r.patientId ?? "—"}</td>
            <td className="py-3 pr-4 text-sm text-text-muted tnum">{formatDateTime(r.receivedAt)}</td>
            <td className="py-3 pr-4">
              <div className="flex items-center justify-center gap-2">
                {r.abnormalCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-high-bg px-2 py-0.5 text-xs font-medium text-high-text">
                    <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {r.abnormalCount}
                  </span>
                )}
                {r.morphologyFlagCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn-text">
                    <FlaskConical className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {r.morphologyFlagCount}
                  </span>
                )}
                {r.abnormalCount === 0 && r.morphologyFlagCount === 0 && (
                  <span className="rounded-full bg-normal-bg px-2 py-0.5 text-xs font-medium text-normal-text">
                    Normal
                  </span>
                )}
              </div>
            </td>
            <td className="py-3">
              <ChevronRight className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`pb-2 pr-4 font-mono text-xs font-medium uppercase tracking-wider text-text-muted ${className}`}>
      {children}
    </th>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-border/40" />
      ))}
    </div>
  );
}

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <FlaskConical className="h-12 w-12 text-text-muted" strokeWidth={1.25} />
      <p className="mt-4 text-lg text-text-strong">
        {hasSearch ? "Sin coincidencias" : "Todavía no llegaron resultados"}
      </p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">
        {hasSearch
          ? "Probá con otro término de búsqueda."
          : "Cuando el analizador envíe una muestra, va a aparecer acá automáticamente."}
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <AlertTriangle className="h-12 w-12 text-high-text" strokeWidth={1.25} />
      <p className="mt-4 text-lg text-text-strong">No se pudo cargar</p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">{message}</p>
      <p className="mt-1 max-w-sm text-sm text-text-muted">
        Verificá que el servicio esté corriendo en el puerto 7700.
      </p>
    </div>
  );
}
