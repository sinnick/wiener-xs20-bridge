# Frente 5 — Cobertura de tests y documentación

> Plan de ejecución. Estado verificado al escribirlo: `bun test` → **141 pass / 0 fail / 323 expect() / 14 archivos**.
>
> **Cómo leer las referencias**: hubo tres agentes escribiendo código en este repo en paralelo, así que los ítems se anclan por **archivo + símbolo o frase citada**, nunca por número de línea. Si una cita no aparece, buscá el símbolo.
>
> **Fuera de alcance (los reescribió otro agente):** `docs/10-build-windows.md` y `docs/12-actualizaciones.md`.
>
> **Tags:** `[COLLISION]` = el archivo fue editado en paralelo por otro frente; releer antes de escribir asserts. `[CROSS-CHECK]` = no es acción de este plan, es algo a verificar con otro frente.

---

## Parte A — Cobertura de tests

### A0. Runner unificado del monorepo — hacer esto PRIMERO

**Qué falta.** El script `test` de la raíz es `cd apps/service && bun test`. Todo lo que se escriba en `packages/shared`, `scripts/` o `apps/ui` queda invisible: se escribe, se olvida, se pudre.

**Verificado empíricamente:** correr `bun test` desde la raíz del monorepo encuentra **exactamente los mismos 141 tests en 14 archivos**. No rompe nada, no levanta basura de `node_modules` ni de `dist-windows/`. El cambio es de riesgo cero.

**Cambio concreto** en `package.json` raíz:

```jsonc
"test": "bun test",                    // era: "cd apps/service && bun test"
"test:service": "cd apps/service && bun test",
"test:rust": "cd apps/ui/src-tauri && cargo test"
```

`cargo test` no puede correr dentro de `bun test`; queda como script hermano (ver A8).

**apps/ui (React) queda fuera a propósito.** Testear componentes exige `happy-dom` + `bunfig.toml` con `preload`, y el riesgo real de la UI es fino: es una vista sobre una API ya testeada. Lo único que lo amerita es `apps/ui/src/lib/api.ts` (construcción de URLs, inyección del token, parseo de errores), testeable sin DOM. Anotado como opcional en A7.

**Esfuerzo: S (~15 min).** Verificación: `bun test` desde la raíz debe seguir dando el mismo conteo.

---

### A1. `hl7/message-processor.ts` — el camino crítico completo

**Riesgo:** máximo. Es el único camino por el que un resultado llega del analizador a la base y al `.txt`, y hoy tiene **un solo test**. El invariante que protege al laboratorio está en el docstring de `process()`: *"Nunca lanza: cualquier error se loguea y se responde AE, porque el equipo espera una respuesta por cada mensaje — si no la mandamos, su conexion queda colgada hasta su propio timeout (~4s) en CADA mensaje malformado."* Ese invariante no está verificado por ningún test.

**Qué falta** en `apps/service/src/hl7/message-processor.test.ts`:

1. **Mensaje malformado → ACK `AE` + `insertFailedRaw`.** Parsear el ACK devuelto y assertar `MSA|AE`. Verificar la fila en `raw_messages` con `parse_status='failed'` y `parse_error` poblado.
2. **Malformado sin MSH-10 legible → el ACK igual se escribe**, con control-id de referencia vacío, y el `messageControlId` de la fila failed cae al fallback `unknown_<rawId>`.
3. **Mensaje no-ORU (un `ACK` entrante) → `AA` sin persistir.** Assertar `repo.countResults()` sin cambios y el log `hl7.non_oru_received`.
4. **El repo tira una excepción que NO es `InsertResultDuplicateError`** → se responde `AE`, **el ACK se escribe igual**, y el proceso no propaga.
5. **`writeAck` tira** (socket ya cerrado) → se loguea `ack.send_failed` y `process()` **no lanza**. Evita que un socket muerto tumbe el procesamiento del siguiente mensaje.
6. **Dos malformados seguidos con el mismo MSH-10 no vacío** → el segundo `insertFailedRaw` choca contra el `UNIQUE(message_control_id)` y el `catch {}` lo traga. Fijar el comportamiento actual, para que si alguien saca ese catch salte acá y no en el laboratorio.
7. **Warnings del mapper se loguean como `hl7.<type>`** — verificar que un OBX desconocido produce **`hl7.unknown_obx_code`** (el nombre exacto importa: es lo que se grepea en producción, y `docs/05` hoy lo documenta mal — ver B1).
8. **`getLastMessageAt()`** avanza incluso cuando el mensaje falla (alimenta `/api/health`).

**Fixtures nuevas** en `scripts/fixtures/messages.ts`:

