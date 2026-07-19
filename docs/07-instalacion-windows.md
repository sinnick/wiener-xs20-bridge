# 07 — Instalación en Windows con NSSM

Esta guía cubre cómo instalar `xs20-service.exe` como un servicio de Windows usando [NSSM](https://nssm.cc/) (Non-Sucking Service Manager).

## Pre-requisitos

- Windows 10/11 o Windows Server 2019+
- Permisos de administrador en la PC
- El archivo `xs20-service.exe` (compilado con `bun run build:windows`)
- NSSM descargado de https://nssm.cc/release/nssm-2.24.zip

## Paso 1 — Crear el directorio del servicio

Como administrador, crear:

```powershell
mkdir "C:\Program Files\WienerXS20"
mkdir "C:\ProgramData\WienerXS20"
mkdir "C:\ProgramData\WienerXS20\config"
mkdir "C:\ProgramData\WienerXS20\db"
mkdir "C:\ProgramData\WienerXS20\logs"
```

Copiar:
- `xs20-service.exe` → `C:\Program Files\WienerXS20\`
- `nssm.exe` (de la descarga) → `C:\Program Files\WienerXS20\`

## Paso 2 — Probar el binario en consola primero

**Antes** de registrar como servicio, conviene confirmar que el `.exe` arranca y escucha:

```powershell
cd "C:\Program Files\WienerXS20"
.\xs20-service.exe --console --log-level=debug
```

Debería ver logs en pantalla. Verificar:

```powershell
# En otra ventana de PowerShell:
Invoke-WebRequest http://127.0.0.1:7700/api/health | Select-Object -ExpandProperty Content
```

Si responde JSON con `"status":"ok"`, todo está bien. `Ctrl+C` para detener.

## Paso 3 — Registrar el servicio con NSSM

```powershell
cd "C:\Program Files\WienerXS20"

# Instalar el servicio (sin --console, va al archivo de log)
.\nssm.exe install WienerXS20Service "C:\Program Files\WienerXS20\xs20-service.exe"

# Configurar
.\nssm.exe set WienerXS20Service DisplayName "Wiener XS 20 Bridge"
.\nssm.exe set WienerXS20Service Description "Recibe resultados HL7 del analizador hematologico Wiener XS 20"
.\nssm.exe set WienerXS20Service Start SERVICE_AUTO_START
.\nssm.exe set WienerXS20Service AppDirectory "C:\Program Files\WienerXS20"

# Auto-reiniciar si crashea
.\nssm.exe set WienerXS20Service AppExit Default Restart
.\nssm.exe set WienerXS20Service AppRestartDelay 5000

# (Opcional) redirigir stdout/stderr a un archivo extra
.\nssm.exe set WienerXS20Service AppStdout "C:\ProgramData\WienerXS20\logs\stdout.log"
.\nssm.exe set WienerXS20Service AppStderr "C:\ProgramData\WienerXS20\logs\stderr.log"
.\nssm.exe set WienerXS20Service AppRotateFiles 1
.\nssm.exe set WienerXS20Service AppRotateBytes 10485760
```

## Paso 4 — Iniciar el servicio

```powershell
.\nssm.exe start WienerXS20Service

# Verificar
Get-Service WienerXS20Service
```

Debería mostrar `Status: Running`.

## Paso 5 — Configurar el firewall

El XS 20 se conectará al puerto TCP 5100 desde la red local. Hay que abrirlo:

```powershell
New-NetFirewallRule -DisplayName "Wiener XS 20 (HL7 inbound)" `
  -Direction Inbound -Protocol TCP -LocalPort 5100 -Action Allow `
  -Profile Domain,Private
```

El puerto HTTP 7700 sigue en localhost, no necesita regla de firewall.

## Paso 6 — Configurar el XS 20

En el equipo, ir a **Setup → Communication Setup → LIS Setup** y configurar:

- **Protocol**: HL7
- **Server IP**: la IP fija de la PC con el servicio
- **Server Port**: `5100`
- **Communication mode**: TCP/IP

Hacer una corrida de prueba y verificar en los logs:

```powershell
Get-Content "C:\ProgramData\WienerXS20\logs\service-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait -Tail 20
```

## Comandos útiles del día a día

```powershell
# Detener el servicio (para actualizar el .exe)
.\nssm.exe stop WienerXS20Service

# Iniciar
.\nssm.exe start WienerXS20Service

# Reiniciar
.\nssm.exe restart WienerXS20Service

# Estado detallado
.\nssm.exe status WienerXS20Service

# Editar configuración (abre GUI)
.\nssm.exe edit WienerXS20Service

# Desinstalar
.\nssm.exe stop WienerXS20Service
.\nssm.exe remove WienerXS20Service confirm
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

## Token de la API

Al primer arranque el servicio genera un token aleatorio en:

```
C:\ProgramData\WienerXS20\config\api-token.txt
```

Este token es el que la UI Tauri (Fase 2) leerá para autenticarse con `http://127.0.0.1:7700/api`.

Si querés rotarlo, simplemente borralo y reiniciá el servicio — se generará uno nuevo.

## Troubleshooting

### El servicio no arranca

```powershell
# Ver el último error de NSSM
Get-EventLog -LogName Application -Source nssm -Newest 5

# Probar el .exe a mano para ver el error real
"C:\Program Files\WienerXS20\xs20-service.exe" --console
```

### El XS 20 no se conecta

1. Probar conectividad: desde otra PC en la red, `Test-NetConnection -ComputerName <ip-pc> -Port 5100`
2. Ver si la regla de firewall existe: `Get-NetFirewallRule -DisplayName "Wiener XS 20*"`
3. Verificar que el servicio escucha: `netstat -ano | findstr :5100`

### La DB se corrompió

SQLite con WAL es muy resistente, pero si pasara:

```powershell
.\nssm.exe stop WienerXS20Service
Move-Item "C:\ProgramData\WienerXS20\db\xs20.sqlite" "...\xs20.broken.sqlite"
.\nssm.exe start WienerXS20Service
# Se crea una DB vacía. Los raw_messages anteriores se pueden recuperar del .broken.sqlite con sqlite3.exe.
```
