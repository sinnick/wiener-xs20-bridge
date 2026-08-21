/**
 * Estado de la exportacion a .txt, para que un fallo NO sea invisible.
 *
 * El .txt es el producto final del bridge: es lo unico que la operadora abre.
 * Antes, si la carpeta destino tenia un typo, era una unidad de red caida o el
 * disco estaba lleno, cada muestra fallaba en silencio (un log `export.txt_failed`
 * que nadie mira) y la app seguia diciendo "todo bien" mientras los archivos no
 * aparecian nunca. Aca guardamos el resultado de la ultima exportacion y lo
 * publicamos en /api/health, igual que el chequeo de escritura de la DB.
 *
 * El tracker es un singleton de proceso (`exportStatus`) porque el escritor
 * (TxtExporter, que arma main.ts) y el lector (/api/health) viven en modulos
 * distintos y no comparten inyeccion. Los tests usan su propia instancia.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExportStatus } from "@xs20/shared";

import type { Logger } from "../logger.js";

/**
 * Foto del estado de la exportacion. Es exactamente lo que viaja en
 * /api/health: usamos el tipo del contrato para que no se puedan desincronizar.
 */
export type ExportStatusSnapshot = ExportStatus;

export class ExportStatusTracker {
  /** Ultima carpeta sobre la que sabemos algo (probe o escritura). */
  private dir = "";
  private dirOk = true;
  private dirError: string | null = null;
  private lastWriteAt: Date | null = null;
  private lastWritePath: string | null = null;
  private lastErrorAt: Date | null = null;
  private lastError: string | null = null;
  private lastErrorSampleId: string | null = null;
  private consecutiveFailures = 0;
  private writtenSinceStart = 0;
  private failedSinceStart = 0;

  /**
   * Pasa a hablar de otra carpeta. Lo que sabiamos de la anterior (si aceptaba
   * escrituras, cuantas fallas seguidas lleva) no dice nada del destino nuevo:
   * arrastrarlo haria que la app siga en rojo despues de corregir la carpeta.
   */
  private switchDir(dir: string): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.dirOk = true;
    this.dirError = null;
    this.consecutiveFailures = 0;
  }

  /** Resultado de un chequeo de la carpeta (arranque o cambio de config). */
  recordProbe(dir: string, result: { ok: true } | { ok: false; error: string }): void {
    this.switchDir(dir);
    this.dirOk = result.ok;
    this.dirError = result.ok ? null : result.error;
    if (result.ok) {
      // La carpeta volvio: los fallos viejos ya no describen el estado actual.
      this.consecutiveFailures = 0;
    } else {
      this.lastError = result.error;
      this.lastErrorAt = new Date();
    }
  }

  recordSuccess(dir: string, path: string, now = new Date()): void {
    this.switchDir(dir);
    this.dirOk = true;
    this.dirError = null;
    this.lastWriteAt = now;
    this.lastWritePath = path;
    this.consecutiveFailures = 0;
    this.writtenSinceStart++;
  }

  recordFailure(dir: string, sampleId: string, error: string, now = new Date()): void {
    this.switchDir(dir);
    this.dirOk = false;
    this.dirError = error;
    this.lastErrorAt = now;
    this.lastError = error;
    this.lastErrorSampleId = sampleId;
    this.consecutiveFailures++;
    this.failedSinceStart++;
  }

  /**
   * Estado actual, contra la carpeta que dice la config en este momento.
   *
   * Si la carpeta cambio y todavia no se chequeo, no arrastramos el error de la
   * anterior: seria mentirle a la operadora que acaba de corregir el destino.
   */
  snapshot(currentDir: string): ExportStatusSnapshot {
    const enabled = currentDir.length > 0;
    const sameDir = currentDir === this.dir;
    const dirOk = sameDir ? this.dirOk : true;
    const dirError = sameDir ? this.dirError : null;
    const consecutiveFailures = sameDir ? this.consecutiveFailures : 0;

    return {
      enabled,
      dir: currentDir,
      dirOk,
      dirError,
      lastWriteAt: this.lastWriteAt?.toISOString() ?? null,
      lastWritePath: this.lastWritePath,
      lastErrorAt: sameDir ? (this.lastErrorAt?.toISOString() ?? null) : null,
      lastError: sameDir ? this.lastError : null,
      lastErrorSampleId: sameDir ? this.lastErrorSampleId : null,
      consecutiveFailures,
      writtenSinceStart: this.writtenSinceStart,
      failedSinceStart: this.failedSinceStart,
      healthy: !enabled || (dirOk && consecutiveFailures === 0),
    };
  }
}

/** Tracker que lee /api/health. Lo escribe el TxtExporter del servicio. */
export const exportStatus = new ExportStatusTracker();

/**
 * Chequea que la carpeta destino exista y acepte escrituras, SIN esperar a que
 * llegue una muestra. Crea la carpeta si falta (igual que la exportacion) y
 * escribe/borra un archivo de prueba: es la unica forma de detectar una unidad
 * de red montada pero de solo lectura, o un permiso mal puesto.
 *
 * Nunca lanza. Carpeta vacia = exportacion deshabilitada = ok.
 */
export function probeExportDir(dir: string): { ok: true } | { ok: false; error: string } {
  if (dir.length === 0) return { ok: true };
  const probePath = join(dir, `.xs20-prueba-escritura-${process.pid}.tmp`);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(probePath, "");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try {
      if (existsSync(probePath)) unlinkSync(probePath);
    } catch {
      // Si no se pudo borrar el archivo de prueba no es un fallo de exportacion.
    }
  }
}

/**
 * Chequea la carpeta, lo deja registrado en el tracker y lo loguea.
 *
 * Se llama al construir el exporter (o sea, al arrancar el servicio) y al
 * cambiar la carpeta desde la app: los dos momentos en los que se puede avisar
 * ANTES de perder el .txt de una muestra.
 */
export function probeAndRecord(
  dir: string,
  logger: Logger,
  tracker: ExportStatusTracker = exportStatus,
): { ok: true } | { ok: false; error: string } {
  const result = probeExportDir(dir);
  tracker.recordProbe(dir, result);
  if (dir.length === 0) {
    logger.info("export.dir_disabled", {
      detail:
        "La exportacion a .txt esta apagada (carpeta vacia en la configuracion).",
    });
  } else if (result.ok) {
    logger.info("export.dir_ok", { dir });
  } else {
    logger.error("export.dir_unavailable", {
      dir,
      error: result.error,
      detail:
        "No se puede escribir en la carpeta de exportacion: los .txt de las " +
        "muestras NO se van a generar. Revisar que la ruta exista, que la " +
        "unidad de red este conectada y que el usuario tenga permiso.",
    });
  }
  return result;
}
