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
│    - lanza xs20-service.exe al abrir (solo si no hay    │
│      un servicio ya escuchando en el puerto 7700)       │
│    - lee api-token.txt y se lo pasa al frontend         │
│    - lanza el instalador de updates (run_installer)     │
│    - mata el servicio hijo al cerrar                    │
└────────────────────────────────────────────────────────┘
```

El frontend hace todo el trabajo visual. El shell Rust es mínimo: arranca el
servicio, gestiona el token y expone dos comandos (`get_api_token` y
`run_installer`, este último para el flujo de actualizaciones — ver
`docs/12-actualizaciones.md`). Nada de lógica de negocio en Rust.

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
- **Estado** — health del servicio: conexión TCP, base de datos, uptime, y la
  card "Actualizaciones" (buscar ahora, toggle de chequeo automático). Al final,
  separada del grid de cards, la sección **Mantenimiento** (ver abajo).

Además hay un **banner global de actualizaciones** (`components/UpdateBanner.tsx`
+ `hooks/useUpdateStatus.ts`) que aparece en cualquier vista cuando el servicio
detectó una versión nueva: descargar con progreso → "Instalar y reiniciar"
(cierra la app y lanza el instalador via el comando `run_installer`).

## Mantenimiento: borrar la base

Al fondo de Estado, fuera del grid de cards y detrás de un borde. Está ahí a
propósito: romper el ritmo visual hace que no se lea como "una opción más de la
lista", y queda al final de un scroll largo.

Borra todos los resultados guardados para que el analizador pueda reenviarlos
desde cero con su función "enviar todo" (`POST /api/maintenance/wipe-database`).

La confirmación **no es un doble clic**: hay que escribir `BORRAR` en un input
para que el botón se habilite. Un doble clic son dos clics seguidos en el mismo
lugar, que es exactamente lo que hace alguien apurado. El texto se compara con
`trim()` y sin distinguir mayúsculas — pelearle eso a quien ya escribió la
palabra a propósito es fricción sin señal.

El servidor exige la palabra **también en el body**: la validación de la UI vive
del lado del cliente y un refactor la puede evaporar sin que ningún test del
servicio se entere. Ver `docs/03-contrato-http.md`.

Los `.txt` ya exportados no se tocan (`docs/11-exportacion-txt.md`), y el
borrado queda anotado en el log (`db.wiped`, nivel warn, visible en Actividad) y
en `audit_log`.

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
```

### Empaquetado final

El instalador NSIS lleva todo adentro: la app, `xs20-service.exe`, `nssm.exe` y
los scripts de registración. Al instalar deja el servicio de Windows
**WienerXS20Service** corriendo con auto-arranque, y la UI detecta que ya está
corriendo (sonda al puerto 7700) y no lo vuelve a lanzar. Ver
`docs/07-instalacion-windows.md` y `docs/10-build-windows.md` (sección "Qué
empaqueta el instalador").

En dev (o en macOS/Linux, sin servicio registrado), el shell lanza
`xs20-service` como proceso hijo al abrir y lo mata al cerrar.

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
