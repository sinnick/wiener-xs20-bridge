/**
 * Bump de version del monorepo. Unica forma soportada de cambiar la version:
 * sincroniza todos los lugares donde vive para que nunca driften.
 *
 *   bun run bump 0.2.0
 *
 * Toca:
 *  - package.json (raiz — fuente de verdad)
 *  - apps/service/package.json
 *  - apps/ui/package.json          (tauri.conf.json lee la version de aca)
 *  - packages/shared/package.json
 *  - scripts/package.json
 *  - apps/ui/src-tauri/Cargo.toml
 *  - apps/service/src/version.ts   (regenerado; el binario compilado no tiene
 *                                   package.json en runtime)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const PACKAGE_JSONS = [
  "package.json",
  "apps/service/package.json",
  "apps/ui/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
];

const CARGO_TOML = "apps/ui/src-tauri/Cargo.toml";
const VERSION_TS = "apps/service/src/version.ts";

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function bumpPackageJson(relPath: string, version: string): void {
  const path = join(ROOT, relPath);
  const raw = readFileSync(path, "utf-8");
  const updated = raw.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (updated === raw && !raw.includes(`"version": "${version}"`)) {
    fail(`no se encontro el campo version en ${relPath}`);
  }
  writeFileSync(path, updated);
  console.log(`  ${relPath}`);
}

function bumpCargoToml(version: string): void {
  const path = join(ROOT, CARGO_TOML);
  const raw = readFileSync(path, "utf-8");
  // Solo la primera aparicion: la de [package], antes de las dependencias.
  const updated = raw.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  if (updated === raw && !raw.includes(`version = "${version}"`)) {
    fail(`no se encontro el campo version en ${CARGO_TOML}`);
  }
  writeFileSync(path, updated);
  console.log(`  ${CARGO_TOML}`);
}

function writeVersionTs(version: string): void {
  const path = join(ROOT, VERSION_TS);
  const content = `/**
 * Version del servicio, embebida en el binario compilado (bun build --compile
 * no tiene un package.json a mano en runtime).
 *
 * Generado/actualizado por scripts/bump-version.ts — NO editar a mano.
 */
export const VERSION = "${version}";
`;
  writeFileSync(path, content);
  console.log(`  ${VERSION_TS}`);
}

const version = process.argv[2];
if (!version) fail("uso: bun run bump <X.Y.Z>");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`version invalida "${version}" — se espera X.Y.Z (ej: 0.2.0)`);
}

console.log(`Actualizando version a ${version}:`);
for (const p of PACKAGE_JSONS) bumpPackageJson(p, version);
bumpCargoToml(version);
writeVersionTs(version);

console.log(`
Listo. Proximos pasos para publicar:

  git add -A && git commit -m "v${version}"
  git tag v${version}
  git push && git push --tags

El push del tag dispara el workflow de release que publica el instalador
en GitHub Releases.`);
