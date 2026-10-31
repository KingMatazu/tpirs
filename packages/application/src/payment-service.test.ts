import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb, PaymentRow } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider, mockWebhookSignature } from "@tpirs/payment-provider-mock";
import type { MockPaymentProvider } from "@tpirs/payment-provider-mock";
import { createPaymentService, PaymentError } from "./payment-service.js";
import type { PaymentService } from "./payment-service.js";
import { formatMinor } from "./receipt-renderer.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const BIKE_FEE = 20_000;
const TODAY: BusinessDate = businessDate("2026-06-15");
const PAID_AT = "2026-06-15T08:00:00Z";

function testConfig(
  slug: string,
  underpaymentPolicy: "wallet" | "suspense" = "wallet",
): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: `State ${slug}`,
      slug,
      legalEntity: `${slug} Revenue`,
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Etc/UTC",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: slug,
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "X",
      receiptHeader: "State Revenue",
      receiptFooter: "f",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: `${slug}-{id}`,
        shortCodeFormat: `${slug[0]?.toUpperCase() ?? "X"}{id}`,
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      allocationOrder: "today_first",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: BIKE_FEE,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [{ port: "PaymentProvider", adapter: "mock" }],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "LEVY",
      otpMessageTemplate: "code {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 1,
      depositDeadlineHours: 1,
      freezeOnShortfall: true,
    },
    payments: { underpaymentPolicy },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [{ code: "other", label: "Other" }],
    },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

interface TenantFixture {
  readonly tenantId: string;
  readonly assetId: string;
  readonly endpointToken: string;
  /** A staff user, so a finance action can be attributed to somebody real. */
  readonly financeUserId: string;
}

