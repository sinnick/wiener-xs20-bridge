/**
 * Actividad del servicio en vivo (stream SSE).
 *
 * Se llama "Actividad" y no "Logs" a proposito: quien la mira es la operadora
 * del laboratorio, no un tecnico. Por eso cada evento se muestra traducido
 * ("Llegó la muestra 000015" en vez de "hl7.parsed sampleId=000015") y la
 * plomeria interna (pedidos HTTP, bytes de control MLLP) queda oculta detras
 * del switch de detalle tecnico.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";

import { subscribeLogs, type LogLine, type StreamState } from "../lib/api";
import { describeEvent, formatCtx } from "../lib/dictionaries";
import { Dot, formatTime } from "../components/primitives";

const LEVEL_STYLE: Record<LogLine["level"], string> = {
  debug: "text-text-muted",
  info: "text-accent",
  warn: "text-warn-text",
  error: "text-high-text",
};

/** Como se llama cada nivel en la interfaz. */
const LEVEL_LABEL: Record<LogLine["level"], string> = {
  debug: "Detalle",
  info: "Info",
  warn: "Aviso",
  error: "Error",
};

const MAX_LINES = 500;

type Filter = LogLine["level"] | "all";

interface Entry {
  id: number;
  line: LogLine;
}

export function LogsView() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [technical, setTechnical] = useState(false);
  const [conn, setConn] = useState<StreamState>("connecting");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(0);

  useEffect(() => {
    return subscribeLogs({
      onEvent: (e) => {
        if (pausedRef.current) return;
        setEntries((prev) => {
          const next = [...prev, { id: nextIdRef.current++, line: e }];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      },
      onState: setConn,
    });
  }, []);

  // Auto-scroll al fondo cuando llegan lineas nuevas (si no esta pausado).
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, paused]);

  const visible = useMemo(
    () =>
      entries.filter(({ line }) => {
        if (filter !== "all" && line.level !== filter) return false;
        if (technical) return true;
        // Modo operadora: fuera la plomeria interna.
        if (line.level === "debug") return false;
        return !describeEvent(line.msg, line.ctx).noise;
      }),
    [entries, filter, technical],
  );

  const levels: Filter[] = technical
    ? ["all", "info", "warn", "error", "debug"]
    : ["all", "info", "warn", "error"];

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-8 py-6">
        <div>
          <h1 className="text-2xl font-medium text-text-strong">Actividad</h1>
          <ConnectionLine state={conn} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="mr-1 flex cursor-pointer items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={technical}
              onChange={(e) => {
                setTechnical(e.target.checked);
                if (!e.target.checked && filter === "debug") setFilter("all");
              }}
              className="h-4 w-4 accent-accent"
            />
            Detalle técnico
          </label>
          <div className="flex rounded-full border border-border bg-surface p-1" role="group" aria-label="Filtrar por tipo">
            {levels.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`rounded-full px-3 py-1 text-sm ${
                  filter === f ? "bg-text-strong text-surface" : "text-text-muted hover:text-text"
                }`}
              >
                {f === "all" ? "Todo" : LEVEL_LABEL[f]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPaused((p) => !p)}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:bg-accent-soft"
          >
            {paused ? (
              <Play className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Pause className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            )}
            {paused ? "Reanudar" : "Pausar"}
          </button>
          <button
            onClick={() => setEntries([])}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface hover:bg-accent-soft"
            title="Limpiar la lista"
            aria-label="Limpiar la lista de actividad"
          >
            <Trash2 className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-4">
        {visible.length === 0 && (
          <EmptyActivity
            state={conn}
            filtered={entries.length > 0}
            onClearFilter={() => {
              setFilter("all");
              setTechnical(true);
            }}
          />
        )}
        {visible.map(({ id, line }) => {
          const d = describeEvent(line.msg, line.ctx);
          return (
            <div key={id} className="flex gap-3 border-b border-border/30 py-1.5 text-sm">
              <span className="shrink-0 font-mono text-text-muted tnum">
                {formatTime(line.time)}
              </span>
              <span
                className={`w-16 shrink-0 font-mono text-xs uppercase leading-5 ${LEVEL_STYLE[line.level]}`}
              >
                {LEVEL_LABEL[line.level]}
              </span>
              <span className="min-w-0">
                <span className={d.known ? "text-text-strong" : "font-mono text-text-strong"}>
                  {d.text}
                </span>
                {technical && (
                  <span className="ml-2 font-mono text-xs text-text-muted">
                    {line.msg}
                    {line.ctx && Object.keys(line.ctx).length > 0
                      ? `  ${formatCtx(line.ctx)}`
                      : ""}
                  </span>
                )}
                {/* El servicio manda a veces una explicacion de que hacer.
                    En un aviso o un error es lo mas util de toda la linea. */}
                {d.detail && !technical && (line.level === "warn" || line.level === "error") && (
                  <span className="mt-0.5 block max-w-2xl text-xs text-text-muted">
                    {d.detail}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Estado de la conexion con el servicio ───────────────────────────────────
//
// El bug que arregla esto: sin handler de error, un stream que nunca conecta
// se veia exactamente igual que un laboratorio tranquilo ("Esperando
// eventos…"). Ahora la conexion se ve siempre.

function ConnectionLine({ state }: { state: StreamState }) {
  const map: Record<StreamState, { dot: string; text: string }> = {
    connecting: { dot: "bg-text-muted animate-pulse", text: "Conectando con el servicio…" },
    open: { dot: "bg-normal-text", text: "Conectado · eventos en tiempo real" },
    reconnecting: {
      dot: "bg-high-text animate-pulse",
      text: "Se perdió la conexión con el servicio. Reconectando…",
    },
  };
  const s = map[state];
  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-1 inline-flex items-center gap-2 text-sm text-text-muted"
    >
      <Dot className={s.dot} />
      {s.text}
    </p>
  );
}

function EmptyActivity({
  state,
  filtered,
  onClearFilter,
}: {
  state: StreamState;
  filtered: boolean;
  onClearFilter: () => void;
}) {
  if (state !== "open") {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-text-muted">
        <p className="text-text-strong">
          {state === "connecting"
            ? "Conectando con el servicio…"
            : "Sin conexión con el servicio"}
        </p>
        <p className="mt-1 max-w-sm text-sm">
          Mientras tanto no podemos saber qué está pasando. Se reintenta solo.
        </p>
      </div>
    );
  }

  if (filtered) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-text-muted">
        <p className="text-text-strong">Ningún evento coincide con el filtro</p>
        <button
          onClick={onClearFilter}
          className="mt-3 rounded-sm px-3 py-1.5 text-sm text-accent hover:bg-accent-soft"
        >
          Ver todo, incluido el detalle técnico
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-text-muted">
      <p className="text-text-strong">Todo tranquilo por acá</p>
      <p className="mt-1 max-w-sm text-sm">
        Cuando el equipo se conecte o mande una muestra, lo vas a ver acá.
      </p>
    </div>
  );
}
