import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, ZoneRecord } from "@tpirs/db";
import { requirePermission } from "../auth.js";
import { createZoneSchema, listZonesSchema, renameZoneSchema } from "../schemas.js";

/**
 * Zone management (Phase 11, Step 8).
 *
 * Zones are the tenant's own geography — parks, markets, districts — and the
 * hierarchy the registry, reports and collector views group by. They are pure
 * tenant data, so every route is scoped to the caller's tenant and guarded by
 * `zone:read` / `zone:manage`. Nothing here is levy-specific: a tenant that
 * never opens this screen works with an empty list (an asset needs no zone).
 *
 * Editing is deliberately small: create a zone (optionally inside a parent) and
 * rename it. A zone is never deleted, because historical payments, scans and
 * audits reference it; retiring one is a rename ("North (retired)") or a
 * future `archivedAt`, not a delete that would orphan those rows.
 */
export interface ZoneRoutesContext {
  readonly db: AnyDb;
}

function toZoneJson(zone: ZoneRecord): {
  id: string;
  parentZoneId: string | null;
  name: string;
} {
  return { id: zone.id, parentZoneId: zone.parentZoneId, name: zone.name };
}

function badRequest(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "bad_request", message, requestId: request.id } });
}

function notFound(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: { code: "not_found", message, requestId: request.id } });
}

function conflict(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(409).send({ error: { code: "conflict", message, requestId: request.id } });
}

/**
 * The table's `unique (tenant_id, parent_zone_id, name)` is the authority on
 * duplicates — a pre-check would race with a concurrent create. Translating the
 * constraint violation is the only reliable way to answer `409` instead of a
 * `500` that echoes SQL.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

export function registerZoneRoutes(app: FastifyInstance, context: ZoneRoutesContext): void {
  app.get("/v1/zones", { schema: listZonesSchema }, async (request, reply) => {
    const principal = requirePermission(request, "zone:read");
    const zones = await withTenant(context.db, principal.tenantId, (tx) =>
      repositories(tx).zones.list(),
    );
    return reply.send({ zones: zones.map(toZoneJson) });
  });

  app.post("/v1/zones", { schema: createZoneSchema }, async (request, reply) => {
    const principal = requirePermission(request, "zone:manage");
    const body = request.body as { name: string; parentZoneId?: string };
    const name = body.name.trim();
    if (name === "") return badRequest(request, reply, "A zone name is required");
    const parentZoneId = body.parentZoneId ?? null;

    if (parentZoneId !== null) {
      const parent = await withTenant(context.db, principal.tenantId, (tx) =>
        repositories(tx).zones.findById(parentZoneId),
      );
      if (parent === undefined) {
        return notFound(request, reply, "Parent zone not found");
      }
    }

    try {
      const zone = await withTenant(context.db, principal.tenantId, (tx) =>
        repositories(tx).zones.create({ tenantId: principal.tenantId, parentZoneId, name }),
      );
      request.audit = {
        action: "zone.create",
        entityType: "zone",
        entityId: zone.id,
        after: toZoneJson(zone),
      };
      return await reply.code(201).send({ zone: toZoneJson(zone) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return conflict(request, reply, "A zone with that name already exists here");
      }
      throw error;
    }
  });

  app.patch("/v1/zones/:id", { schema: renameZoneSchema }, async (request, reply) => {
    const principal = requirePermission(request, "zone:manage");
    const { id } = request.params as { id: string };
    const body = request.body as { name: string };
    const name = body.name.trim();
    if (name === "") return badRequest(request, reply, "A zone name is required");

    const before = await withTenant(context.db, principal.tenantId, (tx) =>
      repositories(tx).zones.findById(id),
    );
    if (before === undefined) return notFound(request, reply, "Zone not found");

    try {
      const zone = await withTenant(context.db, principal.tenantId, (tx) =>
        repositories(tx).zones.rename(id, name),
      );
      if (zone === undefined) return await notFound(request, reply, "Zone not found");
      request.audit = {
        action: "zone.rename",
        entityType: "zone",
        entityId: zone.id,
        before: toZoneJson(before),
        after: toZoneJson(zone),
      };
      return await reply.send({ zone: toZoneJson(zone) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return conflict(request, reply, "A zone with that name already exists here");
      }
      throw error;
    }
  });
}