- `ORU_MALFORMADO` — arranca con `MSH` pero con un OBX roto que hace fallar al mapper (no basura sin `MSH`: eso ya lo cubre `tcp-server.test.ts`).
- `MENSAJE_NO_ORU` — un `ACK^R01` entrante bien formado.
- `ORU_SIN_OBR` — dispara el warning `missing_segment`.
- `ORU_SIN_MSH10` — MSH sin control id, para el fallback del punto 2.
- `oruConControlId(id: string)` — helper para el mismo mensaje con distinto MSH-10 (evita colisiones de idempotencia entre tests).

Reutilizar el helper `silentLogger()` que ya está en el archivo; extenderlo a un `spyLogger()` que acumule los eventos.

**Esfuerzo: M (2-3 h).**

---

### A2. `http/server.ts` — matriz de `PUT /api/config` y los rollbacks `[COLLISION]`

**Riesgo:** alto. Es el único camino por el que el laboratorio cambia IP y modo de conexión sin tocar una consola. Si valida mal o revierte mal, el servicio queda **sin transporte activo** y no entra ni un resultado.

**Qué falta** (los tests actuales cubren sólo CORS y `/api/update/*`):

1. **`isValidHost`** vía la API: `0.0.0.0`, `localhost` y una IPv4 válida pasan; `999.1.1.1`, `01.2.3.4` (el chequeo `String(n) === oct` rechaza ceros a la izquierda), `mi-pc.local` y `""` dan `400 VALIDATION_ERROR`.
2. **Colisión de puertos**: `tcpPort === httpPort` → 400 con el mensaje que nombra el puerto de la API.
3. **`analyzerHost` vacío se acepta en modo listen** (es como se "limpia" la IP) **pero `newMode === "connect"` con host vacío → 400**. Impide dejar al servicio sin destino.
4. **`analyzerHost: "0.0.0.0"` → 400** (se rechaza para el analizador aunque sea válido para el listener).
5. **Errores acumulados**: tres campos inválidos de una → el mensaje los junta con `". "` y **nada se aplicó**.
6. **Body no-JSON y body `null`** → 400.
7. **Cambio de modo a `connect` sin `analyzerClient`** → `409 MODE_SWITCH_UNAVAILABLE`.
8. **Rollback ante `TCP_BIND_FAILED`**: inyectar un `TcpServer` cuyo `start()` lance, pedir volver a modo `listen` desde `connect`, y verificar que **se responde 409 y el `AnalyzerClient` se vuelve a arrancar**, es decir que el servicio no queda mudo.
9. **Persistencia**: un `PUT` exitoso escribe `settings.json`; uno que devuelve 400/409 **no** lo escribe.
10. **`GET /api/config`** devuelve exactamente el shape de `ServiceConfig` sin filtrar `apiToken` ni `settingsPath` — fijarlo es defensa contra una fuga de token.
11. **404 genérico**: `GET /api/nope` → `{error:{code:"NOT_FOUND"}}` con headers CORS.
12. **401**: endpoints con auth sin token y con token equivocado.

**Bug candidato a fijar como test** `[COLLISION]`: en `updateConfig()`, `cfg.tcpHost`/`cfg.tcpPort` se **mutan antes** del bloque de cambio de modo. Si ese bloque devuelve 409, los puertos ya quedaron cambiados en memoria, **no se revierten y no se persisten**: config en memoria divergida de `settings.json` y del socket real. **Si el test falla contra el código actual es un bug, no un test malo** → pasárselo al frente de robustez.

**Esfuerzo: M (2-3 h).**

---

### A3. `config.ts` — precedencia de 5 capas

**Riesgo:** alto y silencioso. Cero tests. El modo de fallo no es un crash: es que la IP que el laboratorio guardó desde la app vuelve al default y **nadie se entera hasta que faltan resultados**.

**Qué falta.** Archivo nuevo `apps/service/src/config.test.ts`. `resolveConfig(argv)` toma `argv` por parámetro, pero lee `process.env` y el disco — `beforeEach`/`afterEach` que guarde y restaure las `XS20_*`, y `--data-dir` a un temporal único por test.

