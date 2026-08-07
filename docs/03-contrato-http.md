# 03 — Contrato HTTP entre servicio y UI

## Convenciones

- Base URL: `http://127.0.0.1:7700` (configurable, solo escucha en loopback).
- Respuestas y request bodies: JSON con `Content-Type: application/json; charset=utf-8`.
- Errores siempre con shape `{ "error": { "code": string, "message": string, "details"?: any } }`.
- Timestamps siempre en ISO 8601 con timezone (`2026-04-27T15:32:11.234-03:00`).
- Auth (fase 1): bind a `127.0.0.1` y un token estático en `X-XS20-Token` que la UI lee del archivo de configuración en `%PROGRAMDATA%`. Suficiente para evitar que otra app local lea los datos.

## Endpoints

### Resultados

#### `GET /api/results`

Lista resultados con paginación por cursor.

**Query params:**

| Param | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `fromDate` | ISO 8601 | — | Filtra por `receivedAt >= fromDate` |
| `toDate` | ISO 8601 | — | Filtra por `receivedAt <= toDate` |
| `search` | string | — | Match parcial en `sampleId`, `patientId`, `name` |
| `limit` | int | 50 | Max 500 |
| `cursor` | string | — | Cursor opaco devuelto en respuesta previa |

**Respuesta 200:**

```json
{
  "results": [
    {
      "id": "01HMPK...",
      "receivedAt": "2026-04-27T15:32:11.234-03:00",
      "sampleId": "dz-1-19",
      "patientName": "Pérez, Juan",
      "patientId": "MR123456",
      "abnormalCount": 2,
      "morphologyFlagCount": 1
    }
  ],
  "nextCursor": "eyJpZCI6Ij..."
}
```

#### `GET /api/results/:id`

Devuelve el resultado completo (valores, histogramas, flags morfológicas).

**Query params:**

| Param | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `includeRaw` | bool | false | Si true, incluye `rawHl7` (base64 del HL7 original) |

**Respuesta 200:** un `HemogramResult` (ver `packages/shared/src/hemogram.ts`), con histogramas serializados como base64.

**Respuesta 404:** `{"error":{"code":"RESULT_NOT_FOUND","message":"..."}}`.

#### `GET /api/results/:id/histogram/:type`

Devuelve los 256 bytes binarios crudos de un histograma. Útil para descargas/export.

- `:type` ∈ `wbc | rbc | plt`
- Respuesta 200: `Content-Type: application/octet-stream`, body = 256 bytes.

### Configuración

#### `GET /api/config`

Devuelve la configuración actual del servicio (`ServiceConfig`).

#### `PUT /api/config`

Actualiza configuración. Body: `UpdateConfigRequest` (campos editables:
`connectionMode`, `analyzerHost`, `analyzerPort`, `tcpHost`, `tcpPort`, `logLevel`,
`rawRetentionDays` — todos opcionales, se aplica solo lo enviado).
Respuesta: `UpdateConfigResponse` con la config resultante y el flag `restartRequired`.

**Todos los cambios se aplican en caliente, sin reiniciar el servicio** (`restartRequired`
siempre `false`):

- `connectionMode`: cambia quién inicia la conexión TCP (ver `docs/01-protocolo-hl7.md`).
  Al pasar a `connect` se para el listener y arranca el cliente saliente; al pasar a
  `listen`, al revés. Si el servicio arrancó sin cliente saliente, responde
  `409 MODE_SWITCH_UNAVAILABLE`.
- `analyzerHost` / `analyzerPort`: redirigen el cliente saliente en caliente
  (`AnalyzerClient.reconfigure`). No falla si el equipo está apagado: entra en el ciclo
  de reintentos y el estado queda visible en `/api/health`.
