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

const MANIFEST_URL = "https://sinnick.dev/wiener/update/latest.json";

/** sha256 de un cuerpo de instalador de prueba. */
function sha256Of(chunks: Uint8Array[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const c of chunks) hasher.update(c);
  return hasher.digest("hex");
}

interface ManifestInstaller {
  url?: unknown;
  sha256?: unknown;
  size?: unknown;
  /** Campos extra que el checker tiene que ignorar sin romperse. */
  [key: string]: unknown;
}

function manifestJson(
  version: string,
  installer: ManifestInstaller | null = null,
  extra: Record<string, unknown> = {},
): Response {
  const body: Record<string, unknown> = {
    version,
    notes: "notas",
    publishedAt: "2026-08-13T12:00:00Z",
    ...extra,
  };
  if (installer !== null) body.installer = installer;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeChecker(
  fetchImpl: FetchLike,
  overrides: Partial<UpdateCheckerOptions> = {},
): UpdateChecker {
  return new UpdateChecker({
    currentVersion: "0.1.0",
    manifestUrl: MANIFEST_URL,
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

const INSTALLER: ManifestInstaller = {
  url: "wiener-xs20-bridge_0.2.0_x64-setup.exe",
  sha256: "a".repeat(64),
  size: 10,
};

describe("checkNow", () => {
  test("version nueva → update-available con datos del manifest", async () => {
    const checker = makeChecker(async () => manifestJson("0.2.0", INSTALLER));
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
    expect(st.latestVersion).toBe("0.2.0");
    expect(st.releaseNotes).toBe("notas");
    expect(st.publishedAt).toBe("2026-08-13T12:00:00Z");
    expect(st.lastCheckError).toBeNull();
    expect(st.lastCheckAt).not.toBeNull();
  });

  test("acepta version con prefijo v y url absoluta", async () => {
    const checker = makeChecker(async () =>
      manifestJson("v0.3.0", {
        ...INSTALLER,
        url: "https://otro.example.com/setup.exe",
      }),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
    expect(st.latestVersion).toBe("0.3.0");
  });

  test("campos extra desconocidos no rompen el parseo", async () => {
    const checker = makeChecker(async () =>
      manifestJson("0.2.0", { ...INSTALLER, arch: "x64" }, { channel: "stable", futuro: 1 }),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
  });

  test("misma version → idle sin latestVersion", async () => {
    const checker = makeChecker(async () => manifestJson("0.1.0", INSTALLER));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.latestVersion).toBeNull();
    expect(st.lastCheckError).toBeNull();
  });

  test("version menor → idle", async () => {
    const checker = makeChecker(async () => manifestJson("0.0.9", INSTALLER));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });

  test("version omitida por el usuario → idle pero latestVersion informativo", async () => {
    const checker = makeChecker(async () => manifestJson("0.2.0", INSTALLER), {
      getSkippedVersion: () => "0.2.0",
    });
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.latestVersion).toBe("0.2.0");
    expect(st.skippedVersion).toBe("0.2.0");
  });

  // ── Casos benignos: una PC sin internet no tiene que ver rojo ──────────────

  test("red caida → sin error visible, phase preservada", async () => {
    const checker = makeChecker(async () => {
      throw new Error("fetch failed");
    });
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
    expect(st.lastCheckAt).not.toBeNull();
  });

  test("404 (todavia no se publico nada) → sin error visible", async () => {
    const checker = makeChecker(async () => new Response("Not Found", { status: 404 }));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });

  test("servidor caido (503) → sin error visible", async () => {
    const checker = makeChecker(async () => new Response("nope", { status: 503 }));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });

  test("el catch-all del sitio devuelve HTML 200 → sin error visible", async () => {
    const checker = makeChecker(
      async () =>
        new Response("<!doctype html><html><body>home</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
    expect(st.latestVersion).toBeNull();
  });

  test("JSON que no es un manifest → sin error visible", async () => {
    const checker = makeChecker(
      async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });

  // ── Casos accionables: el manifest existe pero esta mal publicado ──────────

  test("version invalida en el manifest → error visible", async () => {
    const checker = makeChecker(async () => manifestJson("ultima", INSTALLER));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toContain("version invalida");
  });

  test("manifest sin bloque installer → error visible", async () => {
    const checker = makeChecker(async () => manifestJson("0.2.0", null));
    const st = await checker.checkNow();
    expect(st.lastCheckError).toContain("installer");
  });

  test("manifest sin sha256 → error visible (el hash es obligatorio)", async () => {
    const checker = makeChecker(async () =>
      manifestJson("0.2.0", { url: INSTALLER.url, size: 10 }),
    );
    const st = await checker.checkNow();
    expect(st.lastCheckError).toContain("sha256");
  });

  test("sha256 que no es hex de 64 → error visible", async () => {
    const checker = makeChecker(async () =>
      manifestJson("0.2.0", { ...INSTALLER, sha256: "abc123" }),
    );
    const st = await checker.checkNow();
    expect(st.lastCheckError).toContain("sha256");
  });

  test("url del instalador invalida → error visible", async () => {
    const checker = makeChecker(async () =>
      manifestJson("0.2.0", { ...INSTALLER, url: "ftp://servidor/setup.exe" }),
    );
    const st = await checker.checkNow();
    expect(st.lastCheckError).toContain("URL invalida");
  });

  test("un manifest roto de una version VIEJA no molesta", async () => {
    // Nadie va a instalar 0.0.9: no hace falta validar su instalador.
    const checker = makeChecker(async () => manifestJson("0.0.9", null));
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });

  test("deshabilitado → no fetchea", async () => {
    let calls = 0;
    const checker = makeChecker(
      async () => {
        calls++;
        return manifestJson("0.2.0", INSTALLER);
      },
      { isEnabled: () => false },
    );
    const st = await checker.checkNow();
    expect(calls).toBe(0);
    expect(st.phase).toBe("idle");
    expect(st.updateCheckEnabled).toBe(false);
  });

  test("un chequeo sin red despues de uno exitoso preserva el update-available", async () => {
    let fail = false;
    const checker = makeChecker(async () => {
      if (fail) throw new Error("sin red");
      return manifestJson("0.2.0", INSTALLER);
    });
    await checker.checkNow();
    fail = true;
    const st = await checker.checkNow();
    expect(st.phase).toBe("update-available");
    expect(st.lastCheckError).toBeNull();
  });

  test("dos chequeos solapados: el segundo no deja la phase pegada en checking", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const checker = makeChecker(async () => {
      calls++;
      await gate;
      return manifestJson("0.2.0", INSTALLER);
    });

    const first = checker.checkNow();
    // El segundo entra mientras el primero espera la respuesta.
    const second = await checker.checkNow();
    expect(second.phase).toBe("checking");
    expect(calls).toBe(1); // el guard evito el fetch duplicado

    release();
    await first;
    expect(checker.getStatus().phase).toBe("update-available");
  });

  test("timeout del manifest: aborta y no queda pegado", async () => {
    const checker = makeChecker(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation timed out")),
          );
        }),
      { manifestTimeoutMs: 50 },
    );
    const st = await checker.checkNow();
    expect(st.phase).toBe("idle");
    expect(st.lastCheckError).toBeNull();
  });
});

describe("startDownload", () => {
  const CHUNKS = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9, 10])];
  const GOOD_SHA = sha256Of(CHUNKS);

  /** fetch que responde el manifest y despues sirve el binario en chunks. */
  function downloadFetch(opts: {
    chunks: Uint8Array[];
    failMidway?: boolean;
    sha256?: string;
    size?: number | null;
    onDownloadCall?: () => void;
  }): FetchLike {
    const installer: ManifestInstaller = {
      url: "https://sinnick.dev/wiener/update/wiener-xs20-bridge_0.2.0_x64-setup.exe",
      sha256: opts.sha256 ?? sha256Of(opts.chunks),
      ...(opts.size === null
        ? {}
        : { size: opts.size ?? opts.chunks.reduce((n, c) => n + c.byteLength, 0) }),
    };
    return async (url: string) => {
      if (url === MANIFEST_URL) return manifestJson("0.2.0", installer);
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
      downloadFetch({ chunks: [CHUNKS[0]!], failMidway: true, size: null }),
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

  test("sha256 que no coincide → phase error y nada queda en disco", async () => {
    const updatesDir = tmpUpdatesDir();
    const bad = makeChecker(
      downloadFetch({ chunks: CHUNKS, sha256: "0".repeat(64) }),
      { updatesDir },
    );
    await bad.checkNow();
    bad.startDownload();
    await waitFor(() => bad.getStatus().phase === "error");
    expect(bad.getStatus().download?.error).toContain("SHA-256");
    expect(readdirSync(updatesDir)).toEqual([]);
  });

  test("sha256 correcto (mayusculas en el manifest) → descarga valida", async () => {
    const checker = makeChecker(downloadFetch({ chunks: CHUNKS, sha256: GOOD_SHA.toUpperCase() }));
    await checker.checkNow();
    checker.startDownload();
    await waitFor(() => checker.getStatus().phase === "downloaded");
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
    let manifestCalls = 0;
    const impl = downloadFetch({ chunks: CHUNKS });
    const counting: FetchLike = async (url, init) => {
      if (url === MANIFEST_URL) manifestCalls++;
      return impl(url, init);
    };
    const checker = makeChecker(counting);
    await checker.checkNow();
    expect(manifestCalls).toBe(1);
    checker.startDownload();
    const st = await checker.checkNow();
    expect(manifestCalls).toBe(1); // no volvio a consultar
    expect(st.phase).toBe("downloading");
    await waitFor(() => checker.getStatus().phase === "downloaded");
  });
});

describe("start/stop", () => {
  test("start limpia .part huerfanos y stop no deja timers", async () => {
    const updatesDir = tmpUpdatesDir();
    writeFileSync(join(updatesDir, "viejo.exe.part"), "basura");
    const checker = makeChecker(async () => manifestJson("0.1.0", INSTALLER), {
      updatesDir,
      initialDelayMs: 60_000,
    });
    checker.start();
    expect(readdirSync(updatesDir)).toEqual([]);
    checker.stop();
  });

  test("start borra instaladores viejos aunque no haya red (PC offline)", async () => {
    const updatesDir = tmpUpdatesDir();
    writeFileSync(join(updatesDir, "wiener-xs20-bridge_0.2.0_x64-setup.exe"), "100 MB");
    const checker = makeChecker(
      async () => {
        throw new Error("sin red");
      },
      { updatesDir, initialDelayMs: 60_000 },
    );
    checker.start();
    expect(readdirSync(updatesDir)).toEqual([]);
    checker.stop();
  });
});
