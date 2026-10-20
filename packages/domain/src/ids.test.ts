import { describe, expect, it } from "vitest";
import { assetId, tenantId, zoneId } from "./ids.js";
import { InvalidIdError } from "./errors.js";

describe("opaque ids", () => {
  it("accepts non-empty values and trims whitespace", () => {
    expect(tenantId("  state-a ")).toBe("state-a");
    expect(assetId("veh_123")).toBe("veh_123");
    expect(zoneId("zone-1")).toBe("zone-1");
  });

  it("rejects empty or whitespace-only values", () => {
    expect(() => tenantId("")).toThrow(InvalidIdError);
    expect(() => tenantId("   ")).toThrow(InvalidIdError);
  });

  it("runtime values remain plain strings (branding is compile-time only)", () => {
    const t = tenantId("x");
    const a = assetId("x");
    expect(t).toBe(a);
  });
});
