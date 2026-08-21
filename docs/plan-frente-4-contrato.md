# Plan — Frente 4: contrato, paginación, salud de exportación y trazabilidad

Estado: PLAN, sin implementar. Ordenado por impacto en el laboratorio.

Este documento es autocontenido: el ejecutor no debería necesitar re-investigar.
Las referencias son a **funciones y comportamientos**, no a números de línea —
`http/server.ts` y `db/repo.ts` fueron editados concurrentemente por otros
agentes y las líneas ya se movieron una vez durante la redacción de este plan.

## Reglas del repo que condicionan este plan

1. **`apps/service/src/db/schema.sql` está CONGELADO.** Existe un runner de
   migraciones en `apps/service/src/db/migrate.ts` con el array `MIGRATIONS`.
   Todo DDL nuevo —incluido un índice— va como entrada nueva en `MIGRATIONS`,
   nunca en `schema.sql`. El motivo está documentado en el encabezado de
   `migrate.ts`: la app se auto-actualiza en la PC del laboratorio y
   `CREATE TABLE IF NOT EXISTS` se saltea la tabla entera en una instalación
   existente.
2. **Los tests corren con `bun test` desde `apps/service`** y usan DB `:memory:`
   más `fetch` real contra un `HttpServer` en un puerto aleatorio. Ver
   `apps/service/src/http/server.test.ts` como plantilla exacta.
3. **UI y servicio se instalan juntos** (un solo instalador NSIS, ver
   `docs/07-instalacion-windows.md`), así que un cambio de wire format
   coordinado entre ambos es aceptable. Aun así la UI ya tiene el patrón de
   "servicio viejo sin el endpoint" en `UpdatesCard` — conviene mantenerlo.

---

## PAQUETE A — `GET /api/results`: validación, paginación y fechas

**Prioridad: máxima.** Los tres bugs viven en la misma ruta de código
(`HttpServer.listResults` → `XsRepo.listResults`), así que separarlos multiplica
el trabajo y el riesgo de conflicto.

### A.1 — Validación de `?limit` (roto hoy, verificado)

**Qué está roto.** `HttpServer.listResults` hace
`parseInt(url.searchParams.get("limit") ?? "50", 10)` sin chequear nada.

- `?limit=abc` → `NaN` → SQLite tira *datatype mismatch* → el catch genérico de
  `handle()` responde **500 INTERNAL**. El contrato dice que un parámetro
  inválido es 400.
- `?limit=-1` → `Math.min(-1, 500) = -1` en `XsRepo.listResults` → SQLite
  interpreta `LIMIT -1` como **sin límite** → devuelve la tabla completa
  serializada en un solo JSON. En una base de 5 años son ~365.000 filas.
- `?limit=0` → devuelve 0 resultados sin error (ambiguo, hoy nadie lo nota).

**Cambio propuesto.** En `apps/service/src/http/server.ts`, un helper exportado
(exportarlo permite testearlo sin levantar el servidor):

```ts
export function parseLimitParam(
  raw: string | null,
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === null || raw === "") return { ok: true, value: 50 };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: "El parámetro 'limit' debe ser un entero entre 1 y 500" };
  }
  const n = Number(raw);
  if (n < 1) {
    return { ok: false, message: "El parámetro 'limit' debe ser un entero entre 1 y 500" };
  }
  return { ok: true, value: Math.min(n, 500) };
}
```

Decisión tomada: `limit > 500` **se clampea a 500**, no da 400 — la doc dice
"max 500", y clampear es más amable con un cliente que pide de más. `limit` no
numérico o `< 1` da `400 VALIDATION_ERROR` con el shape estándar
`{error:{code,message}}`.

Defensa en profundidad: en `XsRepo.listResults` cambiar
`Math.min(params.limit ?? 50, 500)` por
`Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), 500)`, para que un
llamador interno futuro tampoco pueda meter un `LIMIT -1`.

**Compatibilidad:** ninguna ruptura. La UI manda `limit: 200`, sigue andando.

### A.2 — Normalización de `fromDate` / `toDate` (bug no auditado, encontrado acá)

**Qué está roto.** `results.received_at` se persiste con
`hemogram.receivedAt.toISOString()`, es decir siempre UTC terminado en `Z`
(24 caracteres exactos). `XsRepo.listResults` compara con `r.received_at >= ?`
— comparación **de strings** en SQLite. `docs/03-contrato-http.md` documenta los
timestamps como ISO 8601 *con offset* (`2026-04-27T15:32:11.234-03:00`). Un
cliente que respeta la doc rompe el filtro en silencio:

