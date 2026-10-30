import type { FastifyInstance } from "fastify";
import { TenantConfigValidationError, validateTenantConfig } from "@tpirs/config";
import { withTenant } from "@tpirs/db";
import { repositories } from "@tpirs/db";
import { requirePermission, requirePrincipal } from "../auth.js";
import { readTenantConfig } from "../tenants.js";
import type { AuthContext } from "../auth.js";
import { tenantConfigPutSchema } from "../schemas.js";

function serializeIssues(error: TenantConfigValidationError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

export function registerConfigRoutes(app: FastifyInstance, context: AuthContext): void {
  /**
   * The subset of tenant config the dashboard shell needs to render: name,
   * branding and locale. Every signed-in staff member needs it — an officer sees
   * the tenant's name, colours and languages — but `tenant:read` guards the full
   * config (providers, cash rules, reconciliation tolerances), which only
   * finance and administrators need. Without this projection every non-admin
   * role saw "missing permission tenant:read" on sign-in.
   */
  app.get("/v1/tenants/current/branding", async (request, reply) => {
    const principal = requirePrincipal(request);
    const current = await readTenantConfig(context.db, principal.tenantId);
    if (current === undefined) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Tenant not found", requestId: request.id } });
    }
    // The stored config is validated on write; validating again here keeps the
    // projection typed and fails loudly (500) rather than half-rendering a shell.
    const { identity, branding, locale } = validateTenantConfig(current.config);
    return reply.send({
      identity: { name: identity.name, slug: identity.slug },
      branding,
      locale,
    });
  });
  app.get("/v1/tenants/current/config", async (request, reply) => {
    const principal = requirePermission(request, "tenant:read");
    const current = await readTenantConfig(context.db, principal.tenantId);
    if (current === undefined) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Tenant not found", requestId: request.id } });
    }
    return reply.send({ config: current.config, version: current.version });
  });

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
