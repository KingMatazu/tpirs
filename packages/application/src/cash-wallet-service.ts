import { CashError, ForbiddenError, transitionWallet } from "@tpirs/domain";
import type { CashWalletStatus, CashWalletTransition, Permission, Principal } from "@tpirs/domain";
import { cashModelOf, maxBalanceMinorOf } from "@tpirs/config";
import type { TenantCashRules } from "@tpirs/config";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, CollectorWalletRow } from "@tpirs/db";
import type { TenantConfigLoader } from "./asset-service.js";

/** The repository bundle a tenant-scoped transaction gives back. */
type Repositories = ReturnType<typeof repositories>;

/**
 * Wallet state changes: freeze, unfreeze, and the derived view.
 *
 * This is separate from `CollectorCashService` because the deadline sweeper only
 * needs state transitions and must not depend on the fee engine that intake
 * pricing needs. `CollectorCashService.freeze` / `.unfreeze` delegate here, so
 * there is exactly one implementation behind both entry points (ADR 0033).
 */

/**
 * Who is acting. A person carries their resolved permissions; `system` is the
 * deadline sweeper, which has no user and is trusted by construction.
 */
export type CashActor = Principal | { readonly kind: "system" };

export interface CashWalletTransitionInput {
  readonly tenantId: string;
  readonly collectorUserId: string;
  /** Required: the audit entry records why the wallet changed (ADR 0033). */
  readonly reason: string;
  readonly actor: CashActor;
}

/** A wallet with the two numbers a supervisor actually asks for. */
export interface CashWalletView {
  readonly tenantId: string;
  readonly collectorUserId: string;
  readonly status: CashWalletStatus;
  readonly frozenAt: Date | null;
  readonly frozenReason: string | null;
  readonly overdueSince: Date | null;
  readonly floatCeilingMinor: bigint | null;
  /** Derived `COLLECTOR_CASH` position, minor units (ADR 0031). */
  readonly balanceMinor: bigint;
  /** Sum of the collector's open intakes, minor units. */
  readonly openIntakeTotalMinor: bigint;
  /** When the oldest still-open intake was recorded; null when nothing is open. */
  readonly oldestOpenIntakeAt: Date | null;
  /** When this collector's most recent deposit arrived; null before the first. */
  readonly lastDepositAt: Date | null;
  /** How this tenant funds a wallet; prepaid changes what the numbers mean. */
  readonly model: "postpaid" | "prepaid";
  /**
   * How much more cash the collector may take right now, minor units.
   *
   * `max(0, limit - balance)`, where `limit` is the postpaid ceiling or the
   * prepaid grace. The phone shows this; the server checks the same number.
   */
  readonly availableMinor: bigint;
  /** The signed position an intake may reach: ceiling (postpaid) or grace. */
  readonly intakeLimitMinor: bigint;
  /** Prepaid only: the most credit the collector may hold; null under postpaid. */
  readonly maxBalanceMinor: bigint | null;
  /**
   * The collector's funding destination, when finance has provisioned one.
   * Under the prepaid model this is what "fund my wallet" shows (ADR 0069);
   * the account details are absent when the gateway issues only a page.
   */
  readonly depositInstruction: {
    readonly provider: string;
    readonly reference: string;
    readonly kind: "virtual_account" | "narration" | "virtual_terminal";
    readonly accountNumber?: string;
    readonly accountName?: string;
    readonly bank?: string;
    readonly pageUrl?: string;
    readonly currency?: string;
  } | null;
}

export interface CashWalletServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly now?: () => Date;
}

export class CashWalletService {
  constructor(private readonly deps: CashWalletServiceDeps) {}

  /** Freezes the wallet. Idempotent: freezing a frozen wallet changes nothing. */
  async freeze(input: CashWalletTransitionInput): Promise<CashWalletView> {
    return this.transition(input, "freeze");
  }

