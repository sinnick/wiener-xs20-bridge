/**
 * Entrypoint del servicio.
 *
 * Resuelve config → arma logger → abre DB → arranca TCP listener + HTTP API
 * → maneja senales para shutdown limpio.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { resolveConfig } from "./config.js";
import { openDb } from "./db/migrate.js";
import { TxtExporter } from "./export/txt-exporter.js";
import { XsRepo } from "./db/repo.js";
import { MessageProcessor } from "./hl7/message-processor.js";
import { HttpServer } from "./http/server.js";
import { AnalyzerClient } from "./listener/analyzer-client.js";
import { TcpServer } from "./listener/tcp-server.js";
import { Logger } from "./logger.js";
import { UpdateChecker } from "./update/update-checker.js";
import { VERSION } from "./version.js";

/**
 * Manifest de actualizaciones publicado en nuestro VPS (lo sube
 * `bun run release`, ver scripts/release.ts y docs/12-actualizaciones.md).
 * Se puede apuntar a otro servidor para probar: XS20_UPDATE_MANIFEST_URL.
 */
const UPDATE_MANIFEST_URL =
  process.env.XS20_UPDATE_MANIFEST_URL ??
  "https://sinnick.dev/wiener/update/latest.json";

function loadOrCreateApiToken(dataDir: string): string {
  const tokenDir = join(dataDir, "config");
  const tokenPath = join(tokenDir, "api-token.txt");

  if (existsSync(tokenPath)) {
    const t = readFileSync(tokenPath, "utf-8").trim();
    if (t.length > 0) return t;
  }

  if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

/** Cada cuanto se reintenta un bind que fallo. */
const BIND_RETRY_INTERVAL_MS = 15_000;

interface RetryHandle {
  /** True si el bind quedo arriba. */
  readonly ok: boolean;
  cancel(): void;
}

/**
 * Levanta algo que hace bind de un puerto, sin voltear el servicio si falla.
 *
 * Por que esto importa tanto aca: el servicio corre bajo NSSM con
 * `AppExit Default Restart`. Si `Bun.listen`/`Bun.serve` tiran (puerto ocupado)
 * y dejamos que el error llegue al `main().catch` → `process.exit(1)`, NSSM nos
 * reinicia, volvemos a fallar, y queda un loop infinito de arranques. Desde
 * afuera se ve igual que un servicio muerto, pero sin ningun diagnostico.
 *
 * En vez de eso: logueamos la causa exacta y reintentamos en background. El
 * caso tipico — el proceso anterior todavia soltando el puerto despues de una
 * actualizacion, o un TIME_WAIT — se resuelve solo en segundos. Y si es algo
 * permanente (otro programa en el 5100), el servicio sigue vivo, la API
 * responde y la app puede mostrar que pasa.
 */
function startWithRetry(opts: {
  label: string;
  logger: Logger;
  start: () => void;
  hint: string;
  onSuccess?: () => void;
}): RetryHandle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  let ok = false;

  const attempt = (): boolean => {
    try {
      opts.start();
      if (attempts > 0) {
        opts.logger.info(`${opts.label}.bind_recovered`, { attempts });
      }
      opts.onSuccess?.();
      return true;
    } catch (e) {
      attempts++;
      const ctx = {
        error: (e as Error).message,
        attempts,
        retryInMs: BIND_RETRY_INTERVAL_MS,
        detail: opts.hint,
      };
      // El primer fallo se grita; los reintentos van a debug para no llenar el
      // log si el puerto queda tomado por horas.
      if (attempts === 1) opts.logger.error(`${opts.label}.bind_failed`, ctx);
      else opts.logger.debug(`${opts.label}.bind_failed`, ctx);
      return false;
    }
  };

  ok = attempt();
  if (!ok) {
    timer = setInterval(() => {
      if (attempt()) {
        ok = true;
        if (timer) clearInterval(timer);
        timer = null;
      }
    }, BIND_RETRY_INTERVAL_MS);
  }

  return {
    get ok() {
      return ok;
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

async function main(): Promise<void> {
  const config = resolveConfig(process.argv.slice(2));

  // El token vive en el mismo dataDir que la DB (mismo padre).
  const dataDir = dirname(dirname(config.dbPath));
  const apiToken = loadOrCreateApiToken(dataDir);
  config.apiToken = apiToken;

  const logger = new Logger({
    logDir: config.logDir,
    level: config.logLevel,
    console: config.console,
    retentionDays: config.logRetentionDays,
  });

  // Lo primero: los problemas que encontro resolveConfig. Se juntan alla porque
  // la config se resuelve antes de que exista el logger (es ella la que dice
  // donde escribir). Antes se descartaban en silencio y el sintoma era un
  // servicio corriendo con valores que el usuario nunca puso.
  for (const w of config.warnings ?? []) {
    logger.error("config.invalid", { detail: w });
  }

  const startedAt = new Date();
  logger.info("service.starting", {
    version: VERSION,
    pid: process.pid,
    platform: process.platform,
    connectionMode: config.connectionMode,
    analyzerHost: config.analyzerHost,
    analyzerPort: config.analyzerPort,
    tcpPort: config.tcpPort,
    tcpHost: config.tcpHost,
    httpPort: config.httpPort,
    dbPath: config.dbPath,
    logDir: config.logDir,
    exportDir: config.exportDir,
    noListen: config.noListen,
  });

  // DB. Le pasamos el logger para que la recuperacion de una base dañada y las
  // migraciones queden registradas: son cosas que pasan una sola vez y sin
  // rastro no hay forma de entender despues por que se vacio el historico.
  const db = openDb({ path: config.dbPath, logger });
  const repo = new XsRepo(db);
  logger.info("db.ready", { resultCount: repo.countResults() });

  // Verificamos que la DB acepte escrituras ANTES de decir que arrancamos. Si no,
  // el servicio queda vivo (la API y los logs sirven para diagnosticar) pero lo
  // gritamos: sin esto, el sintoma es "el equipo manda y no se guarda nada".
  const writable = repo.probeWritable();
  if (!writable.ok) {
    logger.error("db.not_writable", {
      dbPath: config.dbPath,
      error: writable.error,
      detail:
        "La base rechaza escrituras: NO se van a guardar resultados. Causa " +
        "habitual en Windows: el .sqlite o sus archivos -wal/-shm quedaron de " +
        "otro usuario (por haber corrido el servicio como administrador alguna " +
        "vez). Solucion: cerrar la app y borrar " +
        `${config.dbPath}-wal y ${config.dbPath}-shm, o darle permiso de ` +
        "modificacion al usuario sobre la carpeta db.",
    });
  }

  // Retencion: purga el HL7 crudo viejo al arranque y despues cada 24h.
  // Los resultados estructurados NUNCA se borran; solo el payload pesado.
  const runPurge = () => {
    try {
      const purged = repo.purgeOldRawMessages(config.rawRetentionDays);
      if (purged > 0) {
        logger.info("retention.purged", {
          rawMessagesPurged: purged,
          retentionDays: config.rawRetentionDays,
        });
      }
    } catch (e) {
      logger.error("retention.purge_failed", { error: (e as Error).message });
    }
  };
  runPurge();
  const purgeTimer = setInterval(runPurge, 24 * 60 * 60 * 1000);

  // Exportacion a .txt por muestra. Lee exportDir del config vivo, asi el
  // cambio de carpeta desde la app aplica sin reiniciar.
  const txtExporter = new TxtExporter({ getDir: () => config.exportDir, logger });

  // Procesamiento HL7 compartido por los dos transportes, para que el estado
  // (lastMessageAt, contador de IDs) sea uno solo sin importar quien disco.
  const processor = new MessageProcessor({
    repo,
    logger,
    onHemogramPersisted: (h) => txtExporter.export(h),
  });

  // Los dos transportes se construyen siempre — asi la API puede cambiar de
  // modo en caliente sin reiniciar — pero solo arranca el del modo activo.
  const tcp = new TcpServer({
    host: config.tcpHost,
    port: config.tcpPort,
    repo,
    logger,
    processor,
  });
  const analyzerClient = new AnalyzerClient({
    host: config.analyzerHost,
    port: config.analyzerPort,
    processor,
    logger,
  });

  let tcpBind: RetryHandle | null = null;

  if (config.noListen) {
    logger.warn("tcp.disabled", { reason: "--no-listen flag" });
  } else if (config.connectionMode === "connect") {
    if (config.analyzerHost.length === 0) {
      logger.error("analyzer.client.no_host", {
        detail:
          "Modo 'connect' sin IP del analizador. Configurala en la app " +
          "(Estado → Configuración) o arranca con --analyzer-host=<ip>.",
      });
    } else {
      analyzerClient.start();
    }
  } else if (config.tcpPort === config.httpPort) {
    // Mismo puerto para el listener y la API: solo uno puede quedarse con el.
    // Gana la API — es la unica forma que tiene la operadora de ver que pasa.
    // Si arrancaramos el TCP igual (corre antes que el HTTP), le robaria el
    // puerto a la API y el sintoma seria "la app no conecta", sin pista alguna.
    logger.error("config.port_conflict", {
      tcpPort: config.tcpPort,
      httpPort: config.httpPort,
      detail:
        `El listener TCP y la API HTTP tienen configurado el mismo puerto ` +
        `(${config.tcpPort}). NO se levanta el listener, para dejar la API en ` +
        "pie. Cambiar el puerto del equipo en la app o arrancar con --port=<otro>.",
    });
  } else {
    tcpBind = startWithRetry({
      label: "tcp.listener",
      logger,
      start: () => tcp.start(),
      hint:
        `No se pudo escuchar en ${config.tcpHost}:${config.tcpPort}. Casi ` +
        "siempre es que otro programa ya tiene ese puerto (u otra copia del " +
        "servicio quedo corriendo). El servicio sigue vivo y reintenta solo; " +
        "la app y los logs siguen andando para poder diagnosticar.",
    });
  }

  // Chequeo de versiones nuevas contra el manifest del VPS. Lee los settings en
  // vivo, asi el toggle y el "omitir version" de la app aplican sin reiniciar.
  const updateChecker = new UpdateChecker({
    currentVersion: VERSION,
    manifestUrl: UPDATE_MANIFEST_URL,
    updatesDir: join(dataDir, "updates"),
    logger,
    isEnabled: () => config.updateCheckEnabled,
    getSkippedVersion: () => config.skippedVersion,
  });

  // HTTP API
  const http = new HttpServer({
    repo,
    logger,
    tcp,
    analyzerClient,
    config,
    apiToken,
    port: config.httpPort,
    startedAt,
    version: VERSION,
    updateChecker,
  });
  // Si el 7700 esta ocupado NO nos morimos: seria un loop de reinicios de NSSM
  // sin diagnostico. Reintentamos en background — la causa mas probable es el
  // proceso anterior soltando el puerto durante una actualizacion, que se
  // resuelve en segundos — y mientras tanto el TCP sigue recibiendo y
  // guardando resultados aunque la app no pueda mostrarlos.
  const httpBind = startWithRetry({
    label: "http.api",
    logger,
    start: () => http.start(),
    hint:
      `No se pudo abrir la API HTTP en el puerto ${config.httpPort}. La app no ` +
      "va a poder conectarse hasta que se libere. Suele ser otra copia del " +
      "servicio corriendo, o el puerto tomado por otro programa.",
  });
  updateChecker.start();

  logger.info("service.started", {
    uptimeStartedAt: startedAt.toISOString(),
    apiTokenPath: join(dataDir, "config", "api-token.txt"),
    httpListening: httpBind.ok,
    tcpListening: tcpBind ? tcpBind.ok : false,
  });

  // Shutdown handlers
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("service.stopping", { signal });
    clearInterval(purgeTimer);
    // Cortamos los reintentos de bind pendientes, sino el proceso no termina.
    httpBind.cancel();
    tcpBind?.cancel();
    try {
      updateChecker.stop();
    } catch {
      /* ignore */
    }
    try {
      http.stop();
    } catch {
      /* ignore */
    }
    try {
      tcp.stop();
    } catch {
      /* ignore */
    }
    try {
      analyzerClient.stop();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    logger.info("service.stopped");
    // Damos tiempo a que el log se escriba a disco antes de salir.
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    logger.error("uncaught_exception", { error: e.message, stack: e.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { reason: String(reason) });
  });
}

main().catch((e) => {
  console.error("FATAL:", e);
  // Como servicio de Windows nadie ve la consola: sin esto, un fatal durante el
  // arranque no deja NINGUN rastro y el unico sintoma es que la app "no
  // conecta". Escribimos aparte del log del dia porque el fatal puede ser
  // justamente que no se pudo armar el logger.
  try {
    const cfg = resolveConfig(process.argv.slice(2));
    if (!existsSync(cfg.logDir)) mkdirSync(cfg.logDir, { recursive: true });
    const err = e as Error;
    appendFileSync(
      join(cfg.logDir, "service-crash.log"),
      JSON.stringify({
        time: new Date().toISOString(),
        level: "error",
        msg: "service.fatal",
        ctx: { version: VERSION, error: err?.message ?? String(e), stack: err?.stack },
      }) + "\n",
    );
  } catch {
    // Si ni esto se puede, no queda nada por hacer.
  }
  process.exit(1);
});
