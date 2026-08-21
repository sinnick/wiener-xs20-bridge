/**
 * Banner global de actualizaciones. Aparece arriba del contenido en cualquier
 * vista cuando el servicio detecto una version nueva en GitHub Releases.
 *
 * Flujo: Descargar (el servicio baja el instalador con progreso) → Instalar y
 * reiniciar (confirmacion inline, la app se cierra y corre el instalador).
 * "Más tarde" lo oculta hasta la proxima apertura; "Omitir esta versión" no
 * vuelve a avisar de esa version puntual (persistido en el servicio).
 */

import { useEffect, useState } from "react";
import { AlertCircle, Download, Loader2, RefreshCw, Rocket } from "lucide-react";

import type { UseUpdateStatus } from "../hooks/useUpdateStatus";

/** Que accion esta en curso. Sirve para no permitir un doble click. */
type Busy = "download" | "install" | "skip" | null;

export function UpdateBanner({ update }: { update: UseUpdateStatus }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const { status, dismissed, actionError } = update;

  // Si la accion fallo, volvemos a habilitar los botones. Si salio bien la app
  // ya se esta cerrando (instalar) o el phase cambio (descargar), asi que el
  // boton desaparece solo.
  useEffect(() => {
    if (actionError) setBusy(null);
  }, [actionError]);

  const run = (kind: Exclude<Busy, null>, fn: () => Promise<void>) => () => {
    if (busy !== null) return;
    setBusy(kind);
    void fn().finally(() => {
      // "install" queda deshabilitado a proposito: entre que resuelve y que la
      // ventana se cierra hay un rato en el que un segundo click lanzaria otro
      // instalador.
      if (kind !== "install") setBusy(null);
    });
  };

  if (!status || dismissed) return null;
  const { phase } = status;
  if (phase === "idle" || phase === "checking") return null;

  return (
    <div className="no-print border-b border-border bg-surface px-8 py-3">
      {phase === "update-available" && (
        <BannerRow
          icon={<Download className="h-4 w-4" strokeWidth={1.5} />}
          text={`Hay una nueva versión disponible (v${status.latestVersion})`}
        >
          <PrimaryButton
            onClick={run("download", update.download)}
            loading={busy === "download"}
            loadingLabel="Iniciando descarga…"
            disabled={busy !== null}
          >
            Descargar
          </PrimaryButton>
          <GhostButton onClick={update.dismiss} disabled={busy !== null}>
            Más tarde
          </GhostButton>
          <button
            onClick={run("skip", update.skip)}
            disabled={busy !== null}
            className="text-xs text-text-muted underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "skip" ? "Omitiendo…" : "Omitir esta versión"}
          </button>
          {update.actionError && <ErrorText msg={update.actionError} />}
        </BannerRow>
      )}

      {phase === "downloading" && (
        <BannerRow
          icon={<Download className="h-4 w-4 animate-pulse" strokeWidth={1.5} />}
          text={`Descargando actualización… ${formatProgress(status.download)}`}
        >
          <ProgressBar
            downloaded={status.download?.downloadedBytes ?? 0}
            total={status.download?.totalBytes ?? null}
          />
        </BannerRow>
      )}

      {phase === "downloaded" && !confirming && (
        <BannerRow
          icon={<Rocket className="h-4 w-4" strokeWidth={1.5} />}
          text={`Actualización v${status.latestVersion} lista para instalar`}
        >
          <PrimaryButton onClick={() => setConfirming(true)}>
            Instalar y reiniciar
          </PrimaryButton>
          <GhostButton onClick={update.dismiss}>Más tarde</GhostButton>
          {update.actionError && <ErrorText msg={update.actionError} />}
        </BannerRow>
      )}


      {phase === "downloaded" && confirming && (
        <BannerRow
          icon={<Rocket className="h-4 w-4" strokeWidth={1.5} />}
          text={
            busy === "install"
              ? "Instalando la actualización. La ventana se va a cerrar sola en unos segundos; no la cierres vos."
              : "La aplicación se va a cerrar para instalar la actualización. El servicio se reinicia solo."
          }
        >
          <PrimaryButton
            onClick={run("install", update.install)}
            loading={busy === "install"}
            loadingLabel="Instalando…"
            disabled={busy !== null}
          >
            Sí, instalar
          </PrimaryButton>
          <GhostButton onClick={() => setConfirming(false)} disabled={busy !== null}>
            Cancelar
          </GhostButton>
          {update.actionError && <ErrorText msg={update.actionError} />}
        </BannerRow>
      )}

      {phase === "error" && (
        <BannerRow
          icon={<AlertCircle className="h-4 w-4 text-high-text" strokeWidth={1.5} />}
          text={`No se pudo descargar la actualización: ${status.download?.error ?? "error desconocido"}`}
        >
          <PrimaryButton
            onClick={run("download", update.download)}
            loading={busy === "download"}
            loadingLabel="Reintentando…"
            disabled={busy !== null}
          >
            <RefreshCw className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Reintentar
          </PrimaryButton>
          <GhostButton onClick={update.dismiss} disabled={busy !== null}>
            Más tarde
          </GhostButton>
        </BannerRow>
      )}
    </div>
  );
}

function BannerRow({
  icon,
  text,
  children,
}: {
  icon: React.ReactNode;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex items-center gap-2 text-sm text-text-strong">
        <span className="text-accent">{icon}</span>
        {text}
      </span>
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </div>
  );
}

function PrimaryButton({
  onClick,
  children,
  disabled = false,
  loading = false,
  loadingLabel,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** Que decir mientras la accion esta en curso (si no, se deja el label). */
  loadingLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-surface hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

function GhostButton({
  onClick,
  children,
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm px-3 py-1.5 text-xs text-text-muted hover:bg-border/30 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ErrorText({ msg }: { msg: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-high-text">
      <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} />
      {msg}
    </span>
  );
}

function ProgressBar({ downloaded, total }: { downloaded: number; total: number | null }) {
  const pct = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
  return (
    <span className="flex w-44 items-center">
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: pct !== null ? `${pct}%` : "30%" }}
        />
      </span>
    </span>
  );
}

function formatProgress(
  download: { downloadedBytes: number; totalBytes: number | null } | null,
): string {
  if (!download) return "";
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
  if (download.totalBytes && download.totalBytes > 0) {
    const pct = Math.min(100, Math.round((download.downloadedBytes / download.totalBytes) * 100));
    return `${pct} % (${mb(download.downloadedBytes)} de ${mb(download.totalBytes)} MB)`;
  }
  return `${mb(download.downloadedBytes)} MB`;
}
