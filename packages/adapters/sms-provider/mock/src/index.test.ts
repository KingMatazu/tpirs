import { describe, expect, it } from "vitest";
import { createSmsProviderConformanceSuite, conformanceFixtures } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createMockSmsProvider } from "./index.js";

createSmsProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockSmsProvider(),
}));

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
