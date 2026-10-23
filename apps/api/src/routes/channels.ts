import type { FastifyInstance } from "fastify";
import { PortError } from "@tpirs/ports";
import { resolveWebhookEndpoint } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantChannelAdapters } from "@tpirs/channel-providers";
import type { TenantConfig } from "@tpirs/config";
import type { TenantConfigLoader } from "@tpirs/application";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";

/**
 * USSD and inbound-SMS provider callbacks.
 *
 * Tenancy is resolved exactly as for payment webhooks (ADR 0017, D22): the
 * per-tenant endpoint token in the URL is hashed and looked up through a
 * `SECURITY DEFINER` function, so the tenant is known before any tenant data is
 * read. An unknown token, a revoked token, and an adapter the tenant has not
 * enabled all answer identically, so a caller cannot probe which adapters or
 * tenants exist.
 *
 * The adapter key in the URL must equal the tenant's configured adapter for
 * that port. That is what stops a callback addressed to an adapter the tenant
 * never opted into from being processed by it.
 */

interface ResolvedChannel {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly adapters: TenantChannelAdapters;
}

function notFound(request: { id: unknown }) {
  return errorEnvelope("not_found", "Webhook endpoint not found", String(request.id));
}

function headerRecord(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(raw)) headers[key] = value;
  return headers;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function isBadRequest(error: unknown): error is PortError {
  return error instanceof PortError && error.code === "invalid_request";
}

export function registerChannelRoutes(
  app: FastifyInstance,
  context: {
    readonly services: Services;
    readonly db: AnyDb;
    readonly loadConfig: TenantConfigLoader;
  },
): void {
  const { services, db, loadConfig } = context;

  async function resolve(
    provider: string,
    endpointToken: string,
  ): Promise<ResolvedChannel | undefined> {
    const tenantId = await resolveWebhookEndpoint(db, provider, endpointToken);
    if (tenantId === undefined) return undefined;
    const config = await loadConfig(tenantId);
    if (config === undefined) return undefined;
    const adapters = await services.channelProviders.forTenant(config);
    return { tenantId, config, adapters };
  }

  app.post(
    "/webhooks/ussd/:provider/:endpointToken",
    { schema: { hide: true } },
    async (request, reply) => {
      const { provider, endpointToken } = request.params as {
        provider: string;
        endpointToken: string;
      };
      const resolved = await resolve(provider, endpointToken);
      if (resolved === undefined) return reply.code(404).send(notFound(request));
      const binding = resolved.adapters.ussd;
      if (binding?.adapter !== provider) {
        return reply.code(404).send(notFound(request));
      }

      try {
        const rendered = await services.ussd.handle({
          tenantId: resolved.tenantId,
          config: resolved.config,
          provider: binding.provider,
          body: bodyRecord(request.body),
          headers: headerRecord(request.headers),
          clientIp: request.ip,
        });
        return await reply
          .code(rendered.statusCode)
          .header("content-type", rendered.contentType)
          .send(rendered.body);
      } catch (error) {
        if (isBadRequest(error)) {
          return reply
            .code(400)
            .send(errorEnvelope("bad_request", "Malformed provider callback", request.id));
        }
        throw error;
      }
    },
  );

  app.post(
    "/webhooks/sms/:provider/:endpointToken",
    { schema: { hide: true } },
    async (request, reply) => {
      const { provider, endpointToken } = request.params as {
        provider: string;
        endpointToken: string;
      };
      const resolved = await resolve(provider, endpointToken);
      if (resolved === undefined) return reply.code(404).send(notFound(request));
      const binding = resolved.adapters.sms;
      if (binding?.adapter !== provider) {
        return reply.code(404).send(notFound(request));
      }

      try {
        const result = await services.inboundSms.handle({
          tenantId: resolved.tenantId,
          config: resolved.config,
          provider: binding.provider,
          body: bodyRecord(request.body),
          headers: headerRecord(request.headers),
        });
        // Always 200 for a parsed callback, including duplicates and suppressed
        // replies: a provider retrying an event nobody accepted would only
        // repeat the same work.
        return await reply.code(200).send({
          accepted: true,
          outcome: result.outcome,
          enqueued: result.enqueued,
        });
      } catch (error) {
        if (isBadRequest(error)) {
          return reply
            .code(400)
            .send(errorEnvelope("bad_request", "Malformed provider callback", request.id));
        }
        throw error;
      }
    },
  );
}
