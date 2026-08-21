# 12 — Actualizaciones automáticas

Las actualizaciones se publican en **nuestro propio VPS**
(`https://sinnick.dev/wiener/update/`), no en GitHub. El servicio consulta un
manifest estático (`latest.json`), y si anuncia una versión más nueva, la app
ofrece descargarla e instalarla.

## Cómo funciona

1. **Chequeo**: el servicio hace un GET a
   `https://sinnick.dev/wiener/update/latest.json` al minuto de arrancar y
   después cada 6 horas (`apps/service/src/update/update-checker.ts`). Compara
   el `version` del manifest con la suya. No manda ningún dato: es un GET
   anónimo de un archivo estático.
2. **Aviso**: si hay versión nueva, la app muestra un banner arriba del
   contenido: *"Hay una nueva versión disponible (vX.Y.Z)"* con
   **Descargar** / **Más tarde** / *Omitir esta versión*. "Más tarde" lo oculta
   hasta la próxima apertura de la app; "Omitir esta versión" no vuelve a
   avisar de esa versión puntual (queda en `settings.json` como
   `skippedVersion`).
3. **Descarga**: el servicio baja el instalador a
   `C:\ProgramData\WienerXS20\updates\` con barra de progreso en el banner, y
   **verifica el SHA-256** contra el del manifest. Si no coincide, el archivo se
   descarta y el banner muestra el error.
4. **Instalación**: el botón **Instalar y reiniciar** (con confirmación) cierra
   la app y lanza el instalador (comando Tauri `run_installer`, que solo acepta
   ejecutables dentro de la carpeta `updates`). El instalador pide permisos de
   administrador (UAC), detiene el servicio de Windows, reemplaza los binarios,
   lo re-registra y lo vuelve a arrancar (ver `docs/07-instalacion-windows.md`).
   Al terminar ofrece reabrir la app, ya en la versión nueva. Los datos en
   `C:\ProgramData\WienerXS20` no se tocan.

La pestaña **Estado** tiene una card "Actualizaciones" con la versión
instalada, la última publicada, la fecha del último chequeo, un botón
**Buscar ahora** y el toggle para deshabilitar el chequeo automático.

> **El SHA-256 no es decorativo.** El instalador no está firmado y se ejecuta
> **con elevación UAC**: el hash publicado en el manifest es la única barrera de
> integridad que hay entre el archivo que baja y el que corre como
> administrador. Por eso es obligatorio en el manifest y se verifica siempre
> (un manifest sin `sha256` válido se rechaza sin descargar nada).

## Formato del manifest (`latest.json`)

```json
{
  "version": "0.2.0",
  "notes": "Exportación a .txt por muestra",
  "publishedAt": "2026-08-21T13:45:00.000Z",
  "installer": {
    "url": "https://sinnick.dev/wiener/update/wiener-xs20-bridge_0.2.0_x64-setup.exe",
    "sha256": "3f786850e387550fdab836ed7e6dc881de23001b0000000000000000deadbeef",
    "size": 52920935
  }
}
```

| Campo | Obligatorio | Qué es |
| --- | --- | --- |
| `version` | sí | `X.Y.Z` (se acepta también `vX.Y.Z`). Si no parsea, el servicio lo reporta como manifest inválido |
| `notes` | no | Texto de novedades. Se recorta a 2000 caracteres |
| `publishedAt` | no | ISO 8601. Solo informativo, se muestra en la card de Estado |
| `installer.url` | sí | URL del `.exe`. Puede ser absoluta o **relativa al manifest** (ej. `"wiener-xs20-bridge_0.2.0_x64-setup.exe"`). Solo `http`/`https` |
| `installer.sha256` | sí | 64 caracteres hex, mayúsculas o minúsculas |
| `installer.size` | no | Bytes. Si está, se usa para la barra de progreso y para detectar una descarga cortada |

Hay **un solo instalador**, x64, que adentro lleva los dos binarios del servicio
(x64 baseline y ARM64) y elige el correcto al instalar. Por eso el manifest no
tiene entradas por arquitectura. Los campos que no estén en esta tabla se
ignoran, así que se puede agregar información extra sin romper las
instalaciones viejas.

Lo genera `bun run release` — **no hay que escribirlo a mano.**

## Publicar una versión nueva

```bash
bun run bump 0.2.0
git commit -am "v0.2.0"
bun run release
```

Detalle completo del script, sus chequeos y las variables de `.release.env` en
`docs/10-build-windows.md`.

> **Trampa importante**: la instalación que corre hoy en el laboratorio es la
> **0.1.0**. El banner solo aparece con una versión *estrictamente mayor*, así
> que el primer manifest que se publique tiene que anunciar **0.2.0 o
> superior**. `bun run release` aborta si la versión es menor a 0.2.0 o si no es
> mayor a la ya publicada en el VPS.

## Qué configurar en el VPS

Hoy `https://sinnick.dev/wiener/update/` cae en el catch-all del sitio: nginx
devuelve el HTML de la home con un **200**. El servicio lo tolera (lo trata como
"no hay novedades", sin marcar error), pero mientras esté así el auto-update no
funciona. Hay que agregarle un bloque a nginx que sirva esa ruta como carpeta de
archivos estáticos.

### 1. Crear la carpeta

```bash
sudo mkdir -p /var/www/sinnick.dev/wiener/update
sudo chown -R $USER:www-data /var/www/sinnick.dev/wiener
sudo chmod -R 755 /var/www/sinnick.dev/wiener
```

