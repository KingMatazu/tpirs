import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createObjectStorageConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createLocalDiskObjectStorage } from "./index.js";

const baseDir = mkdtempSync(path.join(tmpdir(), "tpirs-localdisk-"));

createObjectStorageConformanceSuite({ describe, it, expect }, () => ({
  port: createLocalDiskObjectStorage({ baseDir, signingSecret: "conformance-secret" }),
}));

describe("createLocalDiskObjectStorage", () => {
  it("rejects path traversal in keys", async () => {
    const storage = createLocalDiskObjectStorage({ baseDir });
    const error = await storage.get("../escape.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("invalid_request");
  });

  it("presigns a verifiable, expiring URL", async () => {
    const storage = createLocalDiskObjectStorage({
      baseDir,
      signingSecret: "shh",
      publicBaseUrl: "https://files.example",
    });
    const url = await storage.presignGet("a/b.txt", 60);
    expect(url.startsWith("https://files.example/a/b.txt?")).toBe(true);
    expect(url).toContain("signature=");
  });
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});
