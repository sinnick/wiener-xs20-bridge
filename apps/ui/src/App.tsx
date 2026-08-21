/**
 * App principal. Navegacion por sidebar + routing simple por estado.
 */

import { useEffect, useState } from "react";
import { LayoutList, Activity, ScrollText, Droplet } from "lucide-react";

import { ResultsList } from "./pages/ResultsList";
import { ResultDetail } from "./pages/ResultDetail";
import { LogsView } from "./pages/LogsView";
import { StatusView } from "./pages/StatusView";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdateStatus } from "./hooks/useUpdateStatus";
import { useServiceStatus, type LinkState } from "./hooks/useServiceStatus";
import { subscribeLogs } from "./lib/api";
import { Dot } from "./components/primitives";

type View = "results" | "logs" | "status";

export function App() {
  const [view, setView] = useState<View>("results");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastArrivedId, setLastArrivedId] = useState<string | null>(null);
  const update = useUpdateStatus();

  // Escuchamos el stream de actividad globalmente: cuando llega un
  // "hl7.parsed", refrescamos la lista de resultados sin que la operadora
  // tenga que recargar. Y cuando el stream vuelve despues de una caida
  // refrescamos igual, porque nos perdimos lo que paso mientras estuvo caido.
  useEffect(() => {
    return subscribeLogs({
      onEvent: (e) => {
        if (e.msg === "hl7.parsed") {
          const sampleId = e.ctx?.sampleId;
          if (typeof sampleId === "string") setLastArrivedId(sampleId);
          setRefreshKey((k) => k + 1);
        }
      },
      onReconnect: () => setRefreshKey((k) => k + 1),
    });
  }, []);

  const openResult = (id: string) => setSelectedId(id);
  const backToList = () => setSelectedId(null);

  const goto = (v: View) => {
    setView(v);
    setSelectedId(null);
  };

  return (
    <div className="flex h-screen bg-bg">
      {/* Sidebar */}
      <aside className="no-print flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
            <Droplet className="h-5 w-5 text-surface" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div>
            <div className="text-sm font-medium leading-tight text-text-strong">Wiener XS 20</div>
            <div className="font-mono text-xs text-text-muted">Bridge</div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-2" aria-label="Secciones">
          <NavItem
            icon={<LayoutList className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />}
            label="Resultados"
            active={view === "results"}
            onClick={() => goto("results")}
          />
          <NavItem
            icon={<ScrollText className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />}
            label="Actividad"
            active={view === "logs"}
            onClick={() => goto("logs")}
          />
          <NavItem
            icon={<Activity className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />}
            label="Estado"
            active={view === "status"}
            onClick={() => goto("status")}
          />
        </nav>

        <HealthFooter onOpenStatus={() => goto("status")} />
      </aside>

      {/* Contenido */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <UpdateBanner update={update} />
        <div className="flex-1 overflow-hidden">
          {view === "results" && selectedId === null && (
            <ResultsList
              onSelect={openResult}
              refreshKey={refreshKey}
              highlightSampleId={lastArrivedId}
            />
          )}
          {view === "results" && selectedId !== null && (
            <ResultDetail id={selectedId} onBack={backToList} />
          )}
          {view === "logs" && <LogsView />}
          {view === "status" && <StatusView />}
        </div>
      </main>
    </div>
  );
}

// ─── Indicador de salud global ───────────────────────────────────────────────
//
// Antes el pie del sidebar decia "Laboratorio · Craftly" y nada mas: para
// enterarte de que el analizador estaba desconectado habia que entrar a
// Estado. Ahora el estado esta a la vista desde cualquier pantalla.

const LINK_DOT: Record<LinkState, string> = {
  connected: "bg-normal-text",
  waiting: "bg-accent",
  down: "bg-high-text",
  unknown: "bg-text-muted",
};

function HealthFooter({ onOpenStatus }: { onOpenStatus: () => void }) {
  const { link, phase } = useServiceStatus();

  return (
    <div className="border-t border-border px-3 py-3">
      <button
        onClick={onOpenStatus}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-border/30"
        title="Ver el estado del servicio"
      >
        <span className="mt-1.5 shrink-0">
          <Dot
            className={`${LINK_DOT[link.state]} ${phase === "booting" ? "animate-pulse" : ""}`}
          />
        </span>
        <span className="min-w-0">
          <span
            role="status"
            aria-live="polite"
            className="block text-sm leading-snug text-text-strong"
          >
            {link.label}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-text-muted">
            Laboratorio · Craftly
          </span>
        </span>
      </button>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  // Regla de taste: activo = bloque gris suave quieto, sin border/inset.
  // Hover sin transicion (instantaneo).
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${
        active
          ? "bg-border/60 font-medium text-text-strong"
          : "text-text-muted hover:bg-border/30 hover:text-text"
      }`}
    >
      <span className={active ? "text-accent" : ""}>{icon}</span>
      {label}
    </button>
  );
}
