# Wiener XS 20 Bridge

Aplicación Windows para recibir, almacenar y visualizar resultados de hemograma
del analizador **Wiener Lab Counter XS 20** (rebrand del Mindray BC-20s) vía
HL7 v2.3.1 sobre MLLP/TCP.

## Arquitectura

Monorepo con dos procesos independientes que corren en la misma PC del laboratorio:

```
┌──────────────────────────────────────────────────────────────┐
│  PC Windows del laboratorio                                   │
│                                                               │
│  ┌──────────────────────┐         ┌────────────────────┐     │
│  │ apps/service         │         │ apps/ui            │     │
│  │ (.exe / Win service) │◄───────►│ (Tauri + React)    │     │
│  │                      │  HTTP   │                    │     │
│  │ - TCP listener MLLP  │ :7700   │ - Dashboard        │     │
│  │ - Parser HL7 v2.3.1  │         │ - Detalle + histos │     │
│  │ - SQLite             │         │ - Logs en vivo     │     │
│  │ - HTTP API + SSE     │         │ - Estado           │     │
│  └──────────┬───────────┘         └────────────────────┘     │
│             │ TCP :5100 (configurable)                        │
└─────────────┼─────────────────────────────────────────────────┘
              ▲
              │ HL7 sobre MLLP
       ┌──────┴──────┐
       │   XS 20     │
       └─────────────┘
```

La UI (Tauri) usa el **WebView2** que Windows 11 ya trae, así que el instalador
es liviano. El shell nativo lanza el servicio al abrir y lo cierra al salir.

### Quién inicia la conexión TCP

El XS 20 se puede configurar de las dos formas, y el servicio soporta ambas
(`connectionMode`, editable desde la app en **Estado → Configuración**):

| Modo | Quién escucha | Quién disca |
|------|---------------|-------------|
| `connect` | el XS 20 (en su IP, puerto 5100) | el servicio, y reconecta solo |
| `listen` | el servicio (`0.0.0.0:5100`) | el XS 20 |

**En el equipo verificado el modo correcto es `connect`**: el analizador actúa
como servidor TCP. Ver [`docs/01-protocolo-hl7.md`](docs/01-protocolo-hl7.md)
para cómo determinar en qué modo está tu equipo.

## Workspaces

| Path | Propósito | Stack |
|------|-----------|-------|
| `apps/service` | TCP listener MLLP + parser HL7 + SQLite + HTTP API | Bun, bun:sqlite |
| `apps/ui` | App de escritorio (interfaz) | Tauri, React, Vite, Tailwind |
| `packages/shared` | Tipos + generador de mensajes de prueba | TypeScript |
| `scripts` | Simulador del XS 20 (equipo virtual) | Bun |
| `docs` | Documentación técnica | Markdown |

## Estado

- **Servicio**: ✅ completo. 90 tests verdes. Robustecido (retención de datos,
  idle timeout, protocolo aislado en `protocol-map.ts`). `.exe` de Windows probado
  en Windows 11 real. Habla los dos modos de conexión (`listen` y `connect`), con
  reconexión automática y backoff en `connect`.
- **Simulador**: ✅ completo. Genera mensajes HL7 realistas y variados en 5 modos
  (single / batch / loop / fixture / serve). Tu "equipo virtual" para desarrollar
  sin el analizador físico; `serve` hace de analizador para probar modo `connect`.
- **UI**: ✅ completa. Cuatro pantallas (resultados, detalle, actividad, estado).
  Typecheck limpio, buildea. Contrato con la API verificado. La pantalla **Estado**
  permite configurar IP/puerto de escucha, nivel de log y retención **desde la app**,
  aplicados en caliente (sin reiniciar el servicio).
- **Tauri**: ✅ corre en Windows 11 real. El crate Rust compila y la app abre la
  ventana nativa, lanza el servicio, lee el token (`withGlobalTauri`) y la API
  responde. El instalador NSIS se compila desde la Mac con `bun run release`
  — ver `docs/10-build-windows.md`.

## Quickstart (desarrollo, sin equipo físico)

```bash
bun install

# Terminal 1: el servicio
bun run dev:service

# Terminal 2: datos de prueba
bun run scripts/simulator/index.ts --mode=batch --count=30
#   o en vivo, simulando un día de laboratorio:
bun run scripts/simulator/index.ts --mode=loop --interval=4000

# Para probar el modo "connect" (el simulador hace de equipo y escucha):
bun run scripts/simulator/index.ts --mode=serve --port=5199 --count=5 --interval=500
#   y el servicio saliendo a buscarlo:
cd apps/service && bun run src/main.ts --console \
  --mode=connect --analyzer-host=127.0.0.1 --analyzer-port=5199

# Terminal 3: la UI (se abre en http://localhost:1420)
bun run dev:ui
```

Si el servicio pide token, en la consola del navegador:
`localStorage.setItem("xs20_token", "<token de api-token.txt>")`

## Tests y typecheck

```bash
bun test          # 74 tests del servicio
bun run typecheck # shared + service + ui + scripts
```

## Build

```bash
# Servicio → .exe de Windows (x64 baseline y ARM64)
bun run build:service:windows        # → apps/service/dist/xs20-service.exe

# Todo junto: compila, calcula el sha256 y publica en el VPS.
# Cruza macOS → Windows con cargo-xwin; no hace falta una PC con Windows.
bun run bump 0.2.0 && git commit -am "v0.2.0"
bun run release                      # --no-deploy para no subir nada
```

El paso a paso, los requisitos del toolchain y las variables de `.release.env`
están en [`docs/10-build-windows.md`](docs/10-build-windows.md).

## Documentación

- [`docs/01-protocolo-hl7.md`](docs/01-protocolo-hl7.md) — El protocolo HL7 v2.3.1 del XS 20.
- [`docs/02-schema-db.md`](docs/02-schema-db.md) — Schema de la base SQLite.
- [`docs/03-contrato-http.md`](docs/03-contrato-http.md) — Endpoints HTTP + SSE.
- [`docs/04-mapeo-obx.md`](docs/04-mapeo-obx.md) — Mapeo OBX → hemograma.
- [`docs/05-debug-y-logs.md`](docs/05-debug-y-logs.md) — Debug en dev y producción.
- [`docs/06-plan-fase-1.md`](docs/06-plan-fase-1.md) — Plan Fase 1 (✅ completado).
- [`docs/07-instalacion-windows.md`](docs/07-instalacion-windows.md) — Instalar el servicio con NSSM.
- [`docs/08-quickstart-linux.md`](docs/08-quickstart-linux.md) — Quickstart en Linux.
- [`docs/09-ui-tauri.md`](docs/09-ui-tauri.md) — La UI y su arquitectura.
- [`docs/10-build-windows.md`](docs/10-build-windows.md) — **Compilar y publicar el instalador Windows.**
- [`docs/11-exportacion-txt.md`](docs/11-exportacion-txt.md) — Exportación de resultados a `.txt`.
- [`docs/12-actualizaciones.md`](docs/12-actualizaciones.md) — Actualizaciones automáticas (manifest y VPS).

## Cuando llegue el equipo físico

El primer archivo a revisar es **`apps/service/src/hl7/protocol-map.ts`**. Ahí está
aislado todo lo que se dedujo de la documentación del fabricante, marcado por nivel
de confianza (`[CONFIRMADO-DOC]`, `[INFERIDO]`, `[SOSPECHA]`). Si algún valor no
matchea con el equipo real, se corrige ahí y en ningún otro lado.
