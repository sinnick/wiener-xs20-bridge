/**
 * Acceso a las APIs nativas de Tauri via el global `window.__TAURI__`
 * (`withGlobalTauri: true` en tauri.conf.json). No usamos `@tauri-apps/api`
 * como dependencia npm para no duplicar el bundle.
 *
 * Todo lo de aca devuelve "no disponible" en el navegador (dev), asi que cada
 * pantalla tiene que tener un fallback.
 */

import { isTauri } from "./api";

interface TauriGlobals {
  dialog?: {
    open?: (opts: {
      directory?: boolean;
      multiple?: boolean;
      defaultPath?: string;
      title?: string;
    }) => Promise<string | string[] | null>;
  };
  shell?: {
    open?: (path: string) => Promise<void>;
  };
}

function globals(): TauriGlobals | undefined {
  return (window as unknown as { __TAURI__?: TauriGlobals }).__TAURI__;
}

/** True si podemos abrir el selector nativo de carpetas. */
export function canPickDirectory(): boolean {
  return isTauri() && typeof globals()?.dialog?.open === "function";
}

/** True si podemos abrir una carpeta en el explorador de Windows. */
export function canOpenPath(): boolean {
  return isTauri() && typeof globals()?.shell?.open === "function";
}

/**
 * Abre el selector nativo de carpetas. Devuelve la ruta elegida, o null si la
 * operadora cancelo.
 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const open = globals()?.dialog?.open;
  if (!open) throw new Error("El selector de carpetas solo está disponible en la aplicación");
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Elegí la carpeta donde guardar los .txt",
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (picked === null || picked === undefined) return null;
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** Abre una carpeta o archivo con el explorador del sistema. */
export async function openPath(path: string): Promise<void> {
  const open = globals()?.shell?.open;
  if (!open) throw new Error("Abrir carpetas solo está disponible en la aplicación");
  await open(path);
}
