import type { TenantConfig } from "@tpirs/config";
import type { AnyDb } from "@tpirs/db";
import type { BusinessDate, Permission, Principal } from "@tpirs/domain";
import { businessDate, principal } from "@tpirs/domain";
import type { ImportedSettlementRow, PaymentProvider } from "@tpirs/ports";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider, mockWebhookSignature } from "@tpirs/payment-provider-mock";
import { createPaymentService } from "../payment-service.js";
import { CollectorCashService } from "../collector-cash-service.js";

/**
 * Fixtures shared by the Phase 8 acceptance suites (settlement import,
 * reconciliation runs, anomalies, reports).
 *
 * They reuse the Phase 7 cash-day world: a pay-per-use bike tenant, a collector
 * and one gateway levy payment flowed through the ordinary `createIntent` →
 * webhook path, which posts `Dr GATEWAY_CLEARING / Cr ASSET_WALLET` and the
 * revenue credit. Nothing here is state-specific; the config is validated the
 * same way a deployment would.
 */

export const BIKE_FEE = 20_000;
export const RECON_DAY: BusinessDate = businessDate("2026-06-15");
export const RECON_NOW = new Date("2026-06-15T09:00:00Z");
/** Later the same day, so deadline-window arithmetic has room to differ. */
export const RECON_LATER_NOW = new Date("2026-06-15T17:30:00Z");

/** The column mapping every fixture statement is read with. */
export const RECON_MAPPING = {
  reference: "reference",
  amount: "amount",
  fee: "fee",
  settledAt: "settled_at",
  settledAtFormat: "YYYY-MM-DD",
  amountInMinorUnits: true,
  decimalSeparator: ".",
} as const;

type PaymentService = ReturnType<typeof createPaymentService>;

/** Wires the mock provider, fee engine and payment service the suites share. */
export function wirePhase8Services(
  db: AnyDb,
  configs: Map<string, TenantConfig>,
  now: Date = RECON_NOW,
): {
  readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
  readonly feeEngine: ReturnType<typeof createConfigFeeEngine>;
  readonly provider: PaymentProvider;
  readonly providerFor: (name: string) => PaymentProvider | undefined;
  readonly paymentService: PaymentService;
  readonly cashService: CollectorCashService;
} {
  const loadConfig = (tenantId: string): Promise<TenantConfig | undefined> =>
    Promise.resolve(configs.get(tenantId));
  const feeEngine = createConfigFeeEngine({ loadConfig });
  const provider = createMockPaymentProvider();
  const providerFor = (name: string): PaymentProvider | undefined =>
    name === "mock" ? provider : undefined;
  const paymentService = createPaymentService({
    db,
    loadConfig,
    feeEngine,
    providerFor,
    now: () => now,
  });
  const cashService = new CollectorCashService({
    db,
    loadConfig,
    feeEngine,
    providerFor,
    now: () => now,
  });
  return { loadConfig, feeEngine, provider, providerFor, paymentService, cashService };
}

/**
 * One gateway levy payment for one asset/business day, through the ordinary
 * intent-and-webhook path. Returns the provider reference the settlement
 * statement would carry for it.
 */
export async function payLevyDay(
  paymentService: PaymentService,
  input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly businessDate: BusinessDate;
  },
): Promise<string> {
  const { tenantId, assetId, businessDate } = input;
  const endpointToken = await paymentService.provisionEndpoint({ tenantId, provider: "mock" });
  const intent = await paymentService.createIntent({
    tenantId,
    provider: "mock",
    assetId,
    businessDate,
  });
  const rawBody = JSON.stringify({
    providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
    providerReference: intent.reference,
    amount: { amount: Number(intent.amountMinor), currency: intent.currency },
    status: "success",
    paidAt: `${businessDate}T12:00:00Z`,
  });
  const result = await paymentService.ingestWebhookEvent({
    provider: "mock",
    endpointToken,
    headers: { "x-signature": mockWebhookSignature(rawBody) },
    rawBody,
  });
  if (result.outcome !== "applied" || result.paymentId === undefined) {
    throw new Error(`levy payment was not applied: outcome ${result.outcome}`);
  }
  return intent.reference;
}

