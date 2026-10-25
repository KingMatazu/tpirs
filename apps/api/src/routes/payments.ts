import type { FastifyInstance } from "fastify";
import { PaymentError } from "@tpirs/application";
import type { Services } from "../services.js";
import { errorEnvelope } from "../errors.js";
import { requirePermission } from "../auth.js";
import {
  listOutboxSchema,
  listPaymentsSchema,
  listSuspenseSchema,
  resolveSuspenseSchema,
} from "../schemas.js";

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
 * Finance views: payments, suspense, and resolution. Guards use the same
 * principal + permission model as every other route; the system role matrix
 * gives finance_admin read/manage and auditor read-only access.
 */
export function registerPaymentRoutes(
  app: FastifyInstance,
  context: { readonly services: Services },
): void {
  const { services } = context;

  app.get("/v1/payments", { schema: listPaymentsSchema }, async (request, reply) => {
    const principal = requirePermission(request, "payment:read");
    const query = request.query as { status?: string; limit?: string };
    const payments = await services.payment.listPayments({
      tenantId: principal.tenantId,
      ...(query.status === undefined ? {} : { status: query.status as never }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return reply.send({ payments: payments.map((p) => toPaymentJson(p)) });
  });

  app.get("/v1/payments/suspense", { schema: listSuspenseSchema }, async (request, reply) => {
    const principal = requirePermission(request, "payment:read");
    const query = request.query as { limit?: string };
    const payments = await services.payment.listSuspense({
      tenantId: principal.tenantId,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return reply.send({ payments: payments.map((p) => toPaymentJson(p)) });
  });

  app.get("/v1/payments/:id/outbox", { schema: listOutboxSchema }, async (request, reply) => {
    const principal = requirePermission(request, "payment:read");
    const { id } = request.params as { id: string };
    const messages = await services.payment.listOutbox({
      tenantId: principal.tenantId,
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

  app.post(
    "/v1/payments/:id/resolve",
    { schema: resolveSuspenseSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "payment:manage");
      const { id } = request.params as { id: string };
      const body = request.body as { assetId?: string } | undefined;
      if (body?.assetId === undefined) {
        return reply
          .code(400)
          .send(errorEnvelope("bad_request", "assetId is required", request.id));
      }
      try {
        const payment = await services.payment.resolveSuspense({
          tenantId: principal.tenantId,
          paymentId: id,
          assetId: body.assetId,
          approvedByUserId: principal.userId,
        });
        request.audit = {
          action: "payment.suspense.resolve",
          entityType: "payment",
          entityId: payment.id,
          after: toPaymentJson(payment),
        };
        return await Promise.resolve(reply.send({ payment: toPaymentJson(payment) }));
      } catch (error) {
        if (error instanceof PaymentError) {
          return reply.code(400).send(errorEnvelope("bad_request", error.message, request.id));
        }
        throw error;
      }
    },
  );
}
