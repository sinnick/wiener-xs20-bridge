# @xs20/ui

Interfaz de escritorio del Wiener XS 20 Bridge. React + Vite + Tailwind, empaquetada con Tauri.

## Desarrollo (contra el simulador, sin equipo)

En una terminal, arrancá el servicio:

```bash
cd ../.. && bun run dev:service
```

En otra, cargá datos de prueba con el simulador:

```bash
cd ../.. && bun run scripts/simulator/index.ts --mode=batch --count=30
# o simulá un día de laboratorio en vivo:
cd ../.. && bun run scripts/simulator/index.ts --mode=loop --interval=4000
```

En una tercera, arrancá la UI en el navegador:

```bash
bun run dev
# abre http://localhost:1420
```

Vite proxea `/api` hacia `http://127.0.0.1:7700`, así que la UI ve al servicio sin CORS.
Si el servicio tiene token, seteálo en la consola del navegador:

```js
localStorage.setItem("xs20_token", "<el token de api-token.txt>")
```

## Estructura

```
src/
├── main.tsx              # Entrypoint (resuelve el token, monta React)
├── App.tsx               # Layout: sidebar + routing por estado
├── lib/
│   └── api.ts            # Cliente HTTP del servicio (results, health, logs SSE)
├── components/
│   ├── Histogram.tsx     # Histograma con tick bars segmentadas (signature)
│   └── primitives.tsx    # Chips de flags, labels, formateo
└── pages/
    ├── ResultsList.tsx   # Lista/dashboard principal
    ├── ResultDetail.tsx  # Detalle: valores + histogramas + alarmas
    ├── LogsView.tsx      # Logs en vivo (SSE)
    └── StatusView.tsx    # Estado del servicio (health)

src-tauri/                # Shell nativo (Rust)
├── src/main.rs           # Lanza el servicio, lee el token, cierra al salir
├── Cargo.toml
├── build.rs
└── tauri.conf.json
```

## Build de escritorio (Tauri → .exe/.msi)

Requiere Rust + las dependencias de Tauri instaladas (ver docs/09).

```bash
bun run tauri build
# produce el instalador en src-tauri/target/release/bundle/
```

En Windows, el instalador NSIS/MSI empaqueta la UI + el WebView2 (que Windows 11 ya trae).
Poné `xs20-service.exe` junto al ejecutable de la app y el shell lo lanza al arrancar.
