import { sql } from "kysely";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate, money } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { mockWebhookSignature } from "@tpirs/payment-provider-mock";
import type { createPaymentService, IngestWebhookResult } from "../payment-service.js";
import type { CollectorCashService } from "../collector-cash-service.js";

/**
 * Fixtures for the Phase 7 acceptance tests (day close and the deadline
 * sweeper).
 *
 * These live outside the test files so the two acceptance suites share one
 * tenant shape: a pay-per-use bike levy, one collector, the number of assets
 * the test needs, and a mock payment provider. Nothing here is state-specific:
 * currency, timezone, fee and cash rules all come from the validated config the
 * test builds.
 */

export const BIKE_FEE = 20_000;
export const CASH_DAY: BusinessDate = businessDate("2026-06-15");
export const CASH_NOW = new Date("2026-06-15T09:00:00Z");

export interface CashConfigOptions {
  readonly ceilingMinor?: number;
  readonly disabled?: boolean;
  readonly freezeOnShortfall?: boolean;
  readonly depositDeadlineHours?: number;
}

/** The tenant config both acceptance suites use, with the knobs they vary. */
export function cashConfig(slug: string, options: CashConfigOptions = {}): TenantConfig {
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
      cashReceiptTemplate: "Cash {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: !options.disabled,
      floatCeilingMinor: options.ceilingMinor ?? 1_000_000,
      depositDeadlineHours: options.depositDeadlineHours ?? 8,
      freezeOnShortfall: options.freezeOnShortfall ?? true,
    },
    payments: { underpaymentPolicy: "wallet" },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "ng", consentTextKey: "c" },
  });
}

export interface CashAsset {
  readonly assetId: string;
  readonly token: string;
  readonly shortCode: string;
}

export interface CashTenant {
  readonly tenantId: string;
  readonly assets: readonly CashAsset[];
  readonly collectorUserId: string;
  readonly financeUserId: string;
  readonly auditorUserId: string;
  readonly ownerPhone: string;
}

let tenantCounter = 0;

/**
 * A fresh tenant per test: one owner, one collector, one finance user, one
 * auditor, and `assetCount` bikes. Separate tenants keep wallets isolated, so no
 * test sees another's float.
 */
export async function makeCashTenant(
  db: AnyDb,
  configs: Map<string, TenantConfig>,
  options: CashConfigOptions & { readonly assetCount?: number } = {},
): Promise<CashTenant> {
  tenantCounter += 1;
  const stamp = `${Date.now().toString(36)}${tenantCounter.toString(36)}`;
  const slug = `cash${stamp}`.slice(0, 30);
  const assetCount = options.assetCount ?? 1;

  const created = await withSystem(db, async (tx) => {
    const repos = repositories(tx);
    const tenant = await repos.tenants.create({
      slug,
      name: "Cash",
      legalEntity: "Cash Revenue",
      config: {},
    });
    configs.set(tenant.id, cashConfig(slug, options));
    const owner = await repos.owners.create({
      tenantId: tenant.id,
      displayName: "Driver",
      phone: `+2348${stamp.slice(-8).padStart(8, "0")}`,
    });
    const collector = await repos.users.create({
      tenantId: tenant.id,
      username: `collector-${stamp}`,
      displayName: "Collector",
      passwordHash: "not-a-real-hash",
      totpSecret: null,
    });
    const finance = await repos.users.create({
      tenantId: tenant.id,
      username: `finance-${stamp}`,
      displayName: "Finance",
      passwordHash: "not-a-real-hash",
      totpSecret: null,
    });
    const auditor = await repos.users.create({
      tenantId: tenant.id,
      username: `auditor-${stamp}`,
      displayName: "Auditor",
      passwordHash: "not-a-real-hash",
      totpSecret: null,
    });
    const assets: CashAsset[] = [];
    for (let index = 1; index <= assetCount; index += 1) {
      const shortCode = `C${index}-${stamp.slice(-4)}`;
      const asset = await repos.assets.create({
        tenantId: tenant.id,
        zoneId: null,
        ownerId: owner.id,
        assetTypeKey: "bike",
        attributes: { plate_number: `KJA-${stamp.slice(-4)}-${index}` },
        qrPayload: `cash-${stamp}-${index}`,
        qrToken: `cash-${stamp}-${index}-token`,
        shortCode,
        createdByUserId: null,
      });
      assets.push({
        assetId: asset.id,
        token: `cash-${stamp}-${index}-token`,
        shortCode,
      });
    }
    return {
      tenantId: tenant.id,
      assets,
      collectorUserId: collector.id,
      financeUserId: finance.id,
      auditorUserId: auditor.id,
      ownerPhone: owner.phone,
    };
  });
  return created;
}

