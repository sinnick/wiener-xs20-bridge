/**
 * ============================================================================
 *  MAPA DEL PROTOCOLO DEL XS 20  —  FUENTE UNICA DE VERDAD
 * ============================================================================
 *
 * TODO lo que este archivo contiene fue DEDUCIDO de la documentacion del
 * fabricante (Mindray BC-20s / "BC-20S & 30S Communication Protocol V1.0 EN")
 * y NO fue verificado contra un equipo fisico real.
 *
 * >>> CUANDO LLEGUE EL EQUIPO, ESTE ES EL PRIMER ARCHIVO A REVISAR. <<<
 *
 * Si un valor no matchea (un codigo OBX distinto, otra unidad, un typo nuevo
 * del firmware, un histograma con otro codigo), se corrige ACA y en ningun
 * otro lado. La logica de parseo (obx-mapper.ts) importa todo desde aca y no
 * tiene ninguna constante del protocolo hardcodeada.
 *
 * Cada bloque marca su nivel de confianza:
 *   [CONFIRMADO-DOC]  aparece explicito y consistente en la doc del fabricante
 *   [INFERIDO]        deducido del patron, probable pero sin confirmar
 *   [SOSPECHA]        muy poco claro en la doc, casi seguro hay que ajustarlo
 */

import type { HemogramParam, Histogram } from "@xs20/shared";

// ─── Version del protocolo esperada ──────────────────────────────────────────
// [CONFIRMADO-DOC] El XS 20 habla HL7 v2.3.1.
export const EXPECTED_HL7_VERSION = "2.3.1";

// [CONFIRMADO-DOC] Tipo de mensaje que trae resultados.
export const RESULT_MESSAGE_TYPE = "ORU"; // ORU^R01

// ─── Timeouts del protocolo (milisegundos) ──────────────────────────────────
// [INFERIDO] El equipo espera el ACK en ~4s antes de reintentar/abandonar.
// Damos un margen: si nuestra escritura a DB + ACK tarda mas que esto hay un
// problema serio que conviene loguear.
export const ACK_DEADLINE_MS = 4000;

// [INFERIDO] Cuanto puede estar una conexion sin enviar NADA (ni heartbeat)
// antes de que la consideremos muerta y la cerremos. El equipo manda heartbeat
// cada ~3s cuando esta ocioso, asi que 60s de silencio total = conexion colgada.
export const CONNECTION_IDLE_TIMEOUT_MS = 60_000;

// [INFERIDO] Lo mismo pero para el socket SALIENTE (modo "connect"). Va mucho
// mas holgado que el del listener a proposito: aca la deteccion primaria es el
// keepalive de TCP, y este barrido es solo el paracaidas para cuando el SO no
// nos deja habilitarlo (Windows) o el peer quedo medio-abierto igual.
//
// Si el equipo resultara NO mandar heartbeats cuando actua de servidor, esto se
// nota como una reconexion cada 5 minutos en el log ("analyzer.client.idle_
// timeout" seguido de "analyzer.client.connected"). Es feo pero inofensivo:
// reconectar cuando no hay nada en vuelo no pierde ningun mensaje. Si pasa,
// subir este numero es el ajuste correcto.
export const ANALYZER_CLIENT_IDLE_TIMEOUT_MS = 300_000;

// Cada cuanto corre el barrido de conexiones ociosas (listener y cliente).
export const IDLE_SWEEP_INTERVAL_MS = 15_000;

// [INFERIDO] Cuanto esperamos a que `Bun.connect` resuelva antes de darlo por
// fallido. Sin esto, una IP que existe pero se traga los paquetes (equipo
// apagado con la IP todavia ruteada, firewall en DROP) deja el intento colgado
// hasta el timeout del SO — minutos — y el backoff de reconexion nunca corre.
export const ANALYZER_CONNECT_TIMEOUT_MS = 10_000;

// Delay del primer probe de keepalive TCP sobre un socket ocioso. Con
// TCP_KEEPCNT=10 y TCP_KEEPINTVL=1s (lo que fija Bun), un peer muerto se
// detecta ~30s + 10s = 40s despues del ultimo byte.
export const ANALYZER_KEEPALIVE_IDLE_MS = 30_000;

// Tope de bytes que aceptamos acumular esperando el cierre (FS+CR) de un frame
// MLLP. Un ORU^R01 del XS 20 con los 3 histogramas ronda los 3-5 KB, asi que
// 1 MB es holgadisimo para cualquier mensaje legitimo.
//
// Sin este tope, un 0x0B sin su cierre (equipo colgado a mitad de transmision,
// o cualquier cliente TCP que se conecte al 5100 y escriba basura) hace que el
// buffer crezca sin limite hasta voltear el proceso por falta de memoria.
export const MAX_MLLP_FRAME_BYTES = 1_048_576;

// ─── Reconexion en modo "connect" (nosotros salimos al equipo) ───────────────
// Cuando el XS 20 es el servidor TCP, la PC del laboratorio tiene que mantener
// la conexion viva. El equipo se apaga todas las noches y se reinicia, asi que
// reconectar solo no es un caso de borde: es la operacion normal.
//
// Backoff exponencial entre reintentos, arrancando corto (el equipo puede estar
// reiniciandose) y con techo de 30s para no inundar la red ni el log cuando el
// equipo esta apagado durante horas.
export const RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_BACKOFF_FACTOR = 2;

