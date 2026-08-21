/**
 * Inicializacion de la base SQLite.
 *
 * - Abre el archivo (lo crea si no existe).
 * - Verifica que no este corrupto; si lo esta, lo aparta y arranca con una limpia.
 * - Aplica el schema base y despues las migraciones incrementales pendientes.
 * - Devuelve el handle de la DB para que el repo lo use.
 *
 * ============================================================================
 *  REGLA DE ORO DEL SCHEMA — LEER ANTES DE TOCAR schema.sql
 * ============================================================================
 * `schema.sql` es la LINEA BASE (version 1) y esta CONGELADA. No se le agregan
 * columnas, tablas ni indices nunca mas.
 *
 * Todo cambio posterior va como una entrada nueva en el array MIGRATIONS de
 * este archivo. El motivo es que esta app se auto-actualiza sola en la PC del
 * laboratorio: una instalacion vieja ya tiene las tablas creadas, y el
 * `CREATE TABLE IF NOT EXISTS` de schema.sql se saltea la tabla ENTERA — con
 * lo cual una columna agregada ahi jamas llegaria a esa instalacion y el codigo
 * nuevo rompe en runtime contra una tabla vieja.
 *
 * Si se edita schema.sql igual, las instalaciones nuevas quedan con la columna
 * puesta dos veces (una por el CREATE y otra por el ALTER de la migracion) y
 * el ALTER falla. Una sola fuente: MIGRATIONS.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// Cargamos el schema en build time para que funcione en el .exe compilado.
// Bun resuelve este import como string crudo via type assertion.
import schemaSql from "./schema.sql" with { type: "text" };

/** Como migrate.ts reporta lo que hizo. Compatible con la interfaz de Logger. */
export interface MigrateLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface Migration {
  /** Version a la que lleva la DB. Consecutiva, arrancando en 2. */
  version: number;
  /** Descripcion corta para el log. */
  name: string;
  /** DDL/DML de la migracion. Corre dentro de una transaccion. */
  up: (db: Database) => void;
}

/**
 * Migraciones incrementales. La version 1 es `schema.sql` (linea base).
 *
 * Para agregar una: entrada nueva con `version` = la siguiente, un `name`
 * descriptivo y el DDL en `up`. NO tocar las que ya salieron publicadas — una
 * instalacion en el laboratorio ya las corrio y no se vuelven a ejecutar.
 *
 * Ejemplo de como se veria la proxima:
 *
 *   {
 *     version: 2,
 *     name: "results.instrument_serial",
 *     up: (db) => db.exec(`ALTER TABLE results ADD COLUMN instrument_serial TEXT`),
 *   },
 */
export const MIGRATIONS: Migration[] = [];

/** Version de schema que espera este build (1 = solo la linea base). */
export const SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? Math.max(...MIGRATIONS.map((m) => m.version)) : 1;

export interface OpenDbOptions {
  path: string;
  /** Si true, ejecuta PRAGMAs/DDL/migraciones (default true). */
  initialize?: boolean;
  /** Para dejar rastro de la recuperacion y las migraciones aplicadas. */
  logger?: MigrateLogger;
}

/**
 * Chequea que la base no este dañada.
 *
 * Usamos `quick_check` en vez de `integrity_check`: detecta lo mismo que nos
 * importa (paginas rotas, indices inconsistentes) pero sin recorrer toda la
 * base, asi el arranque no se hace eterno cuando el historico creció.
 *
 * Devuelve null si esta sana, o el motivo si esta rota.
 */
export function checkIntegrity(db: Database): string | null {
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const first = rows[0];
    if (!first) return "quick_check no devolvio resultado";
    const verdict = String(Object.values(first)[0] ?? "");
    return verdict.toLowerCase() === "ok" ? null : verdict;
  } catch (e) {
    // Si el PRAGMA mismo explota, el archivo no es una base usable.
    return (e as Error).message;
  }
}

/**
 * Aparta una base dañada renombrandola a `<path>.corrupt-<timestamp>`.
 *
 * NO la borramos: puede tener resultados recuperables con las herramientas de
 * SQLite y son datos clinicos. Nos llevamos tambien el -wal y el -shm porque un
 * WAL huerfano apuntando a una base nueva es, por si solo, otra fuente de
 * corrupcion.
 *
 * Devuelve el sufijo usado.
 */
function quarantineDbFiles(path: string, logger?: MigrateLogger): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `.corrupt-${stamp}`;
  for (const sidecar of ["", "-wal", "-shm"]) {
    const from = path + sidecar;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, from + suffix);
    } catch (e) {
      logger?.error("db.quarantine_failed", {
        file: from,
        error: (e as Error).message,
        detail:
          "No se pudo apartar el archivo dañado (¿esta abierto por otro " +
          "proceso o el antivirus lo tiene tomado?). El servicio va a seguir " +
          "intentando abrir la base rota en cada arranque.",
      });
      throw e;
    }
  }
  return suffix;
}

