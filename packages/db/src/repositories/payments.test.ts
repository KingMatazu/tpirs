import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { AnyDb } from "../connection.js";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "../index.js";
import { resolveWebhookEndpoint } from "../webhook-endpoint.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * These suites prove the database half of the payment intake design: the
 * attribution table, the two outboxes, the immutability triggers, and the one
 * narrow read path to the webhook tokens. The application half is tested where
 * it lives (`@tpirs/application`).
 */
describeIntegration("payment intake repositories (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  let otherTenantId: string;
  let assetId: string;
  let otherAssetId: string;
  let obligationPeriodId: string;
  let ledgerTransactionId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `payments-${stamp}`,
        name: "Payments State",
        legalEntity: "Payments Revenue",
        config: {},
      });
      const other = await repos.tenants.create({
        slug: `payments-other-${stamp}`,
        name: "Other State",
        legalEntity: "Other Revenue",
        config: {},
      });
      tenantId = tenant.id;
      otherTenantId = other.id;

      const asset = await repos.assets.create({
        tenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "vehicle",
        attributes: { plate_number: `PAY-${stamp}` },
        qrPayload: `qr-${stamp}`,
        qrToken: `qr-token-${stamp}`,
        shortCode: `PAY${stamp}`.toUpperCase(),
        createdByUserId: null,
      });
      const otherAsset = await repos.assets.create({
        tenantId: otherTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "vehicle",
        attributes: { plate_number: `OTHER-${stamp}` },
        qrPayload: `qr-other-${stamp}`,
        qrToken: `qr-token-other-${stamp}`,
        shortCode: `OTH${stamp}`.toUpperCase(),
        createdByUserId: null,
      });
      assetId = asset.id;
      otherAssetId = otherAsset.id;

      const period = await repos.obligations.create(tenantId, {
        assetId,
        periodKey: `2026-06-15:${stamp}`,
        businessDate: "2026-06-15",
        amountMinor: 20_000n,
        currency: "NGN",
      });
      obligationPeriodId = period.id;

      const ledgerTransaction = await tx
        .insertInto("transactions")
        .values({
          tenantId,
          sourceType: "payment",
          description: "seed transaction for intake tests",
          metadata: {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ledgerTransactionId = ledgerTransaction.id;
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  function createCreditedPayment(suffix: string, tenant = tenantId): Promise<string> {
    return withTenant(db, tenant, async (tx) => {
      const payment = await repositories(tx).payments.create(tenant, {
        provider: "mock",
        providerEventId: `evt-${stamp}-${suffix}`,
        status: "credited",
        amountMinor: 10_000n,
        currency: "NGN",
        assetId: tenant === tenantId ? assetId : otherAssetId,
        attributionKind: "intent_reference",
        providerReference: `ref-${stamp}-${suffix}`,
      });
      return payment.id;
    });
  }

  it("stores an instruction and resolves a retried intent by its idempotency key", async () => {
    const params = {
      assetId,
      provider: "mock",
      reference: `intent-${stamp}`,
      kind: "intent_reference" as const,
      amountMinor: 20_000n,
      currency: "NGN",
      idempotencyKey: `idem-${stamp}`,
    };

    const first = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(tenantId, params),
    );
    expect(first.status).toBe("active");
    expect(first.amountMinor).toBe(20_000n);

    const retried = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.findByIdempotencyKey(
        tenantId,
        "mock",
        params.idempotencyKey,
      ),
    );
    expect(retried?.id).toBe(first.id);

    const byReference = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.findByReference(tenantId, "mock", params.reference),
    );
    expect(byReference?.id).toBe(first.id);

    // The caller's idempotency key is unique, so a racing retry cannot create a
    // second instruction and bind the same money twice.
    await expect(
      withTenant(db, tenantId, async (tx) =>
        repositories(tx).paymentInstructions.create(tenantId, params),
      ),
    ).rejects.toThrow();
  });

  it("allows one active long-lived instruction per asset and many intent references", async () => {
    const virtualAccount = {
      assetId,
      provider: "mock",
      kind: "virtual_account" as const,
    };
    await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(tenantId, {
        ...virtualAccount,
        reference: `va-${stamp}`,
      }),
    );

    await expect(
      withTenant(db, tenantId, async (tx) =>
        repositories(tx).paymentInstructions.create(tenantId, {
          ...virtualAccount,
          reference: `va-second-${stamp}`,
        }),
      ),
    ).rejects.toThrow();

    // Intent references are one-shot and may be created repeatedly.
    for (const suffix of ["a", "b"]) {
      await withTenant(db, tenantId, async (tx) =>
        repositories(tx).paymentInstructions.create(tenantId, {
          assetId,
          provider: "mock",
          kind: "intent_reference",
          reference: `intent-repeat-${stamp}-${suffix}`,
        }),
      );
    }

    const activeVirtualAccount = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.findActiveForAsset(
        tenantId,
        "mock",
        assetId,
        "virtual_account",
      ),
    );
    expect(activeVirtualAccount?.reference).toBe(`va-${stamp}`);
  });

  it("keeps an instruction's identity immutable", async () => {
    const instruction = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(tenantId, {
        assetId,
        provider: "mock",
        kind: "intent_reference",
        reference: `immutable-${stamp}`,
      }),
    );

    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx
          .updateTable("paymentInstructions")
          .set({ reference: "rewritten" })
          .where("id", "=", instruction.id)
          .execute();
      }),
    ).rejects.toThrow(/identity is immutable/);

    // Lifecycle columns may move.
    const consumed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.markStatus(tenantId, instruction.id, "consumed"),
    );
    expect(consumed?.status).toBe("consumed");
  });

  it("records an applied payment and refuses to rewrite its money facts", async () => {
    const payment = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.create(tenantId, {
        provider: "mock",
        providerEventId: `evt-applied-${stamp}`,
        status: "applied",
        amountMinor: 20_000n,
        currency: "NGN",
        assetId,
        attributionKind: "intent_reference",
        providerReference: `applied-${stamp}`,
        businessDate: "2026-06-15",
        obligationPeriodId,
        transactionId: ledgerTransactionId,
        receiptNumber: `RCT-${stamp}`,
      }),
    );
    expect(payment.status).toBe("applied");
    expect(payment.businessDate).toBe("2026-06-15");
    expect(payment.amountMinor).toBe(20_000n);

    // Even the table owner cannot move money on an applied payment.
    await expect(
      withSystem(db, async (tx) => {
        await tx
          .updateTable("payments")
          .set({ amountMinor: 1n })
          .where("id", "=", payment.id)
          .execute();
      }),
    ).rejects.toThrow(/applied payment is immutable/);

    await expect(
      withSystem(db, async (tx) => {
        await tx
          .updateTable("payments")
          .set({ receiptNumber: "tampered" })
          .where("id", "=", payment.id)
          .execute();
      }),
    ).rejects.toThrow(/applied payment is immutable/);

    // Nor can an applied payment lose its day: the check constraint requires a
    // business date exactly when the status is applied.
    await expect(
      withSystem(db, async (tx) => {
        await tx
          .updateTable("payments")
          .set({ status: "rejected" })
          .where("id", "=", payment.id)
          .execute();
      }),
    ).rejects.toThrow();

    // An applied payment cannot be inserted without the facts a receipt needs.
    await expect(
      withTenant(db, tenantId, async (tx) =>
        repositories(tx).payments.create(tenantId, {
          provider: "mock",
          providerEventId: `evt-incomplete-${stamp}`,
          status: "applied",
          amountMinor: 20_000n,
          currency: "NGN",
        }),
      ),
    ).rejects.toThrow();
  });

  it("moves a credited payment through suspense to applied exactly once", async () => {
    const paymentId = await createCreditedPayment("suspense");

    const suspended = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.markSuspense(tenantId, paymentId, "reference not recognised"),
    );
    expect(suspended?.status).toBe("suspense");

    const applied = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.applyFromSuspense(tenantId, paymentId, {
        businessDate: "2026-06-15",
        obligationPeriodId,
        transactionId: ledgerTransactionId,
        receiptNumber: `RCT-SUSPENSE-${stamp}`,
      }),
    );
    expect(applied?.status).toBe("applied");
    expect(applied?.receiptNumber).toBe(`RCT-SUSPENSE-${stamp}`);

    // A second finance user clicking the same row must not post again.
    const second = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.applyFromSuspense(tenantId, paymentId, {
        businessDate: "2026-06-15",
        obligationPeriodId,
        transactionId: ledgerTransactionId,
        receiptNumber: `RCT-SUSPENSE-OTHER-${stamp}`,
      }),
    );
    expect(second).toBeUndefined();

    // Only a credited payment can be suspended.
    const notSuspended = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.markSuspense(tenantId, paymentId, "too late"),
    );
    expect(notSuspended).toBeUndefined();
  });

  it("fills in the asset and attribution when finance resolves an unattributable payment", async () => {
    // Intake stores an unattributable payment with no asset and no attribution,
    // which is exactly the state the applied-payment check constraint forbids.
    const paymentId = await withTenant(db, tenantId, async (tx) => {
      const payment = await repositories(tx).payments.create(tenantId, {
        provider: "mock",
        providerEventId: `evt-unattributed-${stamp}`,
        providerReference: `unknown-${stamp}`,
        status: "suspense",
        amountMinor: 20_000n,
        currency: "NGN",
        failureReason: "unattributable",
      });
      expect(payment.assetId).toBeNull();
      expect(payment.attributionKind).toBeNull();
      return payment.id;
    });

    const applied = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).payments.applyFromSuspense(tenantId, paymentId, {
        businessDate: "2026-06-15",
        obligationPeriodId,
        transactionId: ledgerTransactionId,
        receiptNumber: `RCT-ATTRIB-${stamp}`,
        assetId,
        attributionKind: "narration",
      }),
    );
    expect(applied?.status).toBe("applied");
    expect(applied?.assetId).toBe(assetId);
    expect(applied?.attributionKind).toBe("narration");
  });

  it("enqueues one receipt per payment and one per obligation period", async () => {
    const paymentId = await createCreditedPayment("sms");

    const receipt = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348000000000",
        body: "Payment received",
        paymentId,
      }),
    );
    expect(receipt?.status).toBe("pending");

    const replay = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348000000000",
        body: "Payment received again",
        paymentId,
      }),
    );
    expect(replay).toBeUndefined();

    const forPeriod = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348000000000",
        body: "Day paid from wallet",
        obligationPeriodId,
      }),
    );
    expect(forPeriod).toBeDefined();

    const periodReplay = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348000000000",
        body: "Day paid from wallet again",
        obligationPeriodId,
      }),
    );
    expect(periodReplay).toBeUndefined();

    const all = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.findByPayment(tenantId, paymentId),
    );
    expect(all).toHaveLength(1);
  });

  it("keeps an outbox body immutable while its delivery state moves", async () => {
    const paymentId = await createCreditedPayment("outbox");
    const message = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "underpayment_notice",
        recipient: "+2348000000001",
        body: "You still owe 5000 kobo",
        paymentId,
      }),
    );
    expect(message).toBeDefined();

    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx
          .updateTable("smsLog")
          .set({ body: "tampered" })
          .where("id", "=", message?.id ?? "")
          .execute();
      }),
    ).rejects.toThrow(/immutable/);

    const sent = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.markSent(tenantId, message?.id ?? "", "provider-message-1"),
    );
    expect(sent?.status).toBe("sent");
    expect(sent?.attempts).toBe(1);
    expect(sent?.body).toBe("You still owe 5000 kobo");

    const failed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.markFailed(tenantId, message?.id ?? "", "gateway timeout"),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(2);
    expect(failed?.lastError).toBe("gateway timeout");
  });

  it("records a webhook delivery once and claims it for processing", async () => {
    const event = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.record(tenantId, {
        provider: "mock",
        providerEventId: `delivery-${stamp}`,
        rawBody: '{"event":"charge.success"}',
      }),
    );
    expect(event?.signatureVerified).toBe(true);
    expect(event?.rawBody).toBe('{"event":"charge.success"}');

    const replay = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.record(tenantId, {
        provider: "mock",
        providerEventId: `delivery-${stamp}`,
        rawBody: '{"event":"charge.success"}',
      }),
    );
    expect(replay).toBeUndefined();

    const claimed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.claimPending(tenantId, 50),
    );
    const claimedEvent = claimed.find((row) => row.id === event?.id);
    expect(claimedEvent?.processedAt).toBeNull();

    const failed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.markFailed(tenantId, event?.id ?? "", "provider timeout"),
    );
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe("provider timeout");
    expect(failed?.processedAt).toBeNull();

    expect(
      await withTenant(db, tenantId, async (tx) =>
        repositories(tx).webhookEvents.countPending(tenantId),
      ),
    ).toBe(1);

    const paymentId = await createCreditedPayment("webhook");
    const processed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.markProcessed(tenantId, event?.id ?? "", paymentId),
    );
    expect(processed?.paymentId).toBe(paymentId);
    expect(processed?.processedAt).not.toBeNull();

    const afterProcessing = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.claimPending(tenantId, 50),
    );
    expect(afterProcessing.map((row) => row.id)).not.toContain(event?.id);
    expect(
      await withTenant(db, tenantId, async (tx) =>
        repositories(tx).webhookEvents.countPending(tenantId),
      ),
    ).toBe(0);
  });

  it("never shows one tenant's intake rows to another tenant", async () => {
    const paymentId = await createCreditedPayment("isolation");
    const instruction = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(tenantId, {
        assetId,
        provider: "mock",
        kind: "intent_reference",
        reference: `isolation-${stamp}`,
      }),
    );
    await withTenant(db, tenantId, async (tx) =>
      repositories(tx).webhookEvents.record(tenantId, {
        provider: "mock",
        providerEventId: `isolation-${stamp}`,
        rawBody: "{}",
      }),
    );
    await withTenant(db, tenantId, async (tx) =>
      repositories(tx).smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348000000002",
        body: "Isolated receipt",
        paymentId,
      }),
    );

    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).payments.findById(otherTenantId, paymentId),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).paymentInstructions.findById(otherTenantId, instruction.id),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).paymentInstructions.findByReference(
          otherTenantId,
          "mock",
          `isolation-${stamp}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).payments.findByProviderEvent(
          otherTenantId,
          "mock",
          `evt-${stamp}-isolation`,
        ),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).smsLog.findByPayment(otherTenantId, paymentId),
      ),
    ).toEqual([]);
    expect(
      await withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).webhookEvents.countPending(otherTenantId),
      ),
    ).toBe(0);

    // Writing a row for another tenant is refused, not merely hidden.
    await expect(
      withTenant(db, otherTenantId, async (tx) =>
        repositories(tx).payments.create(tenantId, {
          provider: "mock",
          providerEventId: `cross-tenant-${stamp}`,
          status: "credited",
          amountMinor: 1_000n,
          currency: "NGN",
          assetId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("resolves a webhook token to its tenant without exposing the token table", async () => {
    const token = `endpoint-token-${stamp}`;
    const endpoint = await withSystem(db, async (tx) =>
      repositories(tx).webhookEndpoints.create(tenantId, { provider: "mock", token }),
    );
    expect(endpoint.tokenHash).toHaveLength(64);
    expect(endpoint.tokenHash).not.toBe(token);

    expect(await resolveWebhookEndpoint(db, "mock", token)).toBe(tenantId);
    expect(await resolveWebhookEndpoint(db, "paystack", token)).toBeUndefined();
    expect(await resolveWebhookEndpoint(db, "mock", `${token}-wrong`)).toBeUndefined();
    expect(await resolveWebhookEndpoint(db, "mock", "   ")).toBeUndefined();

    // The application role has no privilege on the table at all, so a bug that
    // reaches for it directly fails closed rather than leaking every tenant.
    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx.selectFrom("webhookEndpoints").selectAll().execute();
      }),
    ).rejects.toThrow(/permission denied/);

    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx
          .insertInto("webhookEndpoints")
          .values({ tenantId, provider: "mock", tokenHash: "a".repeat(64) })
          .execute();
      }),
    ).rejects.toThrow(/permission denied/);

    await withSystem(db, async (tx) =>
      repositories(tx).webhookEndpoints.revoke(tenantId, endpoint.id),
    );
    expect(await resolveWebhookEndpoint(db, "mock", token)).toBeUndefined();
  });

  it("resolves a token only for the tenant it was issued to", async () => {
    const otherToken = `other-endpoint-${stamp}`;
    const otherEndpoint = await withSystem(db, async (tx) =>
      repositories(tx).webhookEndpoints.create(otherTenantId, {
        provider: "mock",
        token: otherToken,
      }),
    );
    expect(otherEndpoint.tenantId).toBe(otherTenantId);
    expect(await resolveWebhookEndpoint(db, "mock", otherToken)).toBe(otherTenantId);
    expect(await resolveWebhookEndpoint(db, "mock", otherToken)).not.toBe(tenantId);

    // The other tenant's asset is not visible either.
    expect(
      await withTenant(db, tenantId, async (tx) => tx.selectFrom("assets").selectAll().execute()),
    ).toHaveLength(1);
    expect(otherAssetId).not.toBe(assetId);
  });
});
