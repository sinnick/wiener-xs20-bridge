/**
 * Exportacion de cada resultado a un .txt plano por muestra.
 *
 * Es el formato que pide el laboratorio (ver nota original en el repo): un
 * archivo `<idMuestra>.txt` con lineas `TITULO: valor`, sin unidades ni rangos.
 * El destino lo consume una persona (o un Excel), no un parser: por eso los
 * titulos van en castellano, el separador es `: ` y los fines de linea son CRLF
 * (la PC del laboratorio es Windows).
 *
 * La nota pide exactamente estos 17 parametros, en este orden. El equipo manda
 * ademas LINFOCITOS% (lym_pct) y HCM (mch), que la nota omite — si el
 * laboratorio los quiere, es agregar una linea a EXPORT_LINES.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HemogramParam, HemogramResult, HemogramValue } from "@xs20/shared";

import type { Logger } from "../logger.js";

interface ExportLine {
  title: string;
  param: HemogramParam;
  /** Decimales con los que el laboratorio escribe este valor. */
  decimals: number;
}

/** Lineas del archivo, en el orden exacto de la nota del laboratorio. */
export const EXPORT_LINES: readonly ExportLine[] = [
  { title: "LEUCOCITOS", param: "wbc", decimals: 1 },
  { title: "LINFOCITOS#", param: "lym_abs", decimals: 1 },
  { title: "MEDIOS#", param: "mid_abs", decimals: 1 },
  { title: "MEDIOS%", param: "mid_pct", decimals: 1 },
  { title: "GRANULOCITOS#", param: "gran_abs", decimals: 1 },
  { title: "GRANULOCITOS%", param: "gran_pct", decimals: 1 },
  { title: "ERITROCITOS", param: "rbc", decimals: 2 },
  { title: "HEMOGLOBINA", param: "hgb", decimals: 1 },
  { title: "HEMATOCRITO", param: "hct", decimals: 1 },
  { title: "VCM", param: "mcv", decimals: 1 },
  { title: "CHCM", param: "mchc", decimals: 1 },
  { title: "RDW-CV", param: "rdw_cv", decimals: 1 },
  { title: "RDW-SD", param: "rdw_sd", decimals: 1 },
  { title: "PLAQUETAS", param: "plt", decimals: 0 },
  { title: "VPM", param: "mpv", decimals: 1 },
  { title: "PDW", param: "pdw", decimals: 1 },
  { title: "PLAQUETOCRITO", param: "pct", decimals: 3 },
];

/**
 * El laboratorio escribe hemoglobina y CHCM en g/dL, pero el equipo puede
 * estar configurado en g/L. Convertimos segun la unidad que declara el OBX-6,
 * asi el archivo queda bien sin importar como este configurado el XS 20.
 */
function toReportValue(param: HemogramParam, v: HemogramValue): number {
  if ((param === "hgb" || param === "mchc") && v.unit === "g/L") {
    return v.value / 10;
  }
  return v.value;
}

/** Arma el contenido del .txt. Los parametros que no vinieron se omiten. */
export function formatHemogramTxt(hemogram: HemogramResult): string {
  const lines: string[] = [];
  for (const line of EXPORT_LINES) {
    const v = hemogram.values[line.param];
    if (!v) continue;
    lines.push(`${line.title}: ${toReportValue(line.param, v).toFixed(line.decimals)}`);
  }
  return lines.join("\r\n") + "\r\n";
}

/** Nombre de archivo seguro a partir del id de muestra (OBR-3). */
export function exportFileName(sampleId: string): string {
  const safe = sampleId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe || "sin_id"}.txt`;
}

export interface TxtExporterOptions {
  /** Se lee en cada export para que el cambio de carpeta aplique en caliente. */
  getDir: () => string;
  logger: Logger;
}

export class TxtExporter {
  constructor(private opts: TxtExporterOptions) {}

  /**
   * Escribe el .txt de un resultado. Nunca lanza: un disco lleno o una carpeta
   * sin permisos no puede voltear el procesamiento del mensaje ni el ACK.
   * Si la misma muestra se vuelve a correr, el archivo se pisa con lo ultimo.
   */
  export(hemogram: HemogramResult): void {
    const dir = this.opts.getDir();
    if (dir.length === 0) return; // exportacion deshabilitada

    const path = join(dir, exportFileName(hemogram.sample.sampleId));
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, formatHemogramTxt(hemogram));
      this.opts.logger.info("export.txt_written", {
        path,
        sampleId: hemogram.sample.sampleId,
      });
    } catch (e) {
      this.opts.logger.error("export.txt_failed", {
        path,
        sampleId: hemogram.sample.sampleId,
        error: (e as Error).message,
      });
    }
  }
}