Tiene que ser escribible por el usuario con el que `rsync` entra
(`RELEASE_SSH_TARGET`) y legible por nginx (`www-data`). La ruta absoluta que se
elija es la que va en `RELEASE_REMOTE_DIR`.

### 2. Bloque de nginx

Dentro del `server { ... }` de `sinnick.dev` (típicamente
`/etc/nginx/sites-available/sinnick.dev`), **antes** del `location /`:

```nginx
# Auto-update del Wiener XS 20 Bridge: archivos estaticos, no la SPA.
location ^~ /wiener/update/ {
    alias /var/www/sinnick.dev/wiener/update/;
    autoindex off;

    # Content-Type correcto para cada cosa que servimos aca.
    types {
        application/json          json;
        text/plain                txt;
        application/octet-stream  exe;
    }
    default_type application/octet-stream;

    # El manifest se relee cada 6 h: un proxy que lo cachee esconde updates.
    # Con "no-cache" el cliente igual revalida por ETag, asi que el .exe no se
    # vuelve a bajar entero si no cambio.
    add_header Cache-Control "no-cache" always;
}
```

Después:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**Por qué cada línea:**

- **`^~`** — le dice a nginx que si esta ruta matchea, no siga evaluando
  locations con expresión regular. Sin eso, cualquier `location ~ ...` del sitio
  (o el `try_files ... /index.html` de la SPA) puede quedarse con el pedido y
  volver a devolver el HTML de la home.
- **`alias` (no `root`)** — con `alias`, `/wiener/update/latest.json` se resuelve
  a `<alias>/latest.json`. Con `root` habría que replicar `wiener/update/` dentro
  del docroot. La barra final va en los dos lados o en ninguno.
- **`types { ... }` con `exe → application/octet-stream`** — sin esto nginx le
  pone `text/plain` (el `default_type`) a un `.exe`, y algunos proxies y
  antivirus corporativos lo alteran o lo bloquean. El `.exe` tiene que viajar
  como binario.
- **`autoindex off`** — que no se pueda listar la carpeta.

### 3. Verificar

```bash
curl -i https://sinnick.dev/wiener/update/latest.json
# 200 + content-type: application/json  (NO text/html)

curl -sI https://sinnick.dev/wiener/update/wiener-xs20-bridge_0.2.0_x64-setup.exe
# 200 + content-type: application/octet-stream
```

`bun run release` hace estas dos verificaciones solo al final y avisa si algo
sigue cayendo en el catch-all.

### Qué queda en esa carpeta

```
/var/www/sinnick.dev/wiener/update/
├── latest.json
├── SHA256SUMS.txt
├── wiener-xs20-bridge_0.2.0_x64-setup.exe
└── wiener-xs20-bridge_0.3.0_x64-setup.exe   ← los viejos no se borran solos
```

El script sube pero no borra: los instaladores viejos quedan y sirven para
volver atrás si una versión sale mal. Conviene limpiar a mano de vez en cuando
(son ~50 MB cada uno).

## Deshabilitar el chequeo

Desde la app: **Estado → Actualizaciones → destildar "Buscar actualizaciones
automáticamente"**. Queda persistido (`updateCheckEnabled: false` en
`C:\ProgramData\WienerXS20\config\settings.json`) y el servicio deja de
consultar el servidor por completo.

## Troubleshooting

- **PC sin internet**: no pasa nada. Red caída, timeout, 404 o el HTML del
  catch-all se tratan como "no hay novedades": no aparece ningún error rojo en
  la app y la función principal (recibir resultados) no se ve afectada. En los
  logs, con nivel `debug`, quedan las entradas `update.check_unreachable` /
  `update.check_http_error`. También se puede actualizar a mano bajando el
  instalador desde otra PC.
- **La card de Estado muestra un error de chequeo**: eso solo pasa cuando el
  manifest se leyó bien pero está mal publicado (`update.manifest_invalid` en el
  log): versión que no parsea, falta el bloque `installer`, `sha256` que no es
  hex de 64, URL con un protocolo raro. Es un problema de quien publicó, no de
  la PC del laboratorio: revisar el `latest.json` del VPS.
- **Descarga corrupta o cortada**: el banner muestra el error con botón
  **Reintentar**. Si el SHA-256 no coincide, el archivo se borra y **no** se
  ejecuta. Los `.part` a medio bajar se limpian al reiniciar el servicio.
- **El .exe descargado ocupa lugar**: al arrancar, el servicio borra todo lo que
  haya en `C:\ProgramData\WienerXS20\updates\`. También lo borra cuando un
  chequeo confirma que ya está al día (o sea, después de instalar).
- **SmartScreen al instalar**: el instalador no está firmado, así que Windows
  puede mostrar "Windows protegió tu PC" → **Más información → Ejecutar de todas
  formas**. El `SHA256SUMS.txt` publicado al lado del instalador permite
  verificar el archivo.
- **El banner no aparece nunca**: verificar (a) que la versión del manifest sea
  **estrictamente mayor** a la instalada — el caso clásico es publicar 0.1.0
  teniendo 0.1.0 instalada; (b) en Estado → Actualizaciones, que el chequeo esté
  habilitado y que no haya una versión omitida; (c) que
  `curl -i https://sinnick.dev/wiener/update/latest.json` devuelva JSON y no el
  HTML de la home.
- **Probar contra otro servidor**: el servicio acepta la variable de entorno
  `XS20_UPDATE_MANIFEST_URL` para apuntar el chequeo a otro manifest.
