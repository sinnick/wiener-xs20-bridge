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
} from "@xs20/shared";

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
   * Devuelve el id generado, o lanza InsertResultDuplicateError si el
   * messageControlId ya existe.
   */
  insertResult(params: InsertResultParams): string {
    const { hemogram, rawHl7, senderAddress } = params;

    return this.db.transaction(() => {
      // 1. Verificar idempotencia
      const existing = this.db
        .prepare<{ id: string }, [string]>(
          "SELECT id FROM raw_messages WHERE message_control_id = ?",
        )
        .get(hemogram.messageControlId);
      if (existing) {
        throw new InsertResultDuplicateError(hemogram.messageControlId, existing.id);
      }

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
          hemogram.messageControlId,
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
        params.messageControlId,
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
      messageControlId: rawRow?.message_control_id ?? "",
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
}
