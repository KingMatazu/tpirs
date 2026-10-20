import { describe, expect, it } from "vitest";
import { isAssetStatus, qrPayload } from "./asset.js";
import { InvalidIdError } from "./errors.js";

describe("isAssetStatus", () => {
  it("accepts the known lifecycle states", () => {
    expect(isAssetStatus("active")).toBe(true);
    expect(isAssetStatus("suspended")).toBe(true);
    expect(isAssetStatus("retired")).toBe(true);
  });

  it("rejects unknown states", () => {
    expect(isAssetStatus("deleted")).toBe(false);
    expect(isAssetStatus("")).toBe(false);
  });
});

describe("qrPayload", () => {
  it("accepts URL-safe opaque identifiers", () => {
    expect(qrPayload("abcdef0123456789")).toBe("abcdef0123456789");
    expect(qrPayload("A-b_c-d_0123456789")).toBe("A-b_c-d_0123456789");
  });

  it("rejects empty, short, long, and unsafe payloads", () => {
    expect(() => qrPayload("")).toThrow(InvalidIdError);
    expect(() => qrPayload("short")).toThrow(InvalidIdError);
    expect(() => qrPayload("x".repeat(65))).toThrow(InvalidIdError);
    expect(() => qrPayload("has spaces here 1234")).toThrow(InvalidIdError);
    expect(() => qrPayload("plus+slash/1234567890")).toThrow(InvalidIdError);
  });
});