1. **Un test por frontera de precedencia**, de menor a mayor: defaults < `settings.json` < archivo `--config` < env < flags CLI. Cinco tests que apilan capas sobre `tcpPort` y verifican quién gana.
2. **`--data-dir` recalcula `dbPath`, `logDir` y `exportDir`** los tres a la vez.
3. **`settingsPath` se deriva del `dbPath` por defecto / de `--data-dir`**, no del que puedan haber puesto `XS20_DB_PATH` o el archivo de config. Es sutil, es intencional, y sin test alguien lo "arregla".
4. **Whitelist de `loadSettings`**: un `settings.json` con `dbPath`, `httpPort` o `apiToken` adentro **no** debe poder pisar nada. Es la defensa contra que un settings corrupto mueva la base de datos.
5. **Valores inválidos se ignoran, no crashean**: `XS20_LOG_LEVEL=verbose`, `XS20_MODE=otro`, `--mode=raro`, `--port=abc` (→ `NaN`; fijar el comportamiento actual y, si es `NaN`, reportarlo al frente de robustez).
6. **`XS20_EXPORT_DIR=""` se respeta** como "exportación deshabilitada" y no cae al default — hay un `!== undefined` a propósito en `loadEnv()`.
7. **`--config` a un path inexistente o con JSON corrupto** → `{}` silencioso, no lanza.
8. **`console` y `noListen` vienen SIEMPRE del CLI** y no pueden setearse desde el archivo ni desde settings.

**Nota para Parte B**: el header del propio `config.ts` documenta 4 capas y **omite `settings.json`**. Corregirlo como parte de este ítem.

**Esfuerzo: M (~2 h).**

---

### A4. `GET /api/results` y `GET /api/results/:id`

**Riesgo:** medio-alto. Es lo que ve el laboratorio en pantalla. Cero tests.

Un `describe` nuevo con la base sembrada vía `MessageProcessor` + fixtures (se testea el shape real, no filas fabricadas a mano):

1. **`limit`**: default 50; respeta un `limit` explícito; **`?limit=abc` → `NaN` → `LIMIT NaN`**. Fijar qué pasa hoy. `[COLLISION]` si resulta ser un bug → frente de robustez. Idem `?limit=-1` y `?limit=99999` (el cap de 500 vive en `repo.listResults`, no en el handler).
2. **`search`** matchea parcial sobre `sampleId`, `patientId` y `name`; **`fromDate`/`toDate`** filtran por `receivedAt`; combinación de los tres.
3. **Orden** `receivedAt DESC` y `nextCursor: null` siempre (la paginación por cursor no está implementada — ver B4).
4. **`/api/results/:id` inexistente → `404 RESULT_NOT_FOUND`**.
5. **Histogramas serializados**: `channels` viaja como **string base64**. Decodificarlo con `decodeHistogramBase64` y verificar los 256 bytes. Es el contrato exacto que la UI consume y hoy sólo lo sostiene un cast con un comentario que dice "Hack".
6. **`includeRaw=true`** trae `rawHl7`; sin el flag el campo **no está presente** (no `""`); tras una purga de retención devuelve `""`.

**Esfuerzo: S-M (~1.5 h).**

---

### A5. `logger.ts` — rotación por fecha local

**Riesgo:** alto por precedente. El bug **ya ocurrió**: el comentario de `computeLogPath()` cuenta que con `toISOString()` el corte caía a las 21:00 en Argentina y partía en dos el log de una jornada. Se arregló y quedó sin ninguna red.

Archivo nuevo `apps/service/src/logger.test.ts`, con `logDir` en un temporal único:

1. **Rotación a medianoche local**, con `setSystemTime`: loguear a las **23:30 local del día D** y a las **00:30 local del día D+1** → **dos archivos distintos**. Correr con `TZ=America/Argentina/Buenos_Aires` para que sea la zona real del laboratorio.
2. **Padding del nombre**: enero → `service-2026-01-05.log`, no `2026-1-5`.
3. **Filtro por nivel**: con `level: "warn"`, `debug()` e `info()` no escriben ni al archivo ni al buffer.
4. **`setLevel()` en caliente** cambia el filtro para los eventos siguientes.
5. **Buffer circular**: con `bufferSize: 3`, tras 5 eventos `getRecent()` devuelve los **últimos 3 en orden**.
6. **Aislamiento de subscribers**: un subscriber que **lanza** no impide que los otros reciban. Protege el SSE: un cliente que se desconectó feo no puede tumbar el servicio.
7. **`unsubscribe()`** deja de entregar eventos.
8. **Un `logDir` no escribible no crashea** — el evento igual llega al buffer y a los subscribers, para que la app siga mostrando logs aunque el disco esté lleno.
9. Formato: **una línea JSON por evento**, con `time`/`level`/`msg` y `ctx` sólo si se pasó.

**Esfuerzo: S-M (~1.5 h).**

---

### A6. SSE `/api/logs/stream`

**Riesgo:** medio. Es la pantalla "Actividad", la herramienta de diagnóstico en vivo del dev remoto.

1. **Auth por query param**: `?token=<token>` funciona (lo necesita `EventSource`, que no puede mandar headers) y sin token da 401.
2. **Headers**: `text/event-stream; charset=utf-8`, `Cache-Control: no-cache` y los CORS.
3. **Replay del buffer inicial**: 2 eventos antes de abrir el stream llegan al conectarse.
4. **Eventos en vivo**: el frame `event: log\ndata: {...}\n\n`.
5. **Cleanup**: al abortar el fetch, `logger.subscribe` queda des-suscripto.

