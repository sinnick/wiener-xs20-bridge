/**
 * Release de punta a punta, desde esta Mac, sin GitHub Actions.
 *
 *   bun run release              # compila, publica en el VPS
 *   bun run release --no-deploy  # solo compila y deja todo en release-dist/
 *   bun run release --skip-tests # atajo para iterar (NO usar para publicar)
 *
 * Que hace, en orden:
 *
 *   1. Chequeos previos: git limpio, version sincronizada en todo el monorepo,
 *      version >= 0.2.0 (la instalacion en campo es 0.1.0: un manifest 0.1.0
 *      nunca dispara el banner) y mayor a la ya publicada en el VPS.
 *   2. typecheck + tests.
 *   3. Compila el servicio para los dos targets de Windows y copia los dos
 *      binarios a apps/ui/src-tauri/binaries/ (esa carpeta esta gitignoreada,
 *      asi que en un clone limpio el build de Tauri falla sin este paso).
 *   4. Compila el instalador NSIS cruzando macOS -> Windows con cargo-xwin.
 *   5. Renombra el instalador a un nombre estable sin espacios, calcula el
 *      sha256 y arma el latest.json.
 *   6. Sube al VPS por rsync: PRIMERO el instalador, DESPUES el manifest (si
 *      se hiciera al reves, un chequeo justo en el medio veria un manifest
 *      apuntando a un .exe que todavia no existe).
 *
 * Configuracion: variables de entorno, o un archivo `.release.env` en la raiz
 * del repo (gitignoreado, formato KEY=valor). Ver docs/10-build-windows.md.
 *
 *   RELEASE_SSH_TARGET   usuario@host del VPS                      (obligatorio)
 *   RELEASE_REMOTE_DIR   docroot destino, ej. /var/www/sinnick.dev/wiener/update
 *                                                                  (obligatorio)
 *   RELEASE_SSH_PORT     puerto SSH                                (opcional, 22)
 *   RELEASE_BASE_URL     URL publica de esa carpeta                (opcional,
 *                        default https://sinnick.dev/wiener/update/)
 *   RELEASE_SSH_KEY      path de la clave privada                  (opcional)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "release-dist");
const BINARIES_DIR = join(ROOT, "apps/ui/src-tauri/binaries");
const BUNDLE_DIR = join(
  ROOT,
  "apps/ui/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis",
);
/** Version minima publicable: en campo corre la 0.1.0 (ver docs/12). */
const MIN_PUBLISHABLE = "0.2.0";
const DEFAULT_BASE_URL = "https://sinnick.dev/wiener/update/";

/** PATH con el toolchain de cross-compile (rustup, cargo-xwin, LLVM, lld). */
const CROSS_PATH = [
  "/opt/homebrew/opt/rustup/bin",
  join(process.env.HOME ?? "", ".cargo/bin"),
  "/opt/homebrew/opt/llvm/bin",
  "/opt/homebrew/opt/lld/bin",
  process.env.PATH ?? "",
].join(":");

// ─── Utilidades de consola ──────────────────────────────────────────────────

