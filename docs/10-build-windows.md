# 10 — Compilar y publicar la app de Windows

El instalador se compila **en la Mac**, cruzando a Windows. No hace falta una PC
con Windows ni GitHub Actions: `bun run release` hace todo (compilar, calcular
el sha256, subir al VPS) en un solo comando.

---

## Publicar una versión (el camino normal)

```bash
bun run bump 0.2.0            # sincroniza la version en todo el monorepo
git commit -am "v0.2.0"
bun run release
```

`bun run release` (`scripts/release.ts`) hace, en orden:

1. **Chequeos previos** — el árbol de git tiene que estar limpio, la versión
   tiene que estar sincronizada en los `package.json`, el `Cargo.toml` y
   `apps/service/src/version.ts`, ser **≥ 0.2.0** y ser mayor a la ya publicada
   en el VPS.
2. **typecheck + tests** de todo el monorepo.
3. **Compila el servicio** para los dos targets de Windows y copia los dos
   binarios a `apps/ui/src-tauri/binaries/` (esa carpeta está gitignoreada: sin
   este paso, en un clone limpio el build de Tauri falla).
4. **Compila el instalador NSIS** cruzando macOS → Windows con `cargo-xwin`.
5. **Empaqueta**: renombra el instalador a un nombre estable sin espacios,
   calcula el `sha256` y escribe `latest.json` + `SHA256SUMS.txt` en
   `release-dist/`.
6. **Sube al VPS por rsync**: primero el instalador, después el manifest (nunca
   al revés: un chequeo justo en el medio vería un `latest.json` apuntando a un
   `.exe` que todavía no existe).
7. **Verifica** que la URL pública devuelva el manifest nuevo y que el `.exe`
   responda.

Después de eso, las instalaciones existentes ven la versión nueva en su próximo
chequeo (máximo 6 h) o al instante con **Estado → Actualizaciones → Buscar
ahora**. Ver `docs/12-actualizaciones.md`.

> **La versión mínima publicable es 0.2.0.** La instalación que corre hoy en el
> laboratorio es la **0.1.0**, y el auto-update solo dispara con una versión
> *estrictamente mayor*. Un manifest que anuncie 0.1.0 no muestra el banner
> nunca. El script lo verifica y aborta.

### Variantes

```bash
bun run release --no-deploy   # compila y deja todo en release-dist/, no sube nada
bun run release --skip-tests  # itera rapido; NO usar para publicar de verdad
```

### Configuración del deploy (`.release.env`)

Las credenciales del VPS **no** van al repo. El script las lee de variables de
entorno o de un archivo `.release.env` en la raíz (gitignoreado, formato
`CLAVE=valor`):

```bash
# .release.env
RELEASE_SSH_TARGET=usuario@sinnick.dev
RELEASE_REMOTE_DIR=/var/www/sinnick.dev/wiener/update

# opcionales
# RELEASE_SSH_PORT=22
# RELEASE_SSH_KEY=~/.ssh/id_ed25519
# RELEASE_BASE_URL=https://sinnick.dev/wiener/update/
```

| Variable | Obligatoria | Qué es |
| --- | --- | --- |
| `RELEASE_SSH_TARGET` | sí | `usuario@host` del VPS, como se lo pasarías a `ssh` |
| `RELEASE_REMOTE_DIR` | sí | Ruta absoluta de la carpeta del docroot donde viven `latest.json` y los instaladores |
| `RELEASE_SSH_PORT` | no (22) | Puerto SSH |
| `RELEASE_SSH_KEY` | no | Clave privada, si no es la del `~/.ssh/config` |
| `RELEASE_BASE_URL` | no | URL pública de esa carpeta. Default `https://sinnick.dev/wiener/update/`. Es la que se escribe en el `latest.json` |

Si falta alguna de las obligatorias, el script aborta explicando exactamente qué
definir. Se supone que el acceso SSH es por clave (sin contraseña interactiva).

---

