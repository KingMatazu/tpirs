import type { FastifyInstance } from "fastify";
import { TenantConfigValidationError, validateTenantConfig } from "@tpirs/config";
import { withTenant } from "@tpirs/db";
import { repositories } from "@tpirs/db";
import { requirePermission, requirePrincipal } from "../auth.js";
import { readTenantConfig } from "../tenants.js";
import type { AuthContext } from "../auth.js";
import { tenantConfigPutSchema, tenantIdentityPatchSchema } from "../schemas.js";

function serializeIssues(error: TenantConfigValidationError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Copies a key only when the patch actually carries it, so "absent" stays absent. */
function patch<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function registerConfigRoutes(app: FastifyInstance, context: AuthContext): void {
  /**
   * Readable by any authenticated staff member: the dashboard needs the tenant's
   * name, branding, locale, asset schemas and cash/reconciliation rules to render
   * every screen, and only system admins and auditors hold `tenant:read`. The
   * config holds references to secrets, never secret values, and it is
   * tenant-scoped by the principal. Writing it still needs `tenant:configure`.
   */
  app.get("/v1/tenants/current/config", async (request, reply) => {
    const principal = requirePrincipal(request);
    const current = await readTenantConfig(context.db, principal.tenantId);
    if (current === undefined) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Tenant not found", requestId: request.id } });
    }
    return reply.send({ config: current.config, version: current.version });
  });

  /**
   * The state's own details: logo, support contacts, legal entity, app name and
   * brand colours. System-admin only (`tenant:configure`), audited with the full
   * before/after, and every save bumps the config version.
   *
   * The merge happens on the **stored** document rather than on a re-serialized
   * config, so a field this screen does not show (fees, providers, channels) is
   * carried through untouched, and a configuration written by an older release
   * keeps whatever it had. The merged document is then validated by the same
   * rules as a full PUT, so a partial edit cannot produce an invalid config.
   */
  app.patch(
    "/v1/tenants/current/identity",
    { schema: tenantIdentityPatchSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "tenant:configure");
      const body = asRecord(request.body);
      if (body === undefined) {
        return reply.code(400).send({
          error: { code: "bad_request", message: "A JSON body is required", requestId: request.id },
        });
      }

      const before = await readTenantConfig(context.db, principal.tenantId);
      if (before === undefined) {
        return reply
          .code(404)
          .send({
            error: { code: "not_found", message: "Tenant not found", requestId: request.id },
          });
      }

      const stored = asRecord(before.config);
      if (stored === undefined) {
        return reply.code(409).send({
          error: {
            code: "conflict",
            message: "The stored configuration is not an object and cannot be edited",
            requestId: request.id,
          },
        });
      }

      const identity = asRecord(stored.identity) ?? {};
      const contacts = asRecord(identity.supportContacts) ?? {};
      const branding = asRecord(stored.branding) ?? {};
      const colors = asRecord(body.colors);
      const stateName = asString(identity.name);

      const merged = {
        ...stored,
        identity: {
          ...identity,
          ...patch(asString(body.legalEntity), "legalEntity"),
          supportContacts: {
            ...contacts,
            ...patch(asString(body.supportEmail), "email"),
            ...patch(asString(body.supportPhone), "phone"),
          },
        },
        branding: {
          ...branding,
          ...patch(asString(body.appName), "appName"),
          ...patch(asString(body.logoUrl), "logoUrl"),
          ...(colors === undefined ? {} : { colors }),
          // The receipt header is the state's name, not a separate choice: a
          // receipt that greets the driver with a stale name is a support call.
          ...(stateName === undefined ? {} : { receiptHeader: stateName }),
        },
      };

      let config;
      try {
        config = validateTenantConfig(merged);
      } catch (error) {
        if (error instanceof TenantConfigValidationError) {
          return reply.code(422).send({
            error: {
              code: "unprocessable_entity",
              message: "Invalid tenant configuration",
              requestId: request.id,
              issues: serializeIssues(error),
            },
          });
        }
        throw error;
      }

      const updated = await withTenant(context.db, principal.tenantId, async (tx) =>
        repositories(tx).tenants.updateIdentity(principal.tenantId, {
          config,
          legalEntity: config.identity.legalEntity,
        }),
      );

      request.audit = {
        action: "tenant.identity.update",
        entityType: "tenant",
        entityId: principal.tenantId,
        before: before.config,
        after: config,
      };

      return reply.send({ config: updated.config, version: updated.configVersion });
    },
  );

  app.put(
    "/v1/tenants/current/config",
    { schema: tenantConfigPutSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "tenant:configure");

      let config;
      try {
        config = validateTenantConfig(request.body);
      } catch (error) {
        if (error instanceof TenantConfigValidationError) {
          return reply.code(422).send({
            error: {
              code: "unprocessable_entity",
              message: "Invalid tenant configuration",
              requestId: request.id,
              issues: serializeIssues(error),
            },
          });
        }
        throw error;
      }

      const before = await readTenantConfig(context.db, principal.tenantId);
      const updated = await withTenant(context.db, principal.tenantId, async (tx) =>
        repositories(tx).tenants.updateConfig(principal.tenantId, config),
      );

      request.audit = {
        action: "tenant.config.update",
        entityType: "tenant",
        entityId: principal.tenantId,
        before: before?.config,
        after: config,
      };

      return reply.send({ config: updated.config, version: updated.configVersion });
    },
  );
}