- `tcpHost` / `tcpPort`: reinician solo el listener TCP (`TcpServer.reconfigure`). Las
  conexiones abiertas del analizador se cierran y el equipo reconecta solo. Si el nuevo
  host/puerto no se puede bindear (ocupado, IP no asignable), se revierte al anterior y
  responde `409 TCP_BIND_FAILED`.
- `logLevel`: cambia el nivel del logger al instante.
- `rawRetentionDays`: se usa en la próxima corrida de purga.

El `httpPort` **no** es editable por acá (la UI perdería la conexión con la API). Los
valores válidos se persisten en `<dataDir>/config/settings.json` y se recargan al arrancar.

Validaciones (todas devuelven `400 VALIDATION_ERROR` con mensaje): `connectionMode` en
`listen|connect`; `analyzerHost` IPv4 válida y distinta de `0.0.0.0` (obligatoria si el
modo resultante es `connect`); `analyzerPort` entero 1–65535; `tcpPort` entero 1–65535
y distinto del `httpPort`; `tcpHost` IPv4 válida, `0.0.0.0` o `localhost`; `logLevel` en
`debug|info|warn|error`; `rawRetentionDays` entero 0–3650.

### Health / status

#### `GET /api/health`

Devuelve `HealthResponse` con estado del transporte TCP, DB, último mensaje recibido, etc. Sin auth — sirve para que el instalador / monitoreo confirmen que el servicio arrancó.

`connectionMode` dice qué modo está activo. En modo `connect`, el campo `analyzerClient`
trae el detalle de la conexión saliente (`connected`, `address:port`, `connectedAt`,
`lastError`) y es `null` en modo `listen`. El `status` general es `ok` sólo si el transporte
activo está sano: en modo `connect` eso significa **conectado al analizador**, así que con
el equipo apagado el servicio reporta `degraded` (que es correcto: está vivo pero no puede
recibir resultados).

`tcpListener` se mantiene en los dos modos para no romper consumidores: en modo `connect`,
`listening` indica que el cliente está activo y `address:port` es la dirección del equipo.

### Logs en vivo (SSE)

#### `GET /api/logs/stream`

Stream `text/event-stream`. Cada evento es un `LogEvent` JSON.

Ejemplo:

```
event: log
data: {"time":"2026-04-27T15:32:11.234Z","level":"info","msg":"HL7 received","ctx":{"sampleId":"dz-1-19","bytes":2847}}

event: log
data: {"time":"2026-04-27T15:32:11.301Z","level":"debug","msg":"OBX parsed","ctx":{"code":"6690-2","value":5.2}}
```

Heartbeat: el servidor envía `: heartbeat\n\n` cada 30 segundos para mantener viva la conexión.

### Acciones de servicio (fase 1.5+)

#### `POST /api/actions/reprocess/:rawMessageId`

Vuelve a parsear un `raw_message` con la versión actual del parser. Útil si encontramos un bug y queremos reprocesar mensajes históricos.

#### `POST /api/actions/test-connection`

Body: `{ "host": "192.168.1.X", "port": 5100 }`. Abre un socket TCP al equipo y devuelve si pudo conectar. No envía nada — solo prueba el TCP handshake.

## Ejemplo de integración desde la UI

```ts
// apps/ui/src/main/api-client.ts
import type { ListResultsResponse, GetResultResponse } from "@xs20/shared";

const BASE = "http://127.0.0.1:7700";
const TOKEN = await loadTokenFromConfig();

export async function listResults(query: ListResultsQuery = {}) {
  const params = new URLSearchParams(query as any);
  const res = await fetch(`${BASE}/api/results?${params}`, {
    headers: { "X-XS20-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ListResultsResponse;
}

export function streamLogs(onEvent: (e: LogEvent) => void) {
  const es = new EventSource(`${BASE}/api/logs/stream?token=${TOKEN}`);
  es.addEventListener("log", (e) => onEvent(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}
```

## Versionado

Por ahora todos los endpoints son v1 implícito. Si hace falta romper compatibilidad, `/api/v2/...`.
