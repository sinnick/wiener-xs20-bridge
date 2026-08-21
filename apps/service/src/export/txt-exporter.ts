/**
 * Exportacion de cada resultado a un .txt plano por muestra.
 *
 * Es EL producto del bridge: el archivo que la operadora abre en la carpeta del
 * laboratorio. Todo lo demas (TCP, HL7, base, UI) existe para que este archivo
 * aparezca bien escrito. Formato pedido en la nota original del laboratorio: un
 * archivo `<idMuestra>.txt` con lineas `TITULO: valor`, sin unidades ni rangos.
 * Lo consume una persona (o un Excel), no un parser: por eso los titulos van en
 * castellano, el separador es `: ` y los fines de linea son CRLF (la PC del
 * laboratorio es Windows).
 *
 * Tres reglas que no se negocian:
 *  1. Siempre las MISMAS lineas, en el MISMO orden. Un parametro que el equipo
 *     no mando sale igual, con el valor vacio (`VCM: `), asi todos los archivos
 *     tienen la misma forma y la misma cantidad de lineas.
 *  2. Los decimales son los de la nota (LEUCOCITOS 1, ERITROCITOS 2,
 *     PLAQUETAS 0, PLAQUETOCRITO 3).
 *  3. Si no se puede escribir, se registra y se ve en /api/health. Un fallo
 *     silencioso es peor que no exportar.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { HEMOGRAM_PARAMS } from "@xs20/shared";
import type { HemogramParam, HemogramResult, HemogramValue } from "@xs20/shared";

import { exportStatus, probeAndRecord } from "./export-status.js";
import type { ExportStatusTracker } from "./export-status.js";
import type { Logger } from "../logger.js";

interface ExportFormat {
  /** Titulo tal cual sale en el archivo. */
  title: string;
  /** Decimales con los que el laboratorio escribe este valor. */
  decimals: number;
}

/**
 * Titulo y decimales de CADA parametro del contrato.
 *
 * Es un Record sobre HemogramParam a proposito: si mañana se agrega un
 * parametro a HEMOGRAM_PARAMS, esto no compila hasta que alguien le elija
 * titulo y decimales. Un parametro nuevo no puede quedar afuera del .txt por
 * olvido.
 */
export const EXPORT_FORMAT: Record<HemogramParam, ExportFormat> = {
  wbc: { title: "LEUCOCITOS", decimals: 1 },
  lym_abs: { title: "LINFOCITOS#", decimals: 1 },
  lym_pct: { title: "LINFOCITOS%", decimals: 1 },
  mid_abs: { title: "MEDIOS#", decimals: 1 },
  mid_pct: { title: "MEDIOS%", decimals: 1 },
  gran_abs: { title: "GRANULOCITOS#", decimals: 1 },
  gran_pct: { title: "GRANULOCITOS%", decimals: 1 },
  rbc: { title: "ERITROCITOS", decimals: 2 },
  hgb: { title: "HEMOGLOBINA", decimals: 1 },
  hct: { title: "HEMATOCRITO", decimals: 1 },
  mcv: { title: "VCM", decimals: 1 },
  mchc: { title: "CHCM", decimals: 1 },
  rdw_cv: { title: "RDW-CV", decimals: 1 },
  rdw_sd: { title: "RDW-SD", decimals: 1 },
  plt: { title: "PLAQUETAS", decimals: 0 },
  mpv: { title: "VPM", decimals: 1 },
  pdw: { title: "PDW", decimals: 1 },
  pct: { title: "PLAQUETOCRITO", decimals: 3 },
  mch: { title: "HCM", decimals: 1 },
};

/**
 * Orden exacto de las lineas del archivo.
 *
 * Los 17 primeros son los de la nota del laboratorio, en su orden. LINFOCITOS%
 * se intercala al lado de LINFOCITOS# (queda junto a MEDIOS% y GRANULOCITOS%) y
 * HCM va al final, que es donde se agregan los parametros que la nota no pedia.
 */
export const EXPORT_ORDER: readonly HemogramParam[] = [
  "wbc",
  "lym_abs",
  "lym_pct",
  "mid_abs",
  "mid_pct",
  "gran_abs",
  "gran_pct",
  "rbc",
  "hgb",
  "hct",
  "mcv",
  "mchc",
  "rdw_cv",
  "rdw_sd",
  "plt",
  "mpv",
  "pdw",
  "pct",
  "mch",
];

