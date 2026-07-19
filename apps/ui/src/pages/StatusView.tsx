/**
 * Estado del servicio: health, conexion TCP, DB, configuracion.
 */

import { useEffect, useState } from "react";
import { Activity, Database, Radio, Settings } from "lucide-react";

import { getHealth, type HealthResponse } from "../lib/api";
import { Dot } from "../components/primitives";

export function StatusView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      getHealth()
        .then((h) => active && setHealth(h))
        .catch((e) => active && setError(e.message));
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-6">
        <h1 className="text-2xl font-medium text-text-strong">Estado del servicio</h1>
        <p className="mt-1 text-sm text-text-muted">Se actualiza cada 3 segundos</p>
      </header>

      <div className="flex-1 overflow-auto px-8 py-6">
        {error && !health && (
          <div className="rounded-lg border border-high-text/20 bg-high-bg/40 p-4 text-high-text">
            No se pudo contactar el servicio: {error}
          </div>
        )}

        {health && (
          <div className="grid max-w-4xl gap-4 md:grid-cols-2">
            {/* Estado general */}
            <Card icon={<Activity className="h-5 w-5" strokeWidth={1.5} />} title="General">
              <Row label="Estado">
                <span className="inline-flex items-center gap-2">
                  <Dot className={health.status === "ok" ? "bg-normal-text" : "bg-high-text"} />
                  <span className="capitalize">{health.status === "ok" ? "En línea" : health.status}</span>
                </span>
              </Row>
              <Row label="Versión">
                <span className="font-mono tnum">{health.version}</span>
              </Row>
              <Row label="Uptime">
                <span className="font-mono tnum">{formatUptime(health.uptime)}</span>
              </Row>
            </Card>

            {/* Conexion TCP */}
            <Card icon={<Radio className="h-5 w-5" strokeWidth={1.5} />} title="Conexión con el analizador">
              <Row label="Escuchando">
                <span className="inline-flex items-center gap-2">
                  <Dot className={health.tcpListener.listening ? "bg-normal-text" : "bg-high-text"} />
                  {health.tcpListener.listening ? "Sí" : "No"}
                </span>
              </Row>
              <Row label="Dirección">
                <span className="font-mono tnum">
                  {health.tcpListener.address}:{health.tcpListener.port}
                </span>
              </Row>
              <Row label="Conexiones activas">
                <span className="font-mono tnum">{health.tcpListener.activeConnections}</span>
              </Row>
              <Row label="Total desde el inicio">
                <span className="font-mono tnum">{health.tcpListener.totalConnectionsSinceStart}</span>
              </Row>
              <Row label="Último mensaje">
                <span className="font-mono text-sm tnum">
                  {health.lastMessageAt
                    ? new Date(health.lastMessageAt).toLocaleString("es-AR")
                    : "—"}
                </span>
              </Row>
            </Card>

            {/* Base de datos */}
            <Card icon={<Database className="h-5 w-5" strokeWidth={1.5} />} title="Base de datos">
              <Row label="Estado">
                <span className="inline-flex items-center gap-2">
                  <Dot className={health.database.ok ? "bg-normal-text" : "bg-high-text"} />
                  {health.database.ok ? "OK" : "Error"}
                </span>
              </Row>
              <Row label="Resultados guardados">
                <span className="font-mono tnum">{health.database.resultCount}</span>
              </Row>
              <Row label="Tamaño">
                <span className="font-mono tnum">{formatBytes(health.database.sizeBytes)}</span>
              </Row>
            </Card>

            {/* Ayuda / config */}
            <Card icon={<Settings className="h-5 w-5" strokeWidth={1.5} />} title="Configuración">
              <p className="text-sm text-text-muted">
                Para cambiar puertos, retención de datos o el nivel de logs, editá el
                archivo de configuración del servicio y reinicialo. Los cambios de puerto
                requieren reinicio.
              </p>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2 text-text-strong">
        <span className="text-text-muted">{icon}</span>
        <h2 className="font-medium">{title}</h2>
      </div>
      <dl className="space-y-2.5">{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-sm text-text-strong">{children}</dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
