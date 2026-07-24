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

import type { ServiceConfig } from "@xs20/shared";

import type { LogLevel } from "./logger.js";
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
    tcpPort: 5100,
    tcpHost: "0.0.0.0",
    httpPort: 7700,
    dbPath: join(dataDir, "db", "xs20.sqlite"),
    logDir: join(dataDir, "logs"),
    logLevel: "info",
    rawRetentionDays: 90,
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
}

function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { console: false, noListen: false };
  for (const arg of argv) {
    if (arg === "--console") out.console = true;
    else if (arg === "--no-listen") out.noListen = true;
    else if (arg.startsWith("--log-level=")) {
      const v = arg.split("=")[1] as LogLevel;
      if (["debug", "info", "warn", "error"].includes(v)) out.logLevel = v;
    } else if (arg.startsWith("--config=")) out.configPath = arg.split("=")[1];
    else if (arg.startsWith("--port=")) out.tcpPort = parseInt(arg.split("=")[1] ?? "", 10);
    else if (arg.startsWith("--http-port=")) out.httpPort = parseInt(arg.split("=")[1] ?? "", 10);
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.split("=")[1];
  }
  return out;
}

function loadFile(path: string | undefined): Partial<ServiceConfig> {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<ServiceConfig>;
  } catch {
    return {};
  }
}

function loadEnv(): Partial<ServiceConfig> {
  const out: Partial<ServiceConfig> = {};
  if (process.env.XS20_TCP_PORT) out.tcpPort = parseInt(process.env.XS20_TCP_PORT, 10);
  if (process.env.XS20_TCP_HOST) out.tcpHost = process.env.XS20_TCP_HOST;
  if (process.env.XS20_HTTP_PORT) out.httpPort = parseInt(process.env.XS20_HTTP_PORT, 10);
  if (process.env.XS20_DB_PATH) out.dbPath = process.env.XS20_DB_PATH;
  if (process.env.XS20_LOG_DIR) out.logDir = process.env.XS20_LOG_DIR;
  if (process.env.XS20_LOG_LEVEL) {
    const lvl = process.env.XS20_LOG_LEVEL as LogLevel;
    if (["debug", "info", "warn", "error"].includes(lvl)) out.logLevel = lvl;
  }
  return out;
}

export function resolveConfig(argv: string[]): ResolvedConfig {
  const cli = parseCli(argv);
  const fileCfg = loadFile(cli.configPath);
  const envCfg = loadEnv();
  const def = defaultConfig();

  // Si --data-dir, recalculamos paths
  if (cli.dataDir) {
    def.dbPath = join(cli.dataDir, "db", "xs20.sqlite");
    def.logDir = join(cli.dataDir, "logs");
  }

  // El settings.json editable vive junto al token, en <dataDir>/config.
  // dataDir = padre del padre de dbPath (…\WienerXS20\db\xs20.sqlite → …\WienerXS20).
  const dataDir = dirname(dirname(def.dbPath));
  const settingsPath = join(dataDir, "config", "settings.json");
  const persisted = loadSettings(settingsPath);

  // Precedencia (menor a mayor): defaults < settings.json < archivo --config <
  // env < flags CLI. Los settings guardados desde la UI ganan a los defaults,
  // pero un flag/env explicito siempre manda (util en dev y para overrides).
  return {
    ...def,
    ...persisted,
    ...fileCfg,
    ...envCfg,
    ...(cli.tcpPort !== undefined ? { tcpPort: cli.tcpPort } : {}),
    ...(cli.httpPort !== undefined ? { httpPort: cli.httpPort } : {}),
    ...(cli.logLevel ? { logLevel: cli.logLevel } : {}),
    console: cli.console,
    noListen: cli.noListen,
    settingsPath,
  };
}
