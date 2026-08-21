/**
 * Diccionarios de traduccion de lo que habla el equipo / el servicio al
 * castellano que entiende la operadora del laboratorio.
 *
 * Regla general: si no conocemos el codigo, mostramos el codigo crudo. Es
 * preferible una alarma en ingles a esconderla o inventar una traduccion.
 */

// ─── Alarmas morfologicas del analizador ─────────────────────────────────────
//
// Codigos del segmento OBX 99MRC. La lista sale de docs/04-mapeo-obx.md. El
// firmware puede escribirlos distinto entre versiones ("RBC Abn Distribution"
// vs "RBC Abnormal Distribution"), asi que ademas de la tabla normalizamos la
// clave (minusculas, sin signos) antes de buscar.

const MORPHOLOGY_LABELS: Record<string, string> = {
  // Serie blanca
  leukocytosis: "Leucocitosis (glóbulos blancos altos)",
  leucocytosis: "Leucocitosis (glóbulos blancos altos)",
  leukopenia: "Leucopenia (glóbulos blancos bajos)",
  leucopenia: "Leucopenia (glóbulos blancos bajos)",
  neutrophilia: "Neutrofilia",
  neutropenia: "Neutropenia",
  lymphocytosis: "Linfocitosis",
  lymphopenia: "Linfopenia",
  monocytosis: "Monocitosis",
  eosinophilia: "Eosinofilia",
  basophilia: "Basofilia",
  "imm granulocytes": "Sospecha de granulocitos inmaduros",
  "immature granulocytes": "Sospecha de granulocitos inmaduros",
  "atypical lymphs": "Sospecha de linfocitos atípicos",
  "atypical lympho": "Sospecha de linfocitos atípicos",
  "abn wbc scattergram": "Distribución anormal de glóbulos blancos",
  "wbc abn scattergram": "Distribución anormal de glóbulos blancos",
  leftshift: "Desviación a la izquierda",
  "left shift": "Desviación a la izquierda",
  // Serie roja
  erythrocytosis: "Eritrocitosis (glóbulos rojos altos)",
  anemia: "Anemia",
  anisocytosis: "Anisocitosis",
  microcytes: "Microcitos",
  macrocytes: "Macrocitos",
  hypochromia: "Hipocromía",
  "rbc abn distribution": "Distribución anormal de glóbulos rojos",
  "rbc abnormal distribution": "Distribución anormal de glóbulos rojos",
  "dimorphologic population": "Población dimórfica de glóbulos rojos",
  "hgb abn/interfere": "Hemoglobina anormal o interferencia en la medición",
  "hgb abn interfere": "Hemoglobina anormal o interferencia en la medición",
  "hgb abnormal/interference": "Hemoglobina anormal o interferencia en la medición",
  "rbc lyse resistance": "Glóbulos rojos resistentes a la lisis",
  "iron deficiency": "Sospecha de déficit de hierro",
  // Plaquetas
  thrombocytosis: "Trombocitosis (plaquetas altas)",
  thrombopenia: "Trombocitopenia (plaquetas bajas)",
  thrombocytopenia: "Trombocitopenia (plaquetas bajas)",
  "plt clump": "Sospecha de cúmulos plaquetarios",
  "plt clumps": "Sospecha de cúmulos plaquetarios",
  "pltclump": "Sospecha de cúmulos plaquetarios",
  "plt abn distribution": "Distribución anormal de plaquetas",
};

/** Normaliza el codigo del equipo para buscarlo en la tabla. */
function normalizeFlagCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[?¿!¡.,;:]+/g, "") // el equipo marca las sospechas con "?"
    .replace(/\s+/g, " ");
}

/**
 * Traduce una alarma del analizador. Si no la conocemos devolvemos el codigo
 * tal cual: preferimos "Imm Granulocytes?" antes que perder la alarma.
 */
export function morphologyFlagLabel(code: string): string {
  return MORPHOLOGY_LABELS[normalizeFlagCode(code)] ?? code;
}

/** True si la alarma es una sospecha (el equipo la marca con "?"). */
export function isSuspicionFlag(code: string): boolean {
  return code.trim().endsWith("?");
}

// ─── Eventos del servicio (vista Actividad) ──────────────────────────────────
//
// Las claves son las que loggea apps/service/src. La vista se llama
// "Actividad", no "Logs": tiene que leerse como un relato de lo que paso.

