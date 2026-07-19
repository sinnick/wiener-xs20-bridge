# 05 — Debug y logs

## Tres canales de log, una sola fuente

El servicio escribe **todos los logs estructurados con Pino**. Pino sale por un único stream JSON, y desde ahí se distribuye a tres destinos:

```
                    ┌──► Archivo rotativo (siempre)
Pino logger ───────┼──► stdout (solo si --console)
                    └──► Buffer en memoria → SSE /api/logs/stream (solo si hay clientes)
```

## Ubicación de archivos en producción

```
%PROGRAMDATA%\WienerXS20\
├── config\
│   ├── service.json              ← config persistente
│   └── api-token.txt             ← token compartido con la UI
├── db\
│   └── xs20.sqlite               ← base de datos
├── logs\
│   ├── service-2026-04-27.log    ← rotación diaria
│   ├── service-2026-04-26.log
│   └── ...
└── crash\
    └── crash-2026-04-27T15-32-11.txt  ← solo si hay un crash no manejado
```

`%PROGRAMDATA%` típicamente es `C:\ProgramData`, accesible al servicio sin permisos de admin.

## Modos de ejecución

### Modo servicio (producción)

```powershell
nssm start WienerXS20Service
```

- Sin stdout visible.
- Logs solo a archivo + buffer SSE.
- Auto-restart por NSSM si crashea.
- Arranca con Windows.

### Modo consola (desarrollo)

```powershell
nssm stop WienerXS20Service     # parar el servicio si está corriendo
.\xs20-service.exe --console --log-level=debug
```

- stdout activado, con colores (Pino transport `pino-pretty`).
- Logs también van al archivo (mismo path).
- Todos los flags CLI:

| Flag | Default | Descripción |
|------|---------|-------------|
| `--console` | off | Activa output a stdout con colores |
| `--log-level=<level>` | `info` | `debug` / `info` / `warn` / `error` |
| `--config=<path>` | `%PROGRAMDATA%\WienerXS20\config\service.json` | Override de config |
| `--port=<port>` | (de config) | Override del puerto TCP |
| `--http-port=<port>` | (de config) | Override del puerto HTTP |
| `--no-listen` | off | Solo arranca HTTP, no abre TCP (útil para inspeccionar la DB sin riesgo) |

### Modo dry-run (debug avanzado)

```powershell
.\xs20-service.exe --console --replay-raw=<raw_message_id>
```

Toma un `raw_messages.id` de la DB, lo pasa por el parser actual, y muestra el resultado sin persistir. Sirve para iterar sobre el parser cuando descubrimos que algún mensaje histórico tiene un edge case.

## Cómo ver logs en vivo

### Desde otra terminal en la misma PC

```powershell
# tail -f equivalente en PowerShell
Get-Content "$env:PROGRAMDATA\WienerXS20\logs\service-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait -Tail 50

# Pretty-print (porque el archivo está en JSON)
Get-Content "...log" -Wait -Tail 50 | ForEach-Object {
    $obj = $_ | ConvertFrom-Json
    "{0} [{1}] {2}" -f $obj.time, $obj.level, $obj.msg
}
```

### Desde la UI Tauri

Pestaña "Logs" → muestra el stream SSE de `/api/logs/stream` con filtro por nivel y búsqueda. Útil para mostrar al técnico de Wiener al instalar el equipo: arranca la corrida, en la pantalla se ve cada paso (TCP connect, ENQ, mensaje recibido, parse OK, ACK enviado).

### Desde un dev remoto

Si el cliente nos comparte AnyDesk/TeamViewer, basta con ir al directorio de logs y leer el archivo del día. Como los logs son JSON estructurado, se pueden procesar con `jq`:

```powershell
Get-Content "...log" | jq 'select(.level == "error")'
```

## Eventos clave que loggeamos

| Evento | Nivel | Cuándo | Contexto |
|--------|-------|--------|----------|
| `service.started` | info | Al arrancar | versión, config, puertos |
| `service.stopped` | info | Al apagar limpio | uptime |
| `tcp.listener.up` | info | Listener TCP abierto | host, port |
| `tcp.connection.opened` | info | Cliente se conecta | peer address |
| `tcp.connection.closed` | info | Cliente se desconecta | peer, duration, bytes |
| `mllp.frame.received` | debug | Frame MLLP completo | bytes |
| `hl7.parsed` | info | Mensaje parseado OK | sampleId, msgControlId |
| `hl7.unknown_obx` | warn | OBX con código desconocido | code, raw |
| `hl7.parse_error` | error | Parser falló | error, raw_message_id |
| `hl7.duplicate` | info | MSH-10 ya existe (idempotencia) | msgControlId |
| `ack.sent` | debug | ACK enviado | msgControlId, status |
| `db.error` | error | Error en SQLite | query, error |
| `http.request` | debug | HTTP request | method, path, status, duration |

## Crash dumps

Si el proceso muere por una excepción no capturada, se escribe `crash\crash-<timestamp>.txt` con stack trace y últimas N líneas del log. NSSM detecta el exit code y reinicia el servicio.

## Métricas (fase 2+)

Cuando haga falta: endpoint `/api/metrics` con counters Prometheus-compatibles (`messages_received_total`, `parse_errors_total`, `tcp_connections_active`, etc.). Por ahora con los logs estructurados alcanza para investigar cualquier problema.
