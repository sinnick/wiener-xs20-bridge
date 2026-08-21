/**
 * Re-generacion de los .txt a partir de lo que ya esta guardado en la base.
 *
 * Existe por un escenario concreto y caro: la carpeta de exportacion estuvo mal
 * configurada (typo, unidad de red caida, permisos) durante una semana. Los
 * resultados igual se guardaron (la base es la fuente de verdad) pero los
 * .txt de esa semana no existen y, sin esto, no habia forma de recuperarlos:
 * habria que volver a correr las muestras en el analizador.
 *
 * Reconstruye el archivo exactamente igual que la exportacion en vivo (mismo
 * formateo, misma conversion de unidades), asi un .txt regenerado es
 * indistinguible del original.
 */

import type { XsRepo } from "../db/repo.js";
import type { Logger } from "../logger.js";
import type { ExportStatusTracker } from "./export-status.js";
import { probeExportDir } from "./export-status.js";
import { TxtExporter } from "./txt-exporter.js";

/** Cuantos resultados se regeneran si no piden un limite. */
export const RERUN_DEFAULT_LIMIT = 200;
/** Tope duro: mas que esto se pide por rango de fechas, de a tandas. */
export const RERUN_MAX_LIMIT = 500;

export interface RerunExportsParams {
  repo: XsRepo;
  logger: Logger;
  /** Carpeta destino (la de la config vigente). */
  dir: string;
  /** Resultados puntuales por id. Si viene, se ignora el filtro por fecha. */
  ids?: string[];
  /** ISO; mismo filtro que GET /api/results. */
  fromDate?: string;
  toDate?: string;
  /** Default RERUN_DEFAULT_LIMIT, tope RERUN_MAX_LIMIT. */
  limit?: number;
  status?: ExportStatusTracker;
}

export interface RerunExportsResult {
  dir: string;
  /** Motivo por el que ni se intento (carpeta inaccesible), o null. */
  dirError: string | null;
  attempted: number;
  written: number;
  failed: number;
  /** Ids pedidos que no existen en la base. */
  notFound: string[];
  /** Detalle de los primeros fallos (para mostrarle algo util a la operadora). */
  errors: { id: string; sampleId: string; error: string }[];
}

/** Cuantos errores detallamos en la respuesta (el resto queda en el log). */
const MAX_ERROR_DETAIL = 10;

/**
 * Regenera los .txt de resultados ya guardados. Nunca lanza.
 *
 * Si la carpeta no acepta escrituras, corta antes de empezar y lo dice: es mas
 * util que devolver 200 errores identicos.
 */
export function rerunExports(params: RerunExportsParams): RerunExportsResult {
  const { repo, logger, dir } = params;
  const base: RerunExportsResult = {
    dir,
    dirError: null,
    attempted: 0,
    written: 0,
    failed: 0,
    notFound: [],
    errors: [],
  };

  if (dir.length === 0) {
    return { ...base, dirError: "La exportación a .txt está deshabilitada (carpeta vacía)." };
  }

  const probe = probeExportDir(dir);
  if (!probe.ok) {
    logger.error("export.rerun_dir_unavailable", { dir, error: probe.error });
    return { ...base, dirError: probe.error };
  }

  const ids =
    params.ids && params.ids.length > 0
      ? params.ids
      : repo
          .listResults({
            fromDate: params.fromDate,
            toDate: params.toDate,
            limit: Math.min(params.limit ?? RERUN_DEFAULT_LIMIT, RERUN_MAX_LIMIT),
          })
          .map((r) => r.id);

  const exporter = new TxtExporter({
    getDir: () => dir,
    logger,
    status: params.status,
    // Ya chequeamos la carpeta unas lineas arriba.
    probeOnStart: false,
  });

  const out: RerunExportsResult = { ...base };
  for (const id of ids) {
    const hemogram = repo.getResult(id);
    if (!hemogram) {
      out.notFound.push(id);
      continue;
    }
    out.attempted++;
    const res = exporter.export(hemogram);
    if (res.ok && !res.skipped) {
      out.written++;
    } else if (!res.ok) {
      out.failed++;
      if (out.errors.length < MAX_ERROR_DETAIL) {
        out.errors.push({ id, sampleId: hemogram.sample.sampleId, error: res.error });
      }
    }
  }

  logger.info("export.rerun_done", {
    dir,
    attempted: out.attempted,
    written: out.written,
    failed: out.failed,
    notFound: out.notFound.length,
  });
  return out;
}
