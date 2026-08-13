# Registra (o re-apunta) xs20-service.exe como servicio de Windows via NSSM.
# Lo invoca el instalador NSIS al final de la instalacion, corriendo elevado.
# Es idempotente: se puede correr N veces y sobre instalaciones NSSM manuales
# viejas (docs/07) — siempre deja el servicio apuntando a $InstallDir y con la
# config completa re-aplicada.

param([string]$InstallDir = $PSScriptRoot)

$ErrorActionPreference = "Stop"

$dataDir = Join-Path $env:ProgramData "WienerXS20"
$logsDir = Join-Path $dataDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Start-Transcript -Path (Join-Path $logsDir "install-service.log") -Append

try {
  $svc  = "WienerXS20Service"
  $nssm = Join-Path $InstallDir "nssm.exe"
  $exe  = Join-Path $InstallDir "xs20-service.exe"

  if (-not (Test-Path $exe))  { throw "No existe $exe" }
  if (-not (Test-Path $nssm)) { throw "No existe $nssm" }

  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Write-Output "Servicio existente: deteniendo y re-apuntando a $exe"
    & $nssm stop $svc 2>$null | Out-Null
    & $nssm set $svc Application $exe
  } else {
    Write-Output "Instalando servicio $svc -> $exe"
    & $nssm install $svc $exe
    if ($LASTEXITCODE -ne 0) { throw "nssm install fallo con codigo $LASTEXITCODE" }
  }

  # Config completa, re-aplicada siempre (misma que docs/07).
  & $nssm set $svc DisplayName "Wiener XS 20 Bridge"
  & $nssm set $svc Description "Recibe resultados HL7 del analizador hematologico Wiener XS 20"
  & $nssm set $svc Start SERVICE_AUTO_START
  & $nssm set $svc AppDirectory $InstallDir
  & $nssm set $svc AppExit Default Restart
  & $nssm set $svc AppRestartDelay 5000
  & $nssm set $svc AppStdout (Join-Path $logsDir "stdout.log")
  & $nssm set $svc AppStderr (Join-Path $logsDir "stderr.log")
  & $nssm set $svc AppRotateFiles 1
  & $nssm set $svc AppRotateBytes 10485760

  # Firewall: solo hace falta en modo "listen" (el equipo se conecta a esta PC),
  # pero crearla siempre no molesta y evita un paso manual si cambian de modo.
  $ruleName = "Wiener XS 20 (HL7 inbound)"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    Write-Output "Creando regla de firewall '$ruleName' (TCP 5100 inbound)"
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
      -Protocol TCP -LocalPort 5100 -Action Allow -Profile Domain, Private | Out-Null
  }

  & $nssm start $svc
  if ($LASTEXITCODE -ne 0) { throw "nssm start fallo con codigo $LASTEXITCODE" }

  Write-Output "Servicio $svc instalado y corriendo."
} finally {
  Stop-Transcript
}
