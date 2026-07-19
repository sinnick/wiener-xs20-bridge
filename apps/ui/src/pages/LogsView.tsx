/**
 * Logs en vivo del servicio (stream SSE).
 */

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";

import { streamLogs, type LogLine } from "../lib/api";
import { formatTime } from "../components/primitives";

const LEVEL_STYLE: Record<LogLine["level"], string> = {
  debug: "text-text-muted",
  info: "text-accent",
  warn: "text-warn-text",
  error: "text-high-text",
};

const MAX_LINES = 500;

export function LogsView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<LogLine["level"] | "all">("all");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stop = streamLogs((e) => {
      if (pausedRef.current) return;
      setLines((prev) => {
        const next = [...prev, e];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });
    return stop;
  }, []);

  // Auto-scroll al fondo cuando llegan lineas nuevas (si no esta pausado).
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, paused]);

  const visible = filter === "all" ? lines : lines.filter((l) => l.level === filter);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-8 py-6">
        <div>
          <h1 className="text-2xl font-medium text-text-strong">Actividad</h1>
          <p className="mt-1 text-sm text-text-muted">
            Eventos del servicio en tiempo real
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-border bg-surface p-1">
            {(["all", "info", "warn", "error"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-sm capitalize ${
                  filter === f ? "bg-text-strong text-surface" : "text-text-muted hover:text-text"
                }`}
              >
                {f === "all" ? "Todo" : f}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPaused((p) => !p)}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:bg-accent-soft"
          >
            {paused ? <Play className="h-4 w-4" strokeWidth={1.5} /> : <Pause className="h-4 w-4" strokeWidth={1.5} />}
            {paused ? "Reanudar" : "Pausar"}
          </button>
          <button
            onClick={() => setLines([])}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface hover:bg-accent-soft"
            title="Limpiar"
          >
            <Trash2 className="h-4 w-4 text-text-muted" strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-4 font-mono text-sm">
        {visible.length === 0 && (
          <div className="flex h-full items-center justify-center text-text-muted">
            Esperando eventos…
          </div>
        )}
        {visible.map((l, i) => (
          <div key={i} className="flex gap-3 border-b border-border/30 py-1.5">
            <span className="shrink-0 text-text-muted tnum">{formatTime(l.time)}</span>
            <span className={`w-12 shrink-0 uppercase ${LEVEL_STYLE[l.level]}`}>{l.level}</span>
            <span className="text-text-strong">{l.msg}</span>
            {l.ctx && Object.keys(l.ctx).length > 0 && (
              <span className="truncate text-text-muted">
                {Object.entries(l.ctx)
                  .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
                  .join("  ")}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
