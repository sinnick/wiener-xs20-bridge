/**
 * Estado del servicio: health, conexion TCP, DB, y configuracion editable.
 */

import { useEffect, useState } from "react";
import { Activity, Database, Radio, Settings, Check, AlertCircle } from "lucide-react";

import {
  getHealth,
  getConfig,
  updateConfig,
  apiErrorMessage,
  type HealthResponse,
  type ServiceConfig,
  type UpdateConfigRequest,
} from "../lib/api";
import { Dot } from "../components/primitives";

export function StatusView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      getHealth()
        .then((h) => active && setHealth(h))
        .catch((e) => active && setError(apiErrorMessage(e)));
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

            {/* Configuracion editable */}
            <div className="md:col-span-2">
              <ConfigCard />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card de configuracion editable ───────────────────────────────────────────

function ConfigCard() {
  const [cfg, setCfg] = useState<ServiceConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tcpHost, setTcpHost] = useState("");
  const [tcpPort, setTcpPort] = useState("");
  const [logLevel, setLogLevel] = useState<ServiceConfig["logLevel"]>("info");
  const [retention, setRetention] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const applyConfig = (c: ServiceConfig) => {
    setCfg(c);
    setTcpHost(c.tcpHost);
    setTcpPort(String(c.tcpPort));
    setLogLevel(c.logLevel);
    setRetention(String(c.rawRetentionDays));
  };

  useEffect(() => {
    getConfig()
      .then(applyConfig)
      .catch((e) => setLoadError(apiErrorMessage(e)));
  }, []);

  const dirty =
    cfg !== null &&
    (tcpHost !== cfg.tcpHost ||
      tcpPort !== String(cfg.tcpPort) ||
      logLevel !== cfg.logLevel ||
      retention !== String(cfg.rawRetentionDays));

  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const patch: UpdateConfigRequest = {
        tcpHost: tcpHost.trim(),
        tcpPort: Number(tcpPort),
        logLevel,
        rawRetentionDays: Number(retention),
      };
      const res = await updateConfig(patch);
      applyConfig(res.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2 text-text-strong">
        <span className="text-text-muted">
          <Settings className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <h2 className="font-medium">Configuración</h2>
      </div>
      <p className="mb-4 text-sm text-text-muted">
        Los cambios se aplican al instante, sin reiniciar el servicio.
      </p>

      {loadError && (
        <div className="mb-4 rounded-sm border border-high-text/20 bg-high-bg/40 px-3 py-2 text-sm text-high-text">
          No se pudo leer la configuración: {loadError}
        </div>
      )}

      {cfg && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="IP a escuchar"
              hint="Interfaz donde el analizador se conecta. 0.0.0.0 = todas."
            >
              <input
                type="text"
                value={tcpHost}
                spellCheck={false}
                onChange={(e) => setTcpHost(e.target.value)}
                placeholder="0.0.0.0"
                className={inputClass}
              />
            </Field>

            <Field label="Puerto TCP" hint="Puerto donde escucha al XS 20.">
              <input
                type="number"
                min={1}
                max={65535}
                value={tcpPort}
                onChange={(e) => setTcpPort(e.target.value)}
                placeholder="5100"
                className={inputClass}
              />
            </Field>

            <Field label="Nivel de log">
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value as ServiceConfig["logLevel"])}
                className={inputClass}
              >
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </Field>

            <Field label="Retención de HL7 crudo (días)" hint="0 = no purgar nunca.">
              <input
                type="number"
                min={0}
                max={3650}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                placeholder="90"
                className={inputClass}
              />
            </Field>
          </div>

          <p className="mt-3 text-xs text-text-muted">
            La API local usa el puerto{" "}
            <span className="font-mono">{cfg.httpPort}</span> (no editable desde acá).
          </p>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>

            {saved && (
              <span className="inline-flex items-center gap-1.5 text-sm text-normal-text">
                <Check className="h-4 w-4" strokeWidth={2} />
                Guardado
              </span>
            )}
            {saveError && (
              <span className="inline-flex items-center gap-1.5 text-sm text-high-text">
                <AlertCircle className="h-4 w-4" strokeWidth={2} />
                {saveError}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-strong">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-muted">{hint}</span>}
    </label>
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
