import { describe, expect, it } from "vitest";
import { createSmsProviderConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import {
  createRecordedHttpTransport,
  createTermiiSmsProvider,
  TERMII_INBOUND_CALLBACK,
  TERMII_SEND_RESPONSE,
} from "./index.js";

function adapter() {
  const transport = createRecordedHttpTransport([{ status: 200, body: TERMII_SEND_RESPONSE }]);
  return {
    port: createTermiiSmsProvider({ apiKey: "test-key", senderId: "LEVY", transport }),
  };
}

createSmsProviderConformanceSuite({ describe, it, expect }, adapter, {
  inboundCallback: { body: TERMII_INBOUND_CALLBACK },
  expectedInbound: {
    providerMessageId: "termii-inbound-4455",
    from: "2347000000001",
    text: "LEVY KJA-123",
  },
});

describe("Termii SMS transport", () => {
  it("posts the documented JSON body including the api key", async () => {
    const transport = createRecordedHttpTransport([{ status: 200, body: TERMII_SEND_RESPONSE }]);
    const provider = createTermiiSmsProvider({
      apiKey: "secret-key",
      senderId: "LEVY",
      transport,
    });

    const result = await provider.send({
      to: "2347000000001",
      text: "Receipt",
      idempotencyKey: "k1",
    });

    const request = transport.requests[0];
    expect(request?.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body["api_key"]).toBe("secret-key");
    expect(body["to"]).toBe("2347000000001");
    expect(body["sms"]).toBe("Receipt");
    expect(body["from"]).toBe("LEVY");
    expect(body["type"]).toBe("plain");
    expect(result).toEqual({ providerMessageId: "termii-msg-88112233", status: "accepted" });
  });

  it("rejects a provider error payload with PortError", async () => {
    const transport = createRecordedHttpTransport([
      { status: 200, body: JSON.stringify({ code: "400", message: "Invalid sender id" }) },
    ]);
    const provider = createTermiiSmsProvider({ apiKey: "secret-key", senderId: "LEVY", transport });

    await expect(
      provider.send({ to: "2347000000001", text: "Receipt", idempotencyKey: "k2" }),
    ).rejects.toThrow(PortError);
  });

  it("maps an HTTP 429 to PortError rate_limited", async () => {
    const transport = createRecordedHttpTransport([{ status: 429, body: "{}" }]);
    const provider = createTermiiSmsProvider({ apiKey: "secret-key", senderId: "LEVY", transport });

    await expect(
      provider.send({ to: "2347000000001", text: "Receipt", idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("answers polling for receipts and inbound with an empty list", async () => {
    const provider = adapter().port;

    expect(await provider.fetchDeliveryReceipts(new Date(0))).toEqual([]);
    expect(await provider.fetchInbound(new Date(0))).toEqual([]);
  });
});
