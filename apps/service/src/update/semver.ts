/**
 * Comparacion de versiones X.Y.Z, sin dependencias.
 *
 * Alcanza para el update-checker: los tags del repo son siempre vX.Y.Z
 * (lo garantiza scripts/bump-version.ts). Cualquier cosa que no matchee
 * ese formato se considera invalida y no dispara updates.
 */

export type ParsedVersion = [number, number, number];

/** Parsea "1.2.3" o "v1.2.3". Devuelve null si no es X.Y.Z. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compara dos versiones: -1 si a < b, 0 si iguales, 1 si a > b.
 * Una version invalida se considera menor que cualquier valida (y dos
 * invalidas, iguales) — asi un tag raro nunca gana a la version actual.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

/** True si `candidate` es estrictamente mas nueva que `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
