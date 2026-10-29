import type { Principal } from "@tpirs/domain";
import type { ReconciliationExceptionRow } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { requireReconPermission } from "./recon-actor.js";

/** Why an exception transition was refused; routes map these to HTTP. */
export type ExceptionErrorCode = "note_required" | "exception_not_found";

export class ExceptionError extends Error {
  readonly code: ExceptionErrorCode;

  constructor(code: ExceptionErrorCode, message: string) {
    super(message);
    this.name = "ExceptionError";
    this.code = code;
  }
}

/**
 * Working the exception queue (D43).
 *
 * An exception resolves into `resolved` (the condition is fixed) or `waived`
 * (accepted as harmless). Both need `reconciliation:run`, a note, and an
 * audit entry — the same gate the auditor is deliberately kept out of.
 */
export class ExceptionService {
  constructor(private readonly deps: { readonly db: AnyDb; readonly now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async list(
    tenantId: string,
    filter: {
      readonly status?: "open" | "resolved" | "waived";
      readonly severity?: "blocking" | "warning" | "info";
      readonly runId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<ReconciliationExceptionRow[]> {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).exceptions.list(tenantId, filter),
    );
  }

  private async transition(
    tenantId: string,
    id: string,
    actor: Principal,
    status: "resolved" | "waived",
    note: string,
  ): Promise<ReconciliationExceptionRow> {
    requireReconPermission(actor, tenantId, "reconciliation:run");
    const trimmed = note.trim();
    if (trimmed === "") {
      throw new ExceptionError(
        "note_required",
        `an exception must not be ${status} without a note`,
      );
    }
    return withTenant(this.deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const updated = await repos.exceptions.resolve(tenantId, id, {
        status,
        note: trimmed,
        resolvedByUserId: actor.userId,
        resolvedAt: this.now(),
      });
      if (updated === undefined) {
        throw new ExceptionError("exception_not_found", "exception not found or not open");
      }
      await repos.audit.record({
        tenantId,
        actorUserId: actor.userId,
        action:
          status === "resolved"
            ? "reconciliation.exception.resolved"
            : "reconciliation.exception.waived",
        entityType: "reconciliation_exception",
        entityId: id,
        after: { note: trimmed },
      });
      return updated;
    });
  }

  resolve(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly actor: Principal;
    readonly note: string;
  }): Promise<ReconciliationExceptionRow> {
    return this.transition(input.tenantId, input.id, input.actor, "resolved", input.note);
  }

  waive(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly actor: Principal;
    readonly note: string;
  }): Promise<ReconciliationExceptionRow> {
    return this.transition(input.tenantId, input.id, input.actor, "waived", input.note);
  }
}
