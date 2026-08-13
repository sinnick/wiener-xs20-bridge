/**
 * Chequeo de versiones nuevas contra GitHub Releases + descarga del instalador.
 *
 * El servicio consulta periodicamente el ultimo Release del repo (publico, sin
 * auth; el rate limit de 60 req/h sobra para un chequeo cada 6 h). Si hay una
 * version mas nueva, la UI lo ve via GET /api/update/status y ofrece descargar:
 * la descarga la hace este modulo (streaming a <dataDir>/updates con progreso)
 * y el instalador lo lanza la app Tauri (comando run_installer).
 *
 * Un fallo de red nunca rompe nada: queda en lastCheckError y se reintenta en
 * el proximo ciclo (una PC de laboratorio sin internet simplemente no ve
 * updates). fetchImpl es inyectable para los tests.
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
import { isNewerVersion } from "./semver.js";

const USER_AGENT = "wiener-xs20-bridge";
const MAX_RELEASE_NOTES_CHARS = 2000;

/**
 * Firma minima de fetch que usa el checker. Es mas angosta que `typeof fetch`
 * de Bun (que suma props como preconnect) para que los mocks de test sean
 * funciones simples.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheckerOptions {
  /** Version que corre este servicio (apps/service/src/version.ts). */
  currentVersion: string;
  /** "owner/repo" en GitHub. */
  repoSlug: string;
  /** Carpeta donde se descargan los instaladores (<dataDir>/updates). */
  updatesDir: string;
  logger: Logger;
  /** Inyectable para tests. Default: fetch global. */
  fetchImpl?: FetchLike;
  /** Cada cuanto chequear. Default 6 h. */
  checkIntervalMs?: number;
  /** Espera antes del primer chequeo (no frenar el arranque). Default 60 s. */
  initialDelayMs?: number;
  /** Lee config.updateCheckEnabled en vivo. */
  isEnabled: () => boolean;
  /** Lee config.skippedVersion en vivo ("" = ninguna). */
  getSkippedVersion: () => string;
}

/** Shape minimo de la respuesta de GET /repos/:slug/releases/latest. */
interface GitHubRelease {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    size?: number;
    digest?: string | null;
  }>;
}

interface LatestRelease {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  assetUrl: string;
  assetSize: number | null;
  /** "sha256:<hex>" si la API lo trae; se verifica al descargar. */
  assetDigest: string | null;
}

interface DownloadState {
  totalBytes: number | null;
  downloadedBytes: number;
  installerPath: string | null;
  error: string | null;
}

export class UpdateChecker {
  private phase: UpdatePhase = "idle";
  private latest: LatestRelease | null = null;
  private lastCheckAt: Date | null = null;
  private lastCheckError: string | null = null;
  private download: DownloadState | null = null;

  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;

  private readonly fetchImpl: FetchLike;
  private readonly checkIntervalMs: number;
  private readonly initialDelayMs: number;

  constructor(private opts: UpdateCheckerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.checkIntervalMs = opts.checkIntervalMs ?? 6 * 60 * 60 * 1000;
    this.initialDelayMs = opts.initialDelayMs ?? 60_000;
  }

  /** Arranca el ciclo periodico (patron del purgeTimer de main.ts). */
  start(): void {
    this.cleanupPartials();
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

  /** Consulta releases/latest y actualiza el estado. Nunca lanza. */
  async checkNow(): Promise<UpdateStatusResponse> {
    if (!this.opts.isEnabled()) return this.getStatus();
    // No pisar una descarga en curso.
    if (this.phase === "downloading") return this.getStatus();

    const prevPhase = this.phase;
    this.phase = "checking";

    try {
      const res = await this.fetchImpl(
        `https://api.github.com/repos/${this.opts.repoSlug}/releases/latest`,
        {
          headers: {
            // GitHub exige User-Agent; sin el responde 403.
            "User-Agent": USER_AGENT,
            Accept: "application/vnd.github+json",
          },
        },
      );
      this.lastCheckAt = new Date();

      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? `HTTP 403 (posible rate limit de GitHub)`
            : `HTTP ${res.status}`,
        );
      }

      const release = (await res.json()) as GitHubRelease;
      const tag = release.tag_name;
      if (typeof tag !== "string" || tag.length === 0) {
        throw new Error("respuesta sin tag_name");
      }

      if (!isNewerVersion(tag, this.opts.currentVersion)) {
        // Al dia (o el tag es raro): no hay update que ofrecer.
        this.latest = null;
        this.download = null;
        this.lastCheckError = null;
        this.phase = "idle";
        this.cleanupInstallers(null);
        return this.getStatus();
      }

      const asset = (release.assets ?? []).find(
        (a) => typeof a.name === "string" && a.name.endsWith("-setup.exe"),
      );
      if (!asset || typeof asset.browser_download_url !== "string") {
        throw new Error(`el release ${tag} no tiene un asset -setup.exe`);
      }

      const version = tag.replace(/^v/, "");
      const sameAsBefore = this.latest?.version === version;
      this.latest = {
        version,
        notes:
          typeof release.body === "string"
            ? release.body.slice(0, MAX_RELEASE_NOTES_CHARS)
            : null,
        publishedAt: release.published_at ?? null,
        assetUrl: asset.browser_download_url,
        assetSize: typeof asset.size === "number" ? asset.size : null,
        assetDigest: typeof asset.digest === "string" ? asset.digest : null,
      };
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
          latestVersion: version,
        });
      }
    } catch (e) {
      // Red caida, rate limit, JSON invalido, release sin asset: se registra y
      // se reintenta en el proximo ciclo. El estado previo se preserva.
      this.lastCheckAt = new Date();
      this.lastCheckError = (e as Error).message;
      this.phase = prevPhase;
      this.opts.logger.warn("update.check_failed", {
        error: this.lastCheckError,
      });
    }
    return this.getStatus();
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
      totalBytes: target.assetSize,
      downloadedBytes: 0,
      installerPath: null,
      error: null,
    };
    this.abort = new AbortController();

    const finalName = `wiener-xs20-bridge_${target.version}_x64-setup.exe`;
    const partPath = join(this.opts.updatesDir, `${finalName}.part`);

    try {
      mkdirSync(this.opts.updatesDir, { recursive: true });

      const res = await this.fetchImpl(target.assetUrl, {
        signal: this.abort.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("respuesta sin body");

      if (this.download.totalBytes === null) {
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > 0) this.download.totalBytes = len;
      }

      const expectedSha256 = target.assetDigest?.startsWith("sha256:")
        ? target.assetDigest.slice("sha256:".length).toLowerCase()
        : null;
      const hasher = expectedSha256 ? new Bun.CryptoHasher("sha256") : null;

      const writer = Bun.file(partPath).writer();
      try {
        for await (const chunk of res.body) {
          writer.write(chunk);
          hasher?.update(chunk);
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
      if (hasher && expectedSha256) {
        const actual = hasher.digest("hex");
        if (actual !== expectedSha256) {
          throw new Error("el SHA-256 del archivo no coincide con el del release");
        }
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
