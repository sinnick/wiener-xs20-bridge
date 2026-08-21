/**
 * Configuracion del servicio.
 *
 * Resolucion en orden de prioridad (mayor gana):
 *   1. Flags CLI (--port, --console, --log-level, etc.)
 *   2. Variables de entorno (XS20_TCP_PORT, XS20_HTTP_PORT, etc.)
 *   3. Archivo de configuracion (--config=<path>)
 *   4. Defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConnectionMode, ServiceConfig } from "@xs20/shared";

import { DEFAULT_LOG_RETENTION_DAYS, type LogLevel } from "./logger.js";
import { loadSettings } from "./settings-store.js";

export interface ResolvedConfig extends ServiceConfig {
  /** Si true, el logger escribe tambien a stdout con colores. */
  console: boolean;
  /** Si true, no abre el TCP listener (solo HTTP). */
  noListen: boolean;
  /** Token compartido con la UI para autenticar la HTTP API. */
  apiToken: string;
  /** Path del settings.json editable desde la UI (persistencia de cambios). */
  settingsPath: string;
  /** Version que el usuario eligio omitir en el update-checker ("" = ninguna). */
  skippedVersion: string;
  /**
   * Dias que se conservan los archivos de log. 0 = no borrar nunca.
   * Opcional para no obligar a los tests a construir configs completas;
   * `resolveConfig` siempre lo completa.
   */
  logRetentionDays?: number;
  /**
   * Problemas encontrados al resolver la config (valores invalidos, archivos
   * corruptos, puertos en conflicto).
   *
   * Se juntan aca en vez de loguearse en el momento porque la config se resuelve
   * ANTES de que exista el logger — es la config la que dice donde escribir los
   * logs. main.ts los vuelca apenas arma el logger. Sin esto, un `--port=abc` o
   * un settings.json roto se descartaban en silencio.
   */
  warnings?: string[];
}

/**
 * Parsea un puerto y avisa si no sirve, en vez de dejar pasar un NaN.
 *
 * `parseInt("abc")` devuelve NaN y ese NaN llegaba tal cual a `Bun.listen`, que
 * falla con un error que no explica nada. Devuelve undefined si es invalido
 * (el caller se queda con el valor anterior de la cadena de precedencia).
 */
function parsePort(raw: string | undefined, source: string, warnings: string[]): number | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    warnings.push(`${source} esta vacio; se ignora y se usa el valor por defecto.`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    warnings.push(
      `${source}="${raw}" no es un puerto valido (tiene que ser un entero entre ` +
        "1 y 65535); se ignora y se usa el valor por defecto.",
    );
    return undefined;
  }
  return n;
}

/** Igual que parsePort pero para enteros >= 0 (dias de retencion). */
function parseNonNegativeInt(
  raw: string | undefined,
  source: string,
  warnings: string[],
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    warnings.push(`${source}="${raw}" no es un entero valido (>= 0); se ignora.`);
    return undefined;
  }
  return n;
}

function defaultDataDir(): string {
  // Windows: %PROGRAMDATA%\WienerXS20  (ej. C:\ProgramData\WienerXS20)
  // Linux: ~/.local/share/wiener-xs20
  // macOS: ~/Library/Application Support/WienerXS20
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "WienerXS20");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "WienerXS20");
  }
  return join(homedir(), ".local", "share", "wiener-xs20");
}

function defaultConfig(): ResolvedConfig {
  const dataDir = defaultDataDir();
  return {
    // Default "listen": el equipo disca hacia nosotros. Si el XS 20 esta
    // configurado como servidor (el caso verificado en campo), se cambia a
    // "connect" desde la app o con --mode=connect.
    connectionMode: "listen",
    analyzerHost: "",
    analyzerPort: 5100,
    tcpPort: 5100,
    tcpHost: "0.0.0.0",
    httpPort: 7700,
    dbPath: join(dataDir, "db", "xs20.sqlite"),
    logDir: join(dataDir, "logs"),
    logLevel: "info",
    rawRetentionDays: 90,
    exportDir: join(dataDir, "exportes"),
    updateCheckEnabled: true,
    skippedVersion: "",
    logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
    warnings: [],
    console: false,
    noListen: false,
    // Token aleatorio por instalacion. Si no existe en disco, lo generamos
    // y persistimos en config\api-token.txt.
    apiToken: "",
    // Se recomputa en resolveConfig segun el dataDir efectivo.
    settingsPath: "",
  };
}

