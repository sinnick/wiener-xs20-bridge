/**
 * Chequeo de versiones nuevas contra nuestro propio servidor + descarga del
 * instalador.
 *
 * El servicio consulta periodicamente un manifest estatico publicado en el VPS
 * (por defecto https://sinnick.dev/wiener/update/latest.json, lo sube
 * scripts/release.ts). Si anuncia una version mas nueva, la UI lo ve via
 * GET /api/update/status y ofrece descargar: la descarga la hace este modulo
 * (streaming a <dataDir>/updates con progreso) y el instalador lo lanza la app
 * Tauri (comando run_installer, elevado con UAC).
 *
 * Formato del manifest (ver docs/12-actualizaciones.md):
 *
 *   {
 *     "version": "0.2.0",
 *     "notes": "Texto corto de novedades",
 *     "publishedAt": "2026-08-21T13:45:00.000Z",
 *     "installer": {
 *       "url": "wiener-xs20-bridge_0.2.0_x64-setup.exe",
 *       "sha256": "<64 hex>",
 *       "size": 12345678
 *     }
 *   }
 *
 * `url` puede ser absoluta o relativa al manifest. El `sha256` es OBLIGATORIO:
 * ese .exe despues corre elevado, asi que el hash es la unica barrera de
 * integridad que tenemos (no hay firma de codigo). Un archivo cuyo hash no
 * coincide se descarta.
 *
 * Ruido cero en una PC sin internet: red caida, timeout, 404 (todavia no se
 * publico nada) o cualquier respuesta que no sea un manifest JSON se tratan
 * como "no hay novedades" — se loguean pero NO ensucian lastCheckError, que es
 * lo que la UI pinta de rojo. Solo se reporta como error algo accionable: un
 * manifest bien formado que anuncia una version nueva con datos invalidos
 * (sha256 faltante, url rara), o una descarga que falla.
 *
 * fetchImpl es inyectable para los tests.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import type { UpdatePhase, UpdateStatusResponse } from "@xs20/shared";

import type { Logger } from "../logger.js";
import { isNewerVersion, parseVersion } from "./semver.js";

const USER_AGENT = "wiener-xs20-bridge";
const MAX_RELEASE_NOTES_CHARS = 2000;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Firma minima de fetch que usa el checker. Es mas angosta que `typeof fetch`
 * de Bun (que suma props como preconnect) para que los mocks de test sean
 * funciones simples.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheckerOptions {
  /** Version que corre este servicio (apps/service/src/version.ts). */
  currentVersion: string;
  /** URL del manifest JSON (ej. https://sinnick.dev/wiener/update/latest.json). */
  manifestUrl: string;
  /** Carpeta donde se descargan los instaladores (<dataDir>/updates). */
  updatesDir: string;
  logger: Logger;
  /** Inyectable para tests. Default: fetch global. */
  fetchImpl?: FetchLike;
  /** Cada cuanto chequear. Default 6 h. */
  checkIntervalMs?: number;
  /** Espera antes del primer chequeo (no frenar el arranque). Default 60 s. */
  initialDelayMs?: number;
  /** Timeout del GET del manifest. Default 20 s. */
  manifestTimeoutMs?: number;
  /** Lee config.updateCheckEnabled en vivo. */
  isEnabled: () => boolean;
  /** Lee config.skippedVersion en vivo ("" = ninguna). */
  getSkippedVersion: () => string;
}

/** Manifest ya validado. */
interface LatestRelease {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  installerUrl: string;
  installerSize: number | null;
  /** Hex de 64 chars, siempre presente (el manifest lo exige). */
  installerSha256: string;
}

interface DownloadState {
  totalBytes: number | null;
  downloadedBytes: number;
  installerPath: string | null;
  error: string | null;
}

/**
 * Error "accionable": el manifest se pudo leer y anuncia algo, pero los datos
 * no sirven. Se muestra en la UI (es un problema de quien publico, no de la PC).
 */
class ManifestError extends Error {}

export class UpdateChecker {
  private phase: UpdatePhase = "idle";
  private latest: LatestRelease | null = null;
  private lastCheckAt: Date | null = null;
  private lastCheckError: string | null = null;
  private download: DownloadState | null = null;

  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  /** Guard de reentrada: sin esto dos chequeos solapados dejan phase pegada. */
  private checking = false;