Patrón: `fetch` con `AbortController` + `res.body.getReader()` con timeout. No usar `EventSource` (no existe en el runtime de Bun test).

**Esfuerzo: S (~1 h).**

---

### A7. Tests baratos de alto retorno

Todos S (15-30 min cada uno). Van juntos en un solo bloque.

1. **`version.ts` vs `package.json` raíz** — un test que lee ambos y compara. Protege el flujo de release entero: si `bump-version.ts` falla a medias, el updater compara contra la versión equivocada (o nunca actualiza, o actualiza en loop).
2. **`db/migrate.ts` — idempotencia**: `openDb()` dos veces sobre el mismo archivo no lanza; crea el directorio padre; `initialize: false` no ejecuta el DDL. Verificar los PRAGMA (`journal_mode` = wal, `foreign_keys` = 1) — el `ON DELETE CASCADE` depende de eso y en SQLite **está apagado por defecto**.
3. **`hl7/histogram.ts`**: base64 inválido → `HistogramDecodeError`; payload ≠ 256 bytes → error con el conteo real; `"BASE64"` en mayúsculas **sí** debe pasar por el `.toLowerCase()`; round-trip encode→decode; `parseEncapsulatedData` devuelve `undefined` si falta un componente obligatorio y tolera `sourceApp` vacío (así viene del equipo).
4. **`repo.insertFailedRaw` directo**: inserta con `parse_status='failed'`, y un segundo insert con el mismo `messageControlId` **lanza** (lo que justifica el `catch {}` del message-processor).
5. **`scripts/bump-version.ts`**: refactor mínimo para exportar `bumpPackageJson`/`bumpCargoToml` y testearlos **sobre copias en un temporal**, nunca sobre el repo. Verificar que `Cargo.toml` cambia **sólo la primera** aparición de `version = "..."` y que una versión no-semver es rechazada.
6. *(Opcional)* **`apps/ui/src/lib/api.ts`**: URLs con query params, header `X-XS20-Token`, parseo del shape de error. Sin DOM, corre con el runner unificado de A0.

**No priorizar:** `hl7/protocol-map.ts` es una tabla de constantes — un test sólo re-escribiría los mismos números y daría falsa sensación de cobertura. Lo que sí vale ya existe: `obx-mapper.test.ts` ejercita el mapa de verdad, a través del parseo.

---

### A8. Shell Rust — validación de path de `run_installer`

**Riesgo:** es el único límite de seguridad real del repo. `run_installer` recibe un path **del frontend** y lo ejecuta con `cmd /C start`, que dispara elevación UAC. La defensa son tres líneas: `canonicalize`, `starts_with(updates_dir)`, extensión `.exe`.

El problema es que la función arranca con `if !cfg!(target_os = "windows")`, así que en la Mac del dev no se puede ejercitar tal cual.

**Cambio concreto.** Extraer la validación a una función pura:

```rust
fn validate_installer_path(updates_dir: &Path, candidate: &Path) -> Result<PathBuf, String>
```

`run_installer` queda como: chequeo de plataforma → `validate_installer_path` → `Command::spawn`. Después un `#[cfg(test)] mod tests` que corre con `cargo test` **en cualquier plataforma**:

1. `.exe` legítimo dentro de `<tmp>/updates` → `Ok`.
2. **Traversal**: `<tmp>/updates/../evil.exe` → `Err`. El test tiene que **crear** el archivo, porque `canonicalize` falla si no existe — y ese fallo también es una defensa que conviene fijar.
3. **Prefijo hermano**: `<tmp>/updates-malicioso/x.exe` no debe pasar. `starts_with` sobre `Path` compara por componentes, así que debería rechazarlo; el test lo fija por si alguien lo reescribe como comparación de strings, donde **sí** pasaría.
4. Extensión `.bat`, `.cmd`, `.ps1`, `.msi` o sin extensión → `Err`. Y `.EXE` en mayúsculas: hoy la comparación es sensible a mayúsculas, así que **rechaza**; en Windows el sistema igual lo ejecutaría — decidir si se quiere `eq_ignore_ascii_case`, y si se cambia, que sea decisión consciente con test.
5. Path inexistente → `Err`.

