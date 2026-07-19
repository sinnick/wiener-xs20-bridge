# 06 — Plan de Fase 1

## Objetivo

Tener el **servicio funcionando aislado**, validado contra el simulador, antes de tocar la UI.

Criterio de éxito: corro `bun run dev:simulator` en una terminal y `bun run dev:service` en otra, y al cabo de unos segundos veo el resultado persistido en SQLite y devuelvo el ACK correcto. Repetible, idempotente, observable por logs.

## Pasos

### 1.1 — MLLP framing (1-2 horas)

`apps/service/src/hl7/mllp.ts`

- Función `frameMllp(hl7: string): Uint8Array` — envuelve en `<VT>...<FS><CR>`.
- Función `unframeMllp(buffer: Uint8Array): { messages: string[], remaining: Uint8Array }` — toma un buffer (potencialmente con varios mensajes o un mensaje incompleto), devuelve los mensajes completos extraídos y el remainder no consumido (para mensajes que llegan partidos en varios reads del socket).
- Tests: input vacío, mensaje completo, mensaje parcial, dos mensajes seguidos, basura entre mensajes.

### 1.2 — Parser HL7 (3-4 horas)

`apps/service/src/hl7/parser.ts`

- Función `parseHl7(text: string): Hl7Message` — devuelve el AST genérico.
- Helper `getSegment(msg, name): Hl7Segment[]` — todos los segmentos con ese nombre.
- Helper `getField(seg, n): Hl7Field` — campo n-ésimo (1-indexed según convención HL7).
- Helper `getComponent(field, n): string` — componente n-ésimo del primer rep.
- Tests: cada fixture en `scripts/fixtures/`.

### 1.3 — OBX mapper (2-3 horas)

`apps/service/src/hl7/obx-mapper.ts`

- Tabla de constantes con el mapeo `OBX-3 código → HemogramParam` (ver `docs/04-mapeo-obx.md`).
- Función `mapMessageToHemogram(msg: Hl7Message): HemogramResult`.
- Tests: ejemplo normal, anormal, con histogramas, con OBX desconocidos.

### 1.4 — Histogram decoder (1 hora)

`apps/service/src/hl7/histogram.ts`

- Función `decodeHistogram(obxField: string): Uint8Array` — parsea OBX-5 con formato ED y devuelve los 256 bytes.
- Validación: si decoded.length !== 256, error.

### 1.5 — ACK builder (30 min)

`apps/service/src/hl7/ack.ts`

- `buildAck(originalMshControlId: string, status: 'AA' | 'AE' | 'AR', errorMsg?: string): string`.

### 1.6 — SQLite setup (2 horas)

`apps/service/src/db/`

- `schema.sql` — el DDL de `docs/02-schema-db.md`.
- `migrate.ts` — abre la DB con `bun:sqlite`, si no tiene tablas ejecuta el DDL.
- `repo.ts` — funciones tipadas: `insertResult(result: HemogramResult, raw: string)`, `listResults(query)`, `getResult(id)`.

### 1.7 — TCP listener (3 horas)

`apps/service/src/listener/tcp-server.ts`

- `Bun.listen({ port, hostname, socket: { open, data, close, error } })`.
- Buffer por conexión: acumular bytes, intentar `unframeMllp`, por cada mensaje completo: parsear, persistir, ACK.
- Manejo de ENQ (0x10) → responder ACK (0x06).
- Manejo de heartbeat (0x02) → ignorar.
- Logs por evento (ver `docs/05-debug-y-logs.md`).

### 1.8 — HTTP API mínima (2 horas)

`apps/service/src/http/server.ts`

- `Bun.serve({ port: 7700, fetch: router })`.
- Endpoints: `GET /api/health`, `GET /api/results`, `GET /api/results/:id`.
- (Logs SSE quedan para 1.10).

### 1.9 — Simulador del XS 20 (2 horas)

`scripts/simulator/index.ts`

- Conecta TCP al servicio.
- Envía ENQ, espera ACK.
- Lee uno de los fixtures, lo enmarca con MLLP, lo envía.
- Espera el ACK^R01.
- Loggea todo el flujo.

Modo CLI:

```bash
bun run dev:simulator -- --host=127.0.0.1 --port=5100 --fixture=oru-r01-normal
```

### 1.10 — Logs SSE (1 hora)

Buffer circular en memoria + endpoint `GET /api/logs/stream`.

### 1.11 — Build a .exe + smoke test en Windows (2 horas)

- `bun build src/main.ts --compile --target=bun-windows-x64 --outfile dist/xs20-service.exe`.
- Probar el .exe en una VM Windows (o tu equipo si está en Pop!_OS dual-boot / Wine).
- Validar que `--console` funciona, que abre el TCP y el HTTP, que persiste a SQLite.

### 1.12 — Documentar instalación con NSSM (1 hora)

`docs/07-instalacion-windows.md` con los comandos exactos de NSSM para registrar el servicio.

## Total estimado: ~20 horas de trabajo concentrado

## Lo que NO hacemos en Fase 1

- UI Tauri (Fase 2).
- Webhook a sistemas externos (Fase 3 si se decide).
- Métricas Prometheus.
- Schema migrations sofisticadas (alcanza con `if not exists` por ahora).
- Tests E2E con un Windows real automatizado (manual por ahora).
