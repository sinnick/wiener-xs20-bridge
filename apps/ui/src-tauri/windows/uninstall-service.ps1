# Detiene y desregistra el servicio de Windows. Lo invoca el desinstalador
# NSIS antes de borrar los archivos. NO borra C:\ProgramData\WienerXS20:
# la base de datos con los resultados y la configuracion se preservan.

param([string]$InstallDir = $PSScriptRoot)

$ErrorActionPreference = "Continue"

$svc  = "WienerXS20Service"
$nssm = Join-Path $InstallDir "nssm.exe"

if (Get-Service $svc -ErrorAction SilentlyContinue) {
  if (Test-Path $nssm) {
    & $nssm stop $svc 2>$null | Out-Null
    & $nssm remove $svc confirm
  } else {
    # Fallback sin nssm a mano: sc.exe alcanza para parar y borrar el servicio.
    sc.exe stop $svc | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete $svc | Out-Null
  }
}

$ruleName = "Wiener XS 20 (HL7 inbound)"
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
}
