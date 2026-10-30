import { createHash } from "node:crypto";
import { todayInTimeZone } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import type { repositories } from "./repositories/index.js";

/**
 * Demo data for the collector cash flow.
 *
 * The seed cannot call the application services (that would make `@tpirs/db`
 * depend on `@tpirs/application`), so this helper writes the same rows those
 * services write, in the same order, for one settled day:
 *
 * 1. wallet row + active deposit instruction;
 * 2. the day's settlement: `Dr COLLECTOR_CASH / Cr ASSET_WALLET` (cash funded
 *    the wallet) then the allocation `Dr ASSET_WALLET / Cr REVENUE_LEVY`;
 * 3. the intake record pointing at both transactions;
 * 4. the matching deposit: `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH`, one
 *    allocation row, the intake marked matched and the deposit marked matched.
 *
 * The result reconciles to zero — derived `COLLECTOR_CASH` balance 0, no open
 * intakes — which is exactly what the Step 10 day-close test asserts through
 * the service path. Amounts, currency, asset type, fee rule and business day
 * all come from the tenant's validated config: nothing here is state-specific.
 *
 * Idempotent: a tenant that already has the demo wallet is left untouched, so
 * re-running `pnpm db:seed` never doubles the demo day.
 */

export interface CashDemoSeed {
  /** Existing seeded user who takes the cash. */
  readonly collectorUsername: string;
  readonly ownerName: string;
  readonly ownerPhone: string;
  readonly plateNumber: string;
  readonly shortCode: string;
  /** Idempotency key of the demo intake. */
  readonly clientReference: string;
  readonly provider: string;
  /** Destination reference the collector writes on the deposit. */
  readonly depositReference: string;
}

type Repos = ReturnType<typeof repositories>;

export interface CashDemoDayResult {
  readonly seeded: boolean;
  readonly assetId?: string;
  readonly intakeId?: string;
  readonly depositId?: string;
  readonly businessDate?: string;
  readonly amountMinor?: bigint;
}

