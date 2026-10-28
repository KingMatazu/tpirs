import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { Telemetry } from "@tpirs/ports";
import type { CashWalletService } from "./cash-wallet-service.js";

/**
 * The deposit deadline sweeper (ADR 0033).
 *
 * Cash a collector holds past `cashRules.depositDeadlineHours` is a shortfall
 * the platform can see but cannot fix by itself. The sweeper finds those
 * wallets, flags each one once, records who to bother, and freezes when the
 * tenant asked for that.
 *
 * It is deliberately boring: one query for the tenant list, one query per
 * cash-enabled tenant, and the same run twice changes nothing. `overdue_since`
 * is the dedupe key — set once per deadline window, cleared when the cash
 * arrives or a human unfreezes the wallet.
 */

/** A tenant to examine: its id and its stored (still unvalidated) config. */
export interface CashSweepTenant {
  readonly id: string;
  readonly config: unknown;
}

export interface CashDeadlineSweeperDeps {
  readonly db: AnyDb;
  /** The wallet transitions; the sweeper only ever calls `freeze`. */
  readonly cash: Pick<CashWalletService, "freeze">;
  /**
   * The tenants to examine, with their stored config. Defaults to every tenant,
   * read in one system transaction, because the worker has no tenant to scan
   * with and no request path to protect. Config validation happens here, in
   * process, so a sweep costs one query per tenant, not one per tenant per
   * config lookup.
   */
  readonly tenants?: () => Promise<readonly CashSweepTenant[]>;
  readonly now?: () => Date;
  readonly telemetry?: Telemetry;
}

export interface CashSweepSummary {
  /** Tenants with cash enabled that were examined. */
  readonly tenants: number;
  /** Wallets flagged overdue in this run (a wallet is flagged once per window). */
  readonly flagged: number;
  /** Wallets frozen in this run. */
  readonly frozen: number;
}

export interface CashDeadlineSweeper {
  /** Runs one sweep. Safe to run as often as wanted; idempotent per wallet. */
  sweep(): Promise<CashSweepSummary>;
}

export function createCashDeadlineSweeper(deps: CashDeadlineSweeperDeps): CashDeadlineSweeper {
  const now = deps.now ?? (() => new Date());
  const listTenants =
    deps.tenants ??
    (async () =>
      withSystem(deps.db, async (tx) =>
        (await repositories(tx).tenants.list()).map((tenant) => ({
          id: tenant.id,
          config: tenant.config,
        })),
      ));

  async function sweep(): Promise<CashSweepSummary> {
    const at = now();
    let examined = 0;
    let flagged = 0;
    let frozen = 0;

    for (const tenant of await listTenants()) {
      // A present-but-broken config is reported and skipped, never guessed at.
      let config: TenantConfig | undefined;
      try {
        config = validateTenantConfig(tenant.config);
      } catch (error) {
        deps.telemetry?.captureError(error, { stage: "cash-deadline-sweep", tenantId: tenant.id });
        continue;
      }
      if (!config.cashRules.enabled) continue;
      examined += 1;

      const deadlineHours = config.cashRules.depositDeadlineHours;
      // Deadlines are instants measured from the intake, not calendar days
      // (ADR 0033), so the cutoff is a plain hour subtraction.
      const cutoff = new Date(at.getTime() - deadlineHours * 3_600_000);
      const wallets = await withTenant(deps.db, tenant.id, async (tx) =>
        repositories(tx).collectorCash.overdueWallets(tenant.id, cutoff),
      );

      for (const wallet of wallets) {
        if (await flagOnce(tenant.id, wallet.collectorUserId, cutoff, at, deadlineHours)) {
          flagged += 1;
        }

        if (config.cashRules.freezeOnShortfall) {
          await deps.cash.freeze({
            tenantId: tenant.id,
            collectorUserId: wallet.collectorUserId,
            reason: `deposit deadline of ${deadlineHours}h missed`,
            actor: { kind: "system" },
          });
          frozen += 1;
        }
      }
    }

    if (flagged > 0 || frozen > 0) {
      deps.telemetry?.counter("cash.deadline.flagged", flagged);
      deps.telemetry?.counter("cash.deadline.frozen", frozen);
      deps.telemetry?.log("info", "cash deadline sweep flagged collectors", {
        tenants: examined,
        flagged,
        frozen,
      });
    }
    return { tenants: examined, flagged, frozen };
  }

  /**
   * Marks one wallet overdue and records the notice, exactly once per deadline
   * window.
   *
   * The conditional update is the dedupe: `overdue_since is null` makes two
   * concurrent sweeps (or a retried run) produce one flag and one notice, not
   * two. The notice is an append-only audit entry with the numbers a supervisor
   * needs — staff carry no phone number in this schema, so the dashboard reads
   * it rather than an SMS (docs/decisions-needed.md, D40).
   */
  async function flagOnce(
    tenantId: string,
    collectorUserId: string,
    cutoff: Date,
    at: Date,
    deadlineHours: number,
  ): Promise<boolean> {
    const held = await withTenant(deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const open = await repos.collectorCash.openIntakesForCollector(tenantId, collectorUserId);
      const overdue = open.filter((intake) => intake.recordedAt < cutoff);
      return {
        oldestIntakeId: overdue[0]?.id ?? null,
        oldestRecordedAt: overdue[0]?.recordedAt ?? null,
        openIntakeCount: open.length,
        openIntakeTotalMinor: sumMinor(open),
        balanceMinor: await repos.ledger.collectorCashBalance(tenantId, collectorUserId),
      };
    });

    return withTenant(deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const changed = await repos.collectorCash.markOverdue(tenantId, collectorUserId, at);
      if (!changed) return false;
      const wallet = await repos.collectorCash.findWallet(tenantId, collectorUserId);
      await repos.audit.record({
        tenantId,
        actorUserId: null,
        action: "cash.wallet.overdue",
        entityType: "collector_wallet",
        entityId: wallet?.id ?? null,
        before: { overdueSince: null },
        after: {
          overdueSince: at,
          collectorUserId,
          deadlineHours,
          oldestIntakeId: held.oldestIntakeId,
          oldestRecordedAt: held.oldestRecordedAt,
          openIntakeCount: held.openIntakeCount,
          // Audit payloads are JSON: minor-unit amounts travel as strings, the
          // same convention the rest of the audit trail uses.
          openIntakeTotalMinor: String(held.openIntakeTotalMinor),
          balanceMinor: String(held.balanceMinor),
          actor: "cash-deadline-sweeper",
        },
      });
      return true;
    });
  }

  return { sweep };
}

/** Sums the open intakes the caller already loaded, in minor units. */
function sumMinor(intakes: readonly { readonly amountMinor: bigint }[]): bigint {
  return intakes.reduce((total, intake) => total + intake.amountMinor, 0n);
}
