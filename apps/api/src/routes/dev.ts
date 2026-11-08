import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requirePrincipal } from "../auth.js";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";

/**
 * Local-development helpers, never registered in production.
 *
 * Paystack's Test Mode cannot issue a Virtual Terminal NUBAN
 * (`titan-paystack is not available in test mode`), so the funded-wallet flow
 * cannot be driven end to end by a real transfer before the business is live.
 * This route credits the signed-in collector's own wallet through the ordinary
 * deposit path, which is what the browser's "Simulate top-up" button calls.
 *
 * It is not an admin back door: it is only mounted when `NODE_ENV` is not
 * `production`, and it can only credit the caller's own destination.
 */
export function registerDevRoutes(
  app: FastifyInstance,
  context: { readonly services: Services; readonly enabled: boolean },
): void {
  if (!context.enabled) return;
  const { services } = context;

  app.post<{ Body: { amountMinor?: string } }>(
    "/v1/dev/collector-topup",
    {
      schema: {
        // A development affordance belongs in neither the printed contract nor
        // the generated client.
        hide: true,
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const amountMinor = Number(request.body.amountMinor ?? "");
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        return reply
          .code(400)
          .send(
            errorEnvelope("bad_request", "amountMinor must be positive minor units", request.id),
          );
      }

      const config = await services.collectorCash.requireConfig(principal.tenantId);
      const wallet = await services.collectorCash.wallet(principal.tenantId, principal.userId);
      const destination = wallet.depositInstruction;
      if (destination === null) {
        return reply
          .code(409)
          .send(
            errorEnvelope(
              "deposit_unknown",
              "no active funding destination; provision one first",
              request.id,
            ),
          );
      }

      const stamp = randomUUID();
      const result = await services.collectorCash.ingestDeposit({
        tenantId: principal.tenantId,
        config,
        provider: destination.provider,
        event: {
          providerEventId: `dev-topup-${stamp}`,
          providerReference: `T-DEV-${stamp.slice(0, 8).toUpperCase()}`,
          attributionKey: destination.reference,
          amount: { currency: config.locale.currency, amount: amountMinor },
          status: "success",
        },
      });
      const after = await services.collectorCash.wallet(principal.tenantId, principal.userId);
      return await Promise.resolve(
        reply.send({
          outcome: result?.outcome ?? "ignored",
          depositId: result?.depositId ?? null,
          balanceMinor: after.balanceMinor.toString(),
          availableMinor: after.availableMinor.toString(),
        }),
      );
    },
  );
}
