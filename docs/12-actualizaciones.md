# 12 — Actualizaciones automáticas

## Cómo funciona

1. **Chequeo**: el servicio consulta
   `https://api.github.com/repos/sinnick/wiener-xs20-bridge/releases/latest`
   al minuto de arrancar y después cada 6 horas
   (`apps/service/src/update/update-checker.ts`). Compara el tag `vX.Y.Z` del
   Release con su propia versión. No manda ningún dato: es un GET público
   anónimo (no requiere cuenta ni token; el rate limit anónimo de GitHub, 60
   req/h por IP, sobra para este uso).
2. **Aviso**: si hay versión nueva, la app muestra un banner arriba del
   contenido: *"Hay una nueva versión disponible (vX.Y.Z)"* con
   **Descargar** / **Más tarde** / *Omitir esta versión*. "Más tarde" lo oculta
   hasta la próxima apertura de la app; "Omitir esta versión" no vuelve a
   avisar de esa versión puntual (queda en `settings.json` como
   `skippedVersion`).
3. **Descarga**: el servicio baja el asset `-setup.exe` del Release a
   `C:\ProgramData\WienerXS20\updates\` con barra de progreso en el banner.
   Valida el tamaño y, si la API lo publica, el SHA-256 del archivo.
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

## Deshabilitar el chequeo

Desde la app: **Estado → Actualizaciones → destildar "Buscar actualizaciones
automáticamente"**. Queda persistido (`updateCheckEnabled: false` en
`C:\ProgramData\WienerXS20\config\settings.json`) y el servicio deja de
consultar GitHub por completo.

## Publicar una versión nueva (para el desarrollador)

```bash
bun run bump 0.3.0
git add -A && git commit -m "v0.3.0"
git tag v0.3.0
git push && git push --tags
```

El workflow `release.yml` publica el Release con el instalador. Las
instalaciones existentes lo detectan en su próximo chequeo (máximo 6 h, o al
instante con "Buscar ahora"). Detalle en `docs/10-build-windows.md`.

## Troubleshooting

- **PC sin internet**: el chequeo falla silenciosamente. La card de Estado
  muestra el error del último chequeo; la función principal (recibir
  resultados) no se ve afectada. Se puede actualizar a mano bajando el
  instalador de Releases desde otra PC.
- **"HTTP 403 (posible rate limit de GitHub)"**: transitorio (60 req/h por IP,
  compartido si hay proxy/NAT). Se resuelve solo en el próximo ciclo.
- **Descarga corrupta o cortada**: el banner muestra el error con botón
  **Reintentar**. Los `.part` a medio bajar se limpian solos al reiniciar el
  servicio.
- **SmartScreen al instalar**: el instalador descargado tiene la marca
  Mark-of-the-Web y no está firmado, así que Windows puede mostrar "Windows
  protegió tu PC" → **Más información → Ejecutar de todas formas**. El SHA-256
  publicado en el Release (`SHA256SUMS.txt`) permite verificar el archivo.
- **El banner no aparece nunca**: verificar en Estado → Actualizaciones que el
  chequeo esté habilitado, que no haya una versión omitida, y que el último
  chequeo no tenga error.