/** Lineas del archivo ya resueltas (titulo + parametro + decimales). */
export const EXPORT_LINES: readonly (ExportFormat & { param: HemogramParam })[] =
  EXPORT_ORDER.map((param) => ({ param, ...EXPORT_FORMAT[param] }));

/** Parametros del contrato que quedaron fuera del orden (deberia ser vacio). */
export function missingFromExportOrder(): HemogramParam[] {
  return HEMOGRAM_PARAMS.filter((p) => !EXPORT_ORDER.includes(p));
}

/**
 * El laboratorio escribe hemoglobina y CHCM en g/dL, pero el equipo puede estar
 * configurado en g/L (mismo numero x10). Convertimos segun la unidad que declara
 * el OBX-6, asi el archivo queda bien sin importar como este configurado el
 * XS 20: un 8.9 y un 89 son la diferencia entre una anemia severa y un valor
 * normal.
 */
export function toReportValue(param: HemogramParam, v: HemogramValue): number {
  if (isGramUnitParam(param) && normalizeUnit(v.unit) === "g/l") {
    return v.value / 10;
  }
  return v.value;
}

function isGramUnitParam(param: HemogramParam): boolean {
  return param === "hgb" || param === "mchc";
}

/** Unidad comparable: sin espacios y en minusculas ("G/L ", " g/dL" → "g/l"). */
function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

/**
 * Parametros cuya unidad no sabemos convertir a la que espera el laboratorio.
 *
 * Solo miramos HEMOGLOBINA y CHCM: son los unicos con conversion, y si el equipo
 * se reconfigura a mmol/L el numero que escribiriamos esta clinicamente mal.
 * No inventamos la conversion (el factor depende del parametro), pero avisamos
 * fuerte en el log para que se note antes de que alguien lea el archivo.
 */
export function unexpectedUnits(
  hemogram: HemogramResult,
): { param: HemogramParam; unit: string }[] {
  const out: { param: HemogramParam; unit: string }[] = [];
  for (const param of EXPORT_ORDER) {
    if (!isGramUnitParam(param)) continue;
    const v = hemogram.values[param];
    if (!v) continue;
    const u = normalizeUnit(v.unit);
    // Vacio = el equipo no declaro unidad; asumimos la que ya venia usando.
    if (u === "" || u === "g/dl" || u === "g/l") continue;
    out.push({ param, unit: v.unit });
  }
  return out;
}

/** El valor tal cual sale en el archivo. Vacio si no vino o no es un numero. */
export function formatValue(param: HemogramParam, v: HemogramValue | undefined): string {
  if (!v) return "";
  const n = toReportValue(param, v);
  // Un NaN/Infinity escrito como "NaN" en un resultado clinico es peor que un
  // hueco: el hueco se ve, el "NaN" se lee como si fuera un dato.
  if (!Number.isFinite(n)) return "";
  return n.toFixed(EXPORT_FORMAT[param].decimals);
}

/**
 * Arma el contenido del .txt.
 *
 * SIEMPRE escribe todas las lineas de EXPORT_ORDER, en ese orden. Si el equipo
 * no mando un parametro, la linea sale igual con el valor vacio (`VCM: `): asi
 * dos muestras distintas producen archivos con la misma cantidad de lineas y en
 * las mismas posiciones, que es lo que necesita quien los lee o los importa.
 */
export function formatHemogramTxt(hemogram: HemogramResult): string {
  let out = "";
  for (const param of EXPORT_ORDER) {
    out += `${EXPORT_FORMAT[param].title}: ${formatValue(param, hemogram.values[param])}\r\n`;
  }
  return out;
}

/** Nombres de dispositivo de Windows: un archivo asi no se puede crear. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Nombre de archivo seguro a partir del id de muestra (OBR-3).
 *
 * El id normalmente es un numero ("000015" → `000015.txt`), pero puede venir con
 * cualquier cosa adentro (el equipo permite escribirlo a mano, y HL7 escapa
 * caracteres como `\T\`). Todo lo que no sea seguro para un nombre de archivo
 * de Windows se reemplaza por `_`.
 */
