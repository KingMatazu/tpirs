import type { FastifyInstance } from "fastify";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { requirePermission } from "../auth.js";
import { listAuditSchema, parseAuditCursor } from "../schemas.js";

/**
 * Read-only listing of the append-only audit trail (UI track Step 6). Rows are
 * tenant-scoped by the principal and row-level security; the repository offers
 * no update or delete, and the database rejects them anyway, so this screen
 * cannot mutate anything by construction.
 */
export function registerAuditRoutes(app: FastifyInstance, context: { readonly db: AnyDb }): void {
  app.get("/v1/audit", { schema: listAuditSchema }, async (request, reply) => {
    const principal = requirePermission(request, "audit:read");
    const query = request.query as {
      limit?: string;
      cursor?: string;
      action?: string;
      kind?: string;
      actor?: string;
      from?: string;
      to?: string;
    };

    const limitRaw = query.limit === undefined ? undefined : Number(query.limit);
    const limit =
      limitRaw === undefined || Number.isNaN(limitRaw)
        ? 50
        : Math.min(Math.max(Math.trunc(limitRaw), 1), 200);
    const cursor = parseAuditCursor(query.cursor);
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);
    if (
      (from !== undefined && Number.isNaN(from.getTime())) ||
      (to !== undefined && Number.isNaN(to.getTime()))
    ) {
      return reply.code(400).send({
        error: { code: "bad_request", message: "from/to must be ISO dates", requestId: request.id },
      });
    }

    const entries = await withTenant(context.db, principal.tenantId, (tx) =>
      repositories(tx).audit.list({
        ...(query.action === undefined || query.action === "" ? {} : { action: query.action }),
        ...(query.kind === undefined || query.kind === "" ? {} : { kind: query.kind }),
        ...(query.actor === undefined || query.actor === "" ? {} : { actorUserId: query.actor }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
    );

    const last = entries[entries.length - 1];
    const nextCursor =
      last === undefined || entries.length < limit
        ? null
        : `${last.createdAt.toISOString()}|${last.id}`;

    return reply.send({
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        actorUserId: entry.actorUserId,
        before: entry.beforeData,
        after: entry.afterData,
        requestId: entry.requestId,
        ip: entry.ip,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor,
    });
  });
}
