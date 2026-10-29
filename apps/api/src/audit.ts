import type { FastifyReply, FastifyRequest } from "fastify";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";

export interface AuditDescriptor {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

declare module "fastify" {
  interface FastifyRequest {
    audit?: AuditDescriptor;
  }
}

/**
 * Records an audit entry for every state-changing request that succeeds. The
 * route handler declares what to record via `request.audit`; the hook writes it
 * once, after the status is known to be a success, inside the actor's tenant
 * scope so row-level security applies to the write too.
 *
 * This runs in `onSend`, before the response leaves the server, not in
 * `onResponse`: the trail must exist by the time the caller can act on the
 * success. Writing after the response made a successful mutation briefly
 * unaudited, which a test that reads the log right after the call can observe.
 */
export function auditOnSuccess(db: AnyDb) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> => {
    const descriptor = request.audit;
    if (descriptor === undefined) return payload;
    if (request.method === "GET" || request.method === "HEAD") return payload;
    if (reply.statusCode >= 400) return payload;

    const actor = request.principal;
    const tenantId = actor?.tenantId;
    if (tenantId === undefined) {
      request.log.warn({ action: descriptor.action }, "audit skipped: no tenant context");
      return payload;
    }

    await withTenant(db, tenantId, async (tx) => {
      await repositories(tx).audit.record({
        tenantId,
        actorUserId: actor?.userId ?? null,
        action: descriptor.action,
        entityType: descriptor.entityType,
        entityId: descriptor.entityId ?? null,
        before: descriptor.before,
        after: descriptor.after,
        requestId: request.id,
        ip: request.ip,
      });
    });
    return payload;
  };
}
