/**
 * Estado del servicio: health, conexion TCP, DB, y configuracion editable.
 *
 * El health ya no se consulta aca: vive en useServiceStatus() para que el
 * sidebar (y cualquier otra pantalla) puedan mostrarlo. Aca ademas se
 * distingue "dato de ahora" de "ultimo dato conocido hace un rato", que era
 * justamente el bug: la unica pantalla cuyo trabajo es decir "esto esta vivo"
 * decia "En línea" para siempre.
 */

import { useEffect, useId, useState } from "react";
import {
  Activity,
  Database,
  Radio,
  Settings,
  Check,
  AlertCircle,
  FileText,
  FolderOpen,
  FolderSearch,
  RefreshCw,
} from "lucide-react";

import {
  getConfig,
  updateConfig,
  getUpdateStatus,
  checkForUpdates,
  rerunExport,
  apiErrorMessage,
  isConnectionError,
  type ConnectionMode,
  type ExportStatus,
  type HealthResponse,
  type ServiceConfig,
  type UpdateConfigRequest,
  type UpdateStatusResponse,
} from "../lib/api";
import { canOpenPath, canPickDirectory, openPath, pickDirectory } from "../lib/tauri";
import { formatAgo, useServiceStatus } from "../hooks/useServiceStatus";
import { ConnectingState, Dot, ErrorState, Spinner } from "../components/primitives";

