import { randomUUID } from "node:crypto";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantAnomalyRule, TenantConfig } from "@tpirs/config";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { addDays, businessDate, money } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { mockWebhookSignature } from "@tpirs/payment-provider-mock";
import type { createPaymentService } from "../payment-service.js";
import type { CollectorCashService } from "../collector-cash-service.js";
import type { createSettlementImportService } from "../settlement-import-service.js";
import { cashConfig, deliverDeposit, provisionInstruction } from "./cash-day.js";

/**
 * The Phase 8 acceptance fixture: one tenant, one zone tree, 24 assets and 30
 * business days of deterministic activity.
 *
 * The activity is deliberately boring and repeatable: each asset is paid on
 * most days, a fifth of those payments arrive as collector cash that is banked
 * the same day, and one in seven gateway payments is short (a wallet credit
 * under pay-per-use, never a debt). Field scans mirror the truth the platform
 * would derive, including some `unknown` offline checks that must stay out of
 * the compliance denominator.
 *
 * Nothing here is random: the plan is a pure function of the day and asset
 * index, so a failure is reproducible from the day number alone.
 */

export const MONTH_START: BusinessDate = businessDate("2026-06-01");
export const MONTH_DAYS = 30;

export interface MonthZone {
  readonly id: string;
  readonly name: string;
}

export interface MonthAsset {
  readonly assetId: string;
  readonly zoneId: string;
  readonly zoneName: string;
}

export interface MonthTenant {
  readonly tenantId: string;
  readonly collectorUserId: string;
  readonly financeUserId: string;
  readonly officerUserId: string;
  readonly auditorUserId: string;
  readonly zones: readonly MonthZone[];
  readonly assets: readonly MonthAsset[];
  readonly config: TenantConfig;
}

/** The 30 business days the fixture exercises, starting at `MONTH_START`. */
export function monthDays(start: BusinessDate = MONTH_START): BusinessDate[] {
  return Array.from({ length: MONTH_DAYS }, (_unused, index) => addDays(start, index));
}

/** Whether the plan pays for this asset on this day (two out of three). */
export function plannedPaid(dayIndex: number, assetIndex: number): boolean {
  return (dayIndex + assetIndex) % 3 !== 0;
}

/** Whether the plan funds the day with collector cash instead of the gateway. */
export function plannedCash(dayIndex: number, assetIndex: number): boolean {
  return plannedPaid(dayIndex, assetIndex) && (dayIndex + assetIndex) % 5 === 0;
}

/** Whether the gateway payment is short (a wallet credit, never a debt). */
export function plannedShort(dayIndex: number, assetIndex: number): boolean {
  return (
    plannedPaid(dayIndex, assetIndex) &&
    !plannedCash(dayIndex, assetIndex) &&
    (dayIndex + assetIndex) % 7 === 0
  );
}

/** Whether the field app could not decide the status (offline, aged cache). */
export function plannedUnknownScan(dayIndex: number, assetIndex: number): boolean {
  return (dayIndex * 5 + assetIndex) % 11 === 0;
}

