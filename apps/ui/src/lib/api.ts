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
  GetResultResponse,
  HealthResponse,
  ListResultsResponse,
  ResultSummary,
} from "@xs20/shared";

const BASE = import.meta.env.VITE_API_BASE ?? "";

// Cache del token una vez resuelto.
let cachedToken: string | null = null;

/**
 * Resuelve el token de la API.
 * - Dentro de Tauri: lo pide al backend Rust (que lo lee del filesystem).
 * - En el navegador (dev): lo toma del localStorage.
 * Se llama una vez al arrancar (initToken).
 */
export async function initToken(): Promise<void> {
  // Detectar si estamos dentro de Tauri (v1: window.__TAURI__.invoke).
  const tauriInvoke = (window as unknown as {
    __TAURI__?: { invoke?: (cmd: string) => Promise<string> };
  }).__TAURI__?.invoke;

  if (tauriInvoke) {
    try {
      cachedToken = await tauriInvoke("get_api_token");
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

export type { ResultSummary, GetResultResponse, HealthResponse };
