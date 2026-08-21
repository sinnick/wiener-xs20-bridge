# 07 — Instalación en Windows

## Instalación con el instalador (recomendado)

Desde la PC del laboratorio:

1. Descargar el instalador de la última versión:
   **https://sinnick.dev/wiener/update/**
   (el archivo `wiener-xs20-bridge_X.Y.Z_x64-setup.exe` con el número de
   versión más alto).

2. Ejecutarlo. Como el instalador no está firmado, Windows SmartScreen puede
   mostrar "Windows protegió tu PC": tocar **"Más información" → "Ejecutar de
   todas formas"**. (Para verificar la descarga, el hash SHA-256 está publicado
   junto al instalador en `SHA256SUMS.txt`.)

3. Aceptar el pedido de permisos de administrador (UAC) y Siguiente → Instalar.

Eso deja TODO listo, sin pasos manuales:

- La app **Wiener XS 20** (acceso directo en escritorio y menú Inicio).
- El servicio de Windows **WienerXS20Service** registrado con auto-arranque:
  recibe resultados del analizador y exporta los `.txt` **aunque nadie abra la
  app**, y se relanza solo si crashea o al reiniciar la PC.
- La regla de firewall para el puerto TCP 5100 (solo se usa en modo
  "el equipo se conecta a nosotros").
- El runtime WebView2 (en Windows 10 lo instala solo si falta; Windows 11 ya
  lo trae).

El log de la registración del servicio queda en
`C:\ProgramData\WienerXS20\logs\install-service.log`.

**Actualizar a una versión nueva** es correr el instalador nuevo encima (o usar
el aviso de actualización de la propia app, ver `docs/12-actualizaciones.md`):
el instalador detiene el servicio, reemplaza los binarios y lo vuelve a
arrancar. Los datos en `C:\ProgramData\WienerXS20` no se tocan.

**Desinstalar**: Panel de Control → Programas → "Wiener XS 20" → Desinstalar.
Quita la app, el servicio y la regla de firewall. La base de datos con los
resultados (`C:\ProgramData\WienerXS20`) se conserva; borrala a mano si querés
eliminar todo.

> Nota de migración: si esta PC tenía la instalación manual vieja con NSSM en
> `C:\Program Files\WienerXS20`, el instalador re-apunta el servicio existente
> a la carpeta nueva automáticamente. Los archivos viejos de esa carpeta pueden
> borrarse a mano.

## Configurar la conexión con el analizador

Abrir la app → pestaña **Estado** → **Configuración** → "¿Quién inicia la
conexión?":

a) **"Nos conectamos al equipo"** (lo normal en el XS 20): poner la IP del
   analizador y puerto 5100. No hay que configurar nada en el analizador.

b) **"El equipo se conecta a nosotros"**: en el equipo, ir a
   **Setup → Communication Setup → LIS Setup** y configurar Protocol HL7,
   Server IP = la IP fija de esta PC, Server Port 5100, TCP/IP.

Los cambios se aplican al instante, sin reiniciar nada.

## Token de la API

Al primer arranque el servicio genera un token aleatorio en:

```
C:\ProgramData\WienerXS20\config\api-token.txt
```

Es el que la app usa para autenticarse contra `http://127.0.0.1:7700/api`.
Si querés rotarlo, borralo y reiniciá el servicio — se genera uno nuevo.

## Comandos útiles del día a día

```powershell
# Estado del servicio
Get-Service WienerXS20Service

# Detener / iniciar / reiniciar (como administrador)
& "C:\Program Files\Wiener XS 20\nssm.exe" stop WienerXS20Service
& "C:\Program Files\Wiener XS 20\nssm.exe" start WienerXS20Service
& "C:\Program Files\Wiener XS 20\nssm.exe" restart WienerXS20Service

# Salud del servicio
Invoke-WebRequest http://127.0.0.1:7700/api/health | Select-Object -ExpandProperty Content
```

## Logs en vivo (PowerShell)

