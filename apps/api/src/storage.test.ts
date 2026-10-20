import { describe, expect, it } from "vitest";
import { buildObjectStorage } from "./storage.js";

describe("buildObjectStorage", () => {
  it("builds the local-disk adapter when configured", () => {
    const storage = buildObjectStorage({
      OBJECT_STORAGE_ADAPTER: "localdisk",
      OBJECT_STORAGE_LOCAL_DIR: ".test-data/objects",
    });
    expect(typeof storage.put).toBe("function");
  });

  it("requires a bucket for the s3 adapter", () => {
    expect(() => buildObjectStorage({ OBJECT_STORAGE_ADAPTER: "s3" })).toThrow(
      "OBJECT_STORAGE_BUCKET",
    );
  });

  it("rejects unknown adapters", () => {
    expect(() => buildObjectStorage({ OBJECT_STORAGE_ADAPTER: "nope" })).toThrow("Unknown");
  });
});
