/**
 * Cliente HTTP del servicio Wiener XS 20.
 *
 * En dev, Vite proxea /api hacia http://127.0.0.1:7700 (ver vite.config.ts).
 * En produccion (Tauri), BASE apunta directo al servicio local.
 *
 * El token se lee del archivo api-token.txt que genera el servicio. En dev,
 * lo tomamos de una variable global inyectable o del localStorage para probar
 * rapido. En produccion, Tauri lo lee del filesystem y lo inyecta.
 */

import type {
  ConnectionMode,
  ExportRerunRequest,
  ExportRerunResponse,
  ExportStatus,
  GetResultResponse,
  HealthResponse,
  ListResultsResponse,
  ResultSummary,
  ServiceConfig,
  UpdateConfigRequest,
  UpdateConfigResponse,
  UpdateStatusResponse,
  WipeDatabaseResponse,
} from "@xs20/shared";
import { WIPE_CONFIRMATION } from "@xs20/shared";

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:7700";

// Cache del token una vez resuelto.
let cachedToken: string | null = null;

/**
 * Resuelve el token de la API.
 * - Dentro de Tauri: lo pide al backend Rust (que lo lee del filesystem).
 * - En el navegador (dev): lo toma del localStorage.
 * Se llama una vez al arrancar (initToken).
 */
/**
 * Ubica la funcion `invoke` de Tauri. Segun la version/config puede estar en
 * `window.__TAURI__.invoke`, `window.__TAURI__.tauri.invoke` o el low-level
 * `window.__TAURI_INVOKE__`. Probamos las tres para no depender de una sola.
 */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getTauriInvoke(): TauriInvoke | undefined {
  const w = window as unknown as {
    __TAURI__?: {
      invoke?: TauriInvoke;
      tauri?: { invoke?: TauriInvoke };
    };
    __TAURI_INVOKE__?: TauriInvoke;
  };
  return w.__TAURI__?.invoke ?? w.__TAURI__?.tauri?.invoke ?? w.__TAURI_INVOKE__;
}

/** True si corremos dentro del shell Tauri (vs navegador en dev). */
export function isTauri(): boolean {
  return getTauriInvoke() !== undefined;
}

/** Le pide el token al host (Tauri) o, en dev, al localStorage. */
async function loadTokenFromHost(): Promise<string> {
  const tauriInvoke = getTauriInvoke();

  if (tauriInvoke) {
    try {
      const t = (await tauriInvoke("get_api_token")) as string;
      if (typeof t === "string" && t.trim() !== "") return t.trim();
    } catch {
      // cae al localStorage
    }
  }
  return localStorage.getItem("xs20_token") ?? "";
}

let initPromise: Promise<void> | null = null;
let refreshPromise: Promise<string> | null = null;

export function initToken(): Promise<void> {
  if (!initPromise) {
    initPromise = loadTokenFromHost().then((t) => {
      cachedToken = t;
    });
  }
  return initPromise;
}

/** True si ya tenemos un token no vacio. */
export function hasToken(): boolean {
  return (cachedToken ?? "") !== "";
}

/**
 * Vuelve a preguntarle el token al host. Se usa cuando el servicio contesta
 * 401: el caso tipico es que la app arranco antes que el servicio y el
 * `api-token.txt` todavia no existia. Sin esto la app queda en 401 permanente
 * hasta reiniciarla.
 *
 * Las llamadas concurrentes comparten la misma promesa para no disparar N
 * invokes a Tauri (cada uno puede bloquear varios segundos).
 */
