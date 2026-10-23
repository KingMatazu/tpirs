import { describe, expect, it } from "vitest";
import { createSmsProviderConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import {
  AFRICASTALKING_INBOUND_CALLBACK,
  AFRICASTALKING_SEND_RESPONSE,
  createAfricaSTalkingSmsProvider,
  createRecordedHttpTransport,
} from "./index.js";

function adapter() {
  const transport = createRecordedHttpTransport([
    { status: 200, body: AFRICASTALKING_SEND_RESPONSE },
  ]);
  return {
    port: createAfricaSTalkingSmsProvider({ username: "tpirs", apiKey: "test-key", transport }),
  };
}

createSmsProviderConformanceSuite({ describe, it, expect }, adapter, {
  inboundCallback: { body: AFRICASTALKING_INBOUND_CALLBACK },
  expectedInbound: {
    providerMessageId: "ATXid_inbound_9911",
    from: "+254700000001",
    text: "LEVY KJA-123",
  },
});

describe("Africa's Talking SMS transport", () => {
  it("posts the documented form fields with the api key header", async () => {
    const transport = createRecordedHttpTransport([
      { status: 200, body: AFRICASTALKING_SEND_RESPONSE },
    ]);
    const provider = createAfricaSTalkingSmsProvider({
      username: "tpirs",
      apiKey: "secret-key",
      transport,
      senderId: "LEVY",
    });

    await provider.send({ to: "+254700000001", text: "Receipt", idempotencyKey: "k1" });

    const request = transport.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers["apiKey"]).toBe("secret-key");
    const form = new URLSearchParams(request?.body ?? "");
    expect(form.get("username")).toBe("tpirs");
    expect(form.get("to")).toBe("+254700000001");
    expect(form.get("message")).toBe("Receipt");
    expect(form.get("from")).toBe("LEVY");
  });

  it("rejects a rejected recipient with PortError and the provider status code", async () => {
    const transport = createRecordedHttpTransport([
      {
        status: 200,
        body: JSON.stringify({
          SMSMessageData: {
            Recipients: [{ statusCode: 403, status: "InvalidPhoneNumber", messageId: "" }],
          },
        }),
      },
    ]);
    const provider = createAfricaSTalkingSmsProvider({
      username: "tpirs",
      apiKey: "secret-key",
      transport,
    });

    await expect(
      provider.send({ to: "+254700000001", text: "Receipt", idempotencyKey: "k2" }),
    ).rejects.toThrow(PortError);
  });

  it("answers polling for receipts and inbound with an empty list instead of inventing data", async () => {
    const provider = adapter().port;

    expect(await provider.fetchDeliveryReceipts(new Date(0))).toEqual([]);
    expect(await provider.fetchInbound(new Date(0))).toEqual([]);
  });

  it("rejects an inbound callback with an unparseable date", () => {
    const provider = adapter().port;

    expect(() =>
      provider.parseInboundCallback?.({
        body: { ...AFRICASTALKING_INBOUND_CALLBACK, date: "not-a-date" },
      }),
    ).toThrow(PortError);
  });
});