## Requisitos en la Mac (una sola vez)

```bash
brew install rustup llvm lld makensis
rustup-init                                  # toolchain estable
rustup target add x86_64-pc-windows-msvc     # target de Windows
cargo install cargo-xwin                     # baja el SDK de Windows solo
```

- **rustup / cargo** — el compilador.
- **`x86_64-pc-windows-msvc`** — el target al que cruzamos.
- **cargo-xwin** — baja y cachea los headers y libs del Windows SDK
  (`~/Library/Caches/cargo-xwin`) para poder linkear sin Visual Studio. La
  primera corrida se toma unos minutos bajándolos.
- **LLVM + lld** — `clang-cl` y `lld-link`, que son el compilador y el linker
  que usa cargo-xwin.
- **makensis** — arma el instalador NSIS. Sin esto el build compila el `.exe`
  pero no genera el instalador.

El CLI de Tauri viene como devDep de `apps/ui` (`@tauri-apps/cli` pineado en
`1.6.3`, binario precompilado); se usa con `bunx tauri`. **No** hace falta
`cargo install tauri-cli`.

`scripts/release.ts` arma el `PATH` con los directorios de Homebrew, así que no
hace falta tenerlos exportados en el shell.

### Compilar a mano (sin el script)

```bash
# 1. Servicio, los dos targets
cd apps/service
bun run build:windows           # bun-windows-x64-baseline (sin AVX2)
bun run build:windows:arm64     # bun-windows-arm64
cd ../..

# 2. Los binarios tienen que estar en los resources de Tauri
mkdir -p apps/ui/src-tauri/binaries
cp apps/service/dist/xs20-service.exe       apps/ui/src-tauri/binaries/
cp apps/service/dist/xs20-service-arm64.exe apps/ui/src-tauri/binaries/

# 3. Instalador
cd apps/ui
PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH" \
  bunx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

El instalador queda en:

```
apps/ui/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Wiener XS 20_<version>_x64-setup.exe
```

**Ojo con el path**: al cruzar con `--target`, el bundle sale bajo
`target/<triple>/release/bundle/`, **no** bajo `target/release/bundle/` (eso es
solo cuando se compila para el sistema donde corre el comando). `bun run
tauri:build` a secas, en la Mac, compila un bundle **de macOS** — no sirve.

---

## Qué empaqueta el instalador

Un solo instalador **x64** (nativo en PCs x64, emulado en Windows-on-ARM) que
lleva como recursos:

| Archivo | Para qué |
| --- | --- |
| `xs20-service.exe` | Servicio, target `bun-windows-x64-baseline` (sin AVX2, corre en CPUs pre-2013 y bajo la emulación x64) |
| `xs20-service-arm64.exe` | Servicio, target `bun-windows-arm64` (nativo en Windows on ARM) |
| `nssm.exe` | Registra el servicio de Windows |
| `install-service.ps1` / `uninstall-service.ps1` | Alta y baja del servicio |

**Qué binario se usa**: lo decide `install-service.ps1` al instalar, leyendo la
arquitectura **nativa** de la máquina del registro
(`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` →
`PROCESSOR_ARCHITECTURE`). No alcanza con `$env:PROCESSOR_ARCHITECTURE`: adentro
de un proceso emulado esa variable dice `AMD64` aunque la PC sea ARM64. En ARM64
registra el binario ARM64; en cualquier otro caso, el baseline. El mismo criterio
usa `spawn_service()` de `src-tauri/src/main.rs` para el camino de fallback
(cuando no hay servicio de Windows registrado, por ejemplo en dev).

El bundle NSIS usa un template propio (`src-tauri/nsis/installer.nsi`, fork del
template de Tauri v1.6.3 con bloques marcados `XS20 CUSTOM`). Al instalar:
detiene el servicio si existía, mata los dos posibles procesos del servicio,
copia los archivos, registra **WienerXS20Service** con NSSM (auto-arranque +
auto-restart), crea la regla de firewall y lo arranca. Ver
`docs/07-instalacion-windows.md`.

La app detecta al abrir si el servicio ya corre (sonda al puerto 7700) y en ese
caso no lanza un proceso hijo propio.

> **Fork del template NSIS**: `@tauri-apps/cli` está pineado a `1.6.3` para que
> el template no drifte respecto del bundler. Si se bumpea el CLI, hay que
> re-diffear `nsis/installer.nsi` contra el template del tag nuevo
> (`tooling/bundler/src/bundle/windows/templates/installer.nsi` en el repo de
> Tauri) y re-aplicar los bloques `XS20 CUSTOM`.

---

## Qué hay que tener configurado en el VPS

El auto-update se sirve como archivos estáticos desde
`https://sinnick.dev/wiener/update/`. Hoy esa ruta cae en el catch-all de la
home (devuelve el HTML del sitio con un 200), así que hay que agregarle a nginx
un bloque que la sirva como carpeta. La configuración completa, con el porqué de
cada línea, está en **`docs/12-actualizaciones.md` → "Qué configurar en el
VPS"**.