let stepN = 0;
function step(msg: string): void {
  stepN++;
  console.log(`\n\x1b[1m[${stepN}] ${msg}\x1b[0m`);
}
function ok(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function info(msg: string): void {
  console.log(`  ${msg}`);
}
function fail(msg: string): never {
  console.error(`\n\x1b[31mError:\x1b[0m ${msg}\n`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): void {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (res.error) fail(`no se pudo ejecutar ${cmd}: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} termino con codigo ${res.status}`);
}

function capture(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch (e) {
    fail(`no se pudo ejecutar ${cmd} ${args.join(" ")}: ${(e as Error).message}`);
  }
}

// ─── Configuracion ──────────────────────────────────────────────────────────

interface DeployConfig {
  sshTarget: string;
  remoteDir: string;
  sshPort: string;
  baseUrl: string;
  sshKey: string | null;
}

/** Carga .release.env (KEY=valor) sin pisar variables ya definidas. */
function loadReleaseEnv(): void {
  const path = join(ROOT, ".release.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  ok("configuracion leida de .release.env");
}

function resolveDeployConfig(): DeployConfig {
  const missing: string[] = [];
  const sshTarget = process.env.RELEASE_SSH_TARGET ?? "";
  const remoteDir = process.env.RELEASE_REMOTE_DIR ?? "";
  if (sshTarget.length === 0) missing.push("RELEASE_SSH_TARGET");
  if (remoteDir.length === 0) missing.push("RELEASE_REMOTE_DIR");

  if (missing.length > 0) {
    fail(
      `falta configurar ${missing.join(" y ")} para poder subir al VPS.\n\n` +
        `Crea un archivo .release.env en la raiz del repo (esta gitignoreado):\n\n` +
        `  RELEASE_SSH_TARGET=usuario@sinnick.dev\n` +
        `  RELEASE_REMOTE_DIR=/var/www/sinnick.dev/wiener/update\n` +
        `  # opcionales:\n` +
        `  # RELEASE_SSH_PORT=22\n` +
        `  # RELEASE_SSH_KEY=~/.ssh/id_ed25519\n` +
        `  # RELEASE_BASE_URL=${DEFAULT_BASE_URL}\n\n` +
        `O corre 'bun run release --no-deploy' para generar los artefactos\n` +
        `en release-dist/ y subirlos a mano.`,
    );
  }

  let baseUrl = process.env.RELEASE_BASE_URL ?? DEFAULT_BASE_URL;
  if (!baseUrl.endsWith("/")) baseUrl += "/";

  return {
    sshTarget,
    remoteDir: remoteDir.replace(/\/+$/, ""),
    sshPort: process.env.RELEASE_SSH_PORT ?? "22",
    baseUrl,
    sshKey: process.env.RELEASE_SSH_KEY || null,
  };
}

// ─── Chequeos previos ───────────────────────────────────────────────────────

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf-8")) as Record<string, unknown>;
}

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

/** Version del monorepo, verificando que no drifteo entre los lugares donde vive. */
function resolveVersion(): string {
  const version = readJson("package.json").version as string;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`la version de package.json ("${version}") no es X.Y.Z`);
  }

  const mismatches: string[] = [];
  for (const p of [
    "apps/service/package.json",
    "apps/ui/package.json",
    "packages/shared/package.json",
    "scripts/package.json",
  ]) {
    const v = readJson(p).version;
    if (v !== version) mismatches.push(`${p} dice ${String(v)}`);
  }

  const cargo = readFileSync(join(ROOT, "apps/ui/src-tauri/Cargo.toml"), "utf-8");
  const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
  if (cargoVersion !== version) {
    mismatches.push(`apps/ui/src-tauri/Cargo.toml dice ${String(cargoVersion)}`);
  }

  const versionTs = readFileSync(join(ROOT, "apps/service/src/version.ts"), "utf-8");
  const tsVersion = versionTs.match(/VERSION = "([^"]+)"/)?.[1];
  if (tsVersion !== version) {
    mismatches.push(`apps/service/src/version.ts dice ${String(tsVersion)}`);
  }

  if (mismatches.length > 0) {
    fail(
      `la version drifteo (raiz: ${version}):\n  - ${mismatches.join("\n  - ")}\n\n` +
        `Corre 'bun run bump ${version}' para sincronizar todo.`,
    );
  }

  if (compareVersions(version, MIN_PUBLISHABLE) < 0) {
    fail(
      `la version ${version} es menor a ${MIN_PUBLISHABLE}. La instalacion que corre\n` +
        `en el laboratorio es 0.1.0: un manifest que anuncie 0.1.0 (o menos) NO\n` +
        `dispara el banner de actualizacion. Corre 'bun run bump ${MIN_PUBLISHABLE}'.`,
    );
  }

  return version;
}

function assertGitClean(): void {
  const status = capture("git", ["status", "--porcelain"]);
  if (status.length > 0) {
    fail(
      `el arbol de git tiene cambios sin commitear:\n\n${status}\n\n` +
        `Commitealos antes de publicar: un release tiene que ser reproducible\n` +
        `desde un commit concreto.`,
    );
  }
  ok(`arbol limpio (commit ${capture("git", ["rev-parse", "--short", "HEAD"])})`);
}

