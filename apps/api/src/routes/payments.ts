import type { FastifyInstance } from "fastify";
import { PaymentError } from "@tpirs/application";
import type { Services } from "../services.js";
import { errorEnvelope } from "../errors.js";
import { UnauthorizedError } from "../auth.js";

function requireFinance(request: unknown) {
  const req = request as { user?: { permissions?: readonly string[] } };
  const user = req.user;
  if (user === undefined) {
    throw new UnauthorizedError();
  }
  const permissions = user.permissions ?? [];
  if (!permissions.includes("payments:read") && !permissions.includes("payments:resolve")) {
    throw Object.assign(new Error("Forbidden"), { name: "ForbiddenError" });
  }
}

function toPaymentJson(payment: {
  id: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  provider: string;
  providerReference: string | null;
  assetId: string | null;
  attributionKind: string | null;
  businessDate: string | null;
  receiptNumber: string | null;
  failureReason: string | null;
  createdAt: Date;
}) {
  // Dashboard never re-renders money: serialize bigint amounts as strings.
  return {
    id: payment.id,
    status: payment.status,
    amountMinor: payment.amountMinor.toString(),
    currency: payment.currency,
    provider: payment.provider,
    providerReference: payment.providerReference,
    assetId: payment.assetId,
    attributionKind: payment.attributionKind,
    businessDate: payment.businessDate,
    receiptNumber: payment.receiptNumber,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt.toISOString(),
  };
}

/**
 * Finance views: payments, suspense, and resolution.
 */
export function registerPaymentRoutes(
  app: FastifyInstance,
  context: { readonly services: Services },
): void {
  const { services } = context;

  app.get("/v1/payments", async (request, reply) => {
    requireFinance(request);
    const query = request.query as { status?: string; limit?: string };
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const payments = await services.payment.listPayments({
      tenantId,
      ...(query.status === undefined ? {} : { status: query.status as never }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return reply.send({ payments: payments.map((p) => toPaymentJson(p)) });
  });

  app.get("/v1/payments/suspense", async (request, reply) => {
    requireFinance(request);
    const query = request.query as { limit?: string };
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const payments = await services.payment.listSuspense({
      tenantId,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return reply.send({ payments: payments.map((p) => toPaymentJson(p)) });
  });

  app.get("/v1/payments/:id/outbox", async (request, reply) => {
    requireFinance(request);
    const { id } = request.params as { id: string };
    const messages = await services.payment.listOutbox({
      tenantId: (request as unknown as { tenantId: string }).tenantId,
      paymentId: id,
    });
    return reply.send({
      messages: messages.map((m) => ({
        id: m.id,
        kind: m.kind,
        recipient: m.recipient,
        body: m.body,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  });

  app.post("/v1/payments/:id/resolve", async (request, reply) => {
    requireFinance(request);
    const { id } = request.params as { id: string };
    const body = request.body as { assetId?: string } | undefined;
    if (body?.assetId === undefined) {
      return reply.code(400).send(errorEnvelope("bad_request", "assetId is required", request.id));
    }
    try {
      const user = (request as unknown as { user: { id: string } }).user;
      const payment = await services.payment.resolveSuspense({
        tenantId: (request as unknown as { tenantId: string }).tenantId,
        paymentId: id,
        assetId: body.assetId,
        approvedByUserId: user.id,
      });
      return await Promise.resolve(reply.send({ payment: toPaymentJson(payment) }));
    } catch (error) {
      if (error instanceof PaymentError) {
        return reply.code(400).send(errorEnvelope("bad_request", error.message, request.id));
      }
      throw error;
    }
  });
}
