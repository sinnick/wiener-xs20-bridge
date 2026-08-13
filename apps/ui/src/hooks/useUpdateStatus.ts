/**
 * Estado de actualizaciones, con polling adaptativo: cada 5 minutos en reposo
 * y cada 1 segundo mientras hay una descarga en curso (para la barra de
 * progreso). El chequeo real contra GitHub lo hace el servicio; aca solo se
 * consulta GET /api/update/status.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiErrorMessage,
  getUpdateStatus,
  runInstaller,
  skipUpdateVersion,
  startUpdateDownload,
  type UpdateStatusResponse,
} from "../lib/api";

const IDLE_POLL_MS = 5 * 60 * 1000;
const DOWNLOAD_POLL_MS = 1000;

export interface UseUpdateStatus {
  status: UpdateStatusResponse | null;
  /** Arranca la descarga del instalador (el progreso llega por polling). */
  download: () => Promise<void>;
  /** Lanza el instalador descargado; la app se cierra sola. */
  install: () => Promise<void>;
  /** "Omitir esta versión": no volver a avisar de esta version puntual. */
  skip: () => Promise<void>;
  /** Error de la ultima accion (descargar/instalar/omitir), o null. */
  actionError: string | null;
  /** "Más tarde": oculta el banner hasta la proxima apertura de la app. */
  dismissed: boolean;
  dismiss: () => void;
}

export function useUpdateStatus(): UseUpdateStatus {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const phaseRef = useRef<string>("idle");

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const st = await getUpdateStatus();
        if (!active) return;
        phaseRef.current = st.phase;
        setStatus(st);
      } catch {
        // Servicio caido o viejo (sin endpoint): el banner simplemente no
        // aparece. El resto de la app ya muestra sus propios errores.
      }
      if (!active) return;
      const delay =
        phaseRef.current === "downloading" ? DOWNLOAD_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(poll, delay);
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const download = useCallback(async () => {
    setActionError(null);
    try {
      const st = await startUpdateDownload();
      phaseRef.current = st.phase;
      setStatus(st);
      // Acelerar el proximo poll: la descarga ya esta corriendo.
      setTimeout(async () => {
        try {
          const s2 = await getUpdateStatus();
          phaseRef.current = s2.phase;
          setStatus(s2);
        } catch {
          /* ignore */
        }
      }, DOWNLOAD_POLL_MS);
    } catch (e) {
      setActionError(apiErrorMessage(e));
    }
  }, []);

  const install = useCallback(async () => {
    setActionError(null);
    const path = status?.download?.installerPath;
    if (!path) {
      setActionError("No hay un instalador descargado");
      return;
    }
    try {
      await runInstaller(path);
      // Si salio bien, la app se esta cerrando: no hay mas que hacer.
    } catch (e) {
      setActionError(apiErrorMessage(e));
    }
  }, [status]);

  const skip = useCallback(async () => {
    setActionError(null);
    const version = status?.latestVersion;
    if (!version) return;
    try {
      const st = await skipUpdateVersion(version);
      phaseRef.current = st.phase;
      setStatus(st);
    } catch (e) {
      setActionError(apiErrorMessage(e));
    }
  }, [status]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return { status, download, install, skip, actionError, dismissed, dismiss };
}
