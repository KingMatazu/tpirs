import { describe, expect, it } from "vitest";
import { createMockCache } from "@tpirs/cache-mock";
import { createMockClock } from "@tpirs/clock-mock";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createOtpService, OtpError } from "./otp-service.js";

function makeService(overrides: { readonly maxSendsPerWindow?: number } = {}) {
  const cache = createMockCache();
  const sms = createMockSmsProvider();
  const clock = createMockClock({ now: new Date("2026-01-01T00:00:00Z") });
  const service = createOtpService({
    cache,
    sms,
    clock,
    ...(overrides.maxSendsPerWindow === undefined
      ? {}
      : { defaults: { maxSendsPerWindow: overrides.maxSendsPerWindow } }),
  });
  return { cache, sms, clock, service };
}

function codeFromLastMessage(sms: ReturnType<typeof createMockSmsProvider>): string {
  const last = sms.sent[sms.sent.length - 1];
  if (last === undefined) throw new Error("no message sent");
  const match = /\b(\d{6})\b/.exec(last.text);
  if (match === null || match[1] === undefined) throw new Error("no code in message");
  return match[1];
}

describe("createOtpService", () => {
  it("sends a code and verifies it once", async () => {
    const { sms, service } = makeService();
    await service.requestOtp({
      tenantId: "alpha-state",
      phone: "+2348000000001",
      message: (code) => `Alpha: your code is ${code}`,
    });
    expect(sms.sent).toHaveLength(1);
    const code = codeFromLastMessage(sms);

    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000001", code }),
    ).resolves.toEqual({ verified: true });

    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000001", code }),
    ).rejects.toThrow(OtpError);
  });

  it("rejects a wrong code without consuming the pending code", async () => {
    const { sms, service } = makeService();
    await service.requestOtp({
      tenantId: "alpha-state",
      phone: "+2348000000002",
      message: (code) => `code ${code}`,
    });
    const code = codeFromLastMessage(sms);
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000002", code: "000000" }),
    ).rejects.toThrow(OtpError);
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000002", code }),
    ).resolves.toEqual({ verified: true });
  });

  it("rate limits repeated sends per phone within the window", async () => {
    const { sms, service } = makeService({ maxSendsPerWindow: 2 });
    const request = () =>
      service.requestOtp({
        tenantId: "alpha-state",
        phone: "+2348000000003",
        message: (code) => `code ${code}`,
      });
    await request();
    await request();
    await expect(request()).rejects.toMatchObject({ code: "rate_limited" });
    expect(sms.sent).toHaveLength(2);
  });

  it("does not persist a code when the SMS provider fails", async () => {
    const { sms, service } = makeService();
    sms.failNextSend("unavailable");
    await expect(
      service.requestOtp({
        tenantId: "alpha-state",
        phone: "+2348000000004",
        message: (code) => `code ${code}`,
      }),
    ).rejects.toThrow();
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000004", code: "123456" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("locks out after the maximum number of attempts", async () => {
    const cache = createMockCache();
    const sms = createMockSmsProvider();
    const clock = createMockClock({ now: new Date("2026-01-01T00:00:00Z") });
    const service = createOtpService({ cache, sms, clock, defaults: { maxAttempts: 2 } });
    await service.requestOtp({
      tenantId: "alpha-state",
      phone: "+2348000000005",
      message: (code) => `code ${code}`,
    });
    const code = codeFromLastMessage(sms);
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000005", code: "999999" }),
    ).rejects.toThrow(OtpError);
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000005", code: "999999" }),
    ).rejects.toMatchObject({ code: "too_many_attempts" });
    await expect(
      service.verifyOtp({ tenantId: "alpha-state", phone: "+2348000000005", code }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