/** A finance principal holding the reconciliation and reporting permissions. */
export function financeActor(tenant: {
  readonly tenantId: string;
  readonly financeUserId: string;
}): Principal {
  return principal({
    userId: tenant.financeUserId,
    tenantId: tenant.tenantId,
    displayName: "Finance",
    roles: ["finance_admin"],
    permissions: [
      "reconciliation:read",
      "reconciliation:run",
      "report:read",
    ] satisfies Permission[],
  });
}

/** An auditor: read-only by design, so every write path must refuse them. */
export function auditorActor(tenant: {
  readonly tenantId: string;
  readonly auditorUserId: string;
}): Principal {
  return principal({
    userId: tenant.auditorUserId,
    tenantId: tenant.tenantId,
    displayName: "Auditor",
    roles: ["auditor"],
    permissions: ["reconciliation:read", "audit:read"] satisfies Permission[],
  });
}

/** A statement line about one settled payment. */
export function statementRow(input: {
  readonly reference: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly settledOn?: BusinessDate;
  readonly marker: string;
}): ImportedSettlementRow {
  return {
    rowNumber: 1,
    rowHash: `hash-${input.marker}`,
    providerReference: input.reference,
    amount: { amount: input.amountMinor, currency: "NGN" },
    fee: { amount: input.feeMinor, currency: "NGN" },
    settledAt: new Date(`${input.settledOn ?? RECON_DAY}T00:00:00Z`),
    description: `Settlement ${input.marker}`,
    raw: { reference: input.reference },
  };
}

/** Statement content whose only job is an identity hash for the import. */
export function statementContent(marker: string): string {
  return `settlement statement ${marker}`;
}

/**
 * Moves a recorded intake's `recorded_at` into the past.
 *
 * `recordIntake` stamps `recorded_at` from the wall clock (a database default
 * in the repository), so deadline tests have to age the row explicitly rather
 * than pretend the clock moved.
 */
export async function backdateIntake(
  db: AnyDb,
  tenantId: string,
  clientReference: string,
  recordedAt: Date,
): Promise<void> {
  const { sql } = await import("kysely");
  const { withTenant } = await import("@tpirs/db");
  await withTenant(db, tenantId, async (tx) => {
    await sql`
      update cash_intakes
      set recorded_at = ${recordedAt}
      where tenant_id = ${tenantId} and client_reference = ${clientReference}
    `.execute(tx);
  });
}

/**
 * Inserts a second payment row reusing an existing provider reference.
 *
 * The ordinary webhook path cannot produce this (an intent reference is unique
 * per tenant/provider, and a virtual account settles once per day), so the
 * duplicate-reference check is exercised with the evidence a bad import or a
 * racing provider retry would leave.
 */
export async function insertDuplicatePayment(
  db: AnyDb,
  input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly providerReference: string;
    readonly amountMinor: number;
    readonly businessDate: BusinessDate;
  },
): Promise<void> {
  const { sql } = await import("kysely");
  const { withTenant } = await import("@tpirs/db");
  await withTenant(db, input.tenantId, async (tx) => {
    // An `applied` row must be complete, so it reuses the original payment's
    // obligation period and transaction (which a duplicated reference would
    // point at) and carries its own unique receipt.
    const original = await sql<{ obligationPeriodId: string; transactionId: string }>`
      select obligation_period_id as "obligationPeriodId", transaction_id as "transactionId"
      from payments
      where tenant_id = ${input.tenantId}
        and provider_reference = ${input.providerReference}
        and obligation_period_id is not null
      limit 1
    `.execute(tx);
    const row = original.rows[0];
    if (row === undefined) throw new Error("duplicate fixture needs an applied payment");
    await sql`
      insert into payments (
        tenant_id, asset_id, provider, provider_event_id, provider_reference,
        attribution_kind, status, amount_minor, currency, business_date,
        obligation_period_id, transaction_id, receipt_number
      ) values (
        ${input.tenantId}, ${input.assetId}, 'mock',
        ${`dup-${Math.random().toString(36).slice(2)}`},
        ${input.providerReference}, 'narration', 'applied',
        ${input.amountMinor}, 'NGN', ${input.businessDate},
        ${row.obligationPeriodId}, ${row.transactionId},
        ${`DUP-${Math.random().toString(36).slice(2, 10)}`}
      )
    `.execute(tx);
  });
}
