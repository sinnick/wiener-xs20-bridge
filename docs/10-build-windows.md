# Compilar la app de escritorio en Windows (.exe)

## Publicar una versión (GitHub Releases)

La forma oficial de distribuir el instalador es una **GitHub Release** disparada
por un tag `vX.Y.Z`:

```bash
bun run bump 0.2.0        # sincroniza la version en todo el monorepo
git add -A && git commit -m "v0.2.0"
git tag v0.2.0
git push && git push --tags
```

El push del tag dispara `.github/workflows/release.yml`, que corre typecheck y
tests, compila todo, verifica que el tag coincida con la versión de
`package.json`, y publica en Releases:

- `wiener-xs20-bridge_0.2.0_x64-setup.exe` — el instalador NSIS
- `SHA256SUMS.txt` — hash para verificar la descarga

La URL estable de la última versión es
`https://github.com/sinnick/wiener-xs20-bridge/releases/latest`. El repo es
público, así que el laboratorio puede descargar el instalador sin cuenta de
GitHub. Además el auto-update de la app consulta esa misma Release (ver
`docs/12-actualizaciones.md`).

**Importante**: la versión se cambia SOLO con `bun run bump` — sincroniza los
`package.json` del monorepo, `Cargo.toml` y `apps/service/src/version.ts`. Los
instaladores ya no se commitean al repo.

## Build de prueba (GitHub Actions)

Cada push a `main` (y también manualmente via `workflow_dispatch`) dispara el
workflow `.github/workflows/build-windows.yml` en un runner `windows-latest`,
que genera el instalador NSIS y lo sube como artifact `wiener-xs20-setup-nsis`
(sirve para smoke-tests; expira a los 90 días y requiere login para bajarlo).

```bash
gh run download <run-id> -n wiener-xs20-setup-nsis -D ./dist-windows
```

Podés ver el `<run-id>` con `gh run list --workflow=build-windows.yml`, o entrar
a la pestaña "Actions" del repo en GitHub.

No necesitás tener Windows, Rust ni Visual C++ Build Tools instalados en tu
máquina para nada de esto. La sección siguiente ("Compilar" en adelante) queda
como método manual / fallback, por si necesitás compilar localmente en Windows
(por ejemplo para debug).

## Build manual (fallback)

Esta guía es para generar el instalador Windows del Wiener XS 20 Bridge desde tu
PC. Todo el código ya está listo; esto es solo el paso de compilación final, que
sale limpio en Windows con Rust moderno (unos 5-10 min la primera vez).

> **Por qué se compila acá y no vino pre-compilado:** Tauri genera el ejecutable
> nativo con el toolchain del sistema operativo destino. Un `.exe` de Windows se
> compila en Windows. Además, en Windows Tauri usa el **WebView2** que Windows 11
> ya trae — no necesita las librerías de Linux (GTK/WebKit), así que el build es
> mucho más simple que en Linux.

## 1. Requisitos (una sola vez)

Instalá, en este orden:

1. **Microsoft C++ Build Tools**
   https://visualstudio.microsoft.com/visual-cpp-build-tools/
   Al instalar, tildá "Desarrollo para el escritorio con C++".

2. **WebView2 Runtime** — Windows 11 ya lo trae. Si estás en Windows 10:
   https://developer.microsoft.com/microsoft-edge/webview2/

3. **Rust** (via rustup):
   https://www.rust-lang.org/tools/install
   Descargá `rustup-init.exe`, corrélo, elegí la opción por defecto (1).
   Después de instalar, abrí una terminal nueva y verificá:
   ```
   rustc --version
   cargo --version
   ```

4. **Bun** (si no lo tenés ya):
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

## 2. Compilar

Desde la raíz del repo:

```powershell
# 1. Instalar dependencias del monorepo
bun install

# 2. El CLI de Tauri v1 ya viene como devDep de apps/ui (@tauri-apps/cli, binario
#    precompilado). Se usa con `bun run tauri`. NO hace falta `cargo install tauri-cli`
#    (compila el CLI desde fuente — lento y frágil). Si preferís el de cargo:
#    cargo install tauri-cli --version "^1.6"

# 3. Compilar el servicio a .exe (lo necesita la app para lanzarlo)
#    Target "baseline": sin AVX2, para que corra en CPUs viejas (pre-2013) y
#    bajo la emulacion x64 de Windows-on-ARM.
cd apps\service
bun build src\main.ts --compile --target=bun-windows-x64-baseline --outfile dist\xs20-service.exe
cd ..\..

# 4. Compilar la app de escritorio (esto genera el instalador)
cd apps\ui
bun run tauri build
```

El instalador queda en:

```
apps\ui\src-tauri\target\release\bundle\nsis\Wiener XS 20_<version>_x64-setup.exe
```

## 3. Qué empaqueta el instalador

El bundle NSIS usa un template propio (`src-tauri\nsis\installer.nsi`, fork del
template de Tauri v1.6.3 con bloques marcados `XS20 CUSTOM`) y lleva como
recursos `xs20-service.exe`, `nssm.exe` y los scripts
`install-service.ps1` / `uninstall-service.ps1` (`src-tauri\windows\`). Al
instalar: detiene el servicio si existía, copia los archivos, registra
**WienerXS20Service** con NSSM (auto-arranque + auto-restart), crea la regla de
firewall y lo arranca. Ver `docs/07-instalacion-windows.md`.

La app detecta al abrir si el servicio ya corre (sonda al puerto 7700) y en ese
caso no lanza un proceso hijo propio; sin servicio registrado (por ejemplo en
dev o macOS) lo lanza como hijo y lo cierra al salir.

> **Fork del template NSIS**: `@tauri-apps/cli` está pineado a `1.6.3` para que
> el template no drifte respecto del bundler. Si se bumpea el CLI, hay que
> re-diffear `nsis/installer.nsi` contra el template del tag nuevo
> (`tooling/bundler/src/bundle/windows/templates/installer.nsi` en el repo de
> Tauri) y re-aplicar los bloques `XS20 CUSTOM`.

## Si algo falla

- **"link.exe not found"** → faltan los C++ Build Tools (paso 1.1).
- **"error: Microsoft Visual C++ ... required"** → mismo tema, reinstalá los Build Tools.
- **La app abre pero se ve en blanco** → falta el WebView2 Runtime (paso 1.2).
- **"cargo: command not found"** → cerrá y reabrí la terminal después de instalar Rust.
- **`ring`/`zstd-sys` fallan con "Acceso denegado" o cc-rs no encuentra el compilador**
  → hay una variable de entorno `CC` apuntando a algo que no es un compilador C
  (ver `echo $env:CC`). Rust la usa para compilar deps nativas y explota. Solución:
  `Remove-Item Env:\CC` (temporal) o borrarla del entorno de usuario (permanente):
  ```powershell
  [Environment]::SetEnvironmentVariable("CC", $null, "User")
  ```
  Esto ya pasó en la PC del laboratorio (`CC` apuntaba a `~\.local\bin`) y se
  eliminó del entorno de usuario el 2026-07-29.
- **Warnings de Rust al compilar** → normales, ignorables mientras diga
  `Finished` al final.

## Verificado

El crate Rust del shell (`src-tauri/src/main.rs`) fue compilado y ejecutado
durante el desarrollo: la app arranca, lanza el servicio, el servicio levanta la
API en el puerto 7700 y la UI se conecta. El único paso que resta hacer en tu
máquina es la compilación al formato Windows.
