# 09 — UI de escritorio (React + Tauri)

La interfaz es una app React que consume la API HTTP local del servicio. Se
empaqueta con **Tauri**, que usa el **WebView2** que Windows 11 ya trae
preinstalado — por eso el instalador es liviano (~10-15 MB) y no bundlea un
navegador entero como haría Electron.

## Arquitectura

```
┌──────────────────── Ventana Tauri ────────────────────┐
│                                                        │
│   WebView2 (Chromium del sistema)                      │
│   └── React app (Vite build)                           │
│        └── fetch() → http://127.0.0.1:7700/api         │
│                                                        │
│   Shell nativo (Rust, src-tauri/src/main.rs):          │
│    - lanza xs20-service.exe al abrir                    │
│    - lee api-token.txt y se lo pasa al frontend         │
│    - mata el servicio al cerrar                         │
└────────────────────────────────────────────────────────┘
```

El frontend hace todo el trabajo visual. El shell Rust es mínimo: arranca el
servicio y gestiona el token. Nada de lógica de negocio en Rust.

## Desarrollo (sin equipo, contra el simulador)

No necesitás Rust para desarrollar la UI — corre en el navegador con Vite.

```bash
# Terminal 1 — servicio
bun run dev:service

# Terminal 2 — datos de prueba (elegí uno)
bun run scripts/simulator/index.ts --mode=batch --count=30      # 30 de golpe
bun run scripts/simulator/index.ts --mode=loop --interval=4000  # uno cada 4s

# Terminal 3 — la UI
bun run dev:ui
# abrí http://localhost:1420
```

Si el servicio pide token, en la consola del navegador:

```js
localStorage.setItem("xs20_token", "<token de api-token.txt>")
```

En dev, el `data-dir` por defecto del servicio en Linux es
`~/.local/share/wiener-xs20/`, así que el token está en
`~/.local/share/wiener-xs20/config/api-token.txt`.

## Las cuatro pantallas

- **Resultados** — lista/dashboard. KPIs arriba (recibidos, con anormalidades,
  con alarmas), buscador, tabla densa. Se refresca sola cuando llega un
  resultado nuevo (escucha el evento `hl7.parsed` por SSE).
- **Detalle** — al clickear un resultado: valores agrupados por serie (blanca,
  roja, plaquetas) con rangos de referencia y flags, alarmas morfológicas, y los
  histogramas.
- **Actividad** — logs del servicio en vivo (SSE), con filtro por nivel y pausa.
- **Estado** — health del servicio: conexión TCP, base de datos, uptime.

## Build de escritorio (Tauri)

### Requisitos (una sola vez, en la máquina de build)

- **Rust**: https://rustup.rs/
- **Windows**: Microsoft C++ Build Tools + WebView2 (viene con Windows 11).
- Dependencias de Tauri: https://tauri.app/start/prerequisites/

### Compilar

```bash
bun run tauri:build
# produce el instalador en:
#   apps/ui/src-tauri/target/release/bundle/nsis/*.exe
#   apps/ui/src-tauri/target/release/bundle/msi/*.msi
```

### Empaquetado final

El instalador de la UI y el `xs20-service.exe` van juntos. Dos opciones:

1. **Servicio + UI en la misma carpeta**: poné `xs20-service.exe` junto al
   ejecutable de la app. El shell Rust lo lanza al abrir y lo mata al cerrar.
   Ideal si el usuario abre la app manualmente.

2. **Servicio como servicio de Windows (recomendado para producción)**:
   instalá `xs20-service.exe` con NSSM (ver `docs/07`) para que corra siempre en
   background con auto-arranque. La UI detecta que ya está corriendo y no lo
   vuelve a lanzar. Ideal para una PC de laboratorio que queda prendida.

## Íconos

Tauri necesita íconos en `src-tauri/icons/`. Para generarlos desde un PNG:

```bash
bun run tauri icon path/al/logo.png
# genera todos los tamaños (ico, png, icns) automáticamente
```

Hasta que tengas un logo, Tauri usa uno por defecto.

## Notas de estilo

La UI sigue el design system de Craftly (ver el skill `ui-taste`):
- Neutros cálidos + acento azul clínico.
- Geist (sans) para UI, Geist Mono para datos.
- Los histogramas usan **tick bars segmentadas** — el dispositivo de firma.
- Activo en el sidebar = bloque gris suave quieto (sin bordes/insets).
- Chips de estado con pastel bg + texto saturado del mismo tono.
