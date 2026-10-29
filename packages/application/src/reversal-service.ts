import type { AnyDb, ReversalRequestRow } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { Principal } from "@tpirs/domain";
import { LedgerOperationError, LedgerService } from "./ledger-service.js";

/**
 * Reversal requests and their dual approval (ADR 0013).
 *
 * A reversal is never an edit: a finance user requests it with a reason, and a
 * *different* finance user approves it, which posts mirrored entries in one
 * transaction. This service exposes the queue to the dashboard and keeps the
 * "requester ≠ approver" rule in the ledger service where it already lives.
 */

export interface ReversalApproval {
  readonly request: ReversalRequestRow | undefined;
  readonly transactionId: string;
}

export class ReversalService {
  constructor(private readonly deps: { readonly db: AnyDb }) {}

  async list(
    tenantId: string,
    filter: {
      readonly status?: "pending" | "approved" | "rejected";
      readonly limit?: number;
    } = {},
  ): Promise<ReversalRequestRow[]> {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).reversals.list(tenantId, filter),
    );
  }

  async approve(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly approver: Principal;
  }): Promise<ReversalApproval> {
    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const ledger = new LedgerService(tx);
      const posted = await ledger.approveReversal(input.tenantId, {
        reversalRequestId: input.id,
        approverUserId: input.approver.userId,
        isSystemAdmin: input.approver.roles.includes("system_admin"),
        // Reaching this route already required `ledger:approve`.
        hasFinanceApproval: true,
      });
      return {
        request: await repositories(tx).reversals.findById(input.tenantId, input.id),
        transactionId: posted.transaction.id,
      };
    });
  }

  async reject(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly actor: Principal;
    readonly reason: string;
  }): Promise<ReversalRequestRow> {
    const reason = input.reason.trim();
    if (reason === "") {
      throw new LedgerOperationError("a rejection reason is required", "ledger_operation");
    }
    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const ledger = new LedgerService(tx);
      return ledger.rejectReversal(input.tenantId, {
        reversalRequestId: input.id,
        rejectedByUserId: input.actor.userId,
        isSystemAdmin: input.actor.roles.includes("system_admin"),
      });
    });
  }
}