type Ctx = Record<string, unknown>;

interface EventDescriptor {
  /** Frase en castellano. Puede usar el contexto del evento. */
  text: (ctx: Ctx) => string;
  /** Plomeria interna: se oculta salvo que se pida el detalle tecnico. */
  noise?: boolean;
}

const str = (v: unknown): string | null =>
  v === undefined || v === null || v === "" ? null : String(v);

const EVENTS: Record<string, EventDescriptor> = {
  // ── Muestras ──
  "hl7.parsed": {
    text: (c) => {
      const id = str(c.sampleId);
      return id ? `Llegó la muestra ${id}` : "Llegó una muestra";
    },
  },
  "hl7.duplicate": {
    text: () => "Llegó una muestra repetida; se ignoró (ya estaba guardada)",
  },
  "hl7.parse_error": {
    text: (c) => `No se pudo leer el mensaje del equipo: ${str(c.error) ?? "formato inesperado"}`,
  },
  "hl7.non_oru_received": {
    text: () => "El equipo mandó un mensaje que no es un resultado; se ignoró",
  },
  "ack.sent": {
    text: () => "Se le confirmó la recepción al equipo",
    noise: true,
  },
  "ack.send_failed": {
    text: (c) =>
      `No se pudo confirmarle la recepción al equipo: ${str(c.error) ?? "error de red"}`,
  },
  "ack.deadline_exceeded": {
    text: () => "Tardamos demasiado en confirmarle la recepción al equipo",
  },
  "mllp.frame.too_large": {
    text: () => "El equipo mandó un mensaje más grande de lo permitido; se descartó",
  },

  // ── Exportacion de .txt ──
  "export.txt_written": {
    text: (c) => {
      const id = str(c.sampleId);
      return id ? `Se exportó el .txt de la muestra ${id}` : "Se exportó un .txt";
    },
  },
  "export.txt_failed": {
    text: (c) => {
      const id = str(c.sampleId);
      const err = str(c.error) ?? "no se pudo escribir el archivo";
      return `No se pudo exportar el .txt${id ? ` de la muestra ${id}` : ""}: ${err}`;
    },
  },

  // ── Conexion con el equipo (modo "el equipo se conecta a nosotros") ──
  "tcp.connection.opened": { text: () => "El equipo se conectó" },
  "tcp.connection.closed": { text: () => "El equipo cerró la conexión" },
  "tcp.connection.error": {
    text: (c) => `Error en la conexión con el equipo: ${str(c.error) ?? "desconocido"}`,
  },
  "tcp.connection.idle_timeout": {
    text: () => "Se cerró la conexión con el equipo por inactividad",
  },
  "tcp.listener.up": {
    text: (c) => {
      const host = str(c.host);
      const port = str(c.port);
      return host && port
        ? `Escuchando al equipo en ${host}:${port}`
        : "Escuchando al equipo";
    },
  },
  "tcp.listener.down": { text: () => "Se dejó de escuchar al equipo" },
  "tcp.disabled": { text: () => "La escucha del equipo está desactivada" },

  // ── Conexion con el equipo (modo "nosotros nos conectamos") ──
  "analyzer.client.starting": {
    text: (c) => {
      const host = str(c.host);
      const port = str(c.port);
      return host && port ? `Buscando el equipo en ${host}:${port}…` : "Buscando el equipo…";
    },
  },
  "analyzer.client.connected": { text: () => "Se conectó con el equipo" },
  "analyzer.client.disconnected": { text: () => "Se cortó la conexión con el equipo" },
  "analyzer.client.connect_failed": {
    text: (c) =>
      `No se pudo conectar con el equipo (${str(c.error) ?? "sin respuesta"}); se reintenta solo`,
  },
  "analyzer.client.socket_error": {
    text: (c) => `Error en la conexión con el equipo: ${str(c.error) ?? "desconocido"}`,
  },
  "analyzer.client.no_host": {
    text: () => "Falta configurar la IP del equipo en la pantalla Estado",
  },
  "analyzer.client.stopped": { text: () => "Se dejó de buscar el equipo" },
  "analyzer.client.idle_timeout": {
    text: () => "Se cerró la conexión con el equipo por inactividad; se reconecta solo",
  },
  "analyzer.client.keepalive_unavailable": {
    text: () => "No se pudo activar el chequeo de conexión con el equipo",
    noise: true,
  },
  "analyzer.client.stale_socket_discarded": {
    text: () => "Se descartó una conexión vieja con el equipo",
    noise: true,
  },

  "export.dir_ok": { text: () => "La carpeta de exportación quedó lista" },
  "export.dir_disabled": {
    text: () => "No hay carpeta de exportación configurada: no se generan .txt",
  },
  "export.dir_unavailable": {
    text: () => "No se puede escribir en la carpeta de exportación",
  },
  "export.failed": {
    text: (c) => {
      const id = str(c.sampleId);
      return `No se pudo exportar el .txt${id ? ` de la muestra ${id}` : ""}`;
    },
  },
  "export.rerun_done": {
    text: (c) => {
      const written = str(c.written);
      const failed = str(c.failed);
      const base = `Se volvieron a generar ${written ?? "los"} .txt`;
      return failed && failed !== "0" ? `${base} (${failed} fallaron)` : base;
    },
  },
  "export.rerun_dir_unavailable": {
    text: () => "No se pudieron regenerar los .txt: la carpeta no está disponible",
  },
  "export.unexpected_unit": {
    text: (c) => {
      const p = str(c.param);
      const u = str(c.unit);
      return `El equipo mandó ${p ?? "un parámetro"} en una unidad inesperada${u ? ` (${u})` : ""}`;
    },
  },

  // ── Base de datos y mantenimiento ──
  "db.corrupted": { text: () => "La base de datos está dañada" },
  "db.recovered_from_corruption": {
    text: () => "La base de datos estaba dañada y se recuperó; se empezó una nueva",
  },
  "db.recovery_failed": { text: () => "No se pudo recuperar la base de datos" },
  "db.quarantine_failed": {
    text: () => "No se pudo apartar la base de datos dañada",
  },
  "db.open_failed": { text: () => "No se pudo abrir la base de datos" },
  "db.migration.applying": {
    text: (c) => {
      const v = str(c.version);
      return v ? `Actualizando la base de datos (paso ${v})…` : "Actualizando la base de datos…";
    },
    noise: true,
  },
  "db.migration.applied": {
    text: (c) => {
      const v = str(c.version);
      return v ? `Base de datos actualizada (paso ${v})` : "Base de datos actualizada";
    },
    noise: true,
  },
  "db.migration.failed": {
    text: (c) => `No se pudo actualizar la base de datos: ${str(c.error) ?? "sin detalle"}`,
  },
  "logs.purged": { text: () => "Se borraron los archivos de log viejos", noise: true },
  "db.ready": {
    text: (c) => {
      const n = str(c.resultCount);
      return n ? `Base de datos lista (${n} resultados guardados)` : "Base de datos lista";
    },
  },
  "db.not_writable": {
    text: () => "La base de datos no acepta escrituras: los resultados no se van a guardar",
  },
  "retention.purged": {
    text: (c) => {
      const n = str(c.rawMessagesPurged);
      return `Se borraron ${n ?? "los"} mensajes viejos del equipo`;
    },
  },
  "retention.purge_failed": {
    text: () => "No se pudieron borrar los mensajes viejos",
  },

  // ── Servicio y configuracion ──
  "service.starting": { text: () => "Arrancando el servicio…" },
  "service.started": { text: () => "El servicio quedó andando" },
  "service.stopping": { text: () => "Deteniendo el servicio…" },
  "service.stopped": { text: () => "El servicio se detuvo" },
  "config.updated": { text: () => "Se guardó la configuración" },
  "config.persist_failed": {
    text: () => "No se pudo guardar la configuración en el disco",
  },
  "config.invalid": { text: () => "Hay un problema en la configuración" },
  "config.port_conflict": {
    text: () => "Dos puertos configurados chocan entre sí",
  },
  "uncaught_exception": {
    text: (c) => `Error inesperado en el servicio: ${str(c.error) ?? "sin detalle"}`,
  },
  "unhandled_rejection": {
    text: (c) => `Error inesperado en el servicio: ${str(c.reason) ?? "sin detalle"}`,
  },

  // ── Actualizaciones ──
  "update.available": {
    text: (c) => {
      const v = str(c.latestVersion);
      return v ? `Hay una versión nueva disponible (v${v})` : "Hay una versión nueva disponible";
    },
  },
  "update.downloaded": {
    text: (c) => {
      const v = str(c.version);
      return v
        ? `La actualización v${v} quedó lista para instalar`
        : "La actualización quedó lista para instalar";
    },
  },
  "update.download_failed": {
    text: (c) => `No se pudo descargar la actualización: ${str(c.error) ?? "error de red"}`,
  },
  "update.check_failed": {
    text: () => "No se pudo chequear si hay actualizaciones (¿sin internet?)",
  },
  "update.check_unreachable": {
    text: () => "No se pudo chequear si hay actualizaciones: no hay internet",
  },
  "update.check_http_error": {
    text: (c) => {
      const s = str(c.status);
      return `No se pudo chequear si hay actualizaciones${s ? ` (error ${s})` : ""}`;
    },
  },
  "update.check_no_version": {
    text: () => "No se encontró información de versiones publicadas",
  },
  "update.check_not_json": {
    text: () => "La respuesta del servidor de actualizaciones vino mal",
  },
  "update.check_not_manifest": {
    text: () => "La respuesta del servidor de actualizaciones vino mal",
  },
  "update.manifest_invalid": {
    text: () => "La información de la actualización vino incompleta",
  },
  "update.version_skipped": {
    text: (c) => {
      const v = str(c.version);
      return v ? `Se omitió la versión v${v}` : "Se omitió una versión";
    },
  },

  // ── Plomeria interna (ruido) ──
  "http.listener.up": { text: () => "La aplicación quedó lista", noise: true },
  "http.request": {
    text: (c) => `Pedido interno ${str(c.method) ?? ""} ${str(c.path) ?? ""}`.trim(),
    noise: true,
  },
  "http.handler_error": {
    text: (c) => `Error interno de la aplicación: ${str(c.error) ?? "sin detalle"}`,
  },
  "mllp.frame.received": { text: () => "Se recibió un bloque de datos del equipo", noise: true },
  "mllp.control_bytes": { text: () => "Bytes de control del equipo", noise: true },
};

