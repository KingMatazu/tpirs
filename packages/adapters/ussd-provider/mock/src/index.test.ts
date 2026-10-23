import { describe, expect, it } from "vitest";
import { createUssdProviderConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createMockUssdProvider, MOCK_USSD_CALLBACK } from "./index.js";

createUssdProviderConformanceSuite(
  { describe, it, expect },
  () => ({ port: createMockUssdProvider() }),
  {
    callback: { body: MOCK_USSD_CALLBACK },
    expected: {
      sessionId: "mock-session-1",
      from: "+2348000000001",
      text: "",
      shortcode: "*123#",
      serviceCode: "*123#",
    },
  },
);

describe("createMockUssdProvider transport", () => {
  it("accepts cumulative session text, including an empty first request", () => {
    const provider = createMockUssdProvider();

    const first = provider.parseCallback({ body: MOCK_USSD_CALLBACK });
    const next = provider.parseCallback({
      body: { ...MOCK_USSD_CALLBACK, text: "1*KJA-123" },
    });

    expect(first.text).toBe("");
    expect(next.text).toBe("1*KJA-123");
  });

  it("rejects callbacks with an empty session id", () => {
    const provider = createMockUssdProvider();

    expect(() =>
      provider.parseCallback({ body: { ...MOCK_USSD_CALLBACK, sessionId: "" } }),
    ).toThrow(PortError);
  });

  it("renders continue and end responses with the provider prefixes", () => {
    const provider = createMockUssdProvider();

    const cont = provider.renderResponse({ type: "continue", message: "Choose" });
    const end = provider.renderResponse({ type: "end", message: "Bye" });

    expect(cont.body).toBe("CON Choose");
    expect(end.body).toBe("END Bye");
    expect(cont.contentType).toBe("text/plain; charset=utf-8");
  });
});