// ─── Mapeo OBX-3 codigo → parametro canonico del hemograma ───────────────────
// [CONFIRMADO-DOC] para los codigos LOINC (con guion, ej "6690-2").
// [INFERIDO] para los codigos propietarios 99MRC (5 digitos, ej "10027"):
//   el patron es claro pero los numeros exactos pueden variar por firmware.
export const PARAM_CODE_TO_CANON: Record<string, HemogramParam> = {
  "6690-2": "wbc", // [CONFIRMADO-DOC] LOINC
  "731-0": "lym_abs", // [CONFIRMADO-DOC]
  "736-9": "lym_pct", // [CONFIRMADO-DOC]
  "10027": "mid_abs", // [INFERIDO] 99MRC
  "10029": "mid_pct", // [INFERIDO]
  "10028": "gran_abs", // [INFERIDO]
  "10030": "gran_pct", // [INFERIDO]
  "789-8": "rbc", // [CONFIRMADO-DOC]
  "718-7": "hgb", // [CONFIRMADO-DOC] — OJO unidad (ver UNIT_OVERRIDES)
  "4544-3": "hct", // [CONFIRMADO-DOC]
  "787-2": "mcv", // [CONFIRMADO-DOC]
  "785-6": "mch", // [CONFIRMADO-DOC]
  "786-4": "mchc", // [CONFIRMADO-DOC]
  "788-0": "rdw_cv", // [CONFIRMADO-DOC]
  "21000-5": "rdw_sd", // [CONFIRMADO-DOC]
  "777-3": "plt", // [CONFIRMADO-DOC]
  "32623-1": "mpv", // [CONFIRMADO-DOC]
  "32207-3": "pdw", // [CONFIRMADO-DOC]
  "10002": "pct", // [INFERIDO] 99MRC
};

// ─── Codigos de metadata de la muestra (no son valores del hemograma) ────────
// [INFERIDO] Los 08xxx son propietarios; el patron es consistente en la doc.
export const SAMPLE_META_CODES = {
  takeMode: "08001", // [INFERIDO] O=open tube, C=closed, etc.
  bloodMode: "08002", // [INFERIDO] W=whole, P=predilute
  testMode: "08003", // [INFERIDO] CBC, CBC+DIFF
  refGroup: "01001", // [INFERIDO]
  age: "30525-0", // [CONFIRMADO-DOC] LOINC
} as const;

// Set derivado para chequeos rapidos "es metadata?"
export const SAMPLE_META_CODE_SET = new Set<string>(Object.values(SAMPLE_META_CODES));

// ─── Histogramas ─────────────────────────────────────────────────────────────
// [INFERIDO] Codigos de los 3 histogramas. El patron 150x0 es claro en la doc
// pero conviene confirmar contra el equipo.
export const HISTOGRAM_CODES: Record<string, Histogram["type"]> = {
  "15000": "wbc", // [INFERIDO]
  "15010": "rbc", // [INFERIDO]
  "15020": "plt", // [INFERIDO]
};

// [SOSPECHA] Discriminadores (lineas que separan poblaciones celulares).
// Estos codigos son los que MENOS claros estan en la doc. Muy probable que
// haya que ajustarlos cuando llegue el equipo. El parser los trata como
// opcionales: si no matchean, el histograma igual se guarda sin las lineas.
export const DISCRIMINATOR_CODES: Record<
  string,
  { type: Histogram["type"]; line: "leftLine" | "midLine" | "rightLine" }
> = {
  "15001": { type: "wbc", line: "leftLine" }, // [SOSPECHA]
  "15002": { type: "wbc", line: "midLine" }, // [SOSPECHA]
  "15003": { type: "wbc", line: "rightLine" }, // [SOSPECHA]
  "15011": { type: "rbc", line: "leftLine" }, // [SOSPECHA]
  "15012": { type: "rbc", line: "rightLine" }, // [SOSPECHA]
  "15021": { type: "plt", line: "leftLine" }, // [SOSPECHA]
  "15022": { type: "plt", line: "rightLine" }, // [SOSPECHA]
};

// [CONFIRMADO-DOC] Un histograma decodificado son exactamente 256 bytes.
export const HISTOGRAM_CHANNEL_COUNT = 256;

// [CONFIRMADO-DOC] En el OBX-5 con valueType=ED, el subtipo viene con este typo
// del fabricante ("Octer" en vez de "Octet"). Lo aceptamos tal cual. Si un
// firmware nuevo lo corrige a "Octet-stream", agregar el valor a este set.
export const ENCAPSULATED_DATA_SUBTYPES = new Set(["Octer-stream", "Octet-stream"]);

// ─── Valores de campos enum ──────────────────────────────────────────────────
// [INFERIDO] Como el equipo codifica el sexo del paciente en PID-8.
export const SEX_MAP: Record<string, "M" | "F" | "U"> = {
  Male: "M",
  M: "M",
  Female: "F",
  F: "F",
  Unknown: "U",
  U: "U",
};

// [INFERIDO] Valores validos de blood mode (OBX 08002).
export const BLOOD_MODE_VALUES = new Set(["W", "P"]);

// ─── Flags de anormalidad (OBX-8) ────────────────────────────────────────────
// [CONFIRMADO-DOC] Codigos estandar HL7 de abnormal flags.
export const ABNORMAL_FLAG_CODES = new Set(["N", "H", "L", "HH", "LL", "A"]);

// ─── Posiciones de campos en OBR ─────────────────────────────────────────────
// [SOSPECHA] La doc no es 100% clara sobre en que campo del OBR viene cada
// timestamp. Asumimos OBR-6 = requested/drawn, OBR-7 = observation/analyzed.
// Si las fechas salen cruzadas cuando llegue el equipo, cambiar estos numeros.
export const OBR_FIELD = {
  sampleId: 3, // [INFERIDO]
  drawnAt: 6, // [SOSPECHA]
  analyzedAt: 7, // [SOSPECHA]
  operator: 10, // [INFERIDO]
} as const;
