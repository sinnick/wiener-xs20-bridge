/**
 * Tests de la apertura de la base: recuperacion ante corrupcion y migraciones.
 *
 * Los dos caminos importan por el mismo motivo: la app se auto-actualiza sola
 * en la PC del laboratorio y corre como servicio con reinicio automatico. Un
 * fallo aca no es "se cayo una vez", es el bridge muerto para siempre.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, checkIntegrity, type Migration, openDb } from "./migrate.js";
import { XsRepo } from "./repo.js";

const created: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xs20-migrate-"));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Deja el .sqlite ilegible, como despues de un corte de luz o un antivirus.
 *
 * Los sidecars van tambien: si queda un -wal VALIDO al lado, SQLite reconstruye
 * la base sola a partir de el (y hace bien) — con lo cual no habria corrupcion
 * que detectar. La corrupcion real es la que ni el WAL puede reparar.
 */
function damageDb(dbPath: string): void {
  for (const sidecar of ["-wal", "-shm"]) {
    if (existsSync(dbPath + sidecar)) unlinkSync(dbPath + sidecar);
  }
  writeFileSync(dbPath, "esto no es una base de datos, ni por asomo".repeat(50));
}

/** Junta los eventos logueados para poder afirmar que quedo rastro. */
function recordingLogger() {
  const events: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
  return {
    events,
    info: (msg: string, ctx?: Record<string, unknown>) => events.push({ level: "info", msg, ctx }),
    warn: (msg: string, ctx?: Record<string, unknown>) => events.push({ level: "warn", msg, ctx }),
    error: (msg: string, ctx?: Record<string, unknown>) => events.push({ level: "error", msg, ctx }),
  };
}

describe("checkIntegrity", () => {
  test("una base sana no reporta nada", () => {
    const db = openDb({ path: ":memory:" });
    expect(checkIntegrity(db)).toBeNull();
  });
});

describe("openDb - recuperacion de base corrupta", () => {
  test("un archivo que no es SQLite se aparta y se arranca con una base limpia", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "db", "xs20.sqlite");
    // Simulamos el .sqlite dañado por un corte de luz: bytes que no son una
    // base valida en el lugar del archivo.
    const db0 = openDb({ path: dbPath });
    db0.close();
    damageDb(dbPath);

    const logger = recordingLogger();
    const db = openDb({ path: dbPath, logger });

    // Arranco igual y la base nueva sirve para guardar resultados.
    expect(new XsRepo(db).countResults()).toBe(0);
    expect(checkIntegrity(db)).toBeNull();

    // El archivo dañado quedo al lado, NO se borro: son datos clinicos.
    const quarantined = readdirSync(join(dir, "db")).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBeGreaterThanOrEqual(1);

    // Y quedo rastro fuerte de lo que paso.
    const msgs = logger.events.map((e) => e.msg);
    expect(msgs).toContain("db.recovered_from_corruption");
    expect(logger.events.every((e) => e.level === "error" || e.level === "info")).toBe(true);
    db.close();
  });

  test("se lleva tambien el -wal y el -shm (un WAL huerfano corrompe la base nueva)", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "db", "xs20.sqlite");
    openDb({ path: dbPath }).close();
    damageDb(dbPath);
    // Sidecars rotos que sobrevivieron al corte: si los dejaramos, SQLite los
    // aplicaria sobre la base NUEVA y la volveria a romper.
    writeFileSync(dbPath + "-wal", "wal roto");
    writeFileSync(dbPath + "-shm", "shm roto");

    const db = openDb({ path: dbPath, logger: recordingLogger() });

    // Los tres archivos viejos quedaron apartados juntos.
    const apartados = readdirSync(join(dir, "db")).filter((f) => f.includes(".corrupt-"));
    expect(apartados.some((f) => f.includes("-wal"))).toBe(true);
    expect(apartados.some((f) => f.includes("-shm"))).toBe(true);

    // Y el -wal que hay ahora es el nuevo, no el roto que arrastrariamos.
    if (existsSync(dbPath + "-wal")) {
      expect(readFileSync(dbPath + "-wal", "utf-8")).not.toContain("wal roto");
    }
    expect(checkIntegrity(db)).toBeNull();
    db.close();
  });

  test("una base sana NO se toca (no hay falsos positivos)", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "db", "xs20.sqlite");
    const first = openDb({ path: dbPath });
    first.exec(
      `INSERT INTO raw_messages (id, received_at, message_control_id, message_type, raw_hl7, byte_size, parse_status)
       VALUES ('r1', '2025-01-01T00:00:00.000Z', 'MSG1', 'ORU', 'x', 1, 'parsed')`,
    );
    first.close();

    const logger = recordingLogger();
    const db = openDb({ path: dbPath, logger });

    // El historico sigue ahi y nadie aparto nada.
    const row = db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get() as { n: number };
    expect(row.n).toBe(1);
    expect(readdirSync(join(dir, "db")).filter((f) => f.includes(".corrupt-"))).toHaveLength(0);
    expect(logger.events.map((e) => e.msg)).not.toContain("db.recovered_from_corruption");
    db.close();
  });
});

