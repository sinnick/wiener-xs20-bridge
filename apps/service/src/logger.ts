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

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { LogEvent } from "@xs20/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
      if (path !== this.currentLogPath) this.currentLogPath = path;
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
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.cfg.logDir, `service-${date}.log`);
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
