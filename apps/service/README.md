# @xs20/service

Servicio Windows que escucha el TCP del XS 20, parsea HL7 y persiste en SQLite.

## Estructura prevista (Fase 1)

```
src/
├── main.ts                    # Entrypoint, arma todo y arranca
├── config.ts                  # Lee config (puerto TCP, paths, etc.) + flags CLI
├── logger.ts                  # Pino + rotación + flag --console
├── db/
│   ├── schema.sql             # DDL de SQLite (ver docs/02-schema-db.md)
│   ├── migrate.ts             # Ejecuta el DDL si la DB no existe
│   └── repo.ts                # Queries tipadas (insertResult, listResults, etc.)
├── hl7/
│   ├── mllp.ts                # Frame/unframe MLLP (<VT>...<FS><CR>)
│   ├── parser.ts              # HL7 v2.3.1 → árbol de segmentos
│   ├── obx-mapper.ts          # OBX → HemogramResult (ver docs/04-mapeo-obx.md)
│   ├── ack.ts                 # Construye ACK^R01 con MSA|AA|<MSH-10>
│   └── histogram.ts           # Decodifica Base64 → Uint8Array de 256 bytes
├── listener/
│   └── tcp-server.ts          # Bun.listen + maneja conexiones largas + heartbeat
├── http/
│   ├── server.ts              # Bun.serve para la API local
│   ├── routes/
│   │   ├── results.ts         # GET /api/results, GET /api/results/:id
│   │   ├── config.ts          # GET/PUT /api/config
│   │   ├── health.ts          # GET /api/health
│   │   └── logs.ts            # GET /api/logs/stream (SSE)
│   └── auth.ts                # Token simple en header (binding 127.0.0.1)
└── events.ts                  # EventEmitter interno para "result-received", etc.
```

## Notas de diseño

- **Single-binary**: todo se compila a `dist/xs20-service.exe` con `bun build --compile`.
- **Bind localhost only**: la HTTP API solo escucha en `127.0.0.1:7700`. El TCP del XS 20 escucha en `0.0.0.0:5100` (o el puerto configurado).
- **Sin estado en memoria**: cada resultado se persiste antes de enviar el ACK. Si el proceso muere, no hay nada que perder.
- **Backpressure**: si la DB tarda en escribir, el ACK al XS 20 se demora — pero el XS 20 espera hasta 4 segundos. Si la escritura SQLite tardara más, hay un problema serio.
