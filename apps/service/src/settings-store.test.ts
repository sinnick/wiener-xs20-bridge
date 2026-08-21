import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("tcpPort fuera de rango se descarta (igual que analyzerPort)", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(path, JSON.stringify({ tcpPort: 70000 }), "utf-8");
    expect(loadSettings(path)).toEqual({});

    writeFileSync(path, JSON.stringify({ tcpPort: 0 }), "utf-8");
    expect(loadSettings(path)).toEqual({});
  });

  // ─── Perdida silenciosa de la config ────────────────────────────────────────
  // Volver a los defaults sin avisar es de las fallas mas dañinas del servicio:
  // se pierde analyzerHost, el bridge deja de recibir resultados, y el unico
  // sintoma que ve la operadora es que "no llega nada".

  test("un settings.json corrupto avisa fuerte en vez de silenciarse", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(path, '{"analyzerHost": "192.168.1.5", ', "utf-8");

    const warnings: string[] = [];
    expect(loadSettings(path, (w) => warnings.push(w))).toEqual({});

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("corrupto");
    // El aviso tiene que decirle a la persona QUE hacer.
    expect(warnings[0]).toContain("IP");
  });

  test("el settings.json corrupto se aparta, no se pisa (puede tener la IP)", () => {
    const dir = tmpDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"analyzerHost": "192.168.1.5", ', "utf-8");

    loadSettings(path);

    expect(existsSync(path)).toBe(false);
    const apartados = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(apartados).toHaveLength(1);
    expect(readFileSync(join(dir, apartados[0]!), "utf-8")).toContain("192.168.1.5");
  });

  test("un JSON valido que no es objeto tambien se trata como corrupto", () => {
    const path = join(tmpDir(), "settings.json");
    writeFileSync(path, "[1,2,3]", "utf-8");
    const warnings: string[] = [];
    expect(loadSettings(path, (w) => warnings.push(w))).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  test("un archivo sano no dispara ningun aviso", () => {
    const path = join(tmpDir(), "settings.json");
    saveSettings(path, { analyzerHost: "192.168.1.5" });
    const warnings: string[] = [];
    expect(loadSettings(path, (w) => warnings.push(w))).toEqual({ analyzerHost: "192.168.1.5" });
    expect(warnings).toHaveLength(0);
  });

  // ─── Escritura atomica ──────────────────────────────────────────────────────

  test("saveSettings no deja el .tmp tirado", () => {
    const dir = tmpDir();
    const path = join(dir, "settings.json");
    saveSettings(path, { tcpPort: 5200 });

    expect(existsSync(path + ".tmp")).toBe(false);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("si se corta la luz a mitad de escritura, el archivo previo sobrevive entero", () => {
    const dir = tmpDir();
    const path = join(dir, "settings.json");
    saveSettings(path, { analyzerHost: "192.168.1.5", tcpPort: 5100 });

    // Un .tmp a medio escribir de una corrida anterior no puede afectar al
    // archivo bueno: el rename es lo unico que lo reemplaza, y es atomico.
    writeFileSync(path + ".tmp", '{"analyzerHost": "192.1', "utf-8");

    expect(loadSettings(path)).toEqual({ analyzerHost: "192.168.1.5", tcpPort: 5100 });
  });

  test("sobreescribir un settings.json existente funciona (rename pisa el destino)", () => {
    const path = join(tmpDir(), "settings.json");
    saveSettings(path, { tcpPort: 5100 });
    saveSettings(path, { tcpPort: 5200 });
    expect(loadSettings(path)).toEqual({ tcpPort: 5200 });
  });
});