  /**
   * Unfreezes the wallet. Idempotent like `freeze`.
   *
   * Clears `overdue_since` as well: the reason the wallet was frozen is the
   * shortfall, and unfreezing is the decision to let the collector take cash
   * again. If the money is still out at the next sweep, the collector is
   * flagged again — a new deadline window, not a silent amnesty (ADR 0033).
   */
  async unfreeze(input: CashWalletTransitionInput): Promise<CashWalletView> {
    return this.transition(input, "unfreeze");
  }

  /**
   * Every wallet in the tenant with its derived position.
   *
   * The list is not paginated: a tenant has one wallet per collector, and the
   * supervisor view needs the whole set to answer "who is over the deadline".
   * The derived balance costs one aggregate per wallet, which is the same
   * query the detail view runs.
   */
  async list(tenantId: string): Promise<CashWalletView[]> {
    const rules = await this.rules(tenantId);
    return withTenant(this.deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const views: CashWalletView[] = [];
      for (const wallet of await repos.collectorCash.listWallets(tenantId)) {
        views.push(await this.view(repos, wallet, rules));
      }
      return views;
    });
  }

  /** The wallet and its derived position; `wallet_unknown` when absent. */
  async wallet(tenantId: string, collectorUserId: string): Promise<CashWalletView> {
    const rules = await this.rules(tenantId);
    return withTenant(this.deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const wallet = await repos.collectorCash.findWallet(tenantId, collectorUserId);
      if (wallet === undefined) {
        throw new CashError(
          "wallet_unknown",
          `no cash wallet exists for collector ${collectorUserId}`,
        );
      }
      return this.view(repos, wallet, rules);
    });
  }

  /** The tenant's cash rules, which decide what the derived numbers mean. */
  private async rules(tenantId: string): Promise<TenantCashRules> {
    const config = await this.deps.loadConfig(tenantId);
    if (config === undefined) {
      throw new Error(`No configuration found for tenant "${tenantId}"`);
    }
    return config.cashRules;
  }

  private async instruction(
    repos: Repositories,
    tenantId: string,
    collectorUserId: string,
  ): Promise<CashWalletView["depositInstruction"]> {
    const instruction = await repos.collectorCash.findActiveInstructionForCollector(
      tenantId,
      collectorUserId,
    );
    if (instruction === undefined) return null;
    const details = instructionDetails(instruction.details);
    return {
      provider: instruction.provider,
      reference: instruction.reference,
      kind: instruction.kind,
      ...details,
    };
  }

  private async transition(
    input: CashWalletTransitionInput,
    transition: CashWalletTransition,
  ): Promise<CashWalletView> {
    const permission: Permission = transition === "freeze" ? "cash:freeze" : "cash:unfreeze";
    assertCashPermission(input.actor, input.tenantId, permission);
    const reason = input.reason.trim();
    if (reason === "") {
      throw new CashError(
        "reason_required",
        `a reason is required to ${transition} a collector wallet`,
      );
    }
    const rules = await this.rules(input.tenantId);

    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const current = await repos.collectorCash.lockWallet(input.tenantId, input.collectorUserId);
      const next = transitionWallet(
        { status: current.status, frozenReason: current.frozenReason },
        transition,
        reason,
      );

      // Nothing changed: a double click is answered with the current state and
      // must not append a second audit entry that says it did.
      if (next.status === current.status) {
        return this.view(repos, current, rules);
      }

      await repos.collectorCash.setWalletStatus(input.tenantId, input.collectorUserId, {
        status: next.status,
        frozenReason: next.frozenReason,
      });
      if (transition === "unfreeze") {
        await repos.collectorCash.clearOverdue(input.tenantId, input.collectorUserId);
      }
      await repos.audit.record({
        tenantId: input.tenantId,
        actorUserId: actorUserIdOf(input.actor),
        action: transition === "freeze" ? "cash.wallet.frozen" : "cash.wallet.unfrozen",
        entityType: "collector_wallet",
        entityId: current.id,
        before: { status: current.status, frozenReason: current.frozenReason },
        after: {
          status: next.status,
          reason,
          collectorUserId: input.collectorUserId,
          ...(isSystemActor(input.actor) ? { actor: "cash-deadline-sweeper" } : {}),
        },
      });

      const updated = await repos.collectorCash.findWallet(input.tenantId, input.collectorUserId);
      return this.view(repos, updated ?? current, rules);
    });
  }

  private async view(
    repos: Repositories,
    wallet: CollectorWalletRow,
    rules: TenantCashRules,
  ): Promise<CashWalletView> {
    const model = cashModelOf(rules);
    const balanceMinor = await repos.ledger.collectorCashBalance(
      wallet.tenantId,
      wallet.collectorUserId,
    );
    // Postpaid caps the cash the collector may hold; prepaid caps how far an
    // intake may cross zero. Either way the phone sees one "available" number.
    const limitMinor =
      model === "prepaid"
        ? BigInt(rules.intakeGuard === "grace" ? (rules.graceMinor ?? 0) : 0)
        : (wallet.floatCeilingMinor ?? BigInt(rules.floatCeilingMinor));
    const availableMinor = balanceMinor >= limitMinor ? 0n : limitMinor - balanceMinor;
    return {
      tenantId: wallet.tenantId,
      collectorUserId: wallet.collectorUserId,
      status: wallet.status,
      frozenAt: wallet.frozenAt,
      frozenReason: wallet.frozenReason,
      overdueSince: wallet.overdueSince,
      floatCeilingMinor: wallet.floatCeilingMinor,
      balanceMinor,
      model,
      availableMinor,
      intakeLimitMinor: limitMinor,
      maxBalanceMinor: model === "prepaid" ? BigInt(maxBalanceMinorOf(rules)) : null,
      openIntakeTotalMinor: await repos.collectorCash.sumOpenIntakes(
        wallet.tenantId,
        wallet.collectorUserId,
      ),
      oldestOpenIntakeAt: await repos.collectorCash.oldestOpenIntakeAt(
        wallet.tenantId,
        wallet.collectorUserId,
      ),
      lastDepositAt: await repos.collectorCash.lastDepositAt(
        wallet.tenantId,
        wallet.collectorUserId,
      ),
      depositInstruction: await this.instruction(repos, wallet.tenantId, wallet.collectorUserId),
    };
  }
}