export function refreshToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = loadTokenFromHost()
      .then((t) => {
        cachedToken = t;
        return t;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// El token: en dev lo podes setear en la consola con
//   localStorage.setItem("xs20_token", "el-token")
export function getToken(): string {
  if (cachedToken !== null) return cachedToken;
  return localStorage.getItem("xs20_token") ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem("xs20_token", token);
}

/**
 * fetch con el token puesto. Ante un 401 vuelve a pedirle el token al host y
 * reintenta UNA sola vez (nunca entra en loop).
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        "X-XS20-Token": getToken(),
      },
    });

  const res = await send();
  if (res.status !== 401) return res;

  await refreshToken();
  return send();
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
  }
}

/**
 * True si el error es "no pudimos hablar con el servicio" y no "el servicio
 * nos contesto que los datos estan mal".
 *
 * Un 401 entra aca a proposito: significa que todavia no tenemos (o perdimos)
 * el token del servicio, que es un problema de arranque/conexion. Mostrarlo
 * como error de datos confunde, porque /api/health no pide token y entonces la
 * vista Estado dice "En línea" mientras Resultados falla.
 */
export function isConnectionError(err: unknown): boolean {
  // Un 500 NO entra: ahi el servicio contesto y tiene algo puntual que decir
  // (por ejemplo, que la base no se puede leer). Ese mensaje hay que mostrarlo.
  if (err instanceof ApiError) return err.status === 401 || err.status === 503;
  // fetch tira TypeError cuando no hay nadie escuchando del otro lado.
  return err instanceof TypeError;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export function getHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>("/api/health");
}

export interface ListParams {
  search?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export function listResults(params: ListParams = {}): Promise<ListResultsResponse> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.fromDate) q.set("fromDate", params.fromDate);
  if (params.toDate) q.set("toDate", params.toDate);
  if (params.limit) q.set("limit", String(params.limit));
  const qs = q.toString();
  return apiGet<ListResultsResponse>(`/api/results${qs ? `?${qs}` : ""}`);
}

export function getResult(id: string): Promise<GetResultResponse> {
  return apiGet<GetResultResponse>(`/api/results/${encodeURIComponent(id)}`);
}

// ─── Configuracion ───────────────────────────────────────────────────────────

export function getConfig(): Promise<ServiceConfig> {
  return apiGet<ServiceConfig>("/api/config");
}

export async function updateConfig(
  patch: UpdateConfigRequest,
): Promise<UpdateConfigResponse> {
  const res = await authedFetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as UpdateConfigResponse;
}

// ─── Exportacion a .txt ──────────────────────────────────────────────────────

/**
 * Vuelve a escribir los .txt de resultados ya guardados.
 *
 * Sirve cuando la carpeta destino estuvo mal configurada: los resultados nunca
 * se perdieron (estan en la base), pero los archivos de esos dias no existen.
 * Sin argumentos regenera los ultimos 200.
 */
export function rerunExport(params: ExportRerunRequest = {}): Promise<ExportRerunResponse> {
  return apiPost<ExportRerunResponse>("/api/export/rerun", params);
}

// ─── Mantenimiento ───────────────────────────────────────────────────────────

/**
 * Borra TODOS los resultados guardados, para que el analizador pueda mandarlos
 * de nuevo desde cero con su funcion "enviar todo".
 *
 * No recibe parametros a proposito: la UI nunca manda otra cosa que la constante
 * compartida. Que la operadora haya tipeado la palabra es una condicion de la
 * interfaz; que el servidor la exija es una condicion del protocolo. Son dos
 * cosas distintas y no hay que acoplarlas pasando el texto del input.
 */
export function wipeDatabase(): Promise<WipeDatabaseResponse> {
  return apiPost<WipeDatabaseResponse>("/api/maintenance/wipe-database", {
    confirm: WIPE_CONFIRMATION,
  });
}

// ─── Actualizaciones ─────────────────────────────────────────────────────────

export function getUpdateStatus(): Promise<UpdateStatusResponse> {
  return apiGet<UpdateStatusResponse>("/api/update/status");
}

export function checkForUpdates(): Promise<UpdateStatusResponse> {
  return apiPost<UpdateStatusResponse>("/api/update/check");
}

export function startUpdateDownload(): Promise<UpdateStatusResponse> {
  return apiPost<UpdateStatusResponse>("/api/update/download");
}

export function skipUpdateVersion(version: string): Promise<UpdateStatusResponse> {
  return apiPost<UpdateStatusResponse>("/api/update/skip", { version });
}

/**
 * Lanza el instalador descargado via el comando Rust `run_installer` y cierra
 * la app. Solo funciona dentro del shell Tauri en Windows.
 */
export async function runInstaller(installerPath: string): Promise<void> {
  const tauriInvoke = getTauriInvoke();
  if (!tauriInvoke) {
    throw new Error("Solo disponible dentro de la aplicación de escritorio");
  }
  await tauriInvoke("run_installer", { path: installerPath });
}

/**
 * Extrae un mensaje legible del cuerpo de error del servicio
 * ({ error: { message } }). Si no se puede parsear, devuelve el texto crudo.
 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.body) as { error?: { message?: string } };
      if (parsed?.error?.message) return parsed.error.message;
    } catch {
      // no era JSON
    }
    return err.body || `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface LogLine {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
}

// ─── Stream SSE de actividad ─────────────────────────────────────────────────
//
// Un unico EventSource compartido por toda la app (App.tsx lo usa para
// refrescar la lista, LogsView para mostrar las lineas). El EventSource nativo
// reconecta solo, PERO reusa siempre la misma URL — y el token viaja en la
// query string. Si arrancamos sin token, ese reintento automatico da 401 para
// siempre. Por eso manejamos la reconexion a mano: cerramos, pedimos el token
// de nuevo y reconstruimos la URL.

/** "connecting" = todavia no conectamos nunca; "reconnecting" = se cayo. */
export type StreamState = "connecting" | "open" | "reconnecting";

export interface StreamHandlers {
  /** Llega una linea de log nueva. */
  onEvent?: (e: LogLine) => void;
  /** Cambio el estado de la conexion. Se llama al suscribirse con el actual. */
  onState?: (s: StreamState) => void;
  /** Se reconecto despues de una caida (util para re-sincronizar datos). */
  onReconnect?: () => void;
}

const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 10000;

let es: EventSource | null = null;
let streamState: StreamState = "connecting";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let hadDropped = false;
/** Si nunca conectamos, un fallo es "todavia conectando", no "se corto". */
let everOpened = false;
const subscribers = new Set<StreamHandlers>();

function setStreamState(s: StreamState): void {
  if (streamState === s) return;
  streamState = s;
  for (const sub of subscribers) sub.onState?.(s);
}

function connectStream(): void {
  // Ya hay una conexion viva, o una reconexion agendada: no abrir una segunda.
  if (es || reconnectTimer !== null) return;

  const token = getToken();
  const url = `${BASE}/api/logs/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const source = new EventSource(url);
  es = source;

  source.onopen = () => {
    reconnectAttempts = 0;
    everOpened = true;
    setStreamState("open");
    if (hadDropped) {
      hadDropped = false;
      for (const sub of subscribers) sub.onReconnect?.();
    }
  };

  source.addEventListener("log", (e) => {
    let line: LogLine;
    try {
      line = JSON.parse((e as MessageEvent).data) as LogLine;
    } catch {
      return; // linea malformada
    }
    for (const sub of subscribers) sub.onEvent?.(line);
  });

  source.onerror = () => {
    // Cortamos el reintento automatico del navegador: reconectamos nosotros
    // con un token fresco (ver comentario de arriba).
    source.close();
    if (es === source) es = null;
    hadDropped = true;
    // Si nunca llegamos a conectar (el servicio todavia esta arrancando)
    // seguimos diciendo "conectando": nunca hubo una conexion que perder.
    setStreamState(everOpened ? "reconnecting" : "connecting");
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || subscribers.size === 0) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempts);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (subscribers.size === 0) return;
    // Sin token no hay stream posible: volvemos a pedirselo al host antes de
    // reintentar (el servicio pudo haber arrancado recien).
    if (!hasToken()) {
      void refreshToken().finally(connectStream);
    } else {
      connectStream();
    }
  }, delay);
}

/**
 * Se suscribe al stream de actividad. Devuelve una funcion para desuscribirse.
 * Todos los suscriptores comparten una sola conexion.
 */
export function subscribeLogs(handlers: StreamHandlers): () => void {
  subscribers.add(handlers);
  handlers.onState?.(streamState);
  connectStream();
  return () => {
    subscribers.delete(handlers);
  };
}

export type {
  ConnectionMode,
  ExportRerunRequest,
  ExportRerunResponse,
  ExportStatus,
  ResultSummary,
  GetResultResponse,
  HealthResponse,
  ServiceConfig,
  UpdateConfigRequest,
  UpdateConfigResponse,
  UpdateStatusResponse,
  WipeDatabaseResponse,
};
export { WIPE_CONFIRMATION };
