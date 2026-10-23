import { describe, expect, it } from "vitest";
import { createSmsProviderConformanceSuite, conformanceFixtures } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import {
  createMockInboundSmsCallback,
  createMockSmsProvider,
  MOCK_INBOUND_SMS_CALLBACK,
} from "./index.js";

createSmsProviderConformanceSuite(
  { describe, it, expect },
  () => ({ port: createMockSmsProvider() }),
  {
    inboundCallback: { body: MOCK_INBOUND_SMS_CALLBACK },
    expectedInbound: {
      providerMessageId: "mock-inbound-1",
      from: "+2348000000001",
      text: "LEVY KJA-123",
    },
  },
);

describe("createMockSmsProvider failure injection", () => {
  it("fails the next send with the injected code", async () => {
    const sms = createMockSmsProvider();
    sms.failNextSend("unavailable");
    await expect(
      sms.send({ to: conformanceFixtures.smsRecipient, text: "x", idempotencyKey: "k1" }),
    ).rejects.toThrow(PortError);
    const result = await sms.send({
      to: conformanceFixtures.smsRecipient,
      text: "x",
      idempotencyKey: "k2",
    });
    expect(result.status).toBe("accepted");
    expect(sms.sent).toHaveLength(1);
  });
});

describe("createMockSmsProvider inbound callbacks", () => {
  it("normalizes a provider callback into an inbound message", () => {
    const sms = createMockSmsProvider();

    const message = sms.parseInboundCallback?.({ body: MOCK_INBOUND_SMS_CALLBACK });

    expect(message?.providerMessageId).toBe("mock-inbound-1");
    expect(message?.text).toBe("LEVY KJA-123");
    expect(message?.receivedAt.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  });

  it("rejects a malformed callback with PortError", () => {
    const sms = createMockSmsProvider();

    expect(() => sms.parseInboundCallback?.({ body: { text: "LEVY" } })).toThrow(PortError);
  });

  it("round-trips a normalized message through the fixture helper", () => {
    const sms = createMockSmsProvider();
    const receivedAt = new Date("2026-06-15T10:00:00Z");

    const callback = createMockInboundSmsCallback({
      providerMessageId: "m-2",
      from: "+2348000000002",
      text: "STATUS D1",
      receivedAt,
    });
    const parsed = sms.parseInboundCallback?.({ body: callback });

    expect(parsed).toEqual({
      providerMessageId: "m-2",
      from: "+2348000000002",
      text: "STATUS D1",
      receivedAt,
    });
  });
});