describeIntegration("PaymentService (integration)", () => {
  let db: AnyDb;
  let service: PaymentService;
  let provider: MockPaymentProvider;
  const config = testConfig("pay");
  const suspenseConfig = testConfig("paysusp", "suspense");
  const configs = new Map<string, TenantConfig>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    provider = createMockPaymentProvider();
    service = createPaymentService({
      db,
      loadConfig,
      feeEngine: createConfigFeeEngine({ loadConfig }),
      providerFor: (name) => (name === "mock" ? provider : undefined),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  /** A fresh tenant with one bike asset, so no test shares a wallet or a day. */
  async function makeTenant(options: { cfg?: TenantConfig } = {}): Promise<TenantFixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cfg = options.cfg ?? config;
    const tenant = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const created = await repos.tenants.create({
        slug: `pay-${stamp}`,
        name: "Pay",
        legalEntity: "Pay Revenue",
        config: {},
      });
      const owner = await repos.owners.create({
        tenantId: created.id,
        displayName: "Driver",
        phone: "+2348012345678",
      });
      await repos.users.create({
        tenantId: created.id,
        username: `finance-${stamp}`,
        displayName: "Finance",
        passwordHash: "not-a-real-hash",
        totpSecret: null,
      });
      await repos.assets.create({
        tenantId: created.id,
        zoneId: null,
        ownerId: owner.id,
        assetTypeKey: "bike",
        attributes: { plate_number: "KJA-123" },
        qrPayload: `pay-${stamp}`,
        qrToken: `pay-${stamp}-token`,
        shortCode: "P1",
        createdByUserId: null,
      });
      return created;
    });
    configs.set(tenant.id, cfg);
    const { assetId, financeUserId } = await withTenant(db, tenant.id, async (tx) => {
      const asset = await repositories(tx).assets.findByShortCode("P1");
      if (asset === undefined) throw new Error("asset not found");
      const financeUser = await repositories(tx).users.findByUsername(`finance-${stamp}`);
      if (financeUser === undefined) throw new Error("finance user not found");
      return { assetId: asset.id, financeUserId: financeUser.id };
    });
    // A webhook endpoint token belongs to exactly one tenant, so each fixture
    // gets its own; a shared token would deliver every payment to one tenant.
    const endpointToken = await service.provisionEndpoint({
      tenantId: tenant.id,
      provider: "mock",
    });
    return { tenantId: tenant.id, assetId, endpointToken, financeUserId };
  }

  async function paymentRow(tenantId: string, id: string): Promise<PaymentRow> {
    const row = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.findById(tenantId, id),
    );
    if (row === undefined) throw new Error("payment not found");
    return row;
  }

  async function walletBalance(tenantId: string, assetId: string): Promise<bigint> {
    return withTenant(db, tenantId, async (tx) =>
      repositories(tx).ledger.accountBalance(tenantId, "ASSET_WALLET", assetId),
    );
  }

  /** Creates an intent and returns the reference the gateway would send back. */
  async function intentRef(fixture: TenantFixture): Promise<string> {
    const intent = await service.createIntent({
      tenantId: fixture.tenantId,
      provider: "mock",
      assetId: fixture.assetId,
      businessDate: TODAY,
    });
    return intent.reference;
  }

  /**
   * Registers a reusable instruction (a virtual account in production) for the
   * asset, and returns its reference. Because the reference outlives one
   * payment, a second delivery can arrive against it.
   */
  async function longLivedReference(fixture: TenantFixture): Promise<string> {
    const reference = `va-${Math.random().toString(36).slice(2)}`;
    await withTenant(db, fixture.tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(fixture.tenantId, {
        assetId: fixture.assetId,
        provider: "mock",
        reference,
        kind: "virtual_account",
        amountMinor: null,
        currency: null,
        idempotencyKey: null,
      }),
    );
    return reference;
  }

  function webhookBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      providerReference: "unused",
      amount: { amount: BIKE_FEE, currency: "NGN" },
      status: "success",
      paidAt: PAID_AT,
      ...overrides,
    });
  }

  function deliver(endpointToken: string, body: string, signature = mockWebhookSignature(body)) {
    return service.ingestWebhookEvent({
      provider: "mock",
      endpointToken,
      headers: { "x-signature": signature },
      rawBody: body,
    });
  }

  it("provisions a webhook endpoint token", async () => {
    const fixture = await makeTenant();
    expect(fixture.endpointToken).not.toBe("");
    expect(
      await service.provisionEndpoint({ tenantId: fixture.tenantId, provider: "mock" }),
    ).not.toBe("");
  });

  it("creates an intent for the day's fee", async () => {
    const fixture = await makeTenant();
    const intent = await service.createIntent({
      tenantId: fixture.tenantId,
      provider: "mock",
      assetId: fixture.assetId,
      businessDate: TODAY,
    });
    expect(intent.amountMinor).toBe(BigInt(BIKE_FEE));
    expect(intent.currency).toBe("NGN");
    expect(intent.kind).toBe("intent_reference");
    expect(intent.alreadySettled).toBe(false);
  });

  it("applies a full payment, settles the day and enqueues exactly one receipt", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    const result = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, providerEventId: "evt-apply" }),
    );
    expect(result.outcome).toBe("applied");
    expect(result.receiptNumber).toBeDefined();

    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.status).toBe("applied");
    expect(row.businessDate).toBe("2026-06-15");
    expect(row.attributionKind).toBe("intent_reference");

    const outbox = await service.listOutbox({ tenantId: fixture.tenantId, paymentId: row.id });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe("receipt");
    expect(outbox[0]?.body).toContain("KJA-123");
    expect(outbox[0]?.body).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("treats a replayed webhook as an accepted no-op", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    const body = webhookBody({ providerReference: reference, providerEventId: "evt-replay" });
    const first = await deliver(fixture.endpointToken, body);
    const second = await deliver(fixture.endpointToken, body);

    expect(second.outcome).toBe("duplicate");
    expect(second.accepted).toBe(true);
    expect(second.paymentId ?? first.paymentId).toBe(first.paymentId);

    const outbox = await service.listOutbox({
      tenantId: fixture.tenantId,
      paymentId: first.paymentId ?? "",
    });
    expect(outbox).toHaveLength(1);
  });

  it("rejects a webhook whose signature does not verify", async () => {
    const fixture = await makeTenant();
    const result = await deliver(fixture.endpointToken, webhookBody(), "not-the-signature");
    expect(result.outcome).toBe("ignored");
    expect(result.accepted).toBe(false);
  });

  it("ignores a webhook whose endpoint token is unknown", async () => {
    const body = webhookBody();
    const result = await service.ingestWebhookEvent({
      provider: "mock",
      endpointToken: "not-a-real-token",
      headers: { "x-signature": mockWebhookSignature(body) },
      rawBody: body,
    });
    expect(result.outcome).toBe("ignored");
    expect(result.tenantId).toBeUndefined();
  });

  it("sends an unattributable payment to suspense for finance", async () => {
    const fixture = await makeTenant();
    const result = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: "no-such-reference" }),
    );
    expect(result.outcome).toBe("suspense");
    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.failureReason).toBe("unattributable");
    expect(row.status).toBe("suspense");
  });

  it("sends a currency mismatch to suspense even under the wallet policy", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    const result = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, amount: { amount: BIKE_FEE, currency: "GHS" } }),
    );
    expect(result.outcome).toBe("suspense");
    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.failureReason).toBe("currency_mismatch");
  });

  it("credits the wallet and notes the exact shortfall for a short payment", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    const result = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, amount: { amount: 5_000, currency: "NGN" } }),
    );
    expect(result.outcome).toBe("credited");

    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.status).toBe("credited");
    expect(row.businessDate).toBeNull();
    // The provider name (not the webhook event id) is what a statement row is
    // matched against later.
    expect(row.provider).toBe("mock");
    expect(await walletBalance(fixture.tenantId, fixture.assetId)).toBe(5_000n);

    const outbox = await service.listOutbox({ tenantId: fixture.tenantId, paymentId: row.id });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe("underpayment_notice");
    // 20,000 − 5,000 = 15,000 minor units, i.e. ₦150.00 in the tenant's locale.
    expect(outbox[0]?.body).toContain(formatMinor(15_000n, "NGN", "en-NG"));
  });

  it("asks for only the shortfall on the next intent after a short payment", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, amount: { amount: 5_000, currency: "NGN" } }),
    );
    const next = await service.createIntent({
      tenantId: fixture.tenantId,
      provider: "mock",
      assetId: fixture.assetId,
      businessDate: TODAY,
    });
    expect(next.amountMinor).toBe(BigInt(BIKE_FEE - 5_000));
  });

  it("issues no intent and asks for nothing once the day is paid", async () => {
    const fixture = await makeTenant();
    const first = await intentRef(fixture);
    const settled = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: first, providerEventId: "evt-first" }),
    );
    expect(settled.outcome).toBe("applied");

    // A provider cannot charge zero, so a settled day yields no intent at all.
    const next = await service.createIntent({
      tenantId: fixture.tenantId,
      provider: "mock",
      assetId: fixture.assetId,
      businessDate: TODAY,
    });
    expect(next.nothingRequired).toBe(true);
    expect(next.alreadySettled).toBe(true);
    expect(next.amountMinor).toBe(0n);
    expect(next.reference).toBe("");
  });

  it("credits the wallet and settles nothing when the day is already paid", async () => {
    const fixture = await makeTenant();
    const first = await intentRef(fixture);
    const settled = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: first, providerEventId: "evt-first" }),
    );
    expect(settled.outcome).toBe("applied");

    // A long-lived instruction (a virtual account in production) keeps its
    // reference, so a second payment can arrive for an already-paid day.
    const reference = await longLivedReference(fixture);
    const extra = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, providerEventId: "evt-second" }),
    );
    expect(extra.outcome).toBe("credited");
    const row = await paymentRow(fixture.tenantId, extra.paymentId ?? "");
    expect(row.failureReason).toBe("already_settled");
  });

  it("sends an underpayment to suspense under the suspense policy", async () => {
    const fixture = await makeTenant({ cfg: suspenseConfig });
    const reference = await intentRef(fixture);
    const result = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference, amount: { amount: 5_000, currency: "NGN" } }),
    );
    expect(result.outcome).toBe("suspense");
    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.failureReason).toBe("underpayment");
    expect(await walletBalance(fixture.tenantId, fixture.assetId)).toBe(0n);
  });

  it("records a provider-reported failure as rejected with no business date", async () => {
    const fixture = await makeTenant();
    const result = await deliver(fixture.endpointToken, webhookBody({ status: "failed" }));
    expect(result.outcome).toBe("rejected");
    const row = await paymentRow(fixture.tenantId, result.paymentId ?? "");
    expect(row.status).toBe("rejected");
    expect(row.businessDate).toBeNull();
  });

  it("applies a suspense payment to a day when finance resolves it", async () => {
    const fixture = await makeTenant();
    const staged = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: "missing-ref", providerEventId: "evt-resolve" }),
    );
    expect(staged.outcome).toBe("suspense");

    const resolved = await service.resolveSuspense({
      tenantId: fixture.tenantId,
      paymentId: staged.paymentId ?? "",
      assetId: fixture.assetId,
      approvedByUserId: fixture.financeUserId,
    });
    expect(resolved.status).toBe("applied");
    expect(resolved.businessDate).toBe("2026-06-15");
    expect(resolved.assetId).toBe(fixture.assetId);
    expect(resolved.attributionKind).toBe("narration");

    const outbox = await service.listOutbox({
      tenantId: fixture.tenantId,
      paymentId: resolved.id,
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe("receipt");

    // Finance applying a payment is a state change and must be attributable.
    const audited = await withTenant(db, fixture.tenantId, async (tx) =>
      repositories(tx).audit.search({ action: "payment.suspense_resolved", limit: 10 }),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorUserId).toBe(fixture.financeUserId);
    expect(audited[0]?.entityId).toBe(resolved.id);
  });

  it("refuses to apply a payment that is not in suspense", async () => {
    const fixture = await makeTenant();
    const reference = await intentRef(fixture);
    const applied = await deliver(
      fixture.endpointToken,
      webhookBody({ providerReference: reference }),
    );
    await expect(
      service.resolveSuspense({
        tenantId: fixture.tenantId,
        paymentId: applied.paymentId ?? "",
        assetId: fixture.assetId,
        approvedByUserId: fixture.financeUserId,
      }),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it("never reveals another tenant's payments", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const reference = await intentRef(a);
    await deliver(a.endpointToken, webhookBody({ providerReference: reference }));

    expect(await service.listPayments({ tenantId: b.tenantId })).toHaveLength(0);
    const own = await service.listPayments({ tenantId: a.tenantId });
    expect(own).toHaveLength(1);
  });

  it("does not create a period or a debt for a day nobody declared", async () => {
    const fixture = await makeTenant();
    const missing = await withTenant(db, fixture.tenantId, async (tx) =>
      repositories(tx).obligations.findByAssetAndPeriod(
        fixture.tenantId,
        fixture.assetId,
        "2026-01-01",
      ),
    );
    expect(missing).toBeUndefined();
  });
});
