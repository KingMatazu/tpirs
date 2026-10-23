import type { FastifyInstance } from "fastify";
import { PaymentError } from "@tpirs/application";
import type { Services } from "../services.js";
import { errorEnvelope } from "../errors.js";

/**
 * Tokenised webhook intake (ADR 0017). The token is a per-endpoint secret in the
 * URL; the application role cannot read it from `webhook_endpoints`, so the
 * payment service resolves it via a `SECURITY DEFINER` function. The raw body is
 * captured before JSON parsing so the provider's signature can be verified byte
 * for byte.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  context: { readonly services: Services },
): void {
  const { services } = context;

  app.post(
    "/webhooks/:provider/:endpointToken",
    {
      config: {
        // The route handler reads `request.rawBody` (set by a preParsing hook).
        rawBody: true,
      },
    },
    async (request, reply) => {
      const { provider, endpointToken } = request.params as {
        provider: string;
        endpointToken: string;
      };
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }

      try {
        const result = await services.payment.ingestWebhookEvent({
          provider,
          endpointToken,
          headers,
          rawBody,
        });
        if (result.accepted) {
          // Always return 200 for handled deliveries (including duplicates) so a
          // misbehaving gateway never treats a healthy endpoint as failing.
          return await Promise.resolve(
            reply.code(200).send({ accepted: true, outcome: result.outcome }),
          );
        }
        // A bad signature must not be "accepted", but we still return a generic
        // response shape to avoid leaking which detail failed.
        return await Promise.resolve(reply.code(400).send({ accepted: false }));
      } catch (error) {
        if (error instanceof PaymentError) {
          return await Promise.resolve(
            reply.code(400).send(errorEnvelope("bad_request", error.message, request.id)),
          );
        }
        throw error;
      }
    },
  );
}
