import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSettings, saveSettings } from "./settings-store.js";

describe("settings-store", () => {
  const created: string[] = [];

  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), "xs20-settings-"));
    created.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of created.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("archivo inexistente → {}", () => {
    expect(loadSettings(join(tmpDir(), "settings.json"))).toEqual({});
  });

  test("round-trip: lo que se guarda es lo que se lee", () => {
    const path = join(tmpDir(), "settings.json");
    const settings = {
      tcpHost: "192.168.1.50",
      tcpPort: 5200,
      logLevel: "warn" as const,
      rawRetentionDays: 30,
    };
    saveSettings(path, settings);
    expect(loadSettings(path)).toEqual(settings);
  });

  test("exportDir vacio se conserva (deshabilitado, no cae al default)", () => {
    const path = join(tmpDir(), "settings.json");
    saveSettings(path, { exportDir: "" });
    expect(loadSettings(path)).toEqual({ exportDir: "" });
  });

  test("crea el directorio padre si no existe", () => {
    const path = join(tmpDir(), "nested", "deep", "settings.json");
    saveSettings(path, { tcpPort: 5100 });
    expect(existsSync(path)).toBe(true);
    expect(loadSettings(path)).toEqual({ tcpPort: 5100 });
  });

  test("descarta campos con tipos incorrectos, conserva los validos", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        tcpPort: "no-es-numero",
        tcpHost: 123,
        logLevel: "gritando",
        rawRetentionDays: -5,
        campoDesconocido: "x",
        // este si es valido:
        // (se agrega para verificar que no descartamos todo)
      }),
      "utf-8",
    );
    expect(loadSettings(path)).toEqual({});
  });

  test("conserva solo los campos editables conocidos", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ tcpPort: 5100, logLevel: "debug", httpPort: 9999, dbPath: "x" }),
      "utf-8",
    );
    expect(loadSettings(path)).toEqual({ tcpPort: 5100, logLevel: "debug" });
  });

  test("JSON corrupto → {} (no crashea)", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(path, "{ esto no es json ", "utf-8");
    expect(loadSettings(path)).toEqual({});
  });

  test("updateCheckEnabled: boolean valido se conserva, otro tipo se descarta", () => {
    const path = join(tmpDir(), "settings.json");
    saveSettings(path, { updateCheckEnabled: false });
    expect(loadSettings(path)).toEqual({ updateCheckEnabled: false });

    writeFileSync(path, JSON.stringify({ updateCheckEnabled: "si" }), "utf-8");
    expect(loadSettings(path)).toEqual({});
  });

  test("skippedVersion: string (incluso vacio) se conserva, otro tipo se descarta", () => {
    const path = join(tmpDir(), "settings.json");
    saveSettings(path, { skippedVersion: "0.2.0" });
    expect(loadSettings(path)).toEqual({ skippedVersion: "0.2.0" });

    saveSettings(path, { skippedVersion: "" });
    expect(loadSettings(path)).toEqual({ skippedVersion: "" });

    writeFileSync(path, JSON.stringify({ skippedVersion: 2 }), "utf-8");
    expect(loadSettings(path)).toEqual({});
  });
});
