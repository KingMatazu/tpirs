import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ReversalRequestRow } from "@tpirs/db";
import { LedgerOperationError } from "@tpirs/application";
import { requirePermission } from "../auth.js";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";
import { approveReversalSchema, listReversalsSchema, rejectReversalSchema } from "../schemas.js";

/**
 * Reversal requests (ADR 0013). A reversal is requested with a reason and
 * approved by a different finance user, which posts mirrored entries. These
 * routes only expose the queue; the ledger service owns the dual-approval rule
 * and the posting, so the dashboard cannot approve its own request even if it
 * tried.
 */

function toReversalJson(row: ReversalRequestRow) {
  return {
    id: row.id,
    originalTransactionId: row.originalTransactionId,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    approvedByUserId: row.approvedByUserId,
    rejectedByUserId: row.rejectedByUserId,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    rejectedAt: row.rejectedAt === null ? null : row.rejectedAt.toISOString(),
    reversingTransactionId: row.reversingTransactionId,
    createdAt: row.createdAt.toISOString(),
  };
}

const LEDGER_ERROR_STATUS: Readonly<Record<LedgerOperationError["code"], number>> = {
  ledger_operation: 409,
  reversal_not_found: 404,
  reversal_not_pending: 409,
  self_approval: 409,
  system_admin_forbidden: 403,
  finance_approval_required: 403,
};

function sendLedgerError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: LedgerOperationError,
) {
  return reply
    .code(LEDGER_ERROR_STATUS[error.code])
    .send(errorEnvelope(error.code, error.message, request.id));
}

export function registerReversalRoutes(
  app: FastifyInstance,
  context: { readonly services: Services },
): void {
  const { services } = context;

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    "/v1/reversals",
    { schema: listReversalsSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "ledger:read");
      const { status, limit } = request.query;
      const reversals = await services.reversals.list(principal.tenantId, {
        ...(status === undefined ? {} : { status: status as never }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      return reply.send({ reversals: reversals.map((row) => toReversalJson(row)) });
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/v1/reversals/:id/approve",
    { schema: approveReversalSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "ledger:approve");
      try {
        const result = await services.reversals.approve({
          tenantId: principal.tenantId,
          id: request.params.id,
          approver: principal,
        });
        if (result.request === undefined) {
          return await reply
            .code(404)
            .send(errorEnvelope("reversal_not_found", "Reversal request not found", request.id));
        }
        request.audit = {
          action: "ledger.reversal.approve",
          entityType: "reversal_request",
          entityId: result.request.id,
          after: {
            originalTransactionId: result.request.originalTransactionId,
            reversingTransactionId: result.transactionId,
            note: request.body.note?.trim() ?? "",
          },
        };
        return await reply.send({
          reversal: toReversalJson(result.request),
          transactionId: result.transactionId,
        });
      } catch (error) {
        if (error instanceof LedgerOperationError) {
          return sendLedgerError(request, reply, error);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/v1/reversals/:id/reject",
    { schema: rejectReversalSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "ledger:approve");
      try {
        const row = await services.reversals.reject({
          tenantId: principal.tenantId,
          id: request.params.id,
          actor: principal,
          reason: request.body.reason,
        });
        request.audit = {
          action: "ledger.reversal.reject",
          entityType: "reversal_request",
          entityId: row.id,
          after: {
            originalTransactionId: row.originalTransactionId,
            reason: request.body.reason.trim(),
          },
        };
        return await reply.send({ reversal: toReversalJson(row) });
      } catch (error) {
        if (error instanceof LedgerOperationError) {
          return sendLedgerError(request, reply, error);
        }
        throw error;
      }
    },
  );
}
