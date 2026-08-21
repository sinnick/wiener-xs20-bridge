/**
 * Settings editables desde la UI, persistidos en disco.
 *
 * A diferencia del resto de la config (que sale de defaults / env / flags CLI),
 * estos valores los puede cambiar el usuario en vivo desde la app y quedan
 * guardados en `<dataDir>/config/settings.json`. Al arrancar, el servicio los
 * carga y los aplica sobre los defaults (ver config.ts).
 *
 * Solo persistimos el subconjunto que tiene sentido tocar sin reiniciar:
 * puerto/host del listener TCP, nivel de log, retencion del HL7 crudo y la
 * carpeta de exportacion de .txt por muestra.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
    | "exportDir"
    | "updateCheckEnabled"
  >
> & {
  /** Version que el usuario eligio omitir en el update-checker ("" = ninguna). */
  skippedVersion?: string;
};

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const CONNECTION_MODES = ["listen", "connect"] as const;

/**
 * Como loadSettings avisa que descarto algo.
 *
 * Hace falta un callback y no un Logger porque la config se resuelve ANTES de
 * que exista el logger (el logger necesita logDir, que sale de la config). El
 * caller junta los avisos y los loguea apenas puede — ver config.ts / main.ts.
 */
export type SettingsWarn = (warning: string) => void;

/**
 * Lee settings.json y devuelve solo los campos validos.
 *
 * Si el archivo esta corrupto NO lo silenciamos: se lo aparta con un sufijo
 * `.corrupt-<timestamp>` y se avisa por `onWarn`. Perder este archivo sin ruido
 * es una de las fallas mas dañinas del servicio: se pierde `analyzerHost`, el
 * bridge vuelve al modo/direccion por defecto y deja de recibir resultados sin
 * que aparezca ningun error — la operadora solo ve que "no llega nada".
 */
export function loadSettings(path: string, onWarn?: SettingsWarn): PersistedSettings {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    onWarn?.(
      `No se pudo leer ${path} (${(e as Error).message}). El servicio arranca ` +
        "con la configuracion por defecto: revisar la IP del equipo en la app.",
    );
    return {};
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("el contenido no es un objeto JSON");
    }
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
    if (
      typeof parsed.tcpPort === "number" &&
      Number.isInteger(parsed.tcpPort) &&
      parsed.tcpPort >= 1 &&
      parsed.tcpPort <= 65535
    ) {
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
    // "" es valido: significa exportacion deshabilitada, no debe caer al default.
    if (typeof parsed.exportDir === "string") {
      out.exportDir = parsed.exportDir;
    }
    if (typeof parsed.updateCheckEnabled === "boolean") {
      out.updateCheckEnabled = parsed.updateCheckEnabled;
    }
    // "" es valido: significa "ninguna version omitida".
    if (typeof parsed.skippedVersion === "string") {
      out.skippedVersion = parsed.skippedVersion;
    }
    return out;
  } catch (e) {
    const kept = quarantineCorruptSettings(path);
    onWarn?.(
      `settings.json estaba corrupto (${(e as Error).message}). ` +
        (kept
          ? `Se lo aparto como ${kept} y `
          : "No se lo pudo apartar (¿carpeta sin permisos?) y ") +
        "el servicio arranca con la configuracion POR DEFECTO. Si el equipo " +
        "estaba en modo 'connect', hay que volver a cargar su IP en la app " +
        "(Estado → Configuración) o no van a llegar resultados.",
    );
    return {};
  }
}

/**
 * Aparta un settings.json ilegible en vez de pisarlo.
 *
 * Puede tener la IP del equipo a medio escribir, que es justo el dato que a
 * nadie le queda anotado. Devuelve el path nuevo, o null si no se pudo mover.
 */
function quarantineCorruptSettings(path: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${stamp}`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Escribe settings.json de forma atomica (crea el directorio si hace falta).
 *
 * `writeFileSync` directo sobre el archivo final deja JSON truncado si se corta
 * la luz a mitad de la escritura, y ahi el servicio pierde TODA la config al
 * proximo arranque. En cambio: escribimos un `.tmp`, lo bajamos a disco con
 * fsync y recien ahi hacemos rename — que es atomico. Con eso el archivo final
 * siempre es o el viejo entero o el nuevo entero, nunca uno a medias.
 *
 * El fsync no es opcional: sin el, el rename puede llegar al disco antes que
 * los datos y quedariamos con el mismo archivo corrupto que queremos evitar.
 */
export function saveSettings(path: string, settings: PersistedSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // En Windows rename falla si el destino existe; renameSync de Node usa
    // MoveFileEx con REPLACE_EXISTING, asi que pisa bien igual.
    renameSync(tmp, path);
  } catch (e) {
    // No dejamos el .tmp tirado si algo fallo a mitad de camino.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}
