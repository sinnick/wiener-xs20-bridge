/**
 * Contrato HTTP entre el servicio y la UI.
 *
 * El servicio escucha en http://127.0.0.1:7700 (configurable).
 * La UI Tauri consume estos endpoints. NUNCA habla TCP ni HL7 directo.
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

/**
 * Quien inicia la conexion TCP con el analizador.
 *
 * - "listen"  → el servicio escucha en tcpHost:tcpPort y el XS 20 se conecta.
 * - "connect" → el XS 20 escucha y el servicio se conecta a analyzerHost:analyzerPort.
 *
 * El XS 20 soporta las dos configuraciones desde su menu de LIS. Cual usar
 * depende de como este configurado el equipo — ver docs/01-protocolo-hl7.md.
 */
export type ConnectionMode = "listen" | "connect";

export interface ServiceConfig {
  /** Quien disca. Default "listen". */
  connectionMode: ConnectionMode;
  /** IP del analizador. Solo se usa en modo "connect". */
  analyzerHost: string;
  /** Puerto donde escucha el analizador. Solo modo "connect". Default 5100. */
  analyzerPort: number;
  /** Puerto TCP donde escucha al XS 20. Solo modo "listen". Default 5100. */
  tcpPort: number;
  /** Interfaz TCP (default "0.0.0.0"). Solo modo "listen". */
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
  /** Carpeta donde escribir el .txt por muestra al recibir. "" = deshabilitado. */
  exportDir: string;
  /** Si true, el servicio chequea el manifest del VPS buscando versiones nuevas. */
  updateCheckEnabled: boolean;
}

export type UpdateConfigRequest = Partial<
  Pick<
    ServiceConfig,
    | "connectionMode"
    | "analyzerHost"
    | "analyzerPort"
    | "tcpPort"
    | "tcpHost"
    | "logLevel"
    | "rawRetentionDays"
    | "exportDir"
    | "updateCheckEnabled"
  >
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
  /** Modo de conexion activo. */
  connectionMode: ConnectionMode;
  /**
   * Estado del transporte TCP.
   *
   * En modo "listen", `listening` = el listener esta arriba y `address:port` es
   * donde escuchamos. En modo "connect", `listening` = el cliente esta activo y
   * `address:port` es la direccion del analizador.
   */
  tcpListener: {
    listening: boolean;
    address: string;
    port: number;
    activeConnections: number;
    totalConnectionsSinceStart: number;
  };
  /**
   * Detalle del cliente saliente. Solo en modo "connect" (null en "listen").
   * Es lo que la app usa para mostrar "conectado al equipo" vs "esperando al
   * equipo (apagado?)" sin obligar al usuario a leer logs.
   */
  analyzerClient: {
    /** El cliente esta corriendo (aunque todavia no haya conectado). */
    active: boolean;
    /** Hay socket establecido con el analizador ahora mismo. */
    connected: boolean;
    address: string;
    port: number;
    /** ISO del momento en que se establecio la conexion actual, o null. */
    connectedAt: string | null;
    /** Ultimo error de conexion (ej "ECONNREFUSED"), o null. */
    lastError: string | null;
  } | null;
  /** Estado de la DB. */
  database: {
    ok: boolean;
    sizeBytes: number;
    resultCount: number;
  };
  /**
   * Estado de la exportacion a .txt (el archivo que abre el laboratorio).
   *
   * Opcional para no romper a un servicio viejo: si no viene, la app no muestra
   * la tarjeta. Ver docs/11-exportacion-txt.md.
   */
  export?: ExportStatus;
  /** Ultima vez que recibimos un mensaje del XS 20 (ISO o null). */
  lastMessageAt: string | null;
  version: string;
}

/**
 * Como viene saliendo la exportacion a .txt.
 *
 * Existe porque un fallo de escritura (carpeta con un typo, unidad de red
 * caida, disco lleno) era invisible: la app decia "todo bien" y los archivos no
 * aparecian nunca en la carpeta que mira la operadora.
 */