export function exportFileName(sampleId: string): string {
  let safe = sampleId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  // Windows recorta puntos y espacios finales: "15." se abriria como "15".
  safe = safe.replace(/[. ]+$/, "");
  // "." o ".." no son un nombre, son la carpeta actual y la de arriba.
  if (/^\.+$/.test(safe)) safe = "";
  if (safe.length > 64) safe = safe.slice(0, 64);
  if (safe.length === 0) return "sin_id.txt";
  // CON.txt, NUL.txt, COM1.txt: Windows los rechaza. Los desarmamos con "_".
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return `${safe}.txt`;
}

let tmpCounter = 0;

/**
 * Escribe el archivo completo o no lo escribe: temporal + rename atomico.
 *
 * Un `writeFileSync` directo sobre el destino puede dejar el .txt a medias si se
 * corta la luz (la PC del laboratorio no tiene UPS) o si la unidad de red se cae
 * a mitad de la escritura, y quien lo abre despues no tiene como darse cuenta:
 * ve un hemograma con menos lineas. Con el temporal, el destino solo cambia
 * cuando el contenido ya esta entero y bajado a disco (fsync), y el rename es
 * atomico dentro de la misma carpeta (en Windows tambien pisa el existente).
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  const bytes = Buffer.from(content, "utf-8");
  try {
    const fd = openSync(tmp, "w");
    try {
      // Loop explicito: una escritura corta (disco al limite) no puede pasar
      // por completa, o el rename publicaria un archivo truncado.
      let written = 0;
      while (written < bytes.length) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error("La escritura no avanzo (disco lleno?)");
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Si tampoco se puede borrar el temporal, el error importante es el de arriba.
    }
    throw e;
  }
}

export interface TxtExporterOptions {
  /** Se lee en cada export para que el cambio de carpeta aplique en caliente. */
  getDir: () => string;
  logger: Logger;
  /** Registro compartido de estado; default el que publica /api/health. */
  status?: ExportStatusTracker;
  /**
   * Chequear la carpeta al construir el exporter (o sea, al arrancar el
   * servicio). Se puede apagar en tests para no tocar disco.
   */
  probeOnStart?: boolean;
}

/** Que paso con un .txt. `export()` nunca lanza: devuelve esto. */
export type ExportOutcome =
  /** La exportacion esta deshabilitada (carpeta vacia): no habia nada que hacer. */
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; path: string }
  | { ok: false; path: string; error: string };

export class TxtExporter {
  private readonly status: ExportStatusTracker;

  constructor(private opts: TxtExporterOptions) {
    this.status = opts.status ?? exportStatus;
    // El chequeo al arrancar es lo que hace que un destino roto se vea ANTES de
    // perder el .txt de la primera muestra del dia.
    if (opts.probeOnStart !== false) {
      probeAndRecord(opts.getDir(), opts.logger, this.status);
    }
  }

  /**
   * Escribe el .txt de un resultado. Nunca lanza: un disco lleno o una carpeta
   * sin permisos no puede voltear el procesamiento del mensaje ni el ACK.
   * Si la misma muestra se vuelve a correr, el archivo se pisa con lo ultimo
   * (es lo que corresponde: el resultado nuevo reemplaza al viejo, y el
   * historico completo queda igual en la base).
   */
  export(hemogram: HemogramResult): ExportOutcome {
    const dir = this.opts.getDir();
    const sampleId = hemogram.sample.sampleId;
    if (dir.length === 0) return { ok: true, skipped: true }; // exportacion deshabilitada

    for (const u of unexpectedUnits(hemogram)) {
      this.opts.logger.warn("export.unexpected_unit", {
        sampleId,
        param: u.param,
        unit: u.unit,
        detail:
          "El equipo mando este parametro en una unidad que no sabemos pasar a " +
          "g/dL; el .txt lleva el numero tal cual vino. Revisar la configuracion " +
          "de unidades del XS 20.",
      });
    }

    const path = join(dir, exportFileName(sampleId));
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileAtomic(path, formatHemogramTxt(hemogram));
      this.status.recordSuccess(dir, path);
      this.opts.logger.info("export.txt_written", { path, sampleId });
      return { ok: true, skipped: false, path };
    } catch (e) {
      const error = (e as Error).message;
      this.status.recordFailure(dir, sampleId, error);
      this.opts.logger.error("export.txt_failed", {
        path,
        sampleId,
        error,
        detail:
          "No se pudo escribir el .txt de esta muestra. El resultado SI quedo " +
          "guardado en la base: cuando se arregle la carpeta se puede regenerar " +
          "desde Estado → Exportación de .txt.",
      });
      return { ok: false, path, error };
    }
  }
}
