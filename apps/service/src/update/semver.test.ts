import { describe, expect, test } from "bun:test";

import { compareVersions, isNewerVersion, parseVersion } from "./semver.js";

describe("parseVersion", () => {
  test("parsea X.Y.Z", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("12.34.56")).toEqual([12, 34, 56]);
  });

  test("acepta prefijo v (formato de tag)", () => {
    expect(parseVersion("v0.2.0")).toEqual([0, 2, 0]);
  });

  test("tolera espacios alrededor", () => {
    expect(parseVersion(" v1.0.0 ")).toEqual([1, 0, 0]);
  });

  test("rechaza formatos invalidos", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
    expect(parseVersion("1.2.x")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
    expect(parseVersion("1.2.3-rc.1")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("ordena por major, minor y patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.1.2", "0.1.10")).toBe(-1);
  });

  test("iguales (con o sin prefijo v)", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("version invalida pierde contra cualquier valida", () => {
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
    expect(compareVersions("0.0.1", "garbage")).toBe(1);
    expect(compareVersions("garbage", "basura")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  test("solo true si es estrictamente mas nueva", () => {
    expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
  });

  test("un tag invalido nunca dispara update", () => {
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
  });
});