/**
 * Aplica las migraciones pendientes segun `PRAGMA user_version`.
 *
 * Cada migracion corre en su propia transaccion junto con el bump de version:
 * si falla a la mitad, la DB queda en la version anterior y se puede reintentar
 * al proximo arranque, en vez de quedar a medio migrar.
 *
 * Exportada aparte de openDb para poder testearla con migraciones sinteticas.
 */
export function applyMigrations(
  db: Database,
  migrations: Migration[] = MIGRATIONS,
  logger?: MigrateLogger,
): number {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
      ?.user_version ?? 0,
  );

  // Una base preexistente (creada antes de que existiera el versionado) tiene
  // user_version = 0 pero el schema v1 completo, porque schema.sql ya corrio.
  // La marcamos como v1 sin hacer nada mas.
  let version = current === 0 ? 1 : current;
  if (current === 0) {
    db.exec(`PRAGMA user_version = 1`);
  }

  const pending = migrations.filter((m) => m.version > version).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    logger?.info("db.migration.applying", {
      from: version,
      to: migration.version,
      name: migration.name,
    });
    try {
      db.exec("BEGIN");
      migration.up(db);
      // user_version no acepta bind de parametros: es DDL puro.
      db.exec(`PRAGMA user_version = ${Math.floor(migration.version)}`);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      logger?.error("db.migration.failed", {
        version: migration.version,
        name: migration.name,
        error: (e as Error).message,
        detail:
          "La base queda en la version anterior. Se reintenta al proximo " +
          "arranque; si vuelve a fallar, hay que revisar la migracion.",
      });
      throw e;
    }
    version = migration.version;
    logger?.info("db.migration.applied", { version, name: migration.name });
  }

  return version;
}

/** Abre la base y le aplica schema + migraciones. No verifica corrupcion. */
function openAndInitialize(opts: OpenDbOptions): Database {
  const db = new Database(opts.path, { create: true });
  if (opts.initialize !== false) {
    db.exec(schemaSql);
    applyMigrations(db, MIGRATIONS, opts.logger);
  }
  return db;
}

export function openDb(opts: OpenDbOptions): Database {
  // Crear directorio si no existe.
  const dir = dirname(opts.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const logger = opts.logger;

  try {
    const db = new Database(opts.path, { create: true });

    // Chequeamos ANTES de tocar el schema: un `exec` contra una base rota puede
    // fallar con un error generico que no delata que el problema es corrupcion.
    const corruption = opts.initialize === false ? null : checkIntegrity(db);
    if (corruption === null) {
      if (opts.initialize !== false) {
        db.exec(schemaSql);
        applyMigrations(db, MIGRATIONS, logger);
      }
      return db;
    }

    logger?.error("db.corrupted", { dbPath: opts.path, verdict: corruption });
    try {
      db.close();
    } catch {
      // ignore
    }
    return recoverFromCorruption(opts, corruption);
  } catch (e) {
    // `new Database()` o el schema tiraron: archivo truncado, no-SQLite, o
    // header ilegible. Mismo tratamiento que la corrupcion detectada.
    const message = (e as Error).message;
    logger?.error("db.open_failed", { dbPath: opts.path, error: message });
    return recoverFromCorruption(opts, message);
  }
}

/**
 * Aparta la base rota y arranca con una limpia.
 *
 * Perder el historico duele, pero mucho menos que quedarse sin bridge: sin base
 * el servicio muere en cada arranque, NSSM lo reinicia en loop, y el laboratorio
 * deja de recibir resultados del equipo sin que nadie entienda por que. El
 * archivo viejo queda al lado, intacto, para intentar recuperarlo con calma.
 */
function recoverFromCorruption(opts: OpenDbOptions, reason: string): Database {
  const logger = opts.logger;
  const suffix = quarantineDbFiles(opts.path, logger);

  let db: Database;
  try {
    db = openAndInitialize(opts);
  } catch (e) {
    // Si tampoco podemos crear una base nueva, el problema no es el archivo
    // (disco lleno, carpeta sin permisos). Ahi si no hay nada que hacer aca:
    // gritamos y dejamos que el caller decida.
    logger?.error("db.recovery_failed", {
      dbPath: opts.path,
      error: (e as Error).message,
      detail:
        "Se aparto la base dañada pero tampoco se pudo crear una nueva. " +
        "Revisar espacio en disco y permisos sobre la carpeta db.",
    });
    throw e;
  }

  logger?.error("db.recovered_from_corruption", {
    dbPath: opts.path,
    corruptFile: opts.path + suffix,
    reason,
    detail:
      "La base estaba dañada (corte de luz, antivirus o disco). Se la aparto " +
      `con el sufijo "${suffix}" y se arranco con una base VACIA: el historico ` +
      "de resultados ya no se ve en la app, pero los resultados nuevos se " +
      "guardan normalmente. Los .txt exportados de las muestras viejas NO se " +
      "tocaron. El archivo apartado se puede intentar recuperar; no borrarlo " +
      "sin consultar.",
  });

  return db;
}
