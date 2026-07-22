# Compilar la app de escritorio en Windows (.exe / .msi)

## Build automático (GitHub Actions)

Cada push a `master` (y también manualmente via `workflow_dispatch`) dispara el
workflow `.github/workflows/build-windows.yml` en un runner `windows-latest`.
Ese workflow instala dependencias, corre typecheck y tests, compila el servicio
a `xs20-service.exe`, lo copia junto a los recursos de Tauri, y genera el
instalador con `cargo tauri build`. Al terminar quedan publicados dos artifacts:

- `wiener-xs20-setup-nsis` — el instalador NSIS (`-setup.exe`)
- `wiener-xs20-setup-msi` — el instalador MSI

Para descargarlos localmente (necesitás el [GitHub CLI](https://cli.github.com/)):

```bash
gh run download <run-id> -n wiener-xs20-setup-nsis -D ./dist-windows
```

Podés ver el `<run-id>` con `gh run list --workflow=build-windows.yml`, o entrar
a la pestaña "Actions" del repo en GitHub.

Esta es la forma recomendada de generar el instalador — no necesitás tener
Windows, Rust ni Visual C++ Build Tools instalados en tu máquina. La sección
siguiente ("Compilar" en adelante) queda como método manual / fallback, por si
necesitás compilar localmente en Windows (por ejemplo para debug).

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

# 2. Instalar el CLI de Tauri (una vez)
cargo install tauri-cli --version "^1.6"

# 3. Compilar el servicio a .exe (lo necesita la app para lanzarlo)
cd apps\service
bun build src\main.ts --compile --target=bun-windows-x64 --outfile dist\xs20-service.exe
cd ..\..

# 4. Compilar la app de escritorio (esto genera el instalador)
cd apps\ui
cargo tauri build
```

El instalador queda en:

```
apps\ui\src-tauri\target\release\bundle\nsis\Wiener XS 20_0.1.0_x64-setup.exe
apps\ui\src-tauri\target\release\bundle\msi\Wiener XS 20_0.1.0_x64_en-US.msi
```

Cualquiera de los dos instala la app. El NSIS (`-setup.exe`) es el más común.

## 3. Empaquetar servicio + app juntos

La app necesita el `xs20-service.exe` al lado para lanzarlo. Dos formas:

### Opción A — Todo junto (simple)
Copiá `apps\service\dist\xs20-service.exe` a la carpeta donde se instala la app
(por defecto `C:\Program Files\Wiener XS 20\`). Al abrir la app, el shell lanza el
servicio solo, y lo cierra al salir. Ideal si el usuario abre la app a mano.

### Opción B — Servicio de Windows (producción, recomendado)
Instalá el servicio con NSSM para que corra siempre en background con
auto-arranque (ver `docs/07-instalacion-windows.md`). La app detecta que ya está
corriendo y no lo vuelve a lanzar. Ideal para una PC de laboratorio prendida todo
el día: los resultados se reciben aunque nadie tenga la app abierta.

## Si algo falla

- **"link.exe not found"** → faltan los C++ Build Tools (paso 1.1).
- **"error: Microsoft Visual C++ ... required"** → mismo tema, reinstalá los Build Tools.
- **La app abre pero se ve en blanco** → falta el WebView2 Runtime (paso 1.2).
- **"cargo: command not found"** → cerrá y reabrí la terminal después de instalar Rust.
- **Warnings de Rust al compilar** → normales, ignorables mientras diga
  `Finished` al final.

## Verificado

El crate Rust del shell (`src-tauri/src/main.rs`) fue compilado y ejecutado
durante el desarrollo: la app arranca, lanza el servicio, el servicio levanta la
API en el puerto 7700 y la UI se conecta. El único paso que resta hacer en tu
máquina es la compilación al formato Windows.