/** Claves cuyo prefijo siempre es ruido, aunque no esten en la tabla. */
const NOISE_PREFIXES = ["mllp.", "http.request"];

export interface EventDescription {
  /** Frase en castellano (o la clave cruda si no la conocemos). */
  text: string;
  /** Explicacion mas larga (que hacer al respecto), si el servicio la manda. */
  detail: string | null;
  /** True si es plomeria interna que la operadora no necesita ver. */
  noise: boolean;
  /** True si tenemos traduccion; false si mostramos la clave cruda. */
  known: boolean;
}

/**
 * El servicio manda a veces un `ctx.detail` con una explicacion en castellano
 * pensada para quien opera ("revisar que la unidad de red este conectada…").
 * Es la mejor fuente que tenemos, asi que la usamos: como explicacion cuando ya
 * conocemos el evento, y como texto principal cuando no.
 */
function contextDetail(ctx?: Ctx): string | null {
  const d = ctx?.detail;
  return typeof d === "string" && d.trim() !== "" ? d.trim() : null;
}

export function describeEvent(msg: string, ctx?: Ctx): EventDescription {
  const detail = contextDetail(ctx);
  const desc = EVENTS[msg];

  if (desc) {
    return {
      text: desc.text(ctx ?? {}),
      detail,
      noise: desc.noise ?? false,
      known: true,
    };
  }

  // Evento que todavia no traducimos: si el servicio mando una explicacion en
  // castellano, mostrarla es mucho mejor que mostrar la clave tecnica.
  if (detail) {
    return { text: detail, detail: null, noise: false, known: true };
  }

  return {
    text: msg,
    detail: null,
    noise: NOISE_PREFIXES.some((p) => msg.startsWith(p)),
    known: false,
  };
}

/** Renderiza el ctx crudo (para el modo "detalle técnico"). */
export function formatCtx(ctx?: Ctx): string {
  if (!ctx) return "";
  return Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

// ─── Datos del paciente ──────────────────────────────────────────────────────

export function sexLabel(sex: "M" | "F" | "U" | null): string | null {
  if (sex === "M") return "Masculino";
  if (sex === "F") return "Femenino";
  if (sex === "U") return "Sin especificar";
  return null;
}

export function bloodModeLabel(mode: "W" | "P" | null): string | null {
  if (mode === "W") return "Sangre entera";
  if (mode === "P") return "Prediluida";
  return null;
}