/** The display fields stored on a terminal instruction; absent is normal. */
function instructionDetails(value: unknown): {
  accountNumber?: string;
  accountName?: string;
  bank?: string;
  pageUrl?: string;
  currency?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
  };
  const accountNumber = pick("accountNumber");
  const accountName = pick("accountName");
  const bank = pick("bank");
  const pageUrl = pick("pageUrl");
  const currency = pick("currency");
  return {
    ...(accountNumber === undefined ? {} : { accountNumber }),
    ...(accountName === undefined ? {} : { accountName }),
    ...(bank === undefined ? {} : { bank }),
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(currency === undefined ? {} : { currency }),
  };
}

export function createCashWalletService(deps: CashWalletServiceDeps): CashWalletService {
  return new CashWalletService(deps);
}

function isSystemActor(actor: CashActor): actor is { readonly kind: "system" } {
  return "kind" in actor;
}

function actorUserIdOf(actor: CashActor): string | null {
  return isSystemActor(actor) ? null : actor.userId;
}

/**
 * Fails closed. A person may only act inside their own tenant, and only with
 * the permission the transition requires; the sweeper acts as `system`.
 */
function assertCashPermission(actor: CashActor, tenantId: string, permission: Permission): void {
  if (isSystemActor(actor)) return;
  if (actor.tenantId !== tenantId) {
    throw new ForbiddenError(`Cannot change a wallet in another tenant`, permission);
  }
  if (!actor.permissions.includes(permission)) {
    throw new ForbiddenError(`Missing permission "${permission}"`, permission);
  }
}