```powershell
# Tail del log JSON
Get-Content "C:\ProgramData\WienerXS20\logs\service-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait -Tail 50

# Pretty-print de los logs (lee JSON línea por línea)
Get-Content "C:\ProgramData\WienerXS20\logs\service-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait -Tail 50 | ForEach-Object {
    try {
        $obj = $_ | ConvertFrom-Json
        $time = $obj.time.Substring(11,12)
        $level = $obj.level.ToUpper().PadRight(5)
        $ctxStr = if ($obj.ctx) { ' ' + ($obj.ctx | ConvertTo-Json -Compress -Depth 3) } else { '' }
        "$time [$level] $($obj.msg)$ctxStr"
    } catch {
        $_
    }
}
```

## Troubleshooting

### El servicio no arranca

```powershell
# Ver el último error de NSSM
Get-EventLog -LogName Application -Source nssm -Newest 5

# Probar el .exe a mano para ver el error real
& "C:\Program Files\Wiener XS 20\xs20-service.exe" --console
```

### El XS 20 no se conecta

1. Probar conectividad: desde otra PC en la red, `Test-NetConnection -ComputerName <ip-pc> -Port 5100`
2. Ver si la regla de firewall existe: `Get-NetFirewallRule -DisplayName "Wiener XS 20*"`
3. Verificar que el servicio escucha: `netstat -ano | findstr :5100`

### La DB se corrompió

SQLite con WAL es muy resistente, pero si pasara:

```powershell
& "C:\Program Files\Wiener XS 20\nssm.exe" stop WienerXS20Service
Move-Item "C:\ProgramData\WienerXS20\db\xs20.sqlite" "C:\ProgramData\WienerXS20\db\xs20.broken.sqlite"
& "C:\Program Files\Wiener XS 20\nssm.exe" start WienerXS20Service
# Se crea una DB vacía. Los raw_messages anteriores se pueden recuperar del .broken.sqlite con sqlite3.exe.
```

## Apéndice — Instalación manual con NSSM (fallback / referencia)

El instalador hace todo esto solo (via `install-service.ps1`, que viene dentro
del paquete). Esta receta queda como referencia para instalar a mano un
`xs20-service.exe` suelto, o para entender qué configura el instalador.

El `nssm.exe` embebido es NSSM 2.24 win64 (dominio público, de
https://nssm.cc/release/nssm-2.24.zip). SHA-256 del binario:
`f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97`.

```powershell
# 1. Carpetas
mkdir "C:\Program Files\WienerXS20"
# (C:\ProgramData\WienerXS20 y subcarpetas las crea el servicio al arrancar)
# Copiar xs20-service.exe y nssm.exe a C:\Program Files\WienerXS20\

# 2. Probar el binario en consola ANTES de registrarlo
cd "C:\Program Files\WienerXS20"
.\xs20-service.exe --console --log-level=debug
# En otra ventana: Invoke-WebRequest http://127.0.0.1:7700/api/health
# Si responde "status":"ok", Ctrl+C y seguir.

# 3. Registrar y configurar el servicio
.\nssm.exe install WienerXS20Service "C:\Program Files\WienerXS20\xs20-service.exe"
.\nssm.exe set WienerXS20Service DisplayName "Wiener XS 20 Bridge"
.\nssm.exe set WienerXS20Service Description "Recibe resultados HL7 del analizador hematologico Wiener XS 20"
.\nssm.exe set WienerXS20Service Start SERVICE_AUTO_START
.\nssm.exe set WienerXS20Service AppDirectory "C:\Program Files\WienerXS20"
.\nssm.exe set WienerXS20Service AppExit Default Restart
.\nssm.exe set WienerXS20Service AppRestartDelay 5000
.\nssm.exe set WienerXS20Service AppStdout "C:\ProgramData\WienerXS20\logs\stdout.log"
.\nssm.exe set WienerXS20Service AppStderr "C:\ProgramData\WienerXS20\logs\stderr.log"
.\nssm.exe set WienerXS20Service AppRotateFiles 1
.\nssm.exe set WienerXS20Service AppRotateBytes 10485760

# 4. Arrancar
.\nssm.exe start WienerXS20Service
Get-Service WienerXS20Service   # → Running

# 5. Firewall (solo para modo "el equipo se conecta a nosotros")
New-NetFirewallRule -DisplayName "Wiener XS 20 (HL7 inbound)" `
  -Direction Inbound -Protocol TCP -LocalPort 5100 -Action Allow `
  -Profile Domain,Private

# Desinstalar a mano
.\nssm.exe stop WienerXS20Service
.\nssm.exe remove WienerXS20Service confirm
```
