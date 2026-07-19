/**
 * Builder de mensajes ACK^R01 segun HL7 v2.3.1.
 *
 * Estructura minima:
 *   MSH|^~\&|||||<TIMESTAMP>||ACK^R01|<NEW_ID>|P|2.3.1||||||UNICODE
 *   MSA|<STATUS>|<ORIGINAL_MSH_10>[|<TEXT>]
 *
 * Status:
 *   AA = Application Accept (todo OK)
 *   AE = Application Error (algo fallo, pero el ACK llega)
 *   AR = Application Reject (rechazo el mensaje)
 */

export type AckStatus = "AA" | "AE" | "AR";

export interface BuildAckOptions {
  originalMessageControlId: string;
  status: AckStatus;
  /** Texto opcional del error (para AE/AR). */
  errorText?: string;
  /** Override del timestamp (para tests). */
  now?: Date;
  /** Override del control id del propio ACK (para tests). */
  ackControlId?: string;
}

/**
 * Construye un mensaje ACK^R01.
 * El resultado es texto HL7 sin framing MLLP — el caller lo envuelve.
 */
export function buildAck(opts: BuildAckOptions): string {
  const ts = formatHl7Timestamp(opts.now ?? new Date());
  const newId = opts.ackControlId ?? `ACK${ts}`;

  const msh = `MSH|^~\\&|||||${ts}||ACK^R01|${newId}|P|2.3.1||||||UNICODE`;
  const msaParts = [`MSA`, opts.status, opts.originalMessageControlId];
  if (opts.errorText) {
    msaParts.push(opts.errorText.replace(/[|^~\\&]/g, " ")); // sanitizar delimitadores
  }
  const msa = msaParts.join("|");

  return `${msh}\r${msa}`;
}

/**
 * "YYYYMMDDHHMMSS" en UTC. El XS 20 espera este formato.
 * Nota: usamos UTC para evitar drift por DST entre la PC y el equipo.
 */
function formatHl7Timestamp(d: Date): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}