También vale un test de `strip_verbatim` (con y sin prefijo `\\?\`).

**Correr con:** `cd apps/ui/src-tauri && cargo test`. No entra en `bun test`; documentarlo en el README.

**Esfuerzo: M (~2 h, incluyendo el refactor).**

---

### A9. `main.ts` — smoke test opcional

`main.ts` es casi todo cableado y sus piezas quedan cubiertas por A1-A6. Pero el orden de arranque (config → logger → DB → `probeWritable` → transporte → HTTP) y el shutdown limpio no los toca nadie.

Si sobra tiempo: spawnear el servicio como subproceso con `--data-dir=<tmp> --no-listen --http-port=<libre>`, pollear `GET /api/health`, verificar `status` y que se creó `api-token.txt`, mandar `SIGTERM` y verificar exit 0. Lento y algo frágil; `test.skipIf(process.env.CI)` o dejarlo para el final.

**Esfuerzo: M (~1.5 h). Opcional.**

---

### Resumen de esfuerzo — Parte A

| Ítem | Esfuerzo | Orden |
|------|----------|-------|
| A0 Runner unificado | S (15 min) | 1º |
| A1 message-processor | M (2-3 h) | 2º |
| A2 PUT /api/config `[COLLISION]` | M (2-3 h) | 3º |
| A3 config.ts | M (2 h) | 4º |
| A4 GET /api/results | S-M (1.5 h) | 5º |
| A5 logger | S-M (1.5 h) | 6º |
| A6 SSE | S (1 h) | 7º |
| A7 baratos | S (2 h todos) | 8º |
| A8 Rust | M (2 h) | 9º |
| A9 main.ts | M (1.5 h) | opcional |

**Total sin opcionales: ~15 h.** Con A0+A1+A2+A3 (≈8 h) ya se cubre el 80% del riesgo real.

---

## Parte B — Documentación

### B1. `docs/05-debug-y-logs.md` — ficción que se lee en medio de un incidente

**Riesgo: el más alto de la Parte B.** Este documento se abre cuando algo ya se rompió. Cada afirmación falsa cuesta minutos o una hora de un dev que además está mirando por AnyDesk.

1. **"El servicio escribe todos los logs estructurados con Pino"** y el diagrama "Pino logger ───►". Falso: `logger.ts` declara en su header que **a propósito** no usa Pino, *"para evitar dependencias pesadas"*. Reescribir el párrafo y el diagrama con "logger propio (`logger.ts`)" y **conservar la nota de por qué** (es una decisión de diseño buena, vale documentarla).
2. **"stdout activado, con colores (Pino transport `pino-pretty`)"** → los colores los pone `formatConsole()` en el mismo `logger.ts`.
3. **`--replay-raw=<raw_message_id>`, la sección "Modo dry-run (debug avanzado)". El flag NO EXISTE**: `parseCli()` no lo reconoce y lo ignora silenciosamente. **Borrar la sección** o marcarla como no implementada. Que quede *"toma un raw de la DB y lo pasa por el parser actual"* como si funcionara es la peor mentira del repo: es exactamente lo que uno haría al descubrir un edge case en producción.
4. **Crash dumps `crash\crash-<timestamp>.txt`. No se escriben nunca.** `main.ts` engancha `uncaughtException` y `unhandledRejection` y **sólo loguea**. No hay carpeta `crash\` ni código que la cree. Corregir a: "una excepción no capturada queda como evento `uncaught_exception` en el log del día". `[CROSS-CHECK]` si el frente de robustez agregó crash dumps de verdad, coordinar antes de borrarlo.
5. **`config\service.json` en el árbol de directorios.** El archivo real es **`config\settings.json`**.
6. **La tabla de flags dice que `--config` tiene default.** No lo tiene: `loadFile()` devuelve `{}` si no se pasó `--config=<path>`. Sin el flag, **no se lee ningún archivo de configuración**. Corregir y explicar la diferencia entre el `--config` de arranque y el `settings.json` que escribe la app.
7. **Flags faltantes**: `--data-dir`, `--mode=listen|connect`, `--analyzer-host`, `--analyzer-port`. Los dos del medio son **los que se necesitan para diagnosticar el modo de conexión**, que es la falla más probable.
8. **Tabla de eventos** — corregir contra lo que emite el código:
   - `hl7.unknown_obx` **no existe**: el real es **`hl7.unknown_obx_code`**. Faltan además `hl7.invalid_number`, `hl7.histogram_decode_error`, `hl7.missing_segment`.
   - **`db.error` no lo emite nadie.** Los reales: `db.ready`, `db.not_writable`.
   - Faltan y son los que importan: `analyzer.client.*` (`starting`, `connected`, `disconnected`, `connect_failed`, `socket_error`, `no_host`, `stopped`) — **todo el modo `connect` está ausente**; `export.txt_written` / `export.txt_failed`; `retention.purged` / `retention.purge_failed`; `config.updated` / `config.persist_failed`; `tcp.connection.idle_timeout`; `tcp.listener.down`; `mllp.control_bytes`; `update.*`; `uncaught_exception` / `unhandled_rejection`.
   - Cerrar la sección con *"la lista viva sale de `grep -rhoE '\.(debug|info|warn|error)\("[a-z0-9_.]+"' apps/service/src`"*, para poder re-verificar la tabla en 10 segundos en vez de que se pudra otra vez.

**Esfuerzo: M (~1.5 h).**

---

### B2. `docs/13-cuando-no-llegan-resultados.md` (NUEVO) — el árbol de diagnóstico

**Qué falta.** El documento operativo que hoy vive sólo en la cabeza del dev. Es el de mayor valor nuevo de todo el frente: es lo que se le manda a alguien no técnico a las 9 de la mañana cuando el laboratorio llama.

En castellano llano, sin jerga, estructurado como **síntoma → chequeo → qué significa → qué hacer**. Cada chequeo tiene que ser algo que la persona **puede ver en la pantalla Estado**, no un comando. Los comandos van en un apéndice para el dev remoto.

**Paso 0 — ¿Qué dice la pantalla Estado?** Es la raíz del árbol:
- **"ok" verde** → el servicio está sano; el problema es aguas arriba (el equipo no mandó la muestra) o aguas abajo (la carpeta de exportación).
- **"degraded"** → dos causas muy distintas que hay que separar:
  - **transporte caído**. En modo `connect` significa **no conectado al analizador** (el equipo apagado alcanza — es lo normal a la noche, no es una falla). En modo `listen`, que el listener TCP no está bindeado.
  - **base de datos no escribible**. Síntoma clásico: *"el equipo manda y no se guarda nada"*. Causa habitual en Windows: el `.sqlite` o sus `-wal`/`-shm` quedaron de otro usuario por haber corrido el servicio como administrador alguna vez. Solución: cerrar la app y borrar los `-wal`/`-shm`, o dar permiso de modificación sobre la carpeta `db`.

**Paso 1 — ¿El modo de conexión es el correcto?** Es la causa nº1 y la más invisible. `Test-NetConnection -ComputerName <ip-del-equipo> -Port 5100`: conecta → tiene que estar en **`connect`**; no conecta pero los resultados aparecían antes → **`listen`**. Se cambia desde **Estado → Configuración**, en caliente.

**Paso 2 — ¿Cambió la IP del analizador?** Con DHCP el equipo cambia de IP tras un corte de luz y el servicio queda discando a la nada. En el log: `analyzer.client.connect_failed` repetido. **Recomendación operativa: pedir IP fija para el analizador.**

**Paso 3 — ¿Está el firewall?** Sólo en modo `listen`. `Get-NetFirewallRule -DisplayName "Wiener XS 20*"` y `netstat -ano | findstr :5100`.

**Paso 4 — ¿Llegan pero no aparecen los .txt?** Tres casos que se ven distinto en la app:
- El resultado **está en la lista** pero no hay `.txt` → carpeta de exportación: `exportDir` vacío la deshabilita; si no, buscar `export.txt_failed`. Recordar que `C:\ProgramData` **es una carpeta oculta**, así que el archivo puede estar ahí sin verse.
- El resultado **no está en la lista** pero el equipo dice que lo mandó → duplicado (`hl7.duplicate`: mismo MSH-10, se ACKeó pero no se re-persistió) o error de parseo (`hl7.parse_error`, quedó como `failed` en `raw_messages`).
- **Nada llega desde hace rato** → volver al paso 0.

**Paso 5 — ¿El servicio está vivo?** `Get-Service WienerXS20Service` y `Invoke-WebRequest http://127.0.0.1:7700/api/health`. Aclarar que **la app y el servicio son dos cosas distintas**: cerrar la app **no** detiene el servicio, y el servicio sigue recibiendo y exportando aunque nadie abra la app. Esto es lo que más confunde al personal.

**Apéndice para el dev remoto**: cómo pedir los logs del día, qué eventos grepear para cada síntoma (con los nombres **correctos**, ver B1), y cómo mandar el `.sqlite` si hace falta.

**Cerrar con "qué NO hacer"**: no borrar `C:\ProgramData\WienerXS20` (se pierden los resultados históricos), no correr la app como administrador (produce el `db.not_writable`), no cambiar el puerto TCP sin coordinar con el analizador.

**Esfuerzo: M-L (2-3 h).** Es escritura, no investigación: el material ya está disperso en `docs/01`, `07`, `11` y en los mensajes de error de `main.ts`.

---

### B3. `README.md`, `apps/ui/README.md` y el footgun de `tauri:build`

**Riesgo: alto para cualquiera que entre nuevo al repo** (incluido un agente futuro): el README es lo primero que se lee y describe un proyecto en un estado que ya no existe.

**`README.md`:**

1. **"Solo falta compilar el instalador `.msi/.nsis`"**. Doblemente falso: ya está compilado y probado en campo, y **MSI nunca fue un target** (`tauri.conf.json` declara `"targets": ["nsis"]`). Reemplazar por el estado real y **linkear a `docs/10`** sin duplicar el procedimiento.
2. **El bloque `cd apps/ui && cargo tauri build`** contradice a `docs/10`. Reemplazarlo por **un link**. Regla general que evita que vuelva a pasar: **el README no repite procedimientos, apunta a la doc que los tiene.**
3. **Números de tests contradictorios**: "90 tests verdes" y "74 tests del servicio"; el real es 141 y mañana será otro. **Convención propuesta para todo el repo: nunca escribir el número de tests, escribir el comando.** Mata la clase entera de bug de forma permanente. Aplicar también en `docs/08`.
4. **Índice de documentación incompleto**: faltan `docs/11` y `docs/12`. Agregarlos, más `docs/13` cuando aterrice.
5. **Falta una sección de release.** Tres pasos de alto nivel (`bun run bump X.Y.Z` → build local → subir al VPS) que **linkeen a `docs/10` y `docs/12`**. `[CROSS-CHECK]` coordinar con el frente de release y **no inventar URLs**.
6. Verificar que el Quickstart con `--mode=connect` sigue siendo correcto tras los cambios del frente de robustez.

**`apps/ui/README.md`:**

1. Sacar **MSI** de los dos lugares donde aparece. Sólo NSIS.
2. **"Poné `xs20-service.exe` junto al ejecutable de la app"**: obsoleto. Va como **resource del bundle** y `spawn_service()` lo busca en **dos** lugares: junto al ejecutable **y** en `resource_dir()`. Incluir que **si ya hay algo escuchando en el 7700 no lo relanza** (`service_already_running()`).

**El footgun de `tauri:build`:** el script de la raíz corrido en la Mac compila un **bundle macOS** — no falla, no avisa, produce un `.app`/`.dmg` inútil para el laboratorio. Y `docs/09` lo recomienda explícitamente, con un comentario que dice que produce `bundle/nsis/*.exe`, falso en macOS.

**Cambio:** renombrar a **`tauri:build:mac`** y agregar `tauri:build:windows` apuntando al flujo real. `[CROSS-CHECK]` pedirle el comando exacto al frente de `docs/10` en lugar de inventarlo. En `docs/09`, reemplazar "Compilar" por un puntero a `docs/10` y dejar sólo lo que le corresponde: arquitectura de la UI, las cuatro pantallas, el shell Rust, íconos y estilo.

**Esfuerzo: M (~1.5 h los tres juntos).**

---

### B4. `docs/03-contrato-http.md` — endpoints que no existen y campos que faltan

1. **`GET /api/results/:id/histogram/:type` no existe** y está listado sin marca de "futuro": un consumidor recibe el 404 genérico. Borrarlo o moverlo a la sección de fases futuras.
2. **Paginación por cursor**: `cursor` documentado pero ignorado, y `nextCursor` es **siempre `null`**. Documentar el estado real.
3. **Campos editables de `PUT /api/config`**: faltan **`exportDir`** y **`updateCheckEnabled`**, que el handler sí acepta y valida.
4. **Códigos de error**: falta `MODE_SWITCH_UNAVAILABLE` (409) junto a `TCP_BIND_FAILED`.
5. **"Timestamps siempre en ISO 8601 con timezone (`...-03:00`)"**: los `LogEvent` usan `toISOString()`, o sea **UTC con `Z`**. Corregir, porque alguien va a parsear esperando offset local.
6. **Auth**: dice que la UI lee el token *"del archivo de configuración"*. Lo obtiene por el comando nativo **`get_api_token`**. Aclarar, y mencionar que el SSE acepta el token **también por query param**, porque `EventSource` no puede mandar headers.
7. **"Fuerza un chequeo contra GitHub Releases"** `[CROSS-CHECK]` — el destino pasa a ser el VPS. **No inventar la URL**: "contra el servidor de actualizaciones (ver `docs/12`)".

**Esfuerzo: S-M (~1 h).**

---

### B5. `docs/01` y `docs/06` — el byte de ENQ y un ACK que no mandamos

1. **ENQ = `0x10` en `docs/01` y `docs/06`.** El código dice **`0x05`** (`mllp.ts`), que es el ASCII correcto. `0x10` es DLE. **Los docs están mal, el código bien.**
2. **Más grave que el typo**: el diagrama de `docs/01` muestra `ENQ ──►` seguido de `◄── ACK (0x06)` *"(≤ 4 segundos)"*. **El servicio no responde nada a un ENQ**: `TcpServer.onData()` loguea los bytes de control *"sin actuar"*. Alguien depurando "el equipo manda ENQ y no pasa nada" va a perseguir un bug que no existe. Corregir: los bytes de control se registran (`mllp.control_bytes`) y se ignoran; el ACK que sí mandamos es el **ACK HL7** (`MSA|AA`) por cada mensaje ORU.
3. `[COLLISION]` **Decisión de código, no de este plan**: si el servicio *debería* responder `0x06` a un ENQ en modo `listen` es pregunta para el frente de robustez. Este plan sólo alinea la doc con lo que el código hace hoy.
4. `docs/06` es un **plan histórico ya completado**. Alcanza con corregir los dos bytes y agregar arriba un banner *"Documento histórico — Fase 1 completada. Para el estado actual ver el README."* Su paso 1.11 cita `--target=bun-windows-x64` mientras el build real usa `bun-windows-x64-baseline`; el banner cubre esa clase de desfasaje sin ir línea por línea.

**Esfuerzo: S (~30 min).**

---

### B6. Repaso final del resto de `docs/*`

1. **`docs/08`**: *"Tenés que ver `57 pass / 0 fail`"* → sacar el número, dejar el comando. Su lista de flags omite `--mode`, `--analyzer-host`, `--analyzer-port` y `--config`. Verificar los tamaños de binario y el target contra `apps/service/package.json`, que hoy usa `bun-windows-x64-baseline`.
2. **`docs/04-mapeo-obx.md`**: la nota de HGB afirma en negrita *"**No transformamos el valor en el servicio**"*. Cierto **en la persistencia**, pero la exportación a `.txt` **sí** convierte g/L → g/dL para HEMOGLOBINA y CHCM. Acotar a "no transformamos al persistir" + cross-ref a `docs/11`. Si no, el próximo que toque el exporter va a creer que está violando un principio del proyecto.
3. **`docs/02-schema-db.md`**: verificado contra `schema.sql`, el DDL coincide. **Sin cambios**, salvo agregar una línea sobre que `service_config` y `audit_log` existen pero **hoy no se usan** — un lector puede perder tiempo buscando quién los escribe.
4. **`docs/07`**: el paso 1 apunta a GitHub Releases como origen de descarga. `[CROSS-CHECK]` la URL se muda al VPS; **no inventarla**. El resto (NSSM, firewall, troubleshooting, apéndice manual) se verificó y está correcto.
5. **`docs/11-exportacion-txt.md`**: verificado contra el exporter y su test. **Correcto.**
6. **`docs/09`**: además del bloque de build, verificar "Empaquetado final" contra lo que escriba el frente de `docs/10` para no contradecirlo.

**Esfuerzo: S (~45 min).**

---

### B7. Cross-checks — NO son acciones de este plan

1. **`main.ts`, `UPDATE_REPO_SLUG = "sinnick/wiener-xs20-bridge"`** — frente de update/VPS.
2. **Los dos workflows siguen con triggers activos en disco**: `build-windows.yml` tiene `on: push: branches: [main]` y `release.yml` tiene `on: push: tags: ["v*"]`. Si están deshabilitados sólo en la UI de GitHub, la config del repo no lo refleja y un `git push --tags` publicaría una GitHub Release compitiendo con el VPS.
3. **`scripts/bump-version.ts`** imprime *"El push del tag dispara el workflow de release que publica el instalador en GitHub Releases"*. Es texto que el dev lee **cada vez que versiona** y contradice el flujo nuevo.

---

### Resumen de esfuerzo — Parte B

| Ítem | Esfuerzo | Orden |
|------|----------|-------|
| B1 `docs/05` (ficción de crisis) | M (1.5 h) | 1º |
| B2 `docs/13` nuevo (diagnóstico) | M-L (2-3 h) | 2º |
| B3 READMEs + footgun `tauri:build` | M (1.5 h) | 3º |
| B4 `docs/03` contrato HTTP | S-M (1 h) | 4º |
| B5 `docs/01` + `06` (ENQ) | S (30 min) | 5º |
| B6 repaso del resto | S (45 min) | 6º |

**Total Parte B: ~8 h.**

---

## Verificación al terminar

```bash
# La suite completa, desde la raíz del monorepo
bun test

# El shell Rust (no entra en bun test)
cd apps/ui/src-tauri && cargo test

# Typecheck de los cuatro workspaces
bun run typecheck

# Re-verificar la tabla de eventos de docs/05 contra el código
grep -rhoE '\.(debug|info|warn|error)\("[a-z0-9_.]+"' apps/service/src | sort -u

# Confirmar que ninguna doc volvió a hardcodear un número de tests
grep -rniE "[0-9]+ (tests|pass)" README.md apps/*/README.md docs/*.md
```
