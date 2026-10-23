import { describe, expect, it } from "vitest";
import { createUssdProviderConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { AFRICASTALKING_USSD_CALLBACK, createAfricaSTalkingUssdProvider } from "./index.js";

createUssdProviderConformanceSuite(
  { describe, it, expect },
  () => ({ port: createAfricaSTalkingUssdProvider() }),
  {
    callback: { body: AFRICASTALKING_USSD_CALLBACK },
    expected: {
      sessionId: "ATUssdSession1234",
      from: "+254700000001",
      text: "",
      shortcode: "*384*1234#",
      serviceCode: "*384*1234#",
    },
  },
);

describe("Africa's Talking USSD transport", () => {
  it("passes the cumulative text through unchanged", () => {
    const provider = createAfricaSTalkingUssdProvider();

    const request = provider.parseCallback({
      body: { ...AFRICASTALKING_USSD_CALLBACK, text: "1*KJA-123" },
    });

    expect(request.text).toBe("1*KJA-123");
  });

  it("falls back to the configured shortcode when the callback omits the service code", () => {
    const provider = createAfricaSTalkingUssdProvider({ shortcode: "*384*777#" });
    const callback = { ...AFRICASTALKING_USSD_CALLBACK };
    delete (callback as Record<string, unknown>)["serviceCode"];

    const request = provider.parseCallback({ body: callback });

    expect(request.shortcode).toBe("*384*777#");
    expect(request.serviceCode).toBeUndefined();
  });

  it("rejects a callback without any shortcode", () => {
    const provider = createAfricaSTalkingUssdProvider();
    const callback = { ...AFRICASTALKING_USSD_CALLBACK };
    delete (callback as Record<string, unknown>)["serviceCode"];

    expect(() => provider.parseCallback({ body: callback })).toThrow(PortError);
  });

  it("renders CON and END prefixes as plain text", () => {
    const provider = createAfricaSTalkingUssdProvider();

    const cont = provider.renderResponse({ type: "continue", message: "Choose" });
    const end = provider.renderResponse({ type: "end", message: "Bye" });

    expect(cont).toEqual({
      statusCode: 200,
      contentType: "text/plain; charset=utf-8",
      body: "CON Choose",
    });
    expect(end.body).toBe("END Bye");
    expect(provider.capabilities().maxResponseLength).toBe(182);
  });
});