interface CliArgs {
  console: boolean;
  noListen: boolean;
  logLevel?: LogLevel;
  configPath?: string;
  tcpPort?: number;
  httpPort?: number;
  dataDir?: string;
  connectionMode?: ConnectionMode;
  analyzerHost?: string;
  analyzerPort?: number;
}

function parseCli(argv: string[], warnings: string[]): CliArgs {
  const out: CliArgs = { console: false, noListen: false };
  for (const arg of argv) {
    if (arg === "--console") out.console = true;
    else if (arg === "--no-listen") out.noListen = true;
    else if (arg.startsWith("--log-level=")) {
      const v = arg.split("=")[1] as LogLevel;
      if (["debug", "info", "warn", "error"].includes(v)) out.logLevel = v;
      else warnings.push(`--log-level="${v}" no es valido (debug|info|warn|error); se ignora.`);
    } else if (arg.startsWith("--config=")) out.configPath = arg.split("=")[1];
    else if (arg.startsWith("--port=")) {
      out.tcpPort = parsePort(arg.split("=")[1], "--port", warnings);
    } else if (arg.startsWith("--http-port=")) {
      out.httpPort = parsePort(arg.split("=")[1], "--http-port", warnings);
    } else if (arg.startsWith("--data-dir=")) out.dataDir = arg.split("=")[1];
    else if (arg.startsWith("--mode=")) {
      const v = arg.split("=")[1];
      if (v === "listen" || v === "connect") out.connectionMode = v;
      else warnings.push(`--mode="${v}" no es valido (listen|connect); se ignora.`);
    } else if (arg.startsWith("--analyzer-host=")) {
      out.analyzerHost = arg.split("=")[1];
    } else if (arg.startsWith("--analyzer-port=")) {
      out.analyzerPort = parsePort(arg.split("=")[1], "--analyzer-port", warnings);
    }
  }
  return out;
}

function loadFile(path: string | undefined, warnings: string[]): Partial<ServiceConfig> {
  if (!path) return {};
  if (!existsSync(path)) {
    warnings.push(`El archivo de config --config=${path} no existe; se ignora.`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("el contenido no es un objeto JSON");
    }
    return parsed as Partial<ServiceConfig>;
  } catch (e) {
    // Antes esto devolvia {} en silencio: el servicio arrancaba con defaults y
    // nadie se enteraba de que su archivo de config no se estaba aplicando.
    warnings.push(
      `El archivo de config ${path} no se pudo leer (${(e as Error).message}); ` +
        "se ignora COMPLETO y se usan los valores por defecto.",
    );
    return {};
  }
}

function loadEnv(warnings: string[]): Partial<ServiceConfig> {
  const out: Partial<ServiceConfig> = {};
  if (process.env.XS20_TCP_PORT) {
    const p = parsePort(process.env.XS20_TCP_PORT, "XS20_TCP_PORT", warnings);
    if (p !== undefined) out.tcpPort = p;
  }
  if (process.env.XS20_TCP_HOST) out.tcpHost = process.env.XS20_TCP_HOST;
  if (process.env.XS20_HTTP_PORT) {
    const p = parsePort(process.env.XS20_HTTP_PORT, "XS20_HTTP_PORT", warnings);
    if (p !== undefined) out.httpPort = p;
  }
  if (process.env.XS20_MODE === "listen" || process.env.XS20_MODE === "connect") {
    out.connectionMode = process.env.XS20_MODE;
  }
  if (process.env.XS20_ANALYZER_HOST) out.analyzerHost = process.env.XS20_ANALYZER_HOST;
  if (process.env.XS20_ANALYZER_PORT) {
    const p = parsePort(process.env.XS20_ANALYZER_PORT, "XS20_ANALYZER_PORT", warnings);
    if (p !== undefined) out.analyzerPort = p;
  }
  if (process.env.XS20_DB_PATH) out.dbPath = process.env.XS20_DB_PATH;
  if (process.env.XS20_LOG_DIR) out.logDir = process.env.XS20_LOG_DIR;
  if (process.env.XS20_EXPORT_DIR !== undefined) out.exportDir = process.env.XS20_EXPORT_DIR;
  if (process.env.XS20_LOG_LEVEL) {
    const lvl = process.env.XS20_LOG_LEVEL as LogLevel;
    if (["debug", "info", "warn", "error"].includes(lvl)) out.logLevel = lvl;
  }
  return out;
}