/** Manifest ya publicado, o null si todavia no hay ninguno. */
async function fetchPublishedVersion(baseUrl: string): Promise<string | null> {
  const url = `${baseUrl}latest.json`;
  try {
    const res = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      info(`no hay latest.json publicado todavia (404) — este seria el primero`);
      return null;
    }
    if (!res.ok) {
      info(`no se pudo leer ${url} (HTTP ${res.status}) — sigo igual`);
      return null;
    }
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      info(`${url} no parece un manifest (¿el catch-all del sitio?) — sigo igual`);
      return null;
    }
    return body.version;
  } catch (e) {
    info(`no se pudo consultar ${url}: ${(e as Error).message} — sigo igual`);
    return null;
  }
}

// ─── Build ──────────────────────────────────────────────────────────────────

function buildService(): void {
  run("bun", ["run", "build:windows"], { cwd: join(ROOT, "apps/service") });
  run("bun", ["run", "build:windows:arm64"], { cwd: join(ROOT, "apps/service") });

  mkdirSync(BINARIES_DIR, { recursive: true });
  for (const name of ["xs20-service.exe", "xs20-service-arm64.exe"]) {
    const src = join(ROOT, "apps/service/dist", name);
    if (!existsSync(src)) fail(`no se genero ${src}`);
    copyFileSync(src, join(BINARIES_DIR, name));
    ok(`${name} -> src-tauri/binaries/ (${mb(statSync(src).size)})`);
  }
}

