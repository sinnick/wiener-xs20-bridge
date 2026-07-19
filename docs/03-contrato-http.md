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

Actualiza configuración. Body: `UpdateConfigRequest`. Respuesta: `UpdateConfigResponse` con flag `restartRequired`.

Cambios que requieren restart: `tcpPort`, `tcpHost`, `httpPort`. Cambios en caliente: `logLevel`, `rawRetentionDays`.

### Health / status

#### `GET /api/health`

Devuelve `HealthResponse` con estado del listener TCP, DB, último mensaje recibido, etc. Sin auth — sirve para que el instalador / monitoreo confirmen que el servicio arrancó.

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
