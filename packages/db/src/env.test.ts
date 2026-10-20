import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRootEnv, requireEnv } from "./env.js";

describe("requireEnv", () => {
  it("returns the value when set", () => {
    process.env["TPIRS_TEST_VAR"] = "value";
    expect(requireEnv("TPIRS_TEST_VAR")).toBe("value");
  });

  it("throws when missing or empty", () => {
    delete process.env["TPIRS_TEST_VAR"];
    expect(() => requireEnv("TPIRS_TEST_VAR")).toThrow("TPIRS_TEST_VAR");
    process.env["TPIRS_TEST_VAR"] = "";
    expect(() => requireEnv("TPIRS_TEST_VAR")).toThrow("TPIRS_TEST_VAR");
  });
});

describe("loadRootEnv", () => {
  it("loads variables from a .env file without overriding existing ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tpirs-env-"));
    writeFileSync(path.join(dir, ".env"), "TPIRS_FROM_FILE=loaded\nTPIRS_TEST_VAR=original\n");
    process.env["TPIRS_TEST_VAR"] = "original";
    loadRootEnv(dir);
    expect(process.env["TPIRS_FROM_FILE"]).toBe("loaded");
    expect(process.env["TPIRS_TEST_VAR"]).toBe("original");
  });

  it("does nothing when .env is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tpirs-env-"));
    expect(() => loadRootEnv(dir)).not.toThrow();
  });
});