export function StatusView() {
  const status = useServiceStatus();
  const { health, phase, stale, staleMs, error } = status;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-8 py-6">
        <div>
          <h1 className="text-2xl font-medium text-text-strong">Estado del servicio</h1>
          {/* Esta linea es la que tiene que decir SIEMPRE la verdad sobre la
              frescura del dato: es el bug que la pantalla tenia. */}
          <p className="mt-1 inline-flex items-center gap-2 text-sm" role="status" aria-live="polite">
            {phase === "booting" ? (
              <span className="inline-flex items-center gap-2 text-text-muted">
                <Spinner className="h-3.5 w-3.5" />
                Conectando con el servicio…
              </span>
            ) : phase === "offline" ? (
              <span className="inline-flex items-center gap-2 text-high-text">
                <Dot className="bg-high-text" />
                Sin contacto con el servicio ·{" "}
                {staleMs !== null
                  ? `último dato conocido ${formatAgo(staleMs)}`
                  : "nunca respondió"}
              </span>
            ) : stale ? (
              <span className="inline-flex items-center gap-2 text-warn-text">
                <Spinner className="h-3.5 w-3.5" />
                Reintentando ·{" "}
                {staleMs !== null ? `último dato ${formatAgo(staleMs)}` : "sin datos"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-text-muted">
                <Dot className="bg-normal-text" />
                Al día · se actualiza cada 3 segundos
              </span>
            )}
          </p>
        </div>
        <button
          onClick={status.refresh}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:bg-accent-soft"
        >
          <RefreshCw className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
          Actualizar ahora
        </button>
      </header>

      <div className="flex-1 overflow-auto px-8 py-6">
        {/* Arranque: el servicio puede tardar en levantar, y un primer intento
            fallido no es todavia una noticia. Recien cuando se declara offline
            mostramos el error. */}
        {phase === "booting" && !health && <ConnectingState />}

        {phase === "offline" && !health && (
          <ErrorState
            title="No se pudo contactar el servicio"
            message={error ?? "No responde"}
            hint="Verificá que el servicio esté corriendo en el puerto 7700."
            onRetry={status.refresh}
          />
        )}

        {health && (
          <div className="max-w-4xl">
            {phase === "offline" && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-high-text/20 bg-high-bg/40 p-4 text-sm text-high-text"
              >
                <strong>El servicio no responde.</strong> Lo que ves abajo es el último
                dato conocido, de {staleMs !== null ? formatAgo(staleMs) : "hace un rato"}
                {error ? ` (${error})` : ""}. Mientras tanto los resultados que mande el
                analizador no se están guardando.
              </div>
            )}

            <div
              className={`grid gap-4 md:grid-cols-2 ${phase === "offline" ? "opacity-60" : ""}`}
            >
              {/* Estado general */}
              <Card icon={<Activity className="h-5 w-5" strokeWidth={1.5} />} title="General">
                <Row label="Estado">
                  <span className="inline-flex items-center gap-2">
                    <Dot className={generalDotClass(health, phase)} />
                    <span>{generalLabel(health, phase)}</span>
                  </span>
                </Row>
                <Row label="Versión">
                  <span className="font-mono tnum">{health.version}</span>
                </Row>
                <Row label="Uptime">
                  <span className="font-mono tnum">{formatUptime(health.uptime)}</span>
                </Row>
              </Card>

              {/* Conexion con el equipo */}
              <Card
                icon={<Radio className="h-5 w-5" strokeWidth={1.5} />}
                title="Conexión con el analizador"
              >
                <Row label="Modo">
                  <span className="text-sm">
                    {health.connectionMode === "connect"
                      ? "Nos conectamos al equipo"
                      : "El equipo se conecta a nosotros"}
                  </span>
                </Row>

                {health.analyzerClient ? (
                  <>
                    <Row label="Estado">
                      <span className="inline-flex items-center gap-2">
                        <Dot
                          className={
                            health.analyzerClient.connected ? "bg-normal-text" : "bg-high-text"
                          }
                        />
                        {health.analyzerClient.connected
                          ? "Conectado al equipo"
                          : "Esperando al equipo"}
                      </span>
                    </Row>
                    <Row label="Equipo">
                      <span className="font-mono tnum">
                        {health.analyzerClient.address}:{health.analyzerClient.port}
                      </span>
                    </Row>
                    {!health.analyzerClient.connected && health.analyzerClient.lastError && (
                      <Row label="Último error">
                        <span className="text-sm text-high-text">
                          {health.analyzerClient.lastError}
                        </span>
                      </Row>
                    )}
                    {health.analyzerClient.connectedAt && (
                      <Row label="Conectado desde">
                        <span className="font-mono text-sm tnum">
                          {new Date(health.analyzerClient.connectedAt).toLocaleString("es-AR")}
                        </span>
                      </Row>
                    )}
                  </>
                ) : (
                  <>
                    <Row label="Escuchando">
                      <span className="inline-flex items-center gap-2">
                        <Dot
                          className={health.tcpListener.listening ? "bg-normal-text" : "bg-high-text"}
                        />
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
                  </>
                )}

                <Row label="Reconexiones">
                  <span className="font-mono tnum">
                    {health.tcpListener.totalConnectionsSinceStart}
                  </span>
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
                    {health.database.ok ? "OK" : "No se puede escribir"}
                  </span>
                </Row>
                {!health.database.ok && (
                  <p className="rounded-sm border border-high-text/20 bg-high-bg/40 px-3 py-2 text-xs text-high-text">
                    La base rechaza escrituras: <strong>los resultados que llegue a
                    mandar el analizador no se van a guardar.</strong> Cerrá la app y
                    volvé a abrirla; si sigue igual, revisá los permisos de la carpeta{" "}
                    <span className="font-mono">C:\ProgramData\WienerXS20\db</span>.
                  </p>
                )}
                <Row label="Resultados guardados">
                  <span className="font-mono tnum">{health.database.resultCount}</span>
                </Row>
                <Row label="Tamaño">
                  <span className="font-mono tnum">{formatBytes(health.database.sizeBytes)}</span>
                </Row>
              </Card>

              {/* Exportacion de .txt — el archivo que abre el laboratorio */}
              {health.export && <ExportCard status={health.export} />}

              {/* Actualizaciones */}
              <UpdatesCard currentVersion={health.version} />

              {/* Configuracion editable */}
              <div className="md:col-span-2">
                <ConfigCard />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** El health cacheado no manda si perdimos contacto: ahi lo honesto es rojo. */
function generalDotClass(health: HealthResponse, phase: string): string {
  if (phase === "offline") return "bg-high-text";
  if (health.status === "ok") return "bg-normal-text";
  if (health.status === "degraded") return "bg-warn-text";
  return "bg-high-text";
}

function generalLabel(health: HealthResponse, phase: string): string {
  if (phase === "offline") return "Sin conexión";
  if (health.status === "ok") return "En línea";
  if (health.status === "degraded") return "En línea, con problemas";
  return "Caído";
}

// ─── Card de exportacion a .txt ──────────────────────────────────────────────

/**
 * Como viene saliendo el .txt de cada muestra.
 *
 * Es la tarjeta mas importante de esta pantalla: el .txt es lo unico que el
 * laboratorio abre. Antes, si la carpeta tenia un typo o la unidad de red
 * estaba caida, no habia forma de enterarse hasta que alguien notaba que
 * faltaban archivos.
 */
function ExportCard({ status }: { status: ExportStatus }) {
  const [rerunning, setRerunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRerun = async () => {
    setRerunning(true);
    setResult(null);
    setError(null);
    try {
      const r = await rerunExport();
      setResult(
        r.written === 0
          ? "No había resultados para regenerar."
          : `Se regeneraron ${r.written} archivo${r.written === 1 ? "" : "s"}` +
              (r.failed > 0 ? `, ${r.failed} fallaron.` : "."),
      );
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setRerunning(false);
    }
  };

  return (
    <Card icon={<FileText className="h-5 w-5" strokeWidth={1.5} />} title="Exportación de .txt">
      <Row label="Estado">
        <span className="inline-flex items-center gap-2">
          <Dot
            className={
              !status.enabled
                ? "bg-text-muted"
                : status.healthy
                  ? "bg-normal-text"
                  : "bg-high-text"
            }
          />
          {!status.enabled
            ? "Apagada"
            : status.healthy
              ? "Escribiendo bien"
              : "No se pueden escribir los archivos"}
        </span>
      </Row>

      {status.enabled && !status.healthy && (
        <p className="rounded-sm border border-high-text/20 bg-high-bg/40 px-3 py-2 text-xs text-high-text">
          <strong>Los .txt de las muestras no se están generando.</strong>{" "}
          {status.dirError ?? status.lastError}. Revisá que la carpeta exista y que
          esté conectada (Configuración, más abajo). Los resultados igual quedan
          guardados: cuando la arregles, usá “Regenerar” para recuperar los
          archivos que faltan.
        </p>
      )}

      {status.enabled && (
        <>
          <Row label="Último archivo">
            <span className="text-sm">
              {status.lastWriteAt
                ? formatAgo(Date.now() - new Date(status.lastWriteAt).getTime())
                : "—"}
            </span>
          </Row>
          <Row label="Archivos escritos">
            <span className="font-mono tnum">{status.writtenSinceStart}</span>
          </Row>
          {status.failedSinceStart > 0 && (
            <Row label="Fallados">
              <span className="font-mono tnum text-high-text">{status.failedSinceStart}</span>
            </Row>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              onClick={onRerun}
              disabled={rerunning}
              className="rounded-sm border border-border px-3 py-1.5 text-sm text-text hover:border-accent hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {rerunning ? "Regenerando…" : "Regenerar .txt"}
            </button>
            <span className="text-xs text-text-muted">
              Vuelve a escribir los .txt de los últimos 200 resultados guardados.
            </span>
          </div>
          {result && <p className="text-xs text-normal-text">{result}</p>}
          {error && <p className="text-xs text-high-text">{error}</p>}
        </>
      )}
    </Card>
  );
}

// ─── Card de actualizaciones ─────────────────────────────────────────────────

function UpdatesCard({ currentVersion }: { currentVersion: string }) {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getUpdateStatus()
      .then((st) => active && setStatus(st))
      .catch(() => {
        // Servicio viejo sin el endpoint: la card muestra solo la version.
      });
    return () => {
      active = false;
    };
  }, []);

  const onCheckNow = async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await checkForUpdates());
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const onToggle = async (enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      await updateConfig({ updateCheckEnabled: enabled });
      setStatus(await getUpdateStatus());
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Card icon={<RefreshCw className="h-5 w-5" strokeWidth={1.5} />} title="Actualizaciones">
      <Row label="Versión instalada">
        <span className="font-mono tnum">{currentVersion}</span>
      </Row>
      {status && (
        <>
          <Row label="Última versión publicada">
            <span className="font-mono tnum">
              {status.latestVersion ?? (status.lastCheckAt ? "estás al día" : "—")}
            </span>
          </Row>
          <Row label="Último chequeo">
            <span className="font-mono text-sm tnum">
              {status.lastCheckAt
                ? new Date(status.lastCheckAt).toLocaleString("es-AR")
                : "todavía no se chequeó"}
            </span>
          </Row>
          {status.lastCheckError && (
            <Row label="Último error">
              <span className="text-sm text-high-text">{status.lastCheckError}</span>
            </Row>
          )}
          {status.skippedVersion && (
            <Row label="Versión omitida">
              <span className="font-mono tnum">{status.skippedVersion}</span>
            </Row>
          )}

          <div className="flex items-center justify-between pt-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={status.updateCheckEnabled}
                disabled={toggling}
                onChange={(e) => void onToggle(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              Buscar actualizaciones automáticamente
            </label>
            <button
              onClick={() => void onCheckNow()}
              disabled={checking || !status.updateCheckEnabled}
              className="inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-xs text-text-muted hover:bg-border/30 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checking && <Spinner className="h-3 w-3" />}
              {checking ? "Buscando…" : "Buscar ahora"}
            </button>
          </div>
          {error && (
            <p className="inline-flex items-center gap-1.5 text-sm text-high-text">
              <AlertCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              {error}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Card de configuracion editable ───────────────────────────────────────────

function ConfigCard() {
  const [cfg, setCfg] = useState<ServiceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadOffline, setLoadOffline] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [mode, setMode] = useState<ConnectionMode>("listen");
  const [analyzerHost, setAnalyzerHost] = useState("");
  const [analyzerPort, setAnalyzerPort] = useState("");
  const [tcpHost, setTcpHost] = useState("");
  const [tcpPort, setTcpPort] = useState("");
  const [logLevel, setLogLevel] = useState<ServiceConfig["logLevel"]>("info");
  const [retention, setRetention] = useState("");
  const [exportDir, setExportDir] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  const ids = {
    mode: useId(),
    analyzerHost: useId(),
    analyzerPort: useId(),
    tcpHost: useId(),
    tcpPort: useId(),
    logLevel: useId(),
    retention: useId(),
    exportDir: useId(),
  };

  const applyConfig = (c: ServiceConfig) => {
    setCfg(c);
    setMode(c.connectionMode);
    setAnalyzerHost(c.analyzerHost);
    setAnalyzerPort(String(c.analyzerPort));
    setTcpHost(c.tcpHost);
    setTcpPort(String(c.tcpPort));
    setLogLevel(c.logLevel);
    setRetention(String(c.rawRetentionDays));
    setExportDir(c.exportDir);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setLoadOffline(false);
    getConfig()
      .then((c) => {
        if (!cancelled) applyConfig(c);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isConnectionError(e)) setLoadOffline(true);
        else setLoadError(apiErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const dirty =
    cfg !== null &&
    (mode !== cfg.connectionMode ||
      analyzerHost !== cfg.analyzerHost ||
      analyzerPort !== String(cfg.analyzerPort) ||
      tcpHost !== cfg.tcpHost ||
      tcpPort !== String(cfg.tcpPort) ||
      logLevel !== cfg.logLevel ||
      retention !== String(cfg.rawRetentionDays) ||
      exportDir !== cfg.exportDir);

  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const patch: UpdateConfigRequest = {
        connectionMode: mode,
        analyzerHost: analyzerHost.trim(),
        analyzerPort: Number(analyzerPort),
        tcpHost: tcpHost.trim(),
        tcpPort: Number(tcpPort),
        logLevel,
        rawRetentionDays: Number(retention),
        exportDir: exportDir.trim(),
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

  const onPickFolder = async () => {
    setFolderError(null);
    try {
      const picked = await pickDirectory(exportDir.trim() || undefined);
      if (picked) setExportDir(picked);
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    }
  };

  const onOpenFolder = async () => {
    setFolderError(null);
    if (!cfg?.exportDir) return;
    try {
      await openPath(cfg.exportDir);
    } catch {
      setFolderError(
        "No se pudo abrir la carpeta. Puede que ya no exista o que se haya movido.",
      );
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2 text-text-strong">
        <span className="text-text-muted">
          <Settings className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h2 className="font-medium">Configuración</h2>
      </div>
      <p className="mb-4 text-sm text-text-muted">
        Los cambios se aplican al instante, sin reiniciar el servicio.
      </p>

      {loading && (
        <div className="space-y-3" role="status" aria-label="Cargando la configuración">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-sm bg-border/40" />
          ))}
        </div>
      )}

      {!loading && loadOffline && (
        <p className="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text-muted">
          No se puede leer la configuración mientras el servicio no responda. Se reintenta
          solo; también podés{" "}
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-accent underline underline-offset-2"
          >
            probar de nuevo
          </button>
          .
        </p>
      )}

      {!loading && !loadOffline && loadError && (
        <div className="rounded-sm border border-high-text/20 bg-high-bg/40 px-3 py-2 text-sm text-high-text">
          No se pudo leer la configuración: {loadError}{" "}
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="underline underline-offset-2"
          >
            Reintentar
          </button>
        </div>
      )}

      {!loading && cfg && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                htmlFor={ids.mode}
                label="¿Quién inicia la conexión?"
                hint="Tiene que coincidir con la configuración de LIS del analizador. Si no estás seguro, probá 'Nos conectamos al equipo' y mirá el estado arriba."
              >
                <select
                  id={ids.mode}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ConnectionMode)}
                  className={inputClass}
                >
                  <option value="connect">
                    Nos conectamos al equipo (el equipo escucha)
                  </option>
                  <option value="listen">
                    El equipo se conecta a nosotros (nosotros escuchamos)
                  </option>
                </select>
              </Field>
            </div>

            {mode === "connect" ? (
              <>
                <Field
                  htmlFor={ids.analyzerHost}
                  label="IP del analizador"
                  hint="La dirección del XS 20 en la red del laboratorio."
                >
                  <input
                    id={ids.analyzerHost}
                    type="text"
                    value={analyzerHost}
                    spellCheck={false}
                    onChange={(e) => setAnalyzerHost(e.target.value)}
                    placeholder="192.168.100.15"
                    className={inputClass}
                  />
                </Field>

                <Field
                  htmlFor={ids.analyzerPort}
                  label="Puerto del analizador"
                  hint="En el XS 20 suele ser 5100."
                >
                  <input
                    id={ids.analyzerPort}
                    type="number"
                    min={1}
                    max={65535}
                    value={analyzerPort}
                    onChange={(e) => setAnalyzerPort(e.target.value)}
                    placeholder="5100"
                    className={inputClass}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  htmlFor={ids.tcpHost}
                  label="IP a escuchar"
                  hint="Interfaz donde el analizador se conecta. 0.0.0.0 = todas."
                >
                  <input
                    id={ids.tcpHost}
                    type="text"
                    value={tcpHost}
                    spellCheck={false}
                    onChange={(e) => setTcpHost(e.target.value)}
                    placeholder="0.0.0.0"
                    className={inputClass}
                  />
                </Field>

                <Field
                  htmlFor={ids.tcpPort}
                  label="Puerto TCP"
                  hint="Puerto donde escucha al XS 20."
                >
                  <input
                    id={ids.tcpPort}
                    type="number"
                    min={1}
                    max={65535}
                    value={tcpPort}
                    onChange={(e) => setTcpPort(e.target.value)}
                    placeholder="5100"
                    className={inputClass}
                  />
                </Field>
              </>
            )}

            <Field htmlFor={ids.logLevel} label="Nivel de log">
              <select
                id={ids.logLevel}
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

            <Field
              htmlFor={ids.retention}
              label="Retención de HL7 crudo (días)"
              hint="0 = no purgar nunca."
            >
              <input
                id={ids.retention}
                type="number"
                min={0}
                max={3650}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                placeholder="90"
                className={inputClass}
              />
            </Field>

            <div className="sm:col-span-2">
              <ExportDirField
                id={ids.exportDir}
                value={exportDir}
                savedValue={cfg.exportDir}
                onChange={setExportDir}
                onPick={() => void onPickFolder()}
                onOpen={() => void onOpenFolder()}
                error={folderError}
              />
            </div>
          </div>

          <p className="mt-3 text-xs text-text-muted">
            La API local usa el puerto{" "}
            <span className="font-mono">{cfg.httpPort}</span> (no editable desde acá).
          </p>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-2 rounded-sm bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving && <Spinner className="h-4 w-4 text-surface" />}
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>

            {saved && (
              <span className="inline-flex items-center gap-1.5 text-sm text-normal-text">
                <Check className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                Guardado
              </span>
            )}
            {saveError && (
              <span className="inline-flex items-center gap-1.5 text-sm text-high-text">
                <AlertCircle className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                {saveError}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Carpeta de exportacion ──────────────────────────────────────────────────
//
// Es LA funcion que le importa al laboratorio y antes dependia de que alguien
// tipeara una ruta de Windows sin errores. Ahora: selector nativo, boton para
// abrirla en el explorador, y aviso si la ruta escrita a mano no parece
// absoluta.

function ExportDirField({
  id,
  value,
  savedValue,
  onChange,
  onPick,
  onOpen,
  error,
}: {
  id: string;
  value: string;
  savedValue: string;
  onChange: (v: string) => void;
  onPick: () => void;
  onOpen: () => void;
  error: string | null;
}) {
  const trimmed = value.trim();
  const unsavedChange = trimmed !== savedValue;
  const looksAbsolute =
    trimmed === "" || /^([A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed);

  return (
    <Field
      htmlFor={id}
      label="Carpeta de exportación de .txt"
      hint="Por cada resultado recibido se escribe un <muestra>.txt ahí."
    >
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="text"
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder="C:\Users\Laboratorio\Documents\Hemogramas"
          aria-describedby={`${id}-estado`}
          className={`${inputClass} min-w-0 flex-1`}
        />
        {canPickDirectory() && (
          <button
            type="button"
            onClick={onPick}
            className="inline-flex shrink-0 items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-accent-soft"
          >
            <FolderSearch className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
            Elegir carpeta…
          </button>
        )}
        {canOpenPath() && savedValue !== "" && (
          <button
            type="button"
            onClick={onOpen}
            disabled={unsavedChange}
            title={
              unsavedChange ? "Guardá los cambios para abrir la carpeta nueva" : undefined
            }
            className="inline-flex shrink-0 items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FolderOpen className="h-4 w-4 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
            Abrir carpeta
          </button>
        )}
      </div>

      <span id={`${id}-estado`} className="mt-1.5 block text-xs">
        {trimmed === "" ? (
          <span className="text-warn-text">
            Vacío: <strong>no se está exportando ningún .txt.</strong> Elegí una carpeta
            para que cada muestra se guarde también como archivo.
          </span>
        ) : !looksAbsolute ? (
          <span className="text-warn-text">
            Eso no parece una carpeta completa. Tiene que empezar con la unidad, por
            ejemplo <span className="font-mono">C:\Users\…</span>. Mejor usá “Elegir
            carpeta…”.
          </span>
        ) : unsavedChange ? (
          <span className="text-text-muted">
            Sin guardar. Se va a exportar acá cuando toques “Guardar cambios”.
          </span>
        ) : (
          <span className="text-normal-text">
            Cada muestra que llegue se guarda también en esta carpeta.
          </span>
        )}
      </span>

      {error && (
        <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-high-text">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {error}
        </span>
      )}
    </Field>
  );
}

const inputClass =
  "w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none";

function Field({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-sm font-medium text-text-strong"
      >
        {label}
      </label>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-muted">{hint}</span>}
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2 text-text-strong">
        <span className="text-text-muted" aria-hidden="true">
          {icon}
        </span>
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