---

## Si algo falla

- **`makensis: command not found`** o el build termina sin generar el `-setup.exe`
  → `brew install makensis`.
- **`lld-link: command not found` / `clang-cl not found`** → falta LLVM o lld, o
  el `PATH` no los tiene: `brew install llvm lld` y usar el `PATH` de arriba.
- **`error: linker 'link.exe' not found`** → se está compilando sin
  `--runner cargo-xwin`. El runner es el que sustituye el linker de MSVC.
- **cargo-xwin se cuelga bajando el SDK** → la primera corrida baja ~1 GB a
  `~/Library/Caches/cargo-xwin`. Se puede borrar esa carpeta para forzar un
  redownload limpio.
- **`path matching binaries/xs20-service-arm64.exe not found`** → falta compilar
  el servicio o copiarlo a `src-tauri/binaries/` (pasos 1 y 2 de "compilar a
  mano"). `bun run release` lo hace solo.
- **El instalador sale pero la app abre en blanco en la PC** → falta el WebView2
  Runtime (Windows 11 ya lo trae; en Windows 10 el instalador lo baja solo con
  `embedBootstrapper`).
- **SmartScreen al instalar** → el instalador no está firmado. "Más información →
  Ejecutar de todas formas". El sha256 publicado permite verificar el archivo.

---

## Compilar desde una PC con Windows (fallback)

Si alguna vez hace falta compilar en Windows (debug de algo específico del
sistema), los requisitos son: Microsoft C++ Build Tools ("Desarrollo para el
escritorio con C++"), WebView2 Runtime, Rust vía rustup, y Bun. Después:

```powershell
bun install
cd apps\service
bun run build:windows
bun run build:windows:arm64
cd ..\..
mkdir apps\ui\src-tauri\binaries -Force
copy apps\service\dist\xs20-service.exe apps\ui\src-tauri\binaries\
copy apps\service\dist\xs20-service-arm64.exe apps\ui\src-tauri\binaries\
cd apps\ui
bun run tauri build
```

Ahí sí el bundle sale en `src-tauri\target\release\bundle\nsis\`. La publicación
(sha256 + `latest.json` + subida) hay que hacerla igual desde la Mac con
`bun run release`, o a mano.

Problemas conocidos en Windows:

- **"link.exe not found"** → faltan los C++ Build Tools.
- **`ring`/`zstd-sys` fallan con "Acceso denegado"** → hay una variable de
  entorno `CC` apuntando a algo que no es un compilador C. Solución:
  `Remove-Item Env:\CC`, o borrarla del entorno de usuario:
  ```powershell
  [Environment]::SetEnvironmentVariable("CC", $null, "User")
  ```
  Ya pasó en la PC del laboratorio (`CC` apuntaba a `~\.local\bin`) y se eliminó
  el 2026-07-29.