/** One tenant with a parent zone and two children, plus its staff. */
export async function makeMonthTenant(
  db: AnyDb,
  configs: Map<string, TenantConfig>,
  options: {
    readonly assetCount?: number;
    readonly slugPrefix?: string;
    readonly anomalyRules?: readonly TenantAnomalyRule[];
  } = {},
): Promise<MonthTenant> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const slug = `${options.slugPrefix ?? "month"}${stamp}`.slice(0, 30);
  const assetCount = options.assetCount ?? 24;
  const config = validateTenantConfig({
    ...cashConfig(slug, { ceilingMinor: 50_000_000 }),
    reconciliation: {
      ...cashConfig(slug).reconciliation,
      feeToleranceMinor: 1_000,
      suspenseAgeingDays: 7,
      // The stable month has no advisory noise; the discrepancy scenario below
      // enables the rules it asserts.
      anomalyRules: options.anomalyRules ?? [],
    },
  });

  const created = await withSystem(db, async (tx) => {
    const repos = repositories(tx);
    const tenant = await repos.tenants.create({
      slug,
      name: "Month State",
      legalEntity: "Month State Revenue",
      config,
    });
    const user = async (username: string) => {
      const row = await repos.users.create({
        tenantId: tenant.id,
        username: `${username}-${stamp}`.slice(0, 60),
        displayName: username,
        passwordHash: "not-a-real-hash",
        totpSecret: null,
      });
      return row.id;
    };
    const collectorUserId = await user("collector");
    const financeUserId = await user("finance");
    const officerUserId = await user("officer");
    const auditorUserId = await user("auditor");

    const parent = await repos.zones.create({
      tenantId: tenant.id,
      parentZoneId: null,
      name: "Central",
    });
    const market = await repos.zones.create({
      tenantId: tenant.id,
      parentZoneId: parent.id,
      name: "Central Market",
    });
    const park = await repos.zones.create({
      tenantId: tenant.id,
      parentZoneId: parent.id,
      name: "Motor Park",
    });
    const zones: MonthZone[] = [
      { id: market.id, name: market.name },
      { id: park.id, name: park.name },
    ];

    const assets: MonthAsset[] = [];
    for (let index = 0; index < assetCount; index += 1) {
      const zone = zones[index % zones.length] ?? zones[0];
      if (zone === undefined) throw new Error("month tenant has no zone");
      const asset = await repos.assets.create({
        tenantId: tenant.id,
        zoneId: zone.id,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: `MN-${stamp.slice(-4)}-${String(index).padStart(2, "0")}` },
        qrPayload: `month-${stamp}-${String(index)}`,
        qrToken: `month-${stamp}-${String(index)}-token`,
        shortCode: `M${String(index).padStart(2, "0")}${stamp.slice(-2)}`,
        createdByUserId: null,
      });
      assets.push({ assetId: asset.id, zoneId: zone.id, zoneName: zone.name });
    }

    return {
      tenantId: tenant.id,
      collectorUserId,
      financeUserId,
      officerUserId,
      auditorUserId,
      zones,
      assets,
      config,
    };
  });
  configs.set(created.tenantId, created.config);
  return created;
}

export interface MonthActivityDeps {
  readonly db: AnyDb;
  readonly tenant: MonthTenant;
  readonly paymentService: ReturnType<typeof createPaymentService>;
  readonly cashService: CollectorCashService;
  readonly settlementImport: ReturnType<typeof createSettlementImportService>;
  readonly days: readonly BusinessDate[];
}

export interface MonthExpectations {
  /** Cash recognised (allocated) per business day, minor units. */
  readonly revenueByDay: ReadonlyMap<string, bigint>;
  /** Gateway statement rows imported per business day. */
  readonly paymentsByDay: ReadonlyMap<string, number>;
  /** Per zone: paid scans and known (paid + no-payment) scans over the month. */
  readonly scansByZone: ReadonlyMap<string, { readonly paid: number; readonly known: number }>;
  readonly totalRevenueMinor: bigint;
}

const CASH_FEE = 20_000;
const SHORT_FEE = 15_000;
const STATEMENT_FEE = 100;

/**
 * One gateway levy payment. `requiredMinor` is what the intent must ask for
 * (the fee minus any wallet credit the asset already holds); `deliveredMinor`
 * is what the driver actually sends, which is less on a short day.
 */
async function payViaGateway(
  paymentService: ReturnType<typeof createPaymentService>,
  tenantId: string,
  assetId: string,
  day: BusinessDate,
  requiredMinor: number,
  deliveredMinor: number,
): Promise<string> {
  const endpointToken = await paymentService.provisionEndpoint({ tenantId, provider: "mock" });
  const intent = await paymentService.createIntent({
    tenantId,
    provider: "mock",
    assetId,
    businessDate: day,
  });
  if (Number(intent.amountMinor) !== requiredMinor) {
    throw new Error(
      `month plan expected ${requiredMinor} on ${day}, got ${String(intent.amountMinor)}`,
    );
  }
  const rawBody = JSON.stringify({
    providerEventId: `evt-${day}-${Math.random().toString(36).slice(2)}`,
    providerReference: intent.reference,
    amount: { amount: deliveredMinor, currency: intent.currency },
    status: "success",
    paidAt: `${day}T12:00:00Z`,
  });
  const result = await paymentService.ingestWebhookEvent({
    provider: "mock",
    endpointToken,
    headers: { "x-signature": mockWebhookSignature(rawBody) },
    rawBody,
  });
  if (!result.accepted) {
    throw new Error(`month payment for ${day} was not accepted: ${result.outcome}`);
  }
  return intent.reference;
}

function statementCsv(rows: readonly string[]): string {
  return ["reference,amount,fee,currency,settled_at,narration", ...rows].join("\n") + "\n";
}

/**
 * Plays the month: payments, cash, deposits, scans and statement imports, day
 * by day. Returns what the platform should then prove.
 */