describe("openDb - una migracion que falla NO se confunde con corrupcion", () => {
  /**
   * Migracion que anda en una base vacia pero revienta contra datos reales:
   * un UNIQUE que las filas que ya existen violan. Es el caso tipico de una
   * migracion que pasa en desarrollo y falla en el laboratorio.
   */
  const migracionRota: Migration[] = [
    {
      version: 2,
      name: "rota-contra-datos-reales",
      up: (d) => d.exec("CREATE UNIQUE INDEX idx_tipo ON raw_messages(message_type)"),
    },
  ];

  test("la base sana NO se aparta y el historico queda intacto", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "db", "xs20.sqlite");
    const inicial = openDb({ path: dbPath });
    // Dos mensajes del mismo tipo: el UNIQUE de la migracion no va a poder.
    for (const [id, ctrl] of [
      ["r1", "MSG1"],
      ["r2", "MSG2"],
    ]) {
      inicial.exec(
        `INSERT INTO raw_messages (id, received_at, message_control_id, message_type, raw_hl7, byte_size, parse_status)
         VALUES ('${id}', '2025-01-01T00:00:00.000Z', '${ctrl}', 'ORU', 'x', 1, 'parsed')`,
      );
    }
    inicial.close();

    const logger = recordingLogger();
    const db = openDb({ path: dbPath, logger, migrations: migracionRota });

    // Lo que NO tiene que pasar: apartar una base perfectamente sana y arrancar
    // vacia — encima la base nueva migraria bien y nadie notaria la perdida.
    expect(readdirSync(join(dir, "db")).filter((f) => f.includes(".corrupt-"))).toHaveLength(0);
    const row = db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get() as { n: number };
    expect(row.n).toBe(2);

    // Sigue en la version vieja, pero vivo y con rastro de lo que paso.
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(1);
    expect(logger.events.map((e) => e.msg)).toContain("db.migration.degraded");
    db.close();
  });

  test("el servicio arranca igual (no tira, no hay loop de reinicios)", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "db", "xs20.sqlite");
    openDb({ path: dbPath }).close();

    // Si esto lanzara, el error caeria en main().catch → exit(1) → NSSM
    // reinicia → vuelve a fallar. Loop infinito sin diagnostico.
    const siempreFalla: Migration[] = [
      {
        version: 2,
        name: "explota",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() =>
      openDb({ path: dbPath, logger: recordingLogger(), migrations: siempreFalla }),
    ).not.toThrow();
  });
});

describe("applyMigrations", () => {
  test("una base recien creada queda en la version del build", () => {
    const db = openDb({ path: ":memory:" });
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThanOrEqual(1);
  });

  test("una base preexistente sin user_version se marca como v1 sin re-aplicar nada", () => {
    // Asi se ve una instalacion del laboratorio anterior al versionado: schema
    // completo, user_version = 0.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE results (id TEXT PRIMARY KEY)");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(0);

    expect(applyMigrations(db, [])).toBe(1);
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(1);
  });

  test("aplica las migraciones pendientes en orden y sube user_version", () => {
    const db = openDb({ path: ":memory:" });
    const logger = recordingLogger();
    const migrations: Migration[] = [
      {
        version: 2,
        name: "results.instrument_serial",
        up: (d) => d.exec("ALTER TABLE results ADD COLUMN instrument_serial TEXT"),
      },
      {
        version: 3,
        name: "results.idx_instrument_serial",
        up: (d) => d.exec("CREATE INDEX idx_serial ON results(instrument_serial)"),
      },
    ];

    expect(applyMigrations(db, migrations, logger)).toBe(3);

    // La columna nueva existe: este es exactamente el caso que hoy rompia,
    // porque el CREATE TABLE IF NOT EXISTS se saltea la tabla entera.
    const cols = (db.prepare("PRAGMA table_info(results)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("instrument_serial");
    expect(logger.events.filter((e) => e.msg === "db.migration.applied")).toHaveLength(2);
  });

  test("es idempotente: correrla de nuevo no re-aplica nada", () => {
    const db = openDb({ path: ":memory:" });
    const migrations: Migration[] = [
      {
        version: 2,
        name: "results.instrument_serial",
        up: (d) => d.exec("ALTER TABLE results ADD COLUMN instrument_serial TEXT"),
      },
    ];
    applyMigrations(db, migrations);

    // Si se re-aplicara, el ALTER fallaria por columna duplicada.
    expect(() => applyMigrations(db, migrations)).not.toThrow();
    expect(applyMigrations(db, migrations)).toBe(2);
  });

  test("una migracion que falla no deja la base a medio migrar", () => {
    const db = openDb({ path: ":memory:" });
    const logger = recordingLogger();
    const migrations: Migration[] = [
      {
        version: 2,
        name: "ok",
        up: (d) => d.exec("CREATE TABLE nueva (x TEXT)"),
      },
      {
        version: 3,
        name: "rota",
        up: (d) => {
          d.exec("CREATE TABLE a_medias (y TEXT)");
          throw new Error("boom");
        },
      },
    ];

    expect(() => applyMigrations(db, migrations, logger)).toThrow("boom");

    // Quedo en la 2: la 3 se revirtio entera y se reintenta al proximo arranque.
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(2);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toContain("nueva");
    expect(tables).not.toContain("a_medias");
    expect(logger.events.map((e) => e.msg)).toContain("db.migration.failed");
  });
});
