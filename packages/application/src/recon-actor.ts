import { assertPermission, ForbiddenError } from "@tpirs/domain";
import type { Permission, Principal } from "@tpirs/domain";

/**
 * Who is acting in a reconciliation flow.
 *
 * `system` is the nightly worker: it has no user row and is trusted by
 * construction, like the cash deadline sweeper. Every human actor is a
 * `Principal` and must hold the permission themselves.
 */
export type ReconActor = Principal | { readonly kind: "system" };

/** True for the system worker, which bypasses permission checks. */
function isSystem(actor: ReconActor): actor is { readonly kind: "system" } {
  return !("userId" in actor);
}

/** Throws for a human actor missing the permission; the worker always passes. */
export function requireReconPermission(
  actor: ReconActor,
  tenantId: string,
  permission: Permission,
): void {
  if (isSystem(actor)) return;
  if (actor.tenantId !== tenantId) {
    throw new ForbiddenError(
      `Actor belongs to tenant "${actor.tenantId}", not "${tenantId}"`,
      permission,
    );
  }
  assertPermission(actor, permission);
}

/** The audit Attribution for the actor: a user id, or null for the worker. */
export function reconActorUserId(actor: ReconActor): string | null {
  return isSystem(actor) ? null : actor.userId;
}
