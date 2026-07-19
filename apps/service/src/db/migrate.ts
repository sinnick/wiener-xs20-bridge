/**
 * Inicializacion de la base SQLite.
 *
 * - Abre el archivo (lo crea si no existe).
 * - Aplica el schema (idempotente gracias a IF NOT EXISTS).
 * - Devuelve el handle de la DB para que el repo lo use.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Cargamos el schema en build time para que funcione en el .exe compilado.
// Bun resuelve este import como string crudo via type assertion.
import schemaSql from "./schema.sql" with { type: "text" };

export interface OpenDbOptions {
  path: string;
  /** Si true, ejecuta PRAGMAs/DDL (default true). */
  initialize?: boolean;
}

export function openDb(opts: OpenDbOptions): Database {
  // Crear directorio si no existe.
  const dir = dirname(opts.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(opts.path, { create: true });

  if (opts.initialize !== false) {
    db.exec(schemaSql);
  }

  return db;
}
