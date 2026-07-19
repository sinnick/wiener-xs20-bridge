/**
 * Contrato HTTP entre el servicio y la UI.
 *
 * El servicio escucha en http://127.0.0.1:7700 (configurable).
 * La UI Electrobun consume estos endpoints. NUNCA habla TCP ni HL7 directo.
 *
 * Ver docs/03-contrato-http.md para el detalle de cada endpoint.
 */

import type { HemogramResult, Histogram } from "./hemogram.js";

// ─── Resultados ──────────────────────────────────────────────────────────────

export interface ListResultsQuery {
  /** ISO 8601, devuelve resultados recibidos >= este timestamp */
  fromDate?: string;
  /** ISO 8601, devuelve resultados recibidos <= este timestamp */
  toDate?: string;
  /** Texto que matchea sampleId, patientId o name */
  search?: string;
  /** Default 50, max 500. */
  limit?: number;
  /** Para paginacion. */
  cursor?: string;
}

export interface ListResultsResponse {
  /** Vista resumida (sin histogramas, sin todos los valores). */
  results: ResultSummary[];
  nextCursor: string | null;
}

/** Summary que se muestra en la lista. Liviano, sin payloads grandes. */
export interface ResultSummary {
  id: string;
  receivedAt: string; // ISO
  sampleId: string;
  patientName: string | null;
  patientId: string | null;
  /** Cantidad de flags anormales en cualquier parametro. */
  abnormalCount: number;
  /** Cantidad de flags morfologicas levantadas. */
  morphologyFlagCount: number;
}

/** GET /api/results/:id devuelve el resultado completo. */
export type GetResultResponse = HemogramResult & {
  /** El raw HL7 original, base64 — solo se devuelve si ?includeRaw=true. */
  rawHl7?: string;
};

// ─── Configuracion ───────────────────────────────────────────────────────────

export interface ServiceConfig {
  /** Puerto TCP donde escucha al XS 20. Default 5100. */
  tcpPort: number;
  /** Interfaz TCP (default "0.0.0.0"). */
  tcpHost: string;
  /** Puerto HTTP local. Default 7700. */
  httpPort: number;
  /** Path de la DB SQLite. */
  dbPath: string;
  /** Path del directorio de logs. */
  logDir: string;
  /** Nivel de log: "debug" | "info" | "warn" | "error" */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Cuantos dias retener mensajes raw HL7 (para auditoria). 0 = no purgar. */
  rawRetentionDays: number;
}

export type UpdateConfigRequest = Partial<
  Pick<ServiceConfig, "tcpPort" | "tcpHost" | "logLevel" | "rawRetentionDays">
>;

export interface UpdateConfigResponse {
  config: ServiceConfig;
  /** True si hace falta reiniciar el servicio para aplicar cambios. */
  restartRequired: boolean;
}

// ─── Health / status ─────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  uptime: number; // segundos
  /** Estado del listener TCP. */
  tcpListener: {
    listening: boolean;
    address: string;
    port: number;
    activeConnections: number;
    totalConnectionsSinceStart: number;
  };
  /** Estado de la DB. */
  database: {
    ok: boolean;
    sizeBytes: number;
    resultCount: number;
  };
  /** Ultima vez que recibimos un mensaje del XS 20 (ISO o null). */
  lastMessageAt: string | null;
  version: string;
}

// ─── Logs en vivo (SSE) ──────────────────────────────────────────────────────

/** GET /api/logs/stream devuelve text/event-stream con eventos de este tipo. */
export interface LogEvent {
  time: string; // ISO
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  /** Campos arbitrarios estructurados (sampleId, port, etc.) */
  ctx?: Record<string, unknown>;
}

// ─── Estructura comun de error HTTP ─────────────────────────────────────────

export interface ApiError {
  error: {
    code: string; // ej "RESULT_NOT_FOUND", "VALIDATION_ERROR"
    message: string;
    details?: unknown;
  };
}

// ─── Histogramas ─────────────────────────────────────────────────────────────
// Los histogramas son binarios. Para serializar en JSON los pasamos como base64.
// La UI los decodifica antes de renderizar.

export interface HistogramPayload {
  type: Histogram["type"];
  channelsBase64: string; // base64 de los 256 bytes
  discriminators: Histogram["discriminators"];
}