```
"2026-04-27T15:32:11.234-03:00"  vs  "2026-04-27T18:32:11.234Z"
                     ^ carácter 11: '5' < '8'  →  compara mal 3 horas
```

Hoy nadie lo nota porque la UI no expone filtro por fecha. En cuanto A.3 lo
agregue, el filtro devuelve rangos equivocados. **Hay que arreglarlo antes de
exponer la UI de fechas, no después.**

**Cambio propuesto.** En `HttpServer.listResults`, normalizar antes de pasar al
repo:

```ts
function toStoredIso(raw: string): string | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
```

Si `fromDate`/`toDate` vienen y no parsean → `400 VALIDATION_ERROR` ("La fecha
'fromDate' no es un ISO 8601 válido"). Si parsean, se manda al repo el
`.toISOString()`, que compara correctamente contra lo almacenado.

Documentar en `docs/03-contrato-http.md` que el servicio acepta cualquier ISO
8601 válido y lo normaliza a UTC internamente.

### A.3 — Paginación por cursor real

**Qué está roto.** `packages/shared/src/api.ts` declara `ListResultsQuery.cursor`
y `ListResultsResponse.nextCursor`; `docs/03-contrato-http.md` la documenta con
un ejemplo. El servidor hardcodea `nextCursor: null` y `XsRepo.listResults` ni
siquiera recibe el parámetro. Consecuencia práctica: `ResultsList` pide
`limit: 200` y **todo lo más viejo que esos 200 resultados es inalcanzable desde
la app**. Un laboratorio que corre años tiene historia clínica invisible.

**DECISIÓN D1 (dueño): cursor keyset vs. offset.**

Recomendación: **cursor keyset**. Razones concretas:

- Offset (`LIMIT n OFFSET m`) drifta: mientras la operadora pagina, el analizador
  sigue insertando resultados en la cabeza del orden `received_at DESC`. Cada
  inserción corre todas las páginas siguientes una posición → filas duplicadas y
  filas salteadas. En un contexto clínico "un resultado que no aparece en ninguna
  página" no es aceptable.
- El keyset usa el índice y no degrada con el offset.
- El contrato y la doc ya declaran un cursor opaco.

Costo de la alternativa: offset es ~1 hora menos de trabajo. No lo vale.

**Forma de la solución.**

*(a) Migración — índice compuesto.* En `MIGRATIONS` de `db/migrate.ts`:

```ts
{
  version: 2,
  name: "results.idx_received_at_id",
  up: (db) => db.exec(
    `CREATE INDEX IF NOT EXISTS idx_results_received_at_id
       ON results(received_at DESC, id DESC)`,
  ),
},
```

El índice existente `idx_results_received_at` queda. **No tocar `schema.sql`.**

*(b) Repo — método nuevo, sin romper el existente.* En `XsRepo`, agregar
`listResultsPage()` y dejar `listResults()` como wrapper de una línea. Esto evita
tocar las ~6 llamadas de `repo.test.ts`:

```ts
export interface ResultsCursor { receivedAt: string; id: string }

listResultsPage(params: {
  limit?: number; fromDate?: string; toDate?: string; search?: string;
  cursor?: ResultsCursor;
}): { results: ResultSummary[]; nextCursor: ResultsCursor | null }

listResults(params): ResultSummary[] {
  return this.listResultsPage(params).results;   // compat
}
```

SQL: al `where` actual se le suma, cuando hay cursor,

```sql
(r.received_at < ? OR (r.received_at = ? AND r.id < ?))
```

y el orden pasa a `ORDER BY r.received_at DESC, r.id DESC`.

Usar la forma con `OR` explícita, no row-values `(a,b) < (?,?)`: es igual de
rápida con el índice compuesto y no depende de la versión de SQLite embebida.

Se pide `LIMIT limit + 1`: si vuelven `limit+1` filas, hay página siguiente; se
descarta la extra y `nextCursor` se arma con la **última fila devuelta**.

*(c) Desempate por `id`.* `received_at` tiene resolución de milisegundos y dos
resultados pueden caer en el mismo ms. El `id` (`r_${Date.now()}_${counter36}`)
**no** es monótono con el tiempo en general, pero como desempate solo necesita
ser total y determinista bajo la misma comparación de strings que usa el
`ORDER BY` — y lo es.

*(d) Codificación del cursor.* En `http/server.ts`:

```ts
// El orden de las claves importa solo por cosmética: así el cursor empieza con
// "eyJpZCI6Ij…", igual que el ejemplo de docs/03-contrato-http.md.
encodeCursor = (c) => btoa(JSON.stringify({ id: c.id, receivedAt: c.receivedAt }));
```

Al decodificar: `atob` + `JSON.parse` dentro de try/catch, y validar que ambos
campos sean strings no vacíos. Cursor inválido → `400 VALIDATION_ERROR`,
**nunca** un 500.

*(e) Semántica a documentar explícitamente.* El cursor **no** codifica los
filtros. El cliente reenvía `search`/`fromDate`/`toDate` en cada página; si
cambia un filtro, tiene que descartar el cursor y empezar de cero. Esto va en
`docs/03-contrato-http.md`, porque es la trampa clásica de esta API.

*(f) UI.* En `apps/ui/src/lib/api.ts`: agregar `cursor?: string` a `ListParams` y
al querystring. En `apps/ui/src/pages/ResultsList.tsx`:

- bajar `limit` a 100 y **acumular** páginas en el estado en vez de reemplazar;
- botón "Cargar más" visible mientras `nextCursor !== null`, con spinner propio;
- resetear la acumulación cuando cambia `search`, `fromDate`, `toDate` o
  `refreshKey` (este último llega por SSE con cada `hl7.parsed`);
- **filtro por fecha**: dos `<input type="date">` (Desde / Hasta) más atajos
  "Hoy / 7 días / 30 días / Todo". Al mandar `toDate`, convertir a fin del día
  local (`23:59:59.999`) y luego `.toISOString()`, si no "Hasta hoy" excluye todo
  lo de hoy.
- **Ojo con los KPIs del header**: hoy `stats.total = results.length` se rotula
  "Recibidos". Con paginación pasa a ser "los cargados hasta ahora". Renombrar a
  "Resultados cargados".

**Compatibilidad.** El shape de respuesta no cambia (`nextCursor` ya existía y
era `null`). Sin ruptura en ninguna dirección.

### Tests del paquete A

En `apps/service/src/http/server.test.ts`:

- `?limit=abc` → 400 con `code === "VALIDATION_ERROR"` (hoy da 500).
- `?limit=-1` → 400. `?limit=0` → 400.
- `?limit=99999` → 200 y como mucho 500 resultados.
- sin `limit` → default 50.
- `?fromDate=no-es-fecha` → 400.
- `?fromDate=<ISO con offset -03:00>` → devuelve el mismo conjunto que el mismo
  instante expresado en `Z`. **Este es el test que prueba A.2.**
- `?cursor=basura` → 400, no 500.

En `apps/service/src/db/repo.test.ts`:

- Insertar 5 resultados, paginar de a 2 y verificar que la unión de las páginas
  es exactamente el conjunto, sin repetidos ni faltantes, y que la última página
  trae `nextCursor === null`.
- **Test del desempate**: insertar 3 resultados con el **mismo** `received_at` y
  paginar de a 1. Sin el desempate por `id` este test entra en loop o saltea
  filas. Es el test que justifica el índice compuesto.
- Paginar con `search` activo y confirmar que el filtro se respeta en todas las
  páginas.

En `db/migrate.test.ts`: abrir una DB con `user_version = 1`, correr `openDb`,
verificar que quedó en 2 y que el índice existe (`PRAGMA index_list(results)`).

**Esfuerzo: 1 a 1,5 días.**

---

## PAQUETE B — Salud de la exportación a `.txt`

**Prioridad: alta.** Es *el* entregable que consume el laboratorio.

**Qué está roto.** `HttpServer.updateConfig` acepta `exportDir` con un
`typeof === "string"` y un `.trim()`, y nada más. Un typo o una unidad de red
desconectada produce: PUT 200 → la app muestra "Guardado" → cada resultado que
llega falla en `TxtExporter.export()`, que loguea `export.txt_failed` y **no hace
nada más** (deliberadamente: no puede voltear el ACK al analizador, y eso está
bien). `HealthResponse` no tiene ningún campo de exportación, así que la pantalla
de Estado muestra todo verde mientras el laboratorio no recibe un solo archivo.

Existe el precedente exacto: `XsRepo.probeWritable()`, escrito por un fallo real
de producción con la misma forma.

### B.1 — `probeExportDir()`

Nuevo export en `apps/service/src/export/txt-exporter.ts`:

```ts
export interface ExportProbe { ok: boolean; error: string | null }
export function probeExportDir(dir: string): ExportProbe
```

Implementación: `mkdirSync(dir, {recursive:true})` → `writeFileSync(join(dir,
".xs20-probe"), "")` → `unlinkSync`. Cualquier throw → `{ok:false, error: msg}`.
Es la misma secuencia que hace el export real, así que prueba lo que importa
(permisos de escritura, no solo existencia).

### B.2 — Estado vivo del exporter

```ts
getStatus(): {
  enabled: boolean; dir: string;
  lastExportAt: Date | null;
  lastError: string | null; lastErrorAt: Date | null;
  consecutiveFailures: number;
  writable: boolean; writableError: string | null;
}
```

**Detalle importante:** `/api/health` se pollea cada 3 s desde `StatusView`.
Escribir un archivo de probe cada 3 s contra una unidad de red SMB es una mala
idea. El probe debe estar **cacheado con TTL de ~30 s** e invalidarse cuando
cambia `exportDir`. El `lastError` / `lastExportAt` vienen de escrituras reales,
que son señal más fuerte que el probe.

### B.3 — `HealthResponse.export`

```ts
/** Estado de la exportación a .txt — es el entregable que consume el laboratorio. */
export: {
  enabled: boolean; dir: string;
  writable: boolean; error: string | null;
  lastExportAt: string | null;
  lastError: string | null; lastErrorAt: string | null;
};
```

`HttpServer` necesita el exporter: agregar `txtExporter?: TxtExporter` a
`HttpServerOptions` (opcional, para no romper los tests existentes) y cablearlo
en `main.ts`.

**DECISIÓN D3 (dueño): ¿el export roto degrada el `status` general?**
Hoy: `status = transport.healthy && dbWritable ? "ok" : "degraded"`.
Propuesta: `&& (!exportEnabled || exportWritable)`.
**Recomendación: sí, degradar** — con el bloque `export` la UI puede explicar
exactamente por qué.

### B.4 — Validación en `PUT /api/config`

1. **Forma** (siempre `400` si falla): si `exportDir` no es vacío, debe ser ruta
   absoluta. Como los tests corren en macOS/Linux y el servicio en Windows, **no
   usar `path.isAbsolute`** (rechazaría `C:\...` en Linux):

   ```ts
   const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\\\\|\/)/;   // C:\… , \\servidor\… , /…
   ```

2. **Escritura** — **DECISIÓN D2 (dueño)**: ¿rechazar o guardar + advertir?

   **Recomendación firme: guardar + advertir.** El motivo es decisivo:
   `ConfigCard.onSave` manda **el patch completo** (modo, IP, puertos, log level,
   retención y `exportDir`) en cada guardado. Si el PUT rechaza por una unidad de
   red momentáneamente caída, la operadora **no puede cambiar ni el nivel de
   log**. Eso es peor que el bug original.

   `UpdateConfigResponse` gana `warnings?: string[]` (opcional → una UI vieja lo
   ignora). Si el probe falla, se persiste igual y se devuelve:

   > "Se guardó la carpeta, pero no se puede escribir en `<dir>`: `<error>`. Los
   > .txt no se van a generar hasta que se corrija."

### B.5 — UI

Card nueva "Exportación" en `StatusView` con carpeta, estado, último archivo
escrito y último error. Con el tono explicativo del mensaje de DB no escribible:

> "No se puede escribir en la carpeta de exportación: **los .txt de las muestras
> nuevas no se están generando.** Revisá que la carpeta exista y que la unidad de
> red esté conectada."

Usar acceso opcional (`health.export?.enabled`) por si corre contra un servicio
viejo.

### Tests del paquete B

- `probeExportDir("")` / carpeta válida / carpeta inexistente creable / ruta
  imposible → `{ok:false}` con mensaje no vacío.
- `TxtExporter`: tras un export exitoso, `getStatus().lastExportAt` no es null;
  tras uno fallido, `lastError` y `consecutiveFailures` avanzan y **el export no
  lanza** (regresión del invariante actual).
- `PUT /api/config` con `exportDir: "relativo/malo"` → 400.
- `PUT /api/config` con carpeta no escribible → **200** con `warnings.length > 0`
  y la config persistida.
- `GET /api/health` con export habilitado y carpeta rota → `export.writable ===
  false` y (si se toma D3) `status === "degraded"`.

**Esfuerzo: ~1 día.**

---

## PAQUETE C — `POST /api/actions/test-connection`

**Prioridad: alta** por relación costo/beneficio.

**Contexto.** `docs/03-contrato-http.md` lo especifica bajo "Acciones de servicio
(fase 1.5+)" — la doc ya lo marca como futuro. Lo real es la necesidad: en
`ConfigCard` la operadora tipea la IP del analizador y la única forma de saber si
anduvo es mirar los logs.

*(a) Módulo nuevo* `apps/service/src/listener/probe-connection.ts` — separado de
`server.ts` a propósito, para reducir conflictos y poder testearlo sin HTTP:

```ts
export async function probeTcpConnection(
  host: string, port: number, timeoutMs = 5000,
  connectFn: typeof Bun.connect = Bun.connect,
): Promise<{ ok: boolean; error: string | null; latencyMs: number }>
```

Abre un socket efímero, cierra con `socket.end()` apenas dispara `open`, y
envuelve todo en un `Promise.race` con timeout. **No envía ni un byte** (el XS 20
podría interpretar basura) y **no toca el socket de `AnalyzerClient`**.

*(b) Endpoint* con auth:

```
POST /api/actions/test-connection   { "host": "192.168.100.15", "port": 5100 }
200 { "ok": true,  "error": null,           "latencyMs": 12 }
200 { "ok": false, "error": "ECONNREFUSED", "latencyMs": 3 }
400 VALIDATION_ERROR
```

Nota de diseño: **la falla de conexión devuelve 200**, no 502. La *acción*
(probar) se ejecutó bien; el resultado es "no conecta".

*(c) Tipos* en `packages/shared/src/api.ts`: `TestConnectionRequest` y
`TestConnectionResponse`.

*(d) UI.* Botón "Probar conexión" en `ConfigCard`, **solo en la rama
`mode === "connect"`**. Clave: prueba los valores **tipeados y sin guardar**.
Estados: "Probando…" → "Conecta ✓ (12 ms)" / "No conecta: ECONNREFUSED", con una
línea de ayuda ("¿El equipo está encendido y en la misma red? ¿El puerto del menú
LIS del XS 20 coincide?").

### Tests

- Contra un `Bun.listen` local efímero → `ok: true`.
- Contra un puerto cerrado → `ok: false`, **sin lanzar**.
- Contra una IP no ruteable (`192.0.2.1`, TEST-NET-1) con `timeoutMs: 200` →
  resuelve en menos de ~1 s (prueba que el timeout funciona).
- Sin token → 401. Con `{host: "no-es-ip"}` → 400.

**Esfuerzo: ~2 h.**

---

## PAQUETE D — Secuencias de escape HL7 y charset

**Prioridad: media-alta** (integridad de datos clínicos).

**Qué está roto.** `parser.ts` extrae `delims.escape` del MSH y nunca lo consume.
`\F\ \S\ \T\ \R\ \E\ \X..\` llegan literales a la DB, a la UI y al nombre del
archivo exportado.

**Corrección de alcance:** el `.txt` exportado **no** contiene el apellido del
paciente — `formatHemogramTxt` solo escribe líneas numéricas. El daño real es:

1. el nombre del paciente y el `sampleId` se muestran mal en la UI y se guardan
   mal en la DB;
2. el **nombre del archivo** exportado sale deformado, porque `exportFileName()`
   sanitiza con `[^A-Za-z0-9._-] → "_"`, así que un `sampleId` con `\S\` se
   convierte en `..._S_...`.

### D.1 — Decodificación de escapes

Módulo nuevo `apps/service/src/hl7/escape.ts`:

```ts
export function unescapeHl7(text: string, delims: Delimiters): string
```

Reglas que importan:

- **Una sola pasada** con `/\\([^\\]*)\\/g` y un `switch`. Nada de `replace`
  encadenados: `\E\` decodifica a `\`, y un segundo pase reinterpretaría ese
  backslash como escape.
- `F` → `delims.field`, `S` → component, `T` → subcomponent, `R` → repetition,
  `E` → escape. `X` + hex → los bytes correspondientes.
- Cualquier otra cosa (`Zxx`, `.br`, basura) → **literal, tal cual vino**. Nunca
  tirar datos que no entendemos.

**Punto de llamada:** `parseComponent()`, que hoy es
`text.split(delims.subcomponent)` → pasa a mapear cada subcomponente por
`unescapeHl7`. Es el lugar correcto porque el split ya ocurrió.

**Lo que NO se toca:** MSH-1 y MSH-2 (*son* los caracteres especiales, y no pasan
por `parseComponent`); `Hl7Segment.raw` / `Hl7Message.raw` (se persisten en
`raw_messages.raw_hl7` para auditoría); los payloads de histograma (el alfabeto
base64 no incluye `\`).

**Backfill:** las filas ya guardadas conservan los escapes. Recomendado dejarlas
así (el `raw_hl7` queda intacto para un eventual reproceso).

### D.2 — MSH-12 (versión) y MSH-18 (charset)

`packages/shared/src/hl7.ts` documenta `versionId` y `characterSet` y ninguno se
lee. Y `mllp.ts` decodifica con `TextDecoder("utf-8", { fatal: false })`: un
equipo en Latin-1 produce U+FFFD (`�`) persistido **sin ninguna señal**.

En `MessageProcessor.process`, después del MSH:

- MSH-12 ≠ `EXPECTED_HL7_VERSION` → `logger.warn("hl7.unexpected_version")`.
  **Nunca rechazar el mensaje**: descartar resultados de un paciente por un
  string de versión sería mucho peor.
- MSH-18 fuera de {vacío, `UNICODE`, `UNICODE UTF-8`, `ASCII`} → warn.
- **Detección de mojibake**: `if (hl7Text.includes("\uFFFD"))` → warn. Son dos
  líneas y es *la* señal práctica de un equipo en Latin-1.

Deduplicar con un `Set<string>` en memoria para no inundar el log.

**DECISIÓN D8: ¿charset configurable?** Recomendación: **no ahora**. Haría falta
enhebrarlo hasta `unframeMllp` y no hay evidencia de que el equipo esté en
Latin-1. Primero la detección.

### Tests

- `\F\ \S\ \T\ \R\ \E\` → `| ^ & ~ \`. `\X0D\` → `\r`; `\X48656C6C6F\` → `Hello`.
- Un escape desconocido (`\Q\`) sobrevive literal.
- `\E\F\E\` → `\F\` y **no** `|` (prueba que es una sola pasada).
- `PID|…|P\S\rez^Juan` llega a `patient.name` con el `^` correcto.
- MSH-1/MSH-2 intactos; el OBX de histograma sigue decodificando a 256 bytes.

**Esfuerzo: ~0,5–1 día.**

---

## PAQUETE E — Contrato honesto

### E.1 — Histogramas: sacar el cast reconocido como hack

`packages/shared/src/api.ts` define `HistogramPayload {type, channelsBase64,
discriminators}` — la forma correcta — y **no se usa en ningún lado**. El
servidor manda `channels` con un base64 disfrazado de `Uint8Array` por un cast
que el propio código admite como hack, y la UI hace el des-casteo inverso. Dos
mentiras que se cancelan: TypeScript no protege nada en toda esta ruta.

```ts
export type GetResultResponse = Omit<HemogramResult, "histograms"> & {
  histograms: HistogramPayload[];
  /** El HL7 original en TEXTO PLANO — solo si ?includeRaw=true. */
  rawHl7?: string;
};
```

En `HttpServer.getResult`: construir explícitamente
`{ type, channelsBase64: encodeHistogramBase64(h.channels), discriminators }`.
En `ResultDetail.tsx`: `channelsBase64={h.channelsBase64}`.

**DECISIÓN D9:** emitir **los dos** campos durante una release, con un comentario
`// deprecado`. Una línea de código que elimina cualquier ventana de
incompatibilidad. **Recomendación: sí.**

*Sub-ítem que NO recomiendo ahora:* `GetResultResponse` declara `receivedAt`,
`drawnAt` y `analyzedAt` como `Date` pero por JSON llegan como `string`.
Arreglarlo bien pide un mapped type `JsonOf<T>` y toca mucha superficie.
Documentarlo con un comentario y dejarlo.

### E.2 — Endpoints documentados que no existen

**DECISIÓN D5: `GET /api/results/:id/histogram/:type`** → **borrar de la doc**.
`GET /api/results/:id` ya devuelve los 256 bytes en base64 y la UI los renderiza
desde ahí.

**DECISIÓN D4: `POST /api/actions/reprocess/:rawMessageId`** → **postergar**,
pero el dueño debe saber la consecuencia: `protocol-map.ts` está lleno de códigos
marcados `[INFERIDO]` y `[SOSPECHA]`. Cuando llegue el equipo real y alguno no
matchee, se corrige el mapa — y **los resultados ya recibidos quedan mal
parseados para siempre**, salvo que exista el reproceso. Sin este endpoint, la
corrección de datos históricos es SQL manual sobre una base de producción
clínica.

Si se implementa: leer `raw_messages.raw_hl7` (si está vacío por
`purgeOldRawMessages` → `409 RAW_PURGED`), re-parsear con el **mismo `id`**, y en
**una transacción** borrar y re-insertar los hijos + `UPDATE results`. No se
puede usar `insertResult` tal cual porque chocaría con
`UNIQUE(message_control_id)`. Esfuerzo: ~0,5 día, **no incluido en el total**.

**DECISIÓN D6: `"down"` en `HealthResponse.status`** → **sacarlo del tipo** (si
está caído, no hay nadie que responda). De paso, en `StatusView` la expresión
`health.status === "ok" ? "En línea" : health.status` muestra la palabra cruda
"degraded" en inglés en la cara de la operadora; mapear a "Degradado".

### E.3 — Constantes de protocolo muertas

El encabezado de `protocol-map.ts` afirma que la lógica "no tiene ninguna
constante del protocolo hardcodeada". No es cierto:

- `MessageProcessor.process` compara `messageType !== "ORU"` con el literal, y
  `RESULT_MESSAGE_TYPE` queda sin usar.
- `EXPECTED_HL7_VERSION` no se usa.
- **Encontrado acá:** `XsRepo.insertResult` hardcodea `"ORU^R01"` como
  `message_type` en el INSERT a `raw_messages`, en vez del MSH-9 real. Si llega
  un `ORU^R30`, la tabla de auditoría miente.

Arreglo: usar las constantes, `InsertResultParams` gana `messageType?: string`
(default `"ORU^R01"`), y actualizar el comentario del encabezado para que vuelva
a ser verdad.

### Tests del paquete E

- `GET /api/results/:id` devuelve `histograms[0].channelsBase64` como string y
  decodifica a 256 bytes (test que *ejecuta* el contrato en vez de confiar en el
  tipo).
- Con `?includeRaw=true`, `rawHl7` empieza con `"MSH|"` — texto plano, no base64.
- `insertResult` guarda el MSH-9 real.
- Un mensaje `ACK` (no ORU) sigue respondiendo AA sin persistir.

**Esfuerzo: ~0,5 día.**

---

## PAQUETE F — `audit_log`: implementado y jamás llamado

**Prioridad: media-baja** en urgencia operativa, **alta** en términos
regulatorios.

`schema.sql` crea `audit_log` con dos índices y `XsRepo.appendAudit()` está
escrito… y **no lo llama nadie**. En contexto clínico, quién cambió la
configuración y cuándo, y por qué un mensaje falló, no es opcional.

### F.1 — Qué auditar

**Criterio: cambios de estado y fallas, NO cada resultado.** El "cuándo entró
cada resultado" ya está en `results.received_at`; duplicarlo infla la tabla
(200 filas/día) sin agregar información.

| Evento | Nivel | Dónde | Contexto |
|---|---|---|---|
| `service.started` | info | `main.ts` | versión, modo, puertos, dbPath, exportDir |
| `service.stopped` | info | `main.ts` | señal |
| `db.not_writable` | error | `main.ts` | dbPath, error |
| `config.updated` | info | `updateConfig` | **diff `{campo:{from,to}}`** ← el más importante |
| `config.mode_switched` | info | `updateConfig` | from, to, analyzerHost |
| `export.dir_unwritable` | error | `updateConfig` / `TxtExporter` | dir, error |
| `export.txt_failed` | error | `TxtExporter` | **solo en la transición ok→falla** |
| `hl7.parse_error` | error | `MessageProcessor` | peer, messageControlId, snippet |
| `hl7.duplicate` | info | `MessageProcessor` | messageControlId |
| `hl7.unexpected_version` / `charset_replacement_chars` | warn | `MessageProcessor` | ver D.2 |
| `retention.purged` | info | `main.ts` | filas, días |
| `update.downloaded` | info | `UpdateChecker` | versión |

El diff de `config.updated` es el de mayor valor. El "quién" es siempre la UI
local (no hay usuarios); anotarlo explícitamente para que nadie asuma identidad.

### F.2 — Cómo llamarlo sin agregar riesgo

**Invariante:** una escritura de auditoría **nunca** puede voltear la ruta del
request ni el procesamiento de un mensaje. Helper `apps/service/src/db/audit.ts`:

```ts
export function safeAudit(repo: XsRepo, logger: Logger, params: {...}): void {
  try { repo.appendAudit({ occurredAt: new Date(), ...params }); }
  catch (e) { logger.error("audit.append_failed", { error: (e as Error).message }); }
}
```

Todos los call sites usan `safeAudit`, ninguno `appendAudit` directo. Crítico en
`MessageProcessor`, donde ya existe el invariante de que nada puede impedir el
ACK.

**Retención:** unas pocas filas por día. **No purgar** (5 años son pocos MB, y es
justamente lo que uno quiere conservar).

### F.3 — Exposición

**DECISIÓN D7.** Recomendación: **no construir UI ahora**. `LogsView` ya muestra
el stream en vivo, que es lo que la operadora necesita día a día. La auditoría es
para soporte y para una eventual auditoría regulatoria.

Punto medio barato (~1 h): `GET /api/audit?limit&eventType&fromDate` reutilizando
`parseLimitParam`, con auth.

### F.4 — `service_config`: tabla muerta

Se crea y nunca se escribe: la configuración vive en `settings.json`.
**DECISIÓN D10**, cosmética. Recomendación: migración
`{version: 3, name: "drop_service_config", up: db => db.exec("DROP TABLE IF EXISTS service_config")}`.
**No editar `schema.sql`** (regla de oro): las instalaciones nuevas la crean y la
migración la borra acto seguido, que es feo pero consistente.

### Tests

- `safeAudit` con un repo que lanza → no propaga, y el logger recibe
  `audit.append_failed`.
- `PUT /api/config` que cambia `logLevel` deja **una** fila `config.updated` cuyo
  `context` contiene `{logLevel: {from:"info", to:"debug"}}`.
- Un HL7 malformado deja `hl7.parse_error` **y** el ACK `AE` sigue saliendo.
- Diez fallos seguidos de export dejan **una sola** fila (dedupe por transición).

**Esfuerzo: ~0,5–1 día.**

---

## Resumen de esfuerzo y secuenciación

| Paquete | Contenido | Esfuerzo | Depende de |
|---|---|---|---|
| A | `/api/results`: limit + fechas + cursor + UI | 1–1,5 días | migración v2 |
| B | Salud de `exportDir` | ~1 día | — |
| C | `test-connection` | ~2 h | — |
| D | Escapes HL7 + MSH-12/18 | 0,5–1 día | — |
| E | Contrato honesto | ~0,5 día | se solapa con D.2 |
| F | `audit_log` | 0,5–1 día | conviene después de B y D |
| *(opcional)* | `reprocess` (decisión D4) | +0,5 día | E |

**Total sin el reproceso: 5 a 7 días de agente.**

A, B, C y D son **independientes entre sí**. F conviene al final porque audita
eventos que introducen B y D. Dentro de A el orden interno importa: **A.2
(normalización de fechas) tiene que salir antes o junto con el filtro de fechas
de la UI en A.3**, si no se expone un filtro que devuelve rangos equivocados.

## Notas para el ejecutor

- Este plan pone lógica nueva en **módulos nuevos** (`listener/probe-connection.ts`,
  `hl7/escape.ts`, `db/audit.ts`) y usa **métodos nuevos** en vez de cambiar
  firmas existentes (`listResultsPage` junto a `listResults`) para minimizar
  conflictos. Mantener ese criterio.
- Antes de empezar, releer el encabezado de `db/migrate.ts`: la regla de que
  `schema.sql` está congelado no es negociable y es fácil de violar sin querer.
- Todo mensaje visible por la operadora va en castellano rioplatense y dice **qué
  pasó, qué consecuencia tiene y qué hacer** — seguir el modelo de
  `db.not_writable` en `main.ts` y del bloque de DB no escribible en
  `StatusView`, que son los mejores ejemplos del repo.
- Cada paquete debería cerrar actualizando `docs/03-contrato-http.md` en el mismo
  commit. La causa raíz de este frente entero es doc y contrato que se
  adelantaron a la implementación y nadie volvió a sincronizar.
