/**
 * Settings editables desde la UI, persistidos en disco.
 *
 * A diferencia del resto de la config (que sale de defaults / env / flags CLI),
 * estos valores los puede cambiar el usuario en vivo desde la app y quedan
 * guardados en `<dataDir>/config/settings.json`. Al arrancar, el servicio los
 * carga y los aplica sobre los defaults (ver config.ts).
 *
 * Solo persistimos el subconjunto que tiene sentido tocar sin reiniciar:
 * puerto/host del listener TCP, nivel de log y retencion del HL7 crudo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ServiceConfig } from "@xs20/shared";

/** Subconjunto editable de la config, persistido en settings.json. */
export type PersistedSettings = Partial<
  Pick<
    ServiceConfig,
    | "connectionMode"
    | "analyzerHost"
    | "analyzerPort"
    | "tcpPort"
    | "tcpHost"
    | "logLevel"
    | "rawRetentionDays"
  >
>;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const CONNECTION_MODES = ["listen", "connect"] as const;

/**
 * Lee settings.json y devuelve solo los campos validos. Si el archivo no existe
 * o esta corrupto, devuelve {} (el servicio cae a los defaults).
 */
export function loadSettings(path: string): PersistedSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const out: PersistedSettings = {};
    if (
      typeof parsed.connectionMode === "string" &&
      (CONNECTION_MODES as readonly string[]).includes(parsed.connectionMode)
    ) {
      out.connectionMode = parsed.connectionMode as PersistedSettings["connectionMode"];
    }
    if (typeof parsed.analyzerHost === "string") {
      out.analyzerHost = parsed.analyzerHost;
    }
    if (
      typeof parsed.analyzerPort === "number" &&
      Number.isInteger(parsed.analyzerPort) &&
      parsed.analyzerPort >= 1 &&
      parsed.analyzerPort <= 65535
    ) {
      out.analyzerPort = parsed.analyzerPort;
    }
    if (typeof parsed.tcpPort === "number" && Number.isInteger(parsed.tcpPort)) {
      out.tcpPort = parsed.tcpPort;
    }
    if (typeof parsed.tcpHost === "string" && parsed.tcpHost.length > 0) {
      out.tcpHost = parsed.tcpHost;
    }
    if (
      typeof parsed.logLevel === "string" &&
      (LOG_LEVELS as readonly string[]).includes(parsed.logLevel)
    ) {
      out.logLevel = parsed.logLevel as PersistedSettings["logLevel"];
    }
    if (
      typeof parsed.rawRetentionDays === "number" &&
      Number.isInteger(parsed.rawRetentionDays) &&
      parsed.rawRetentionDays >= 0
    ) {
      out.rawRetentionDays = parsed.rawRetentionDays;
    }
    return out;
  } catch {
    return {};
  }
}

/** Escribe settings.json (crea el directorio si hace falta). */
export function saveSettings(path: string, settings: PersistedSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}
