import { describe, expect, it, vi } from "vitest";
import {
  createPaymentProviderConformanceSuite,
  createPaymentProviderFixtureSuite,
} from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import {
  createPaystackPaymentProvider,
  PAYSTACK_WEBHOOK_SECRET,
  paystackPaymentProviderFixture,
} from "./index.js";

const SECRET = "sk_test_conformance";

/** A gateway stub: enough of Paystack's envelope to exercise the adapter. */
function stubGateway() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/transaction/initialize")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: true,
            message: "Authorization URL created",
            data: {
              authorization_url: "https://checkout.paystack.com/conf-ref",
              access_code: "conf-access",
              reference: "conf-ref",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/virtual_terminal")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: true,
            message: "Virtual Terminal created",
            data: {
              code: "VT_CONF1234",
              name: "Conformance terminal",
              active: true,
              currency: "NGN",
              paymentMethods: [
                {
                  type: "dedicated_nuban",
                  account_number: "9964842038",
                  account_name: "Conformance/Sales Point",
                  bank: "Paystack-Titan",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/deactivate")) {
      return Promise.resolve(
        new Response(JSON.stringify({ status: true, message: "Terminal set to inactive" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  return { fetch, calls };
}

const { fetch: gateway } = stubGateway();

const build = () =>
  createPaystackPaymentProvider({
    secretKey: SECRET,
    webhookSecret: PAYSTACK_WEBHOOK_SECRET,
    defaultEmail: "conformance@example.com",
    fetch: gateway,
  });

createPaymentProviderConformanceSuite({ describe, it, expect }, () => ({
  port: build(),
}));

createPaymentProviderFixtureSuite(
  { describe, it, expect },
  () => ({ port: build() }),
  paystackPaymentProviderFixture,
);

describe("Paystack adapter (ADR 0069)", () => {
  it("creates a virtual terminal and keeps the dedicated NUBAN", async () => {
    const provider = build();
    const destination = await provider.createDepositAttribution?.({
      tenantId: "tenant-1",
      collectorUserId: "collector-1",
      idempotencyKey: "cash:tenant-1:collector-1:abc",
      name: "Katsina — Aisha",
      phone: "+2348000000001",
      currency: "NGN",
    });

    expect(destination).toMatchObject({
      kind: "virtual_terminal",
      value: "VT_CONF1234",
      accountNumber: "9964842038",
      accountName: "Conformance/Sales Point",
      bank: "Paystack-Titan",
      pageUrl: "https://paystack.shop/pay/vt_conf1234",
      currency: "NGN",
    });
  });

  it("keeps the terminal usable when the market issues no account number", async () => {
    const provider = createPaystackPaymentProvider({
      secretKey: SECRET,
      webhookSecret: PAYSTACK_WEBHOOK_SECRET,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: true,
              data: { code: "VT_NOBANK", active: true, currency: "ZAR", paymentMethods: [] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });

    const destination = await provider.createDepositAttribution?.({
      collectorUserId: "collector-1",
      idempotencyKey: "key",
    });
    expect(destination?.value).toBe("VT_NOBANK");
    expect(destination?.accountNumber).toBeUndefined();
    expect(destination?.pageUrl).toBe("https://paystack.shop/pay/vt_nobank");
  });

  it("reads the terminal code out of the webhook metadata", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: {
        id: 4677002219,
        reference: "T173424527684156",
        amount: 500000,
        currency: "NGN",
        status: "success",
        paid_at: "2025-02-11T10:42:20.000Z",
        metadata: { virtual_terminal: { code: "VT_68SBY77G" } },
        source: { type: "offline", source: "virtual_terminal", identifier: "VT_68SBY77G" },
      },
    });

    const event = build().normalizeWebhook(body);
    expect(event.attributionKey).toBe("VT_68SBY77G");
    expect(event.providerReference).toBe("T173424527684156");
    expect(event.amount).toEqual({ currency: "NGN", amount: 5000 });
  });

  it("falls back to the source identifier when metadata is absent", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: {
        id: 1,
        reference: "T1",
        amount: 100,
        currency: "NGN",
        status: "success",
        paid_at: "2025-02-11T10:42:20.000Z",
        source: { source: "virtual_terminal", identifier: "VT_FALLBACK" },
      },
    });
    expect(build().normalizeWebhook(body).attributionKey).toBe("VT_FALLBACK");
  });

  it("refuses webhooks when no signing secret is configured", async () => {
    const provider = createPaystackPaymentProvider({ secretKey: SECRET, fetch: gateway });
    await expect(
      provider.verifyWebhook({ headers: {}, rawBody: '{"event":"charge.success"}' }),
    ).resolves.toEqual({ ok: false });
  });

  it("names a missing secret instead of calling the network", async () => {
    const provider = createPaystackPaymentProvider({ fetch: gateway });
    await expect(
      provider.createDepositAttribution?.({ collectorUserId: "c", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(PortError);
  });

  it("deactivates a terminal by code", async () => {
    const provider = build();
    await expect(provider.deactivateDepositAttribution?.("VT_CONF1234")).resolves.toBeUndefined();
  });
});
