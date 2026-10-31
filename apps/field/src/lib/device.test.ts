import { describe, expect, it } from "vitest";
import { deviceId, platform } from "./device.js";

describe("deviceId", () => {
  it("creates an id once and returns the same one afterwards", () => {
    const storage = new MemoryStorage();
    const first = deviceId(storage);
    expect(first).not.toBe("");
    expect(deviceId(storage)).toBe(first);
  });

  it("still returns an id when storage is unavailable", () => {
    // Private mode and a locked-down browser both land here; the officer must
    // still be able to sign in, registering as a new device.
    expect(deviceId(undefined)).not.toBe("");
  });

  it("does not treat an empty stored value as an id", () => {
    const storage = new MemoryStorage();
    storage.setItem("tpirs.field.deviceId", "");
    const created = deviceId(storage);
    expect(created).not.toBe("");
    expect(storage.getItem("tpirs.field.deviceId")).toBe(created);
  });
});

describe("platform", () => {
  it("labels the handset for the device binding", () => {
    expect(["android", "ios", "web"]).toContain(platform());
  });
});

class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}
