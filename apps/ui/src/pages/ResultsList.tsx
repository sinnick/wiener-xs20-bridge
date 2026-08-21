/**
 * Pagina principal: lista de resultados recibidos.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, AlertTriangle, FlaskConical, ChevronRight } from "lucide-react";

import { apiErrorMessage, isConnectionError, listResults, type ResultSummary } from "../lib/api";
import { useServiceStatus } from "../hooks/useServiceStatus";
import { ConnectingState, ErrorState, formatDateTime } from "../components/primitives";

const LIMIT = 200;
/** Cuanto dura el resalte de una muestra recien llegada. */
const HIGHLIGHT_MS = 3000;

interface Props {
  onSelect: (id: string) => void;
  /** Cambia cuando llega un resultado nuevo por SSE, para refrescar. */
  refreshKey: number;
  /** Muestra que acaba de llegar, para resaltarla un momento. */
  highlightSampleId?: string | null;
}

export function ResultsList({ onSelect, refreshKey, highlightSampleId }: Props) {
  const [results, setResults] = useState<ResultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Con que busqueda / reintento se hizo el ultimo fetch. Sirve para distinguir
  // una carga que la operadora pidio (que si merece esqueleto) de un refresh
  // disparado por SSE (que no).
  const lastSearchRef = useRef<string | null>(null);
  const lastRetryRef = useRef(0);

  const status = useServiceStatus();

  useEffect(() => {
    let cancelled = false;

    // El esqueleto es solo para la primera carga y para cambios de busqueda.
    // Un refresh disparado por una muestra nueva tiene que ser invisible: la
    // operadora esta mirando la tabla y no puede desaparecerle abajo del dedo.
    const visibleLoad =
      lastSearchRef.current !== search || lastRetryRef.current !== retryKey;
    lastSearchRef.current = search;
    lastRetryRef.current = retryKey;
    if (visibleLoad) {
      setLoading(true);
      setError(null);
      setOffline(false);
    }

    listResults({ search: search || undefined, limit: LIMIT })
      .then((res) => {
        if (cancelled) return;
        setResults(res.results);
        setError(null);
        setOffline(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Un 401 (todavia no tenemos el token del servicio) o el servicio
        // caido no son errores de datos: son problemas de conexion.
        if (isConnectionError(e)) {
          setOffline(true);
          setError(null);
        } else {
          setOffline(false);
          setError(apiErrorMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [search, refreshKey, retryKey]);

  // Resalte breve de la muestra que acaba de entrar.
  useEffect(() => {
    if (!highlightSampleId) return;
    setHighlight(highlightSampleId);
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightSampleId, refreshKey]);

  const onSearchChange = (v: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(v), 250);
  };

  const stats = useMemo(() => {
    const abnormal = results.filter((r) => r.abnormalCount > 0).length;
    const flagged = results.filter((r) => r.morphologyFlagCount > 0).length;
    return { abnormal, flagged };
  }, [results]);

  // "Recibidos" tiene que ser el total real, no lo que trajo este fetch (que
  // viene filtrado por busqueda y topeado en LIMIT).
  const storedTotal = status.health?.database.resultCount ?? null;
  const searching = search !== "";
  const truncated = !searching && storedTotal !== null && storedTotal > results.length;

  return (
    <div className="flex h-full flex-col">
      {/* Header con KPIs */}
      <header className="border-b border-border px-8 py-6">
        <h1 className="text-2xl font-medium text-text-strong">Resultados</h1>
        <div className="mt-4 flex gap-8">
          {searching ? (
            <Kpi label="Coincidencias" value={results.length} />
          ) : (
            <Kpi label="Recibidos" value={storedTotal ?? results.length} />
          )}
          <Kpi label="Con anormalidades" value={stats.abnormal} tone="high" />
          <Kpi label="Con alarmas" value={stats.flagged} tone="warn" />
        </div>
        {truncated && (
          <p className="mt-3 text-xs text-text-muted">
            Se muestran los {results.length} más recientes de {storedTotal}. Los contadores
            de anormalidades y alarmas son sobre los que se muestran.
          </p>
        )}
      </header>

      {/* Buscador */}
      <div className="border-b border-border px-8 py-4">
        <div className="relative max-w-md">
          <label htmlFor="buscar-resultados" className="sr-only">
            Buscar resultados por muestra, paciente o ID
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <input
            id="buscar-resultados"
            type="search"
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
        {!loading && offline && results.length === 0 && (
          <ConnectingState
            message={
              status.phase === "offline"
                ? "Sin conexión con el servicio"
                : "Conectando con el servicio…"
            }
            detail="Los resultados se leen del servicio local. Mientras no responda no podemos mostrarlos; se reintenta solo."
          />
        )}
        {!loading && !offline && error && results.length === 0 && (
          <ErrorState
            message={error}
            hint="Verificá que el servicio esté corriendo en el puerto 7700."
            onRetry={() => setRetryKey((k) => k + 1)}
          />
        )}
        {!loading && !error && !offline && results.length === 0 && (
          <EmptyState hasSearch={searching} />
        )}
        {!loading && results.length > 0 && (
          <>
            {(offline || error) && (
              <p
                role="status"
                className="mb-3 rounded-sm border border-warn-text/20 bg-warn-bg/40 px-3 py-2 text-xs text-warn-text"
              >
                {offline
                  ? "Sin conexión con el servicio: esta lista puede estar desactualizada."
                  : `No se pudo actualizar la lista: ${error}`}
              </p>
            )}
            <ResultsTable results={results} onSelect={onSelect} highlight={highlight} />
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "high" | "warn" }) {
  const color =
    tone === "high" ? "text-high-text" : tone === "warn" ? "text-warn-text" : "text-text-strong";
  return (
    <div>
      <div className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-3xl font-normal tnum ${color}`}>{value}</div>
    </div>
  );
}

function ResultsTable({
  results,
  onSelect,
  highlight,
}: {
  results: ResultSummary[];
  onSelect: (id: string) => void;
  highlight: string | null;
}) {
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">
        Resultados recibidos del analizador. Usá Enter para abrir el detalle.
      </caption>
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
            tabIndex={0}
            onClick={() => onSelect(r.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(r.id);
              }
            }}
            aria-label={`Muestra ${r.sampleId}${r.patientName ? `, ${r.patientName}` : ""}. Ver detalle`}
            className={`cursor-pointer border-b border-border/60 hover:bg-accent-soft ${
              highlight !== null && r.sampleId === highlight ? "animate-flash" : ""
            }`}
          >
            <td className="py-3 pr-4 font-mono text-sm text-text-strong">{r.sampleId}</td>
            <td className="py-3 pr-4 text-sm">
              {r.patientName ?? <span className="text-text-muted">—</span>}
            </td>
            <td className="py-3 pr-4 font-mono text-sm text-text-muted">{r.patientId ?? "—"}</td>
            <td className="py-3 pr-4 text-sm text-text-muted tnum">{formatDateTime(r.receivedAt)}</td>
            <td className="py-3 pr-4">
              <div className="flex items-center justify-center gap-2">
                {r.abnormalCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-high-bg px-2 py-0.5 text-xs font-medium text-high-text"
                    title={`${r.abnormalCount} valores fuera de rango`}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                    {r.abnormalCount}
                  </span>
                )}
                {r.morphologyFlagCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn-text"
                    title={`${r.morphologyFlagCount} alarmas del analizador`}
                  >
                    <FlaskConical className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
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
              <ChevronRight className="h-5 w-5 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`pb-2 pr-4 font-mono text-xs font-medium uppercase tracking-wider text-text-muted ${className}`}
    >
      {children}
    </th>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2" role="status" aria-label="Cargando resultados">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-border/40" />
      ))}
    </div>
  );
}

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <FlaskConical className="h-12 w-12 text-text-muted" strokeWidth={1.25} aria-hidden="true" />
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
