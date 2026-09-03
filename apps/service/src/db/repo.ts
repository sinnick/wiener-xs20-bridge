/**
 * Repositorio de la base SQLite.
 *
 * Funciones tipadas para insertar y leer resultados de hemograma.
 * Toda escritura va dentro de una transaccion para garantizar atomicidad
 * (si algo falla a mitad, no queda un row "huerfano" en results sin sus values).
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  AbnormalFlag,
  HemogramParam,
  HemogramResult,
  HemogramValue,
  Histogram,
  ResultSummary,
  WipeDatabaseResponse,
} from "@xs20/shared";

/** Lo que devuelve XsRepo.wipeClinicalData — es el cuerpo de la respuesta HTTP. */
export type WipeDatabaseResult = WipeDatabaseResponse;

// ─── Tipos de los rows tal como viven en la DB ───────────────────────────────

interface RawMessageRow {
  id: string;
  received_at: string;
  message_control_id: string;
  message_type: string;
  sender_address: string | null;
  raw_hl7: string;
  byte_size: number;
  parse_status: "parsed" | "failed" | "partial";
  parse_error: string | null;
}

interface ResultRow {
  id: string;
  raw_message_id: string;
  patient_id: string | null;
  sample_id: string;
  take_mode: string | null;
  blood_mode: "W" | "P" | null;
  test_mode: string | null;
  ref_group: string | null;
  drawn_at: string | null;
  analyzed_at: string | null;
  operator: string | null;
  comments: string | null;
  received_at: string;
  abnormal_count: number;
  morphology_flag_count: number;
}

// ─── Repo ────────────────────────────────────────────────────────────────────

export interface InsertResultParams {
  hemogram: HemogramResult;
  rawHl7: string;
  senderAddress: string | null;
}

/**
 * Separador del sufijo que desambigua un message_control_id repetido.
 * No aparece en los MSH-10 del equipo (son numeros), asi que no puede formar
 * parte de un id legitimo. Ver XsRepo.storableControlId.
 */
const CONTROL_ID_SEPARATOR = "#";

/** Devuelve el MSH-10 tal como lo mando el equipo, sin el sufijo interno. */
export function originalControlId(stored: string): string {
  const i = stored.indexOf(CONTROL_ID_SEPARATOR);
  return i === -1 ? stored : stored.slice(0, i);
}

export class InsertResultDuplicateError extends Error {
  constructor(
    public readonly messageControlId: string,
    public readonly existingRawMessageId: string,
  ) {
    super(`Mensaje duplicado: messageControlId=${messageControlId} ya procesado`);
    this.name = "InsertResultDuplicateError";
  }
}

