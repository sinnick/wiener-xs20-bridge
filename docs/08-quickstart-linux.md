# 08 — Quickstart para probar en Ubuntu/Linux

Esta guía te lleva de cero a tener el servicio corriendo y enviándole mensajes desde el simulador en menos de 5 minutos.

## Opción A — Con Bun instalado (recomendado para iterar)

### 1. Instalar Bun (una sola vez)

```bash
curl -fsSL https://bun.sh/install | bash
# o si ya tenés npm:
npm install -g bun
```

Verificar: `bun --version` debe mostrar 1.1.0 o superior.

### 2. Instalar dependencias del repo

```bash
cd wiener-xs20-bridge
bun install
```

### 3. Correr los tests

```bash
cd apps/service && bun test
```

Tenés que ver `57 pass / 0 fail`.

### 4. Arrancar el servicio (terminal 1)

```bash
cd apps/service && bun run dev
```

Verás logs con colores. El servicio queda escuchando:

- TCP `0.0.0.0:5100` (donde se conectaría el XS 20)
- HTTP `127.0.0.1:7700` (la API local)

Por defecto guarda todo en `~/.local/share/wiener-xs20/` (db, logs, token).

### 5. Enviar un mensaje desde el simulador (terminal 2)

```bash
cd wiener-xs20-bridge
bun run scripts/simulator/index.ts --mode=fixture --fixture=normal
```

Vas a ver:

```
[envio] conectando a 127.0.0.1:5100...
[envio] conectado
[envio] envie 1412 bytes (MSH-10 = 1001)
[envio] ACK recibido:
         MSH|^~\&|||||...||ACK^R01|...|P|2.3.1...
         MSA|AA|1001
OK
```

En la terminal del servicio aparecen los eventos `tcp.connection.opened`, `hl7.parsed` con `valuesCount: 19`, `ack.sent`, `tcp.connection.closed`.

### 6. Consultar la API (terminal 3)

```bash
TOKEN=$(cat ~/.local/share/wiener-xs20/config/api-token.txt)

# Health
curl http://127.0.0.1:7700/api/health

# Listado de resultados
curl -H "X-XS20-Token: $TOKEN" http://127.0.0.1:7700/api/results | jq

# Detalle del primero
RESULT_ID=$(curl -s -H "X-XS20-Token: $TOKEN" http://127.0.0.1:7700/api/results | jq -r '.results[0].id')
curl -H "X-XS20-Token: $TOKEN" "http://127.0.0.1:7700/api/results/$RESULT_ID" | jq

# Stream de logs en vivo (Ctrl+C para salir)
curl -N -H "X-XS20-Token: $TOKEN" http://127.0.0.1:7700/api/logs/stream
```

### 7. Probar otros escenarios

```bash
# Mensaje con anomalías y flags morfológicas
bun run scripts/simulator/index.ts --fixture=anormal

# Mensaje con histogramas WBC/RBC/PLT
bun run scripts/simulator/index.ts --fixture=histogramas

# Probar idempotencia (envía dos veces el mismo MSH-10)
bun run scripts/simulator/index.ts --fixture=duplicado
```

## Opción B — Con el binario standalone (sin Bun)

Si solo querés probar sin instalar nada en la PC del cliente, compilá el binario una vez:

```bash
cd apps/service && bun run build:linux
```

Esto produce `apps/service/dist/xs20-service-linux` (~98 MB, incluye todo el runtime de Bun adentro).

```bash
# Arrancarlo
./apps/service/dist/xs20-service-linux --console --log-level=debug

# Ya queda corriendo. El simulador igual lo podés ejecutar con bun
# o no necesitás simulador, podés conectarte con el XS 20 real.
```

## Flags útiles del servicio

```
--console                  Output a stdout con colores (además del archivo)
--log-level=debug          debug | info | warn | error (default: info)
--port=5100                Puerto TCP donde escucha al XS 20
--http-port=7700           Puerto HTTP de la API local
--data-dir=/path/...       Override del dataDir (default: ~/.local/share/wiener-xs20)
--no-listen                Solo HTTP, no abre TCP (útil para inspeccionar la DB)
```

## Limpieza completa

Si querés volver a empezar desde cero:

```bash
rm -rf ~/.local/share/wiener-xs20
```

Al próximo arranque se crea todo desde cero (db nueva, token nuevo).

## Inspeccionar la DB con sqlite3

```bash
sudo apt install -y sqlite3   # si no lo tenés
sqlite3 ~/.local/share/wiener-xs20/db/xs20.sqlite

# adentro del prompt:
.tables
.schema results
SELECT id, sample_id, abnormal_count, morphology_flag_count FROM results;
SELECT param, value, unit, flags FROM result_values WHERE result_id = '<ID>';
.quit
```

## Pasar al .exe de Windows

Cuando confirmes que todo funciona en Linux:

```bash
cd apps/service && bun run build:windows
# produce apps/service/dist/xs20-service.exe (~113 MB)
```

Después seguir [`07-instalacion-windows.md`](07-instalacion-windows.md) para instalarlo como servicio.
