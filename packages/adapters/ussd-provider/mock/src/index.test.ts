import { describe, expect, it } from "vitest";
import { createUssdProviderConformanceSuite } from "@tpirs/contracts";
import { createMockUssdProvider } from "./index.js";

createUssdProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockUssdProvider(),
}));

describe("createMockUssdProvider engine injection", () => {
  it("uses the injected engine", async () => {
    const provider = createMockUssdProvider({
      engine: () => ({ type: "end", message: "custom engine response" }),
    });
    const response = await provider.handleSession({
      sessionId: "s1",
      from: "+2348000000001",
      text: "1",
      shortcode: "*123#",
    });
    expect(response.message).toBe("custom engine response");
  });
});
