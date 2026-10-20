import { describe, expect, it } from "vitest";
import { createObjectStorageConformanceSuite } from "@tpirs/contracts";
import { createMockObjectStorage } from "./index.js";

createObjectStorageConformanceSuite({ describe, it, expect }, () => ({
  port: createMockObjectStorage(),
}));

describe("createMockObjectStorage", () => {
  it("lists stored keys and deletes them", async () => {
    const storage = createMockObjectStorage();
    await storage.put({ key: "a.txt", body: "a", contentType: "text/plain" });
    expect(storage.keys()).toEqual(["a.txt"]);
    await storage.delete("a.txt");
    expect(storage.keys()).toEqual([]);
  });
});