function buildInstaller(): void {
  // El bundle sale en target/<triple>/release/bundle/nsis, NO en
  // target/release/bundle (eso es solo cuando se compila para el host).
  run("bunx", ["tauri", "build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc"], {
    cwd: join(ROOT, "apps/ui"),
    env: { PATH: CROSS_PATH },
  });
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Instalador recien generado. En el bundle quedan los de corridas anteriores. */
function findInstaller(version: string): string {
  if (!existsSync(BUNDLE_DIR)) fail(`no existe ${BUNDLE_DIR} — ¿fallo el build de Tauri?`);
  const all = readdirSync(BUNDLE_DIR).filter((n) => n.endsWith("-setup.exe"));
  if (all.length === 0) fail(`no hay ningun *-setup.exe en ${BUNDLE_DIR}`);
  // El bundler lo nombra "Wiener XS 20_<version>_x64-setup.exe".
  const matching = all.filter((n) => n.includes(`_${version}_`));
  const candidates = matching.length > 0 ? matching : all;
  candidates.sort(
    (a, b) => statSync(join(BUNDLE_DIR, b)).mtimeMs - statSync(join(BUNDLE_DIR, a)).mtimeMs,
  );
  const chosen = candidates[0]!;
  if (matching.length === 0) {
    console.log(
      `  \x1b[33m!\x1b[0m ningun instalador del bundle dice ${version}; se usa el mas nuevo (${chosen})`,
    );
  }
  return join(BUNDLE_DIR, chosen);
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

function rsync(localPath: string, cfg: DeployConfig): void {
  const sshCmd = ["ssh", "-p", cfg.sshPort];
  if (cfg.sshKey) sshCmd.push("-i", cfg.sshKey.replace(/^~/, process.env.HOME ?? "~"));
  run("rsync", [
    "-avz",
    "--progress",
    "-e",
    sshCmd.join(" "),
    localPath,
    `${cfg.sshTarget}:${cfg.remoteDir}/`,
  ]);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noDeploy = args.includes("--no-deploy");
  const skipTests = args.includes("--skip-tests");
  const unknown = args.filter((a) => !["--no-deploy", "--skip-tests"].includes(a));
  if (unknown.length > 0) fail(`argumento desconocido: ${unknown.join(", ")}`);

  console.log("\n\x1b[1mWiener XS 20 — release\x1b[0m");

  step("Configuracion");
  loadReleaseEnv();
  const cfg = noDeploy ? null : resolveDeployConfig();
  let baseUrl = cfg?.baseUrl ?? process.env.RELEASE_BASE_URL ?? DEFAULT_BASE_URL;
  if (!baseUrl.endsWith("/")) baseUrl += "/";
  if (cfg) {
    ok(`destino: ${cfg.sshTarget}:${cfg.remoteDir} (puerto ${cfg.sshPort})`);
    ok(`URL publica: ${cfg.baseUrl}`);
  } else {
    ok("modo --no-deploy: no se sube nada");
  }

  step("Chequeos previos");
  assertGitClean();
  const version = resolveVersion();
  ok(`version ${version}, sincronizada en todo el monorepo`);

  const published = await fetchPublishedVersion(baseUrl);
  if (published !== null) {
    if (compareVersions(version, published) <= 0) {
      fail(
        `en el VPS ya hay publicada la version ${published} y esta release es ${version}.\n` +
          `Corre 'bun run bump' con una version mayor (y commitea) antes de publicar.`,
      );
    }
    ok(`publicada hoy: ${published} → se va a publicar ${version}`);
  }

  if (skipTests) {
    console.log("  \x1b[33m! --skip-tests: typecheck y tests salteados\x1b[0m");
  } else {
    step("Typecheck");
    run("bun", ["run", "typecheck"]);
    step("Tests");
    run("bun", ["run", "test"]);
  }

  step("Compilando el servicio (x64 baseline + ARM64)");
  buildService();

  step("Compilando el instalador NSIS (macOS → Windows, cargo-xwin)");
  buildInstaller();

  step("Empaquetando");
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const built = findInstaller(version);
  // Nombre estable y sin espacios: es el que va en el manifest y el que el
  // servicio usa para guardar la descarga.
  const installerName = `wiener-xs20-bridge_${version}_x64-setup.exe`;
  const installerPath = join(DIST, installerName);
  copyFileSync(built, installerPath);
  const size = statSync(installerPath).size;
  const sha256 = await sha256File(installerPath);
  ok(`${installerName} (${mb(size)})`);
  ok(`sha256 ${sha256}`);

  const notes = capture("git", ["log", "-1", "--pretty=%s"]);
  const manifest = {
    version,
    notes,
    publishedAt: new Date().toISOString(),
    installer: {
      url: `${baseUrl}${installerName}`,
      sha256,
      size,
    },
  };
  const manifestPath = join(DIST, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  ok(`latest.json (notas: "${notes}")`);
  // SHA256SUMS.txt para verificar a mano una descarga manual.
  writeFileSync(join(DIST, "SHA256SUMS.txt"), `${sha256}  ${installerName}\n`);

  if (!cfg) {
    step("Listo (sin subir)");
    console.log(`
Los artefactos quedaron en release-dist/:

  ${installerName}
  latest.json
  SHA256SUMS.txt

Para publicar: subilos a la carpeta del VPS (el instalador PRIMERO, el
latest.json DESPUES) o volve a correr 'bun run release' con .release.env
configurado.`);
    return;
  }

  step("Subiendo al VPS");
  // Orden importante: el instalador primero. Si se subiera el manifest antes,
  // un chequeo en el medio veria una version anunciada con un .exe inexistente.
  info("1/3 instalador…");
  rsync(installerPath, cfg);
  info("2/3 SHA256SUMS.txt…");
  rsync(join(DIST, "SHA256SUMS.txt"), cfg);
  info("3/3 latest.json (esto es lo que hace visible la version)…");
  rsync(manifestPath, cfg);

  step("Verificando");
  const check = await fetchPublishedVersion(cfg.baseUrl);
  if (check === version) {
    ok(`${cfg.baseUrl}latest.json anuncia ${version}`);
  } else {
    console.log(
      `  \x1b[33m!\x1b[0m ${cfg.baseUrl}latest.json devolvio ${String(check)} en vez de ${version}.` +
        `\n    Puede ser cache del servidor, o que la ruta /wiener/update/ todavia caiga` +
        `\n    en el catch-all del sitio. Ver la seccion de nginx en docs/12-actualizaciones.md.`,
    );
  }

  const headRes = await fetch(manifest.installer.url, { method: "HEAD" }).catch(() => null);
  if (headRes?.ok) {
    ok(`el instalador responde (${headRes.headers.get("content-type") ?? "sin content-type"})`);
  } else {
    console.log(
      `  \x1b[33m!\x1b[0m ${manifest.installer.url} no responde OK. Revisar nginx.`,
    );
  }

  console.log(`
\x1b[32mPublicado ${version}.\x1b[0m Las instalaciones existentes lo ven en su proximo
chequeo (maximo 6 h) o al instante con "Buscar ahora" en Estado.
`);
}

await main();
