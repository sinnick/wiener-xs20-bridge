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
  GetResultResponse,
  HealthResponse,
  ListResultsResponse,
  ResultSummary,
  ServiceConfig,
  UpdateConfigRequest,
  UpdateConfigResponse,
  UpdateStatusResponse,
} from "@xs20/shared";

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

export async function initToken(): Promise<void> {
  const tauriInvoke = getTauriInvoke();

  if (tauriInvoke) {
    try {
      cachedToken = (await tauriInvoke("get_api_token")) as string;
      return;
    } catch {
      // cae al localStorage
    }
  }
  cachedToken = localStorage.getItem("xs20_token") ?? "";
}

// El token: en dev lo podes setear en la consola con
//   localStorage.setItem("xs20_token", "el-token")
function getToken(): string {
  if (cachedToken !== null) return cachedToken;
  return localStorage.getItem("xs20_token") ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem("xs20_token", token);
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "X-XS20-Token": getToken(),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "X-XS20-Token": getToken(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
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
  const res = await fetch(`${BASE}/api/config`, {
    method: "PUT",
    headers: {
      "X-XS20-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as UpdateConfigResponse;
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

/**
 * Se suscribe al stream SSE de logs. Devuelve una funcion para cerrar.
 */
export function streamLogs(onEvent: (e: LogLine) => void): () => void {
  const token = getToken();
  const url = `${BASE}/api/logs/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);
  es.addEventListener("log", (e) => {
    try {
      onEvent(JSON.parse((e as MessageEvent).data));
    } catch {
      // ignore malformed
    }
  });
  return () => es.close();
}

export interface LogLine {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
}

export type {
  ConnectionMode,
  ResultSummary,
  GetResultResponse,
  HealthResponse,
  ServiceConfig,
  UpdateConfigRequest,
  UpdateConfigResponse,
  UpdateStatusResponse,
};