export async function seedCollectorCashDay(params: {
  readonly repos: Repos;
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly demo: CashDemoSeed;
  readonly now: Date;
}): Promise<CashDemoDayResult> {
  const { repos, tenantId, config, demo } = params;

  const collector = await repos.users.findByUsername(demo.collectorUsername);
  if (collector === undefined) {
    throw new Error(`cash demo collector "${demo.collectorUsername}" is not seeded`);
  }
  if ((await repos.collectorCash.findWallet(tenantId, collector.id)) !== undefined) {
    return { seeded: false };
  }

  const currency = config.locale.currency;
  const assetType = config.assetTypes[0];
  const feeRule = config.obligations.feeRules.find((rule) => rule.assetTypeKey === assetType?.key);
  if (assetType === undefined || feeRule === undefined) {
    throw new Error("cash demo needs one asset type with an effective fee rule");
  }
  const amountMinor = BigInt(feeRule.amountMinor);
  const businessDate = todayInTimeZone(config.locale.timezone, params.now);

  const owner =
    (await repos.owners.findByPhone(demo.ownerPhone)) ??
    (await repos.owners.create({
      tenantId,
      displayName: demo.ownerName,
      phone: demo.ownerPhone,
    }));

  const zone = (await repos.zones.list())[0];
  const asset =
    (await repos.assets.findByShortCode(demo.shortCode)) ??
    (await repos.assets.create({
      tenantId,
      zoneId: zone?.id ?? null,
      ownerId: owner.id,
      assetTypeKey: assetType.key,
      attributes: { plate_number: demo.plateNumber },
      // A QR payload must be 16-64 URL-safe characters (ADR 0007); the sticker's
      // display format ("QR-{id}") is not one. Derived from the short code so a
      // re-seed keeps the same sticker.
      qrPayload: createHash("sha256").update(`seed:${demo.shortCode}`).digest("hex").slice(0, 32),
      qrToken: `seed-${demo.shortCode.toLowerCase()}`,
      shortCode: demo.shortCode,
      createdByUserId: null,
    }));

  await repos.collectorCash.ensureWallet(tenantId, collector.id);
  if (
    (await repos.collectorCash.findActiveInstructionForCollector(tenantId, collector.id)) ===
    undefined
  ) {
    await repos.collectorCash.createInstruction(tenantId, {
      collectorUserId: collector.id,
      provider: demo.provider,
      reference: demo.depositReference,
      kind: "narration",
    });
  }

  const accounts = await repos.accounts.ensureStandardAccounts(tenantId, currency);
  const accountId = (code: string): string => {
    const account = accounts[code];
    if (account === undefined) throw new Error(`standard account ${code} was not created`);
    return account.id;
  };

  const period = await repos.obligations.create(tenantId, {
    assetId: asset.id,
    periodKey: businessDate,
    businessDate,
    amountMinor,
    currency,
    feeRuleKey: feeRule.key,
    feeAmountSnapshotMinor: amountMinor,
  });

  // Cash funded the wallet, then the allocation recognised the revenue — the
  // same two postings `ObligationService.settleInScope` writes for an intake.
  const walletPosting = await repos.ledger.createTransactionWithEntries(tenantId, {
    idempotencyKey: `seed:cash:${demo.clientReference}:wallet`,
    sourceType: "cash_intake",
    sourceId: demo.clientReference,
    description: "Seeded cash intake (wallet credit)",
    postings: [
      {
        accountId: accountId("COLLECTOR_CASH"),
        direction: "debit",
        amountMinor,
        currency,
        assetId: asset.id,
        collectorUserId: collector.id,
      },
      {
        accountId: accountId("ASSET_WALLET"),
        direction: "credit",
        amountMinor,
        currency,
        assetId: asset.id,
      },
    ],
  });

  const allocation = await repos.ledger.createTransactionWithEntries(tenantId, {
    idempotencyKey: `seed:cash:${demo.clientReference}:allocation`,
    sourceType: "allocation",
    sourceId: demo.clientReference,
    description: "Seeded cash intake (obligation allocation)",
    postings: [
      {
        accountId: accountId("ASSET_WALLET"),
        direction: "debit",
        amountMinor,
        currency,
        assetId: asset.id,
        obligationPeriodId: period.id,
      },
      {
        accountId: accountId("REVENUE_LEVY"),
        direction: "credit",
        amountMinor,
        currency,
        assetId: asset.id,
        obligationPeriodId: period.id,
      },
    ],
  });

  await repos.obligations.markPaid(tenantId, period.id, allocation.transaction.id, amountMinor, {
    feeRuleKey: feeRule.key,
    feeAmountSnapshotMinor: amountMinor,
  });

  const { intake } = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
    collectorUserId: collector.id,
    clientReference: demo.clientReference,
    assetId: asset.id,
    zoneId: asset.zoneId,
    businessDate,
    amountMinor,
    currency,
    receiptNumber: `SEED-${demo.shortCode}`,
    obligationPeriodId: period.id,
    transactionId: walletPosting.transaction.id,
  });

  const { deposit } = await repos.collectorCash.insertDepositIfAbsent(tenantId, {
    provider: demo.provider,
    providerReference: demo.depositReference,
    amountMinor,
    currency,
    collectorUserId: collector.id,
  });

  await repos.ledger.createTransactionWithEntries(tenantId, {
    idempotencyKey: `seed:cash-deposit:${demo.depositReference}`,
    sourceType: "cash_deposit",
    sourceId: deposit.id,
    description: `Seeded collector deposit via ${demo.provider}`,
    postings: [
      {
        accountId: accountId("SETTLEMENT_BANK"),
        direction: "debit",
        amountMinor,
        currency,
        collectorUserId: collector.id,
      },
      {
        accountId: accountId("COLLECTOR_CASH"),
        direction: "credit",
        amountMinor,
        currency,
        collectorUserId: collector.id,
      },
    ],
  });

  await repos.collectorCash.addDepositAllocation(tenantId, {
    depositId: deposit.id,
    intakeId: intake.id,
    amountMinor,
  });
  await repos.collectorCash.markIntakeMatched(tenantId, intake.id);
  await repos.collectorCash.setDepositOutcome(tenantId, deposit.id, {
    status: "matched",
    collectorUserId: collector.id,
  });

  return {
    seeded: true,
    assetId: asset.id,
    intakeId: intake.id,
    depositId: deposit.id,
    businessDate,
    amountMinor,
  };
}
