/**
 * Logger del servicio.
 *
 * Tres destinos:
 *  1. Archivo rotativo en logDir (siempre).
 *  2. stdout con colores (solo si --console).
 *  3. Buffer circular en memoria → SSE /api/logs/stream.
 *
 * Para evitar dependencias pesadas, implementamos un wrapper minimo en lugar
 * de pino. Los logs son JSON estructurado, una linea por evento.
 *
 * Si en el futuro queremos pino con sus transports, se puede reemplazar este
 * archivo sin tocar al resto del codigo.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { LogEvent } from "@xs20/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Solo se borran archivos que matcheen EXACTAMENTE este patron.
 *
 * Es a proposito estricto: logDir es una carpeta del usuario y no queremos que
 * un dia esta purga se lleve puesto algo que alguien dejo ahi al lado.
 */
const LOG_FILE_RE = /^service-(\d{4})-(\d{2})-(\d{2})\.log$/;

/** Dias de retencion por defecto. 0 = no borrar nunca. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerConfig {
  logDir: string;
  level: LogLevel;
  /** Si true, ademas de archivo escribimos a stdout con colores. */
  console: boolean;
  /** Tamaño max del buffer en memoria para SSE (default 1000 eventos). */
  bufferSize?: number;
  /**
   * Dias que se conservan los `service-YYYY-MM-DD.log`. Default 30, 0 = nunca
   * borrar. Sin esto una PC 24/7 con logLevel=debug llena el disco: el archivo
   * rota por dia pero nadie limpiaba los viejos.
   */
  retentionDays?: number;
}

type Subscriber = (event: LogEvent) => void;

export class Logger {
  private buffer: LogEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private currentLogPath: string;

  constructor(private cfg: LoggerConfig) {
    if (!existsSync(cfg.logDir)) {
      mkdirSync(cfg.logDir, { recursive: true });
    }
    this.currentLogPath = this.computeLogPath();
    // Al arrancar y despues una sola vez por dia (al rotar). No en cada linea:
    // un readdir por evento seria carisimo con logLevel=debug.
    this.purgeOldLogs();
  }

  setLevel(level: LogLevel): void {
    this.cfg.level = level;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log("warn", msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.log("error", msg, ctx);
  }

  /**
   * Suscribe un consumidor (ej: cliente SSE). Devuelve funcion para des-suscribir.
   */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Devuelve los ultimos N eventos del buffer (mas antiguos primero). */
  getRecent(): LogEvent[] {
    return [...this.buffer];
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.cfg.level]) return;

    const event: LogEvent = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(ctx ? { ctx } : {}),
    };

    // 1. Archivo
    try {
      const path = this.computeLogPath();
      if (path !== this.currentLogPath) {
        // Cambio el dia: rotamos y aprovechamos para limpiar los vencidos.
        this.currentLogPath = path;
        this.purgeOldLogs();
      }
      appendFileSync(this.currentLogPath, JSON.stringify(event) + "\n");
    } catch {
      // Si el archivo falla no podemos hacer mucho — al menos no crasheamos.
    }

    // 2. stdout (si --console)
    if (this.cfg.console) {
      process.stdout.write(formatConsole(event) + "\n");
    }

    // 3. Buffer + subscribers
    this.buffer.push(event);
    const max = this.cfg.bufferSize ?? 1000;
    if (this.buffer.length > max) {
      this.buffer.splice(0, this.buffer.length - max);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private computeLogPath(): string {
    // Fecha LOCAL, no UTC: el archivo tiene que rotar a la medianoche del
    // laboratorio. Con toISOString() (UTC) el corte caia a las 21:00 en
    // Argentina, partiendo en dos el log de una misma jornada de trabajo.
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    return join(this.cfg.logDir, `service-${date}.log`);
  }

  /**
   * Borra los `service-YYYY-MM-DD.log` mas viejos que `retentionDays`.
   *
   * La fecha sale del NOMBRE del archivo, no del mtime: el mtime de Windows se
   * puede correr con una copia o un backup, y el nombre es exactamente el dia
   * que representa. Nunca borra el archivo del dia en curso.
   *
   * Devuelve cuantos borro (para los tests).
   */
  purgeOldLogs(now = new Date()): number {
    const days = this.cfg.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    if (days <= 0) return 0; // retencion desactivada

    // Cutoff a medianoche local: un archivo se borra recien cuando su dia
    // quedo enteramente fuera de la ventana.
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - days);

    let removed = 0;
    try {
      for (const name of readdirSync(this.cfg.logDir)) {
        const m = LOG_FILE_RE.exec(name);
        if (!m) continue; // no es nuestro: ni lo miramos
        const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (fileDate >= cutoff) continue;
        const full = join(this.cfg.logDir, name);
        if (full === this.currentLogPath) continue; // jamas el de hoy
        try {
          unlinkSync(full);
          removed++;
        } catch {
          // Archivo tomado por otro proceso (el visor de logs, el antivirus).
          // Se reintenta manana.
        }
      }
    } catch {
      // La carpeta no se puede listar: no es motivo para voltear el servicio.
    }
    // Dejamos rastro de la limpieza (no recursa: el path del dia no cambio).
    if (removed > 0) {
      this.info("logs.purged", { filesRemoved: removed, retentionDays: days });
    }
    return removed;
  }
}

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gris
  info: "\x1b[36m", // cian
  warn: "\x1b[33m", // amarillo
  error: "\x1b[31m", // rojo
};
const RESET = "\x1b[0m";

function formatConsole(e: LogEvent): string {
  const color = COLORS[e.level];
  const time = e.time.slice(11, 23); // HH:MM:SS.sss
  const lvl = e.level.toUpperCase().padEnd(5);
  const ctx = e.ctx ? " " + JSON.stringify(e.ctx) : "";
  return `${color}${time} ${lvl}${RESET} ${e.msg}${ctx}`;
}