export function resolveConfig(argv: string[]): ResolvedConfig {
  const warnings: string[] = [];
  const cli = parseCli(argv, warnings);
  const fileCfg = loadFile(cli.configPath, warnings);
  const envCfg = loadEnv(warnings);
  const def = defaultConfig();

  // Si --data-dir, recalculamos paths
  if (cli.dataDir) {
    def.dbPath = join(cli.dataDir, "db", "xs20.sqlite");
    def.logDir = join(cli.dataDir, "logs");
    def.exportDir = join(cli.dataDir, "exportes");
  }

  // El settings.json editable vive junto al token, en <dataDir>/config.
  // dataDir = padre del padre de dbPath (…\WienerXS20\db\xs20.sqlite → …\WienerXS20).
  const dataDir = dirname(dirname(def.dbPath));
  const settingsPath = join(dataDir, "config", "settings.json");
  const persisted = loadSettings(settingsPath, (w) => warnings.push(w));

  const retention = parseNonNegativeInt(
    process.env.XS20_LOG_RETENTION_DAYS,
    "XS20_LOG_RETENTION_DAYS",
    warnings,
  );

  // Precedencia (menor a mayor): defaults < settings.json < archivo --config <
  // env < flags CLI. Los settings guardados desde la UI ganan a los defaults,
  // pero un flag/env explicito siempre manda (util en dev y para overrides).
  const resolved: ResolvedConfig = {
    ...def,
    ...persisted,
    ...fileCfg,
    ...envCfg,
    ...(cli.tcpPort !== undefined ? { tcpPort: cli.tcpPort } : {}),
    ...(cli.httpPort !== undefined ? { httpPort: cli.httpPort } : {}),
    ...(cli.logLevel ? { logLevel: cli.logLevel } : {}),
    ...(cli.connectionMode ? { connectionMode: cli.connectionMode } : {}),
    ...(cli.analyzerHost !== undefined ? { analyzerHost: cli.analyzerHost } : {}),
    ...(cli.analyzerPort !== undefined ? { analyzerPort: cli.analyzerPort } : {}),
    ...(retention !== undefined ? { logRetentionDays: retention } : {}),
    console: cli.console,
    noListen: cli.noListen,
    settingsPath,
    warnings,
  };

  // Ultima red: si alguna capa metio un puerto no numerico (un settings.json
  // editado a mano, un --config con "tcpPort": "5100"), lo devolvemos al
  // default antes de que un NaN llegue a Bun.listen.
  for (const key of ["tcpPort", "httpPort", "analyzerPort"] as const) {
    const v = resolved[key];
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      warnings.push(
        `${key}=${JSON.stringify(v)} no es un puerto valido; se usa el default (${def[key]}).`,
      );
      resolved[key] = def[key];
    }
  }

  // El listener TCP y la API HTTP no pueden compartir puerto. En caliente esto
  // ya se valida (http/server.ts), pero por CLI/env/archivo entraba sin chistar
  // y el sintoma era "la app no conecta" — porque el TCP arranca primero y le
  // roba el puerto justamente a la API, que es la unica forma de diagnosticar.
  // main.ts lee este flag para NO levantar el TCP y dejar viva la API.
  if (resolved.tcpPort === resolved.httpPort) {
    warnings.push(
      `El puerto del listener TCP (${resolved.tcpPort}) es el mismo que el de la ` +
        "API HTTP. No se puede: el listener NO se va a levantar, para no dejar " +
        "sin API a la app. Cambiar uno de los dos (--port / --http-port).",
    );
  }

  return resolved;
}
