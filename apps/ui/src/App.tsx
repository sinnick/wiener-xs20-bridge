/**
 * App principal. Navegacion por sidebar + routing simple por estado.
 */

import { useEffect, useState } from "react";
import { LayoutList, Activity, ScrollText, Droplet } from "lucide-react";

import { ResultsList } from "./pages/ResultsList";
import { ResultDetail } from "./pages/ResultDetail";
import { LogsView } from "./pages/LogsView";
import { StatusView } from "./pages/StatusView";
import { streamLogs } from "./lib/api";

type View = "results" | "logs" | "status";

export function App() {
  const [view, setView] = useState<View>("results");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Escuchamos el stream de logs globalmente: cuando llega un "hl7.parsed",
  // refrescamos la lista de resultados sin que el usuario tenga que recargar.
  useEffect(() => {
    const stop = streamLogs((e) => {
      if (e.msg === "hl7.parsed") {
        setRefreshKey((k) => k + 1);
      }
    });
    return stop;
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
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
            <Droplet className="h-5 w-5 text-surface" strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-sm font-medium leading-tight text-text-strong">Wiener XS 20</div>
            <div className="font-mono text-xs text-text-muted">Bridge</div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-2">
          <NavItem
            icon={<LayoutList className="h-5 w-5" strokeWidth={1.5} />}
            label="Resultados"
            active={view === "results"}
            onClick={() => goto("results")}
          />
          <NavItem
            icon={<ScrollText className="h-5 w-5" strokeWidth={1.5} />}
            label="Actividad"
            active={view === "logs"}
            onClick={() => goto("logs")}
          />
          <NavItem
            icon={<Activity className="h-5 w-5" strokeWidth={1.5} />}
            label="Estado"
            active={view === "status"}
            onClick={() => goto("status")}
          />
        </nav>

        <div className="px-5 py-4 font-mono text-xs text-text-muted">
          Laboratorio · Craftly
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 overflow-hidden">
        {view === "results" && selectedId === null && (
          <ResultsList onSelect={openResult} refreshKey={refreshKey} />
        )}
        {view === "results" && selectedId !== null && (
          <ResultDetail id={selectedId} onBack={backToList} />
        )}
        {view === "logs" && <LogsView />}
        {view === "status" && <StatusView />}
      </main>
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
