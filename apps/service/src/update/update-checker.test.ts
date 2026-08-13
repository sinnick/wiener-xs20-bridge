import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../logger.js";
import {
  UpdateChecker,
  type FetchLike,
  type UpdateCheckerOptions,
} from "./update-checker.js";

// Logger que no escribe a consola (buffer a /tmp efimero, nivel error).
function silentLogger(): Logger {
  return new Logger({
    logDir: "/tmp/xs20-test-logs-" + Math.random().toString(36).slice(2),
    level: "error",
    console: false,
  });
}

const dirsToClean: string[] = [];

function tmpUpdatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xs20-updates-"));
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    rmSync(dirsToClean.pop()!, { recursive: true, force: true });
  }
});

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string;
}

function releaseJson(tag: string, assets: ReleaseAsset[], body = "notas"): Response {
  return new Response(
    JSON.stringify({ tag_name: tag, body, published_at: "2026-08-13T12:00:00Z", assets }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeChecker(
  fetchImpl: FetchLike,
  overrides: Partial<UpdateCheckerOptions> = {},
): UpdateChecker {
  return new UpdateChecker({
    currentVersion: "0.1.0",
    repoSlug: "sinnick/wiener-xs20-bridge",
    updatesDir: tmpUpdatesDir(),
    logger: silentLogger(),
    fetchImpl,
    isEnabled: () => true,
    getSkippedVersion: () => "",
    ...overrides,
  });
}

/** Espera hasta que cond() sea true (la descarga corre en background). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
    await Bun.sleep(10);
  }
}

const SETUP_ASSET: ReleaseAsset = {
  name: "wiener-xs20-bridge_0.2.0_x64-setup.exe",
  browser_download_url: "https://example.com/download/setup.exe",
  size: 10,
};

describe("checkNow", () => {
  test("version nueva → update-available con datos del release", async () => {
    const checker = makeChecker(async () => releaseJson("v0.2.0", [SETUP_ASSET]));
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
    expect(st.latestVersion).toBe("0.2.0");
    expect(st.releaseNotes).toBe("notas");
    expect(st.publishedAt).toBe("2026-08-13T12:00:00Z");
    expect(st.lastCheckError).toBeNull();
    expect(st.lastCheckAt).not.toBeNull();
  });

  test("misma version → idle sin latestVersion", async () => {
    const checker = makeChecker(async () => releaseJson("v0.1.0", [SETUP_ASSET]));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.latestVersion).toBeNull();
  });

  test("version menor → idle", async () => {
    const checker = makeChecker(async () => releaseJson("v0.0.9", [SETUP_ASSET]));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
  });

  test("version omitida por el usuario → idle pero latestVersion informativo", async () => {
    const checker = makeChecker(async () => releaseJson("v0.2.0", [SETUP_ASSET]), {
      getSkippedVersion: () => "0.2.0",
    });
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.latestVersion).toBe("0.2.0");
    expect(st.skippedVersion).toBe("0.2.0");
  });

  test("red caida → lastCheckError sin lanzar, phase preservada", async () => {
    const checker = makeChecker(async () => {
      throw new Error("fetch failed");
    });
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBe("fetch failed");
    expect(st.lastCheckAt).not.toBeNull();
  });

  test("HTTP 403 → error legible de rate limit", async () => {
    const checker = makeChecker(async () => new Response("forbidden", { status: 403 }));
    const st = await checker.checkNow();
    expect(st.lastCheckError).toContain("rate limit");
  });

  test("JSON invalido → lastCheckError", async () => {
    const checker = makeChecker(
      async () => new Response("<html>not json</html>", { status: 200 }),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).not.toBeNull();
  });

  test("release sin asset -setup.exe → lastCheckError", async () => {
    const checker = makeChecker(async () =>
      releaseJson("v0.2.0", [
        { name: "SHA256SUMS.txt", browser_download_url: "https://example.com/sums" },
      ]),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toContain("-setup.exe");
  });

  test("deshabilitado → no fetchea", async () => {
    let calls = 0;
    const checker = makeChecker(
      async () => {
        calls++;
        return releaseJson("v0.2.0", [SETUP_ASSET]);
      },
      { isEnabled: () => false },
    );
    const st = await checker.checkNow();
    expect(calls).toBe(0);
    expect(st.phase).toBe("idle");
    expect(st.updateCheckEnabled).toBe(false);
  });

  test("un chequeo fallido despues de uno exitoso preserva el update-available", async () => {
    let fail = false;
    const checker = makeChecker(async () => {
      if (fail) throw new Error("sin red");
      return releaseJson("v0.2.0", [SETUP_ASSET]);
    });
    await checker.checkNow();
    fail = true;
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
    expect(st.lastCheckError).toBe("sin red");
  });
});

describe("startDownload", () => {
  /** fetch que responde el release y despues sirve el binario en chunks. */
  function downloadFetch(opts: {
    chunks: Uint8Array[];
    failMidway?: boolean;
    digest?: string;
    onDownloadCall?: () => void;
  }): FetchLike {
    const asset: ReleaseAsset = {
      ...SETUP_ASSET,
      size: opts.failMidway
        ? undefined as unknown as number
        : opts.chunks.reduce((n, c) => n + c.byteLength, 0),
      ...(opts.digest ? { digest: opts.digest } : {}),
    };
    return async (url: string) => {
      if (url.includes("api.github.com")) {
        return releaseJson("v0.2.0", [asset]);
      }
      opts.onDownloadCall?.();
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of opts.chunks) {
            controller.enqueue(chunk);
            await Bun.sleep(5);
          }
          if (opts.failMidway) controller.error(new Error("conexion cortada"));
          else controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
  }

  const CHUNKS = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9, 10])];

  test("descarga completa: progreso, rename final y phase downloaded", async () => {
    const updatesDir = tmpUpdatesDir();
    const checker = makeChecker(downloadFetch({ chunks: CHUNKS }), { updatesDir });
    await checker.checkNow();

    const st0 = checker.startDownload();
    expect(st0.phase).toBe("downloading");

    await waitFor(() => checker.getStatus().phase === "downloaded");
    const st = checker.getStatus();
    expect(st.download?.downloadedBytes).toBe(10);
    expect(st.download?.totalBytes).toBe(10);
    expect(st.download?.error).toBeNull();
    const expectedPath = join(updatesDir, "wiener-xs20-bridge_0.2.0_x64-setup.exe");
    expect(st.download?.installerPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath).length).toBe(10);
    // No queda .part huerfano.
    expect(readdirSync(updatesDir).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  test("error a mitad de stream → .part borrado y phase error", async () => {
    const updatesDir = tmpUpdatesDir();
    const checker = makeChecker(
      downloadFetch({ chunks: [CHUNKS[0]!], failMidway: true }),
      { updatesDir },
    );
    await checker.checkNow();
    checker.startDownload();

    await waitFor(() => checker.getStatus().phase === "error");
    const st = checker.getStatus();
    expect(st.download?.error).toContain("conexion cortada");
    expect(readdirSync(updatesDir)).toEqual([]);
  });

  test("dos startDownload concurrentes → una sola descarga", async () => {
    let downloadCalls = 0;
    const checker = makeChecker(
      downloadFetch({ chunks: CHUNKS, onDownloadCall: () => downloadCalls++ }),
    );
    await checker.checkNow();
    checker.startDownload();
    checker.startDownload();
    await waitFor(() => checker.getStatus().phase === "downloaded");
    expect(downloadCalls).toBe(1);
  });

  test("digest sha256 del asset se verifica", async () => {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const c of CHUNKS) hasher.update(c);
    const goodDigest = `sha256:${hasher.digest("hex")}`;

    const ok = makeChecker(downloadFetch({ chunks: CHUNKS, digest: goodDigest }));
    await ok.checkNow();
    ok.startDownload();
    await waitFor(() => ok.getStatus().phase === "downloaded");

    const bad = makeChecker(
      downloadFetch({ chunks: CHUNKS, digest: `sha256:${"0".repeat(64)}` }),
    );
    await bad.checkNow();
    bad.startDownload();
    await waitFor(() => bad.getStatus().phase === "error");
    expect(bad.getStatus().download?.error).toContain("SHA-256");
  });

  test("sin update disponible no descarga nada", async () => {
    let downloadCalls = 0;
    const checker = makeChecker(
      downloadFetch({ chunks: CHUNKS, onDownloadCall: () => downloadCalls++ }),
    );
    // Sin checkNow previo: phase idle.
    const st = checker.startDownload();
    expect(st.phase).toBe("idle");
    await Bun.sleep(30);
    expect(downloadCalls).toBe(0);
  });

  test("checkNow durante una descarga no la pisa", async () => {
    let releaseCalls = 0;
    const impl = downloadFetch({ chunks: CHUNKS });
    const counting: FetchLike = async (url, init) => {
      if (url.includes("api.github.com")) releaseCalls++;
      return impl(url, init);
    };
    const checker = makeChecker(counting);
    await checker.checkNow();
    expect(releaseCalls).toBe(1);
    checker.startDownload();
    const st = await checker.checkNow();
    expect(releaseCalls).toBe(1); // no volvio a consultar
    expect(st.phase).toBe("downloading");
    await waitFor(() => checker.getStatus().phase === "downloaded");
  });
});

describe("start/stop", () => {
  test("start limpia .part huerfanos y stop no deja timers", async () => {
    const updatesDir = tmpUpdatesDir();
    writeFileSync(join(updatesDir, "viejo.exe.part"), "basura");
    const checker = makeChecker(async () => releaseJson("v0.1.0", [SETUP_ASSET]), {
      updatesDir,
      initialDelayMs: 60_000,
    });
    checker.start();
    expect(readdirSync(updatesDir)).toEqual([]);
    checker.stop();
  });
});