export async function runMonthActivity(deps: MonthActivityDeps): Promise<MonthExpectations> {
  const { db, tenant, paymentService, cashService, settlementImport, days } = deps;
  const depositReference = await provisionInstruction(db, cashService, tenant);

  const revenueByDay = new Map<string, bigint>();
  const paymentsByDay = new Map<string, number>();
  const scansByZone = new Map<string, { paid: number; known: number }>();
  let totalRevenueMinor = 0n;

  for (const [dayIndex, day] of days.entries()) {
    const rows: string[] = [];
    let revenueMinor = 0n;

    for (const [assetIndex, asset] of tenant.assets.entries()) {
      // Asset 0 underpays once and then stays idle: its 15,000 is a wallet
      // credit, never a debt, and it never settles a day. Every other asset is
      // fully funded, by gateway or by cash.
      const underpaid = dayIndex === 0 && assetIndex === 0;
      const paid = plannedPaid(dayIndex, assetIndex) && !(assetIndex === 0 && dayIndex > 0);
      const viaCash = paid && !underpaid && plannedCash(dayIndex, assetIndex);
      let settled = false;

      if (underpaid) {
        const reference = await payViaGateway(
          paymentService,
          tenant.tenantId,
          asset.assetId,
          day,
          CASH_FEE,
          SHORT_FEE,
        );
        rows.push(
          `${reference},${String(SHORT_FEE)},${String(STATEMENT_FEE)},NGN,${day},Underpayment`,
        );
        // No allocation: the day is not settled and no revenue is recognised.
      } else if (paid && viaCash) {
        await cashService.recordIntake({
          tenantId: tenant.tenantId,
          collectorUserId: tenant.collectorUserId,
          assetId: asset.assetId,
          amount: money("NGN", CASH_FEE),
          clientReference: `month-${day}-${String(assetIndex)}`,
          businessDate: day,
        });
        // Banked the same day: the float closes, and the run sees no overdue.
        const deposit = await deliverDeposit(paymentService, {
          tenantId: tenant.tenantId,
          reference: depositReference,
          amountMinor: CASH_FEE,
        });
        if (deposit.outcome !== "deposit_matched") {
          throw new Error(`month deposit did not match on ${day}: ${deposit.outcome}`);
        }
        settled = true;
      } else if (paid) {
        const reference = await payViaGateway(
          paymentService,
          tenant.tenantId,
          asset.assetId,
          day,
          CASH_FEE,
          CASH_FEE,
        );
        rows.push(
          `${reference},${String(CASH_FEE)},${String(STATEMENT_FEE)},NGN,${day},Settlement`,
        );
        settled = true;
      }

      if (settled) revenueMinor += BigInt(CASH_FEE);
      const authoritative: "paid" | "no_payment_recorded" = settled
        ? "paid"
        : "no_payment_recorded";

      const unknown = plannedUnknownScan(dayIndex, assetIndex);
      const status = unknown ? "unknown" : authoritative;
      await withTenant(db, tenant.tenantId, async (tx) =>
        repositories(tx).scans.insertIfAbsent({
          tenantId: tenant.tenantId,
          assetId: asset.assetId,
          officerUserId: tenant.officerUserId,
          deviceId: "month-device",
          clientScanId: randomUUID(),
          source: "qr",
          observedStatus: status,
          authoritativeStatus: status,
          businessDate: day,
          scannedAt: new Date(`${day}T10:00:00Z`),
          zoneId: asset.zoneId,
        }),
      );
      const counts = scansByZone.get(asset.zoneId) ?? { paid: 0, known: 0 };
      if (status !== "unknown") counts.known += 1;
      if (status === "paid") counts.paid += 1;
      scansByZone.set(asset.zoneId, counts);
    }

    if (rows.length > 0) {
      await settlementImport.importStatement({
        tenantId: tenant.tenantId,
        provider: "mock",
        filename: `statement-${day}.csv`,
        content: statementCsv(rows),
        mapping: {
          reference: "reference",
          amount: "amount",
          fee: "fee",
          currency: "currency",
          settledAt: "settled_at",
          description: "narration",
          settledAtFormat: "YYYY-MM-DD",
          amountInMinorUnits: true,
          decimalSeparator: ".",
        },
        defaultCurrency: "NGN",
        feeToleranceMinor: BigInt(tenant.config.reconciliation.feeToleranceMinor),
        actor: {
          userId: tenant.financeUserId,
          tenantId: tenant.tenantId,
          displayName: "Finance",
          roles: ["finance_admin"],
          permissions: ["reconciliation:run"],
        },
      });
    }

    revenueByDay.set(day, revenueMinor);
    paymentsByDay.set(day, rows.length);
    totalRevenueMinor += revenueMinor;
  }

  return { revenueByDay, paymentsByDay, scansByZone, totalRevenueMinor };
}