export class XsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Inserta un resultado completo en una transaccion.
   * Devuelve el id generado, o lanza InsertResultDuplicateError si ESTE MISMO
   * resultado (misma muestra, mismo instante de analisis) ya esta guardado.
   */
  insertResult(params: InsertResultParams): string {
    const { hemogram, rawHl7, senderAddress } = params;

    return this.db.transaction(() => {
      // ── 1. Idempotencia ─────────────────────────────────────────────────
      //
      // MSH-10 NO identifica un mensaje en este equipo: el XS 20 REINICIA el
      // contador en 1 cada vez que arranca. Deduplicar por ese campo hacia que
      // los primeros N resultados de cada jornada (N = cuantos habia mandado la
      // jornada anterior) se descartaran en silencio — sin fila en la base y
      // sin .txt para el laboratorio. Confirmado en los logs de campo: el 01/09
      // se perdieron los ids 1..25 y el primero que entro fue el 26; el 02/09 se
      // perdieron 1..35 y entro el 36. Desde afuera se ve como "tarda unos
      // minutos en empezar a andar".
      //
      // La identidad real de un resultado es la muestra + el instante en que se
      // analizo. Ese par es lo que deduplica ahora, sin importar con que MSH-10
      // venga: un reintento del equipo (no le llego nuestro ACK) y un reenvio
      // del historico ("enviar todo" desde el analizador) traen el mismo par y
      // no se duplican, pero una muestra nueva ya nunca se pierde.
      const analyzedAt = hemogram.sample.analyzedAt?.toISOString() ?? null;
      if (analyzedAt !== null) {
        const existing = this.db
          .prepare<{ raw_id: string }, [string, string]>(
            `SELECT rm.id AS raw_id
               FROM results r
               JOIN raw_messages rm ON rm.id = r.raw_message_id
              WHERE r.sample_id = ? AND r.analyzed_at = ?`,
          )
          .get(hemogram.sample.sampleId, analyzedAt);
        if (existing) {
          throw new InsertResultDuplicateError(hemogram.messageControlId, existing.raw_id);
        }
      }
      // Si el mensaje no trae instante de analisis no hay con que identificarlo,
      // asi que insertamos igual: una fila repetida se borra despues, un
      // hemograma perdido no se recupera.

      // 2. Insertar raw_messages
      const rawMessageId = `raw_${hemogram.id}`;
      this.db
        .prepare(
          `INSERT INTO raw_messages
            (id, received_at, message_control_id, message_type, sender_address,
             raw_hl7, byte_size, parse_status, parse_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'parsed', NULL)`,
        )
        .run(
          rawMessageId,
          hemogram.receivedAt.toISOString(),
          this.storableControlId(hemogram.messageControlId, hemogram.id),
          "ORU^R01",
          senderAddress,
          rawHl7,
          new TextEncoder().encode(rawHl7).length,
        );

      // 3. Upsert paciente (deduplicado por external_id)
      let patientPk: string | null = null;
      if (hemogram.patient.patientId) {
        patientPk = this.upsertPatient(hemogram, rawMessageId);
      }

      // 4. Calcular contadores
      const abnormalCount = Object.values(hemogram.values).filter((v) =>
        v.flags.some((f) => f !== "N"),
      ).length;
      const morphFlagCount = hemogram.morphologyFlags.length;

      // 5. Insertar results
      this.db
        .prepare(
          `INSERT INTO results
            (id, raw_message_id, patient_id, sample_id, take_mode, blood_mode,
             test_mode, ref_group, drawn_at, analyzed_at, operator, comments,
             received_at, abnormal_count, morphology_flag_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hemogram.id,
          rawMessageId,
          patientPk,
          hemogram.sample.sampleId,
          hemogram.sample.takeMode,
          hemogram.sample.bloodMode,
          hemogram.sample.testMode,
          hemogram.sample.refGroup,
          hemogram.sample.drawnAt?.toISOString() ?? null,
          hemogram.sample.analyzedAt?.toISOString() ?? null,
          hemogram.sample.operator,
          hemogram.sample.comments,
          hemogram.receivedAt.toISOString(),
          abnormalCount,
          morphFlagCount,
        );

      // 6. Insertar result_values
      const insertValue = this.db.prepare(
        `INSERT INTO result_values
          (result_id, param, value, unit, ref_range, flags)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const [param, val] of Object.entries(hemogram.values) as [
        HemogramParam,
        HemogramValue,
      ][]) {
        insertValue.run(
          hemogram.id,
          param,
          val.value,
          val.unit,
          val.refRange,
          JSON.stringify(val.flags),
        );
      }

      // 7. Insertar histogramas
      const insertHist = this.db.prepare(
        `INSERT INTO histograms
          (result_id, type, channels, left_line, mid_line, right_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const h of hemogram.histograms) {
        insertHist.run(
          hemogram.id,
          h.type,
          h.channels,
          h.discriminators.leftLine ?? null,
          h.discriminators.midLine ?? null,
          h.discriminators.rightLine ?? null,
        );
      }

      // 8. Insertar morphology_flags
      const insertFlag = this.db.prepare(
        `INSERT OR IGNORE INTO morphology_flags (result_id, code) VALUES (?, ?)`,
      );
      for (const f of hemogram.morphologyFlags) {
        insertFlag.run(hemogram.id, f.code);
      }

      return hemogram.id;
    })();
  }

  /**
   * Valor a guardar en `raw_messages.message_control_id`.
   *
   * El schema v1 tiene `UNIQUE(message_control_id)` y esta CONGELADO (ver el
   * encabezado de migrate.ts: sacarlo obliga a reconstruir una tabla con hijos
   * apuntandole, en la base de un laboratorio que se actualiza sola). Como el
   * contador del equipo se repite todos los dias, cuando el valor ya esta
   * tomado le colgamos un sufijo unico para no chocar contra el UNIQUE.
   *
   * El MSH-10 original queda intacto dentro de `raw_hl7`, la lectura lo
   * devuelve limpio (ver originalControlId) y el ACK usa el valor en memoria:
   * el equipo nunca ve la diferencia.
   */
  private storableControlId(controlId: string, uniqueSuffix: string): string {
    const taken = this.db
      .prepare<{ id: string }, [string]>(
        "SELECT id FROM raw_messages WHERE message_control_id = ?",
      )
      .get(controlId);
    return taken ? `${controlId}${CONTROL_ID_SEPARATOR}${uniqueSuffix}` : controlId;
  }

  private upsertPatient(hemogram: HemogramResult, _rawMsgId: string): string {
    const externalId = hemogram.patient.patientId!;
    const now = hemogram.receivedAt.toISOString();
    const pk = `pat_${externalId}`;

    const row = this.db
      .prepare<{ id: string }, [string]>(
        "SELECT id FROM patients WHERE external_id = ?",
      )
      .get(externalId);

    if (row) {
      this.db
        .prepare("UPDATE patients SET last_seen_at = ?, name = COALESCE(?, name) WHERE id = ?")
        .run(now, hemogram.patient.name, row.id);
      return row.id;
    }

    this.db
      .prepare(
        `INSERT INTO patients
          (id, external_id, name, birth_date, sex, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pk,
        externalId,
        hemogram.patient.name,
        hemogram.patient.birthDate,
        hemogram.patient.sex,
        now,
        now,
      );
    return pk;
  }

  /**
   * Inserta un raw_message marcado como failed. Sirve para auditoria cuando
   * el parser explota: queremos guardar el HL7 original aunque no podamos
   * estructurarlo.
   */
  insertFailedRaw(params: {
    rawMessageId: string;
    rawHl7: string;
    receivedAt: Date;
    messageControlId: string;
    senderAddress: string | null;
    error: string;
  }): void {
    // El OR IGNORE es la red de seguridad para el id de fila; el
    // message_control_id se desambigua antes porque el contador del equipo se
    // repite (ver storableControlId). Sin eso, el UNIQUE hacia que el mensaje
    // fallido no se guardara y el OR IGNORE se comia el aviso: justo el caso
    // en que mas falta hace tener el crudo para entender que llego.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO raw_messages
          (id, received_at, message_control_id, message_type, sender_address,
           raw_hl7, byte_size, parse_status, parse_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?)`,
      )
      .run(
        params.rawMessageId,
        params.receivedAt.toISOString(),
        this.storableControlId(params.messageControlId, params.rawMessageId),
        "UNKNOWN",
        params.senderAddress,
        params.rawHl7,
        new TextEncoder().encode(params.rawHl7).length,
        params.error,
      );
  }

  // ─── Lecturas para la HTTP API ─────────────────────────────────────────────

  listResults(params: {
    limit?: number;
    fromDate?: string;
    toDate?: string;
    search?: string;
  }): ResultSummary[] {
    const limit = Math.min(params.limit ?? 50, 500);
    const conditions: string[] = [];
    const args: SQLQueryBindings[] = [];

    if (params.fromDate) {
      conditions.push("r.received_at >= ?");
      args.push(params.fromDate);
    }
    if (params.toDate) {
      conditions.push("r.received_at <= ?");
      args.push(params.toDate);
    }
    if (params.search) {
      conditions.push(
        "(r.sample_id LIKE ? OR p.external_id LIKE ? OR p.name LIKE ?)",
      );
      const like = `%${params.search}%`;
      args.push(like, like, like);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        r.id, r.received_at, r.sample_id, p.external_id AS patient_id, p.name,
        r.abnormal_count, r.morphology_flag_count
      FROM results r
      LEFT JOIN patients p ON p.id = r.patient_id
      ${where}
      ORDER BY r.received_at DESC
      LIMIT ?
    `;
    args.push(limit);

    const rows = this.db
      .prepare<
        {
          id: string;
          received_at: string;
          sample_id: string;
          patient_id: string | null;
          name: string | null;
          abnormal_count: number;
          morphology_flag_count: number;
        },
        SQLQueryBindings[]
      >(sql)
      .all(...(args as SQLQueryBindings[]));

    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      sampleId: row.sample_id,
      patientName: row.name,
      patientId: row.patient_id,
      abnormalCount: row.abnormal_count,
      morphologyFlagCount: row.morphology_flag_count,
    }));
  }

  getResult(id: string): HemogramResult | null {
    const row = this.db
      .prepare<ResultRow & { external_id: string | null; patient_name: string | null;
        birth_date: string | null; sex: string | null }, [string]>(
        `SELECT r.*, p.external_id, p.name AS patient_name, p.birth_date, p.sex
         FROM results r
         LEFT JOIN patients p ON p.id = r.patient_id
         WHERE r.id = ?`,
      )
      .get(id);
    if (!row) return null;

    const valueRows = this.db
      .prepare<
        { param: string; value: number; unit: string; ref_range: string | null; flags: string | null },
        [string]
      >(
        `SELECT param, value, unit, ref_range, flags FROM result_values WHERE result_id = ?`,
      )
      .all(id);

    const histRows = this.db
      .prepare<
        {
          type: Histogram["type"];
          channels: Uint8Array;
          left_line: number | null;
          mid_line: number | null;
          right_line: number | null;
        },
        [string]
      >(
        `SELECT type, channels, left_line, mid_line, right_line FROM histograms WHERE result_id = ?`,
      )
      .all(id);

    const flagRows = this.db
      .prepare<{ code: string }, [string]>(
        `SELECT code FROM morphology_flags WHERE result_id = ?`,
      )
      .all(id);

    const rawRow = this.db
      .prepare<{ message_control_id: string }, [string]>(
        `SELECT message_control_id FROM raw_messages WHERE id = ?`,
      )
      .get(row.raw_message_id);

    const values: Partial<Record<HemogramParam, HemogramValue>> = {};
    for (const v of valueRows) {
      values[v.param as HemogramParam] = {
        value: v.value,
        unit: v.unit,
        refRange: v.ref_range,
        flags: v.flags ? (JSON.parse(v.flags) as AbnormalFlag[]) : [],
      };
    }

    return {
      id: row.id,
      receivedAt: new Date(row.received_at),
      messageControlId: originalControlId(rawRow?.message_control_id ?? ""),
      patient: {
        patientId: row.external_id,
        name: row.patient_name,
        birthDate: row.birth_date,
        sex: (row.sex as "M" | "F" | "U" | null) ?? null,
        ageYears: null,
      },
      sample: {
        sampleId: row.sample_id,
        takeMode: row.take_mode,
        bloodMode: row.blood_mode,
        testMode: row.test_mode,
        drawnAt: row.drawn_at ? new Date(row.drawn_at) : null,
        analyzedAt: row.analyzed_at ? new Date(row.analyzed_at) : null,
        operator: row.operator,
        refGroup: row.ref_group,
        comments: row.comments,
      },
      values,
      histograms: histRows.map((h) => ({
        type: h.type,
        channels: new Uint8Array(h.channels),
        discriminators: {
          ...(h.left_line !== null ? { leftLine: h.left_line } : {}),
          ...(h.mid_line !== null ? { midLine: h.mid_line } : {}),
          ...(h.right_line !== null ? { rightLine: h.right_line } : {}),
        },
      })),
      morphologyFlags: flagRows.map((f) => ({ code: f.code, raised: true })),
    };
  }

  getResultRawHl7(resultId: string): string | null {
    const row = this.db
      .prepare<{ raw_hl7: string }, [string]>(
        `SELECT rm.raw_hl7
         FROM results r JOIN raw_messages rm ON rm.id = r.raw_message_id
         WHERE r.id = ?`,
      )
      .get(resultId);
    return row?.raw_hl7 ?? null;
  }

  countResults(): number {
    const row = this.db
      .prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM results")
      .get();
    return row?.c ?? 0;
  }

  /**
   * Comprueba que la DB acepte escrituras, sin modificar datos.
   *
   * Existe por un fallo real en produccion: si el .sqlite (o sus sidecar -wal /
   * -shm) quedan con un dueño distinto al del proceso — pasa si el servicio
   * corrio una vez elevado y despues normal — SQLite falla cada INSERT con
   * "attempt to write a readonly database". El servicio arrancaba igual,
   * mostraba "0 resultados" y respondia AE a cada mensaje del analizador, sin
   * ninguna señal evidente de la causa.
   *
   * `BEGIN IMMEDIATE` pide el lock de escritura sin escribir nada: si la DB es
   * de solo lectura, tira ahi mismo. El ROLLBACK deja todo como estaba.
   */
  probeWritable(): { ok: true } | { ok: false; error: string } {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore: lo importante era conseguir el lock
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ─── Retencion / purga ─────────────────────────────────────────────────────

  /**
   * Borra el HL7 crudo de mensajes mas viejos que `retentionDays`, PERO
   * conserva los resultados estructurados (la tabla results y sus values).
   *
   * El raw HL7 solo se necesita para auditoria/reproceso; es lo mas pesado
   * (~3 KB por mensaje). Los resultados parseados quedan intactos, asi que la
   * app sigue mostrando el historico completo — solo se pierde la posibilidad
   * de reprocesar mensajes muy viejos desde cero.
   *
   * retentionDays = 0 desactiva la purga (nunca borra nada).
   * Devuelve la cantidad de raw_messages afectados.
   */
  purgeOldRawMessages(retentionDays: number, now = new Date()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString();

    // Vaciamos el payload pesado pero dejamos la fila (para no romper el FK con
    // results y conservar el rastro de que existio ese mensaje).
    const res = this.db
      .prepare(
        `UPDATE raw_messages
           SET raw_hl7 = '', parse_error = COALESCE(parse_error, 'purged')
         WHERE received_at < ? AND raw_hl7 <> ''`,
      )
      .run(cutoffIso);
    return res.changes;
  }

  /** Tamano actual del archivo de DB en bytes (via PRAGMA). 0 si es :memory:. */
  databaseSizeBytes(): number {
    const row = this.db
      .prepare<{ size: number }, []>(
        "SELECT (page_count * page_size) AS size FROM pragma_page_count(), pragma_page_size()",
      )
      .get();
    return row?.size ?? 0;
  }

  // ─── Audit log ─────────────────────────────────────────────────────────────

  appendAudit(params: {
    occurredAt: Date;
    level: "info" | "warn" | "error";
    eventType: string;
    message: string;
    context?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (occurred_at, level, event_type, message, context)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.occurredAt.toISOString(),
        params.level,
        params.eventType,
        params.message,
        params.context ? JSON.stringify(params.context) : null,
      );
  }

  // ─── Borrado total ─────────────────────────────────────────────────────────

  /**
   * Borra TODOS los datos clinicos para que el analizador pueda mandarlos de
   * nuevo desde cero con su funcion "enviar todo".
   *
   * Por que hace falta: la deduplicacion es por muestra + instante de analisis
   * (ver insertResult), asi que un reenvio del historico NO vuelve a escribir lo
   * que ya esta guardado. Sin vaciar la base no hay forma de reimportar, y esa
   * es justamente la manera de recuperar los hemogramas que se perdieron cuando
   * deduplicabamos por MSH-10.
   *
   * Borra filas, NO el schema: nada de DROP TABLE + reaplicar schema.sql, que
   * dejaria `PRAGMA user_version` mintiendo y rompe el contrato de migrate.ts.
   *
   * Lo unico que sobrevive es `service_config` (la configuracion del servicio) y
   * `audit_log` (el rastro historico, incluida la anotacion de este borrado).
   */
  wipeClinicalData(now = new Date()): WipeDatabaseResult {
    const startedAt = performance.now();
    const sizeBefore = this.databaseSizeBytes();

    const counts = this.db.transaction(() => {
      // Contamos ANTES de borrar, con COUNT(*) y no con el `changes` del DELETE:
      // un DELETE sin WHERE puede tomar el camino de truncate de SQLite, donde
      // el valor de changes() es ambiguo segun la version. El numero que ve la
      // operadora tiene que ser exacto.
      const count = (table: string): number =>
        (
          this.db.prepare<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get() ?? {
            n: 0,
          }
        ).n;

      const deleted = {
        results: count("results"),
        rawMessages: count("raw_messages"),
        patients: count("patients"),
        resultValues: count("result_values"),
        histograms: count("histograms"),
        morphologyFlags: count("morphology_flags"),
      };

      // Hijo → padre, explicito. NO simplificar a un solo DELETE confiando en el
      // ON DELETE CASCADE, por dos razones independientes:
      //   1. `patients` no cascadea nunca — el FK es results.patient_id con
      //      ON DELETE SET NULL, y ademas apunta al reves.
      //   2. `PRAGMA foreign_keys` es POR CONEXION. Hoy queda encendido solo
      //      porque openDb ejecuta schema.sql en cada apertura; con
      //      `initialize: false` los cascades no corren y quedarian huerfanos.
      this.db.exec(`DELETE FROM result_values`);
      this.db.exec(`DELETE FROM histograms`);
      this.db.exec(`DELETE FROM morphology_flags`);
      this.db.exec(`DELETE FROM results`);
      this.db.exec(`DELETE FROM raw_messages`);
      this.db.exec(`DELETE FROM patients`);

      // La auditoria va DENTRO de la transaccion: si el borrado se revierte, el
      // rastro se revierte con el. Una linea que diga "borre 1.284 resultados"
      // cuando siguen ahi es peor que no tener ninguna.
      this.appendAudit({
        occurredAt: now,
        level: "warn",
        eventType: "db.wiped",
        message: "Se borro toda la base de resultados desde la app",
        context: { ...deleted, sizeBefore },
      });

      return deleted;
    })();

    // VACUUM no puede correr dentro de una transaccion, asi que va recien aca.
    //
    // Importa por lo que ve la operadora, no por prolijidad: databaseSizeBytes()
    // es page_count * page_size, y sin compactar la card de Estado seguiria
    // diciendo "30 MB" con cero resultados. El wal_checkpoint(TRUNCATE) es su
    // complemento — el archivo -wal no entra en page_count, asi que sin truncarlo
    // el disco sigue ocupado aunque la card muestre 32 KB.
    //
    // El catch que se traga el error es deliberado: a esta altura los datos YA
    // estan borrados y commiteados. Un VACUUM que falla (tipicamente por falta de
    // espacio: necesita un temporal del tamano de la base) no puede convertir una
    // operacion exitosa en un error.
    let vacuumed = true;
    try {
      this.db.exec("VACUUM");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      vacuumed = false;
    }

    return {
      deletedResults: counts.results,
      deletedRawMessages: counts.rawMessages,
      deletedPatients: counts.patients,
      sizeBefore,
      sizeAfter: this.databaseSizeBytes(),
      vacuumed,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}