/** One asset of the fixture, failing loudly instead of asserting non-null. */
export function assetAt(tenant: CashTenant, index: number): CashAsset {
  const asset = tenant.assets[index];
  if (asset === undefined) {
    throw new Error(`cash tenant has no asset at index ${index}`);
  }
  return asset;
}

/** The collector's active mock deposit destination, provisioned if needed. */
export async function provisionInstruction(
  db: AnyDb,
  service: CollectorCashService,
  tenant: { readonly tenantId: string; readonly collectorUserId: string },
): Promise<string> {
  await service.provisionDepositInstruction({
    tenantId: tenant.tenantId,
    collectorUserId: tenant.collectorUserId,
    provider: "mock",
  });
  const instruction = await withTenant(db, tenant.tenantId, async (tx) =>
    repositories(tx).collectorCash.findActiveInstructionForCollector(
      tenant.tenantId,
      tenant.collectorUserId,
      "mock",
    ),
  );
  if (instruction === undefined) throw new Error("deposit instruction was not provisioned");
  return instruction.reference;
}

/** Delivers one deposit webhook exactly as the gateway would. */
export async function deliverDeposit(
  paymentService: ReturnType<typeof createPaymentService>,
  params: {
    readonly tenantId: string;
    readonly reference: string;
    readonly amountMinor: number;
    readonly currency?: string;
    readonly status?: "success" | "failed";
  },
): Promise<IngestWebhookResult> {
  const endpointToken = await paymentService.provisionEndpoint({
    tenantId: params.tenantId,
    provider: "mock",
  });
  const rawBody = JSON.stringify({
    providerEventId: `dep-${Math.random().toString(36).slice(2, 10)}`,
    providerReference: params.reference,
    amount: { amount: params.amountMinor, currency: params.currency ?? "NGN" },
    status: params.status ?? "success",
    paidAt: "2026-06-15T12:00:00Z",
  });
  return paymentService.ingestWebhookEvent({
    provider: "mock",
    endpointToken,
    headers: { "x-signature": mockWebhookSignature(rawBody) },
    rawBody,
  });
}

export interface CashPosition {
  /** Derived COLLECTOR_CASH balance for the collector, minor units. */
  readonly balanceMinor: bigint;
  /** Sum of intakes still waiting for a deposit. */
  readonly openIntakeTotalMinor: bigint;
  readonly openIntakes: number;
  readonly intakeTotalMinor: bigint;
  /** Deposits that posted money (matched or partly matched). */
  readonly postedDepositTotalMinor: bigint;
  readonly suspenseDeposits: number;
  /** Whole-ledger totals: these must be equal for the tenant. */
  readonly debitsMinor: bigint;
  readonly creditsMinor: bigint;
}

/** Reads the whole cash position of one collector plus the ledger totals. */
export async function readCashPosition(db: AnyDb, tenant: CashTenant): Promise<CashPosition> {
  return withTenant(db, tenant.tenantId, async (tx) => {
    const repos = repositories(tx);
    const intakes = await repos.collectorCash.listIntakes(tenant.tenantId, {
      collectorUserId: tenant.collectorUserId,
      limit: 200,
    });
    const deposits = await repos.collectorCash.listDeposits(tenant.tenantId, {
      collectorUserId: tenant.collectorUserId,
      limit: 200,
    });
    const totals = await sql<{ direction: string; total: string }>`
      select direction, sum(amount_minor)::text as total
      from ledger_entries
      where tenant_id = ${tenant.tenantId}
      group by direction
    `.execute(tx);
    const debit = totals.rows.find((row) => row.direction === "debit")?.total;
    const credit = totals.rows.find((row) => row.direction === "credit")?.total;
    return {
      balanceMinor: await repos.ledger.collectorCashBalance(
        tenant.tenantId,
        tenant.collectorUserId,
      ),
      openIntakeTotalMinor: await repos.collectorCash.sumOpenIntakes(
        tenant.tenantId,
        tenant.collectorUserId,
      ),
      openIntakes: intakes.rows.filter((row) => row.status === "open").length,
      intakeTotalMinor: intakes.rows.reduce((sum, row) => sum + row.amountMinor, 0n),
      postedDepositTotalMinor: deposits.rows
        .filter((row) => row.status !== "suspense")
        .reduce((sum, row) => sum + row.amountMinor, 0n),
      suspenseDeposits: deposits.rows.filter((row) => row.status === "suspense").length,
      debitsMinor: debit === undefined ? 0n : BigInt(debit),
      creditsMinor: credit === undefined ? 0n : BigInt(credit),
    };
  });
}

/** The intake input for one asset. */
export function intakeFor(tenant: CashTenant, asset: CashAsset, clientReference: string) {
  return {
    tenantId: tenant.tenantId,
    collectorUserId: tenant.collectorUserId,
    assetId: asset.assetId,
    amount: money("NGN", BIKE_FEE),
    clientReference,
  };
}
