import { PortError } from "@tpirs/ports";
import type { ObjectStorage } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createObjectStorageConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<ObjectStorage>,
): void {
  const { describe, it, expect } = harness;

  describe("ObjectStorage conformance", () => {
    it("round-trips an object", () =>
      withAdapter(factory, async (storage) => {
        const body = new TextEncoder().encode("conformance object body");
        await storage.put({
          key: "conformance/roundtrip.txt",
          body,
          contentType: "text/plain",
        });
        const fetched = await storage.get("conformance/roundtrip.txt");
        expect(new TextDecoder().decode(fetched.body)).toBe("conformance object body");
        expect(fetched.contentType).toBe("text/plain");
      }));

    it("throws PortError not_found for missing objects", () =>
      withAdapter(factory, async (storage) => {
        await expect(storage.get("conformance/missing.txt")).rejects.toThrow(PortError);
      }));

    it("deletes idempotently", () =>
      withAdapter(factory, async (storage) => {
        await expect(storage.delete("conformance/never-existed.txt")).resolves.toBeUndefined();
      }));

    it("presigns a get URL", () =>
      withAdapter(factory, async (storage) => {
        await storage.put({ key: "conformance/signed.txt", body: "x", contentType: "text/plain" });
        const url = await storage.presignGet("conformance/signed.txt", 60);
        expect(typeof url).toBe("string");
        expect(url.length > 0).toBe(true);
      }));
  });
}