  private readonly fetchImpl: FetchLike;
  private readonly checkIntervalMs: number;
  private readonly initialDelayMs: number;
  private readonly manifestTimeoutMs: number;

  constructor(private opts: UpdateCheckerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.checkIntervalMs = opts.checkIntervalMs ?? 6 * 60 * 60 * 1000;
    this.initialDelayMs = opts.initialDelayMs ?? 60_000;
    this.manifestTimeoutMs = opts.manifestTimeoutMs ?? 20_000;
  }

  /** Arranca el ciclo periodico (patron del purgeTimer de main.ts). */
  start(): void {
    // Limpieza incondicional: el estado de la descarga vive solo en memoria,
    // asi que cualquier .exe/.part que este en la carpeta al arrancar es
    // basura de una corrida anterior. Antes esto solo pasaba si el chequeo
    // salia bien, y en una PC sin internet el instalador (~100 MB) quedaba
    // ocupando disco para siempre.
    this.cleanupPartials();
    this.cleanupInstallers(null);
    this.initialTimer = setTimeout(() => {
      void this.checkNow();
      this.intervalTimer = setInterval(() => {
        void this.checkNow();
      }, this.checkIntervalMs);
    }, this.initialDelayMs);
  }

  /** Corta timers y aborta una descarga en curso (shutdown limpio). */
  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.abort?.abort();
  }

  getStatus(): UpdateStatusResponse {
    // La version omitida por el usuario se reporta como "idle" (el banner no
    // aparece) pero dejando latestVersion informativo para la card de Estado.
    let phase = this.phase;
    if (
      phase === "update-available" &&
      this.latest !== null &&
      this.latest.version === this.opts.getSkippedVersion()
    ) {
      phase = "idle";
    }
    return {
      phase,
      currentVersion: this.opts.currentVersion,
      latestVersion: this.latest?.version ?? null,
      releaseNotes: this.latest?.notes ?? null,
      publishedAt: this.latest?.publishedAt ?? null,
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      lastCheckError: this.lastCheckError,
      updateCheckEnabled: this.opts.isEnabled(),
      skippedVersion: this.opts.getSkippedVersion(),
      download: this.download ? { ...this.download } : null,
    };
  }

  /** Consulta el manifest y actualiza el estado. Nunca lanza. */
  async checkNow(): Promise<UpdateStatusResponse> {
    if (!this.opts.isEnabled()) return this.getStatus();
    // No pisar una descarga en curso, ni un chequeo que ya esta corriendo (si
    // no, el segundo captura prevPhase = "checking" y la deja pegada hasta el
    // proximo ciclo, o sea hasta 6 h).
    if (this.phase === "downloading") return this.getStatus();
    if (this.checking) return this.getStatus();

    this.checking = true;
    const prevPhase = this.phase;
    this.phase = "checking";

    try {
      const manifest = await this.fetchManifest();
      this.lastCheckAt = new Date();

      if (manifest === null) {
        // Sin manifest legible: no hay novedades y no es culpa de esta PC.
        this.lastCheckError = null;
        this.phase = prevPhase === "checking" ? "idle" : prevPhase;
        return this.getStatus();
      }

      if (!isNewerVersion(manifest.version, this.opts.currentVersion)) {
        // Al dia: no hay update que ofrecer y cualquier instalador guardado
        // de una version anterior ya no sirve.
        this.latest = null;
        this.download = null;
        this.lastCheckError = null;
        this.phase = "idle";
        this.cleanupInstallers(null);
        return this.getStatus();
      }

      const release = this.parseInstaller(manifest);
      const sameAsBefore = this.latest?.version === release.version;
      this.latest = release;
      this.lastCheckError = null;

      if (sameAsBefore && (prevPhase === "downloaded" || prevPhase === "error")) {
        // Misma version que ya descargamos (o fallo): preservar ese estado.
        this.phase = prevPhase;
      } else {
        // Version nueva (o primera vista): cualquier descarga vieja es basura.
        this.download = null;
        this.phase = "update-available";
        this.opts.logger.info("update.available", {
          currentVersion: this.opts.currentVersion,
          latestVersion: release.version,
        });
      }
    } catch (e) {
      // Solo llega aca lo accionable (ManifestError): un manifest que anuncia
      // una version nueva con datos rotos. Se muestra en la UI.
      this.lastCheckAt = new Date();
      this.lastCheckError = (e as Error).message;
      this.phase = prevPhase === "checking" ? "idle" : prevPhase;
      this.opts.logger.warn("update.manifest_invalid", {
        error: this.lastCheckError,
      });
    } finally {
      this.checking = false;
    }
    return this.getStatus();
  }

  /**
   * GET del manifest. Devuelve null si no hay nada publicado o no se pudo
   * llegar (red caida, timeout, 404, respuesta que no es JSON, JSON sin
   * `version`): todos casos benignos que NO tienen que pintar rojo la UI.
   * Solo lanza ManifestError si el manifest es JSON con un `version` invalido.
   */
  private async fetchManifest(): Promise<{ raw: RawManifest; version: string } | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.manifestUrl, {
        // Sin timeout, un socket colgado deja el chequeo (y la phase
        // "checking") tomado hasta el proximo ciclo.
        signal: AbortSignal.timeout(this.manifestTimeoutMs),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          // Un manifest cacheado por un proxy esconde updates.
          "Cache-Control": "no-cache",
        },
      });
    } catch (e) {
      this.opts.logger.debug("update.check_unreachable", {
        url: this.opts.manifestUrl,
        error: (e as Error).message,
      });
      return null;
    }

    if (!res.ok) {
      // 404 = todavia no se publico nada. 5xx / 403 = problema del servidor,
      // igual de inaccionable desde el laboratorio.
      this.opts.logger.debug("update.check_http_error", {
        url: this.opts.manifestUrl,
        status: res.status,
      });
      return null;
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      // Tipico: el servidor todavia no tiene la ruta configurada y devuelve
      // el HTML de la home. Para el laboratorio es "no hay novedades".
      this.opts.logger.debug("update.check_not_json", { url: this.opts.manifestUrl });
      return null;
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.opts.logger.debug("update.check_not_manifest", { url: this.opts.manifestUrl });
      return null;
    }

    const m = raw as RawManifest;
    if (typeof m.version !== "string" || m.version.trim().length === 0) {
      this.opts.logger.debug("update.check_no_version", { url: this.opts.manifestUrl });
      return null;
    }
    const version = m.version.trim().replace(/^v/, "");
    if (parseVersion(version) === null) {
      throw new ManifestError(`el manifest anuncia una version invalida "${m.version}"`);
    }
    return { raw: m, version };
  }

  /** Valida el bloque `installer` del manifest. Lanza ManifestError si no sirve. */
  private parseInstaller(manifest: { raw: RawManifest; version: string }): LatestRelease {
    const { raw, version } = manifest;
    const inst = raw.installer;
    if (typeof inst !== "object" || inst === null) {
      throw new ManifestError(`el manifest ${version} no trae el bloque "installer"`);
    }

    if (typeof inst.url !== "string" || inst.url.length === 0) {
      throw new ManifestError(`el manifest ${version} no trae la URL del instalador`);
    }
    let installerUrl: string;
    try {
      // Permite url relativa al manifest (ej. "wiener-..._0.2.0_x64-setup.exe").
      const resolved = new URL(inst.url, this.opts.manifestUrl);
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
        throw new Error("protocolo no soportado");
      }
      installerUrl = resolved.toString();
    } catch {
      throw new ManifestError(`el manifest ${version} trae una URL invalida: ${inst.url}`);
    }

    // El sha256 es obligatorio: sin firma de codigo, es lo unico que impide
    // que un .exe alterado se ejecute elevado en la PC del laboratorio.
    if (typeof inst.sha256 !== "string" || !SHA256_RE.test(inst.sha256)) {
      throw new ManifestError(
        `el manifest ${version} no trae un sha256 valido del instalador`,
      );
    }

    const size =
      typeof inst.size === "number" && Number.isFinite(inst.size) && inst.size > 0
        ? Math.floor(inst.size)
        : null;

    return {
      version,
      notes:
        typeof raw.notes === "string" ? raw.notes.slice(0, MAX_RELEASE_NOTES_CHARS) : null,
      publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
      installerUrl,
      installerSize: size,
      installerSha256: inst.sha256.toLowerCase(),
    };
  }

  /**
   * Dispara la descarga del instalador en background (el progreso se sigue por
   * polling de getStatus). Idempotente: si ya hay descarga en curso o el
   * instalador ya esta listo, no hace nada.
   */
  startDownload(): UpdateStatusResponse {
    if (this.phase === "update-available" || this.phase === "error") {
      void this.runDownload();
    }
    return this.getStatus();
  }

  private async runDownload(): Promise<void> {
    if (this.phase === "downloading" || !this.latest) return;
    const target = this.latest;
    this.phase = "downloading";
    this.download = {
      totalBytes: target.installerSize,
      downloadedBytes: 0,
      installerPath: null,
      error: null,
    };
    this.abort = new AbortController();

    // Nombre fijo derivado de la version, NUNCA del basename de la URL: el
    // path final lo termina ejecutando run_installer.
    const finalName = `wiener-xs20-bridge_${target.version}_x64-setup.exe`;
    const partPath = join(this.opts.updatesDir, `${finalName}.part`);

    try {
      mkdirSync(this.opts.updatesDir, { recursive: true });

      const res = await this.fetchImpl(target.installerUrl, {
        signal: this.abort.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("respuesta sin body");

      if (this.download.totalBytes === null) {
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > 0) this.download.totalBytes = len;
      }

      const hasher = new Bun.CryptoHasher("sha256");

      const writer = Bun.file(partPath).writer();
      try {
        for await (const chunk of res.body) {
          writer.write(chunk);
          hasher.update(chunk);
          this.download.downloadedBytes += chunk.byteLength;
        }
      } finally {
        await writer.end();
      }

      if (
        this.download.totalBytes !== null &&
        this.download.downloadedBytes !== this.download.totalBytes
      ) {
        throw new Error(
          `descarga incompleta (${this.download.downloadedBytes} de ${this.download.totalBytes} bytes)`,
        );
      }
      const actual = hasher.digest("hex");
      if (actual !== target.installerSha256) {
        throw new Error("el SHA-256 del archivo no coincide con el publicado");
      }

      const finalPath = join(this.opts.updatesDir, finalName);
      renameSync(partPath, finalPath);
      this.cleanupInstallers(finalName);

      this.download.installerPath = finalPath;
      this.phase = "downloaded";
      this.opts.logger.info("update.downloaded", {
        version: target.version,
        installerPath: finalPath,
        bytes: this.download.downloadedBytes,
      });
    } catch (e) {
      try {
        if (existsSync(partPath)) unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      if (this.abort?.signal.aborted) {
        // Shutdown a mitad de descarga: no es un error, se reintenta despues.
        this.phase = "update-available";
        this.download = null;
      } else {
        this.phase = "error";
        if (this.download) this.download.error = (e as Error).message;
        this.opts.logger.warn("update.download_failed", {
          version: target.version,
          error: (e as Error).message,
        });
      }
    } finally {
      this.abort = null;
    }
  }

  /** Borra .part huerfanos (quedan si el servicio murio a mitad de descarga). */
  private cleanupPartials(): void {
    this.removeFromUpdatesDir((name) => name.endsWith(".part"));
  }

  /** Borra instaladores que no sean `keep` (null = todos; quedaron viejos). */
  private cleanupInstallers(keep: string | null): void {
    this.removeFromUpdatesDir(
      (name) => name.endsWith(".exe") && name !== keep,
    );
  }

  private removeFromUpdatesDir(match: (name: string) => boolean): void {
    try {
      if (!existsSync(this.opts.updatesDir)) return;
      for (const name of readdirSync(this.opts.updatesDir)) {
        if (match(name)) {
          try {
            unlinkSync(join(this.opts.updatesDir, name));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/** Shape crudo del latest.json, antes de validar. */
interface RawManifest {
  version?: unknown;
  notes?: unknown;
  publishedAt?: unknown;
  installer?: {
    url?: unknown;
    sha256?: unknown;
    size?: unknown;
  } | null;
}