export interface ExportStatus {
  /** false = exportacion apagada a proposito (carpeta vacia en la config). */
  enabled: boolean;
  /** Carpeta destino configurada. */
  dir: string;
  /** El ultimo chequeo de la carpeta salio bien. */
  dirOk: boolean;
  /** Por que no sirve la carpeta, o null. */
  dirError: string | null;
  /** ISO del ultimo .txt escrito bien, o null si todavia no se escribio ninguno. */
  lastWriteAt: string | null;
  lastWritePath: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastErrorSampleId: string | null;
  /** Exportaciones seguidas que vienen fallando (0 = la ultima salio bien). */
  consecutiveFailures: number;
  writtenSinceStart: number;
  failedSinceStart: number;
  /** true si no hay nada que mirar (deshabilitada tambien cuenta como sana). */
  healthy: boolean;
}

// ─── Re-exportacion de .txt ──────────────────────────────────────────────────
// POST /api/export/rerun regenera los .txt de resultados YA guardados, para
// recuperar los archivos de los dias en que la carpeta destino estuvo mal.

export interface ExportRerunRequest {
  /** Resultados puntuales. Si viene, se ignoran los filtros de fecha. */
  ids?: string[];
  /** ISO, mismo criterio que GET /api/results. */
  fromDate?: string;
  toDate?: string;
  /** Cuantos regenerar (default 200, tope 500). */
  limit?: number;
}

export interface ExportRerunResponse {
  dir: string;
  /** Cuantos resultados se intentaron escribir. */
  attempted: number;
  written: number;
  failed: number;
  /** Ids pedidos que no existen en la base. */
  notFound: string[];
  /** Detalle de los primeros fallos (el resto queda en el log). */
  errors: { id: string; sampleId: string; error: string }[];
}

// ─── Mantenimiento: borrado total de la base ─────────────────────────────────
// POST /api/maintenance/wipe-database borra TODOS los resultados guardados para
// que el analizador pueda mandarlos de nuevo desde cero con su funcion "enviar
// todo". Existe porque la deduplicacion (por muestra + instante de analisis)
// hace que un reenvio del historico no vuelva a escribir lo que ya esta: sin
// vaciar la base, no hay forma de reimportar.
//
// Los .txt YA exportados no se tocan: se van pisando a medida que el equipo
// reenvia cada muestra. Ver docs/11-exportacion-txt.md.

/**
 * Texto que hay que escribir para confirmar el borrado.
 *
 * Vive aca y no en cada lado a proposito: lo valida el servidor y lo usa la UI
 * para habilitar el boton. Una sola fuente, asi los dos no se pueden
 * desincronizar si algun dia se cambia la palabra.
 */
export const WIPE_CONFIRMATION = "BORRAR";

export interface WipeDatabaseRequest {
  /** Tiene que ser exactamente WIPE_CONFIRMATION. */
  confirm: string;
}

export interface WipeDatabaseResponse {
  deletedResults: number;
  deletedRawMessages: number;
  deletedPatients: number;
  /** Tamano del archivo antes y despues, en bytes. */
  sizeBefore: number;
  sizeAfter: number;
  /** false si no se pudo compactar el archivo. Los datos igual se borraron. */
  vacuumed: boolean;
  durationMs: number;
}

// ─── Actualizaciones ─────────────────────────────────────────────────────────
// El servicio chequea el manifest publicado en el VPS periodicamente (ver
// apps/service/src/update/update-checker.ts). La UI hace polling de
// GET /api/update/status y muestra un banner cuando hay version nueva.
// Ver docs/12-actualizaciones.md.

export type UpdatePhase =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatusResponse {
  phase: UpdatePhase;
  /** Version que esta corriendo este servicio. */
  currentVersion: string;
  /** Ultima version publicada, o null si no hubo chequeo aun o estamos al dia. */
  latestVersion: string | null;
  /** Cuerpo (markdown) del Release, recortado. Null si no hay version nueva. */
  releaseNotes: string | null;
  /** ISO de publicacion del Release, o null. */
  publishedAt: string | null;
  /** ISO del ultimo chequeo (exitoso o no), o null si nunca se chequeo. */
  lastCheckAt: string | null;
  /** Error del ultimo chequeo (red caida, rate limit), o null si salio bien. */
  lastCheckError: string | null;
  updateCheckEnabled: boolean;
  /** Version que el usuario eligio omitir ("" = ninguna). */
  skippedVersion: string;
  /** Estado de la descarga del instalador, o null si no se inicio. */
  download: {
    totalBytes: number | null;
    downloadedBytes: number;
    /** Path absoluto del instalador listo, seteado cuando phase = "downloaded". */
    installerPath: string | null;
    error: string | null;
  } | null;
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
