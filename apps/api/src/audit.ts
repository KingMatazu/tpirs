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
 * once, after the response is known to be a success, inside the actor's tenant
 * scope so row-level security applies to the write too.
 */
export function auditOnSuccess(db: AnyDb) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const descriptor = request.audit;
    if (descriptor === undefined) return;
    if (request.method === "GET" || request.method === "HEAD") return;
    if (reply.statusCode >= 400) return;

    const actor = request.principal;
    const tenantId = actor?.tenantId;
    if (tenantId === undefined) {
      request.log.warn({ action: descriptor.action }, "audit skipped: no tenant context");
      return;
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
  };
}
