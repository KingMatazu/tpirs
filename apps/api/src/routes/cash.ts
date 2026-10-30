import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CashError, ForbiddenError } from "@tpirs/domain";
import type { CashErrorCode, Permission, Principal } from "@tpirs/domain";
import type { CashIntakeRow, CashDepositRow } from "@tpirs/db";
import { requirePermission } from "../auth.js";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";
import {
  createCashIntakeSchema,
  freezeWalletSchema,
  getCashWalletSchema,
  listCashDepositsSchema,
  listCashWalletsSchema,
  matchCashDepositSchema,
  provisionDepositInstructionSchema,
  reverseCashIntakeSchema,
} from "../schemas.js";

/** What the dashboard may see of a wallet; money travels as strings. */
function toWalletJson(wallet: {
  collectorUserId: string;
  status: string;
  frozenAt: Date | null;
  frozenReason: string | null;
  overdueSince: Date | null;
  floatCeilingMinor: bigint | null;
  balanceMinor: bigint;
  openIntakeTotalMinor: bigint;
  oldestOpenIntakeAt: Date | null;
  lastDepositAt: Date | null;
  depositInstruction: {
    provider: string;
    reference: string;
    kind: "virtual_account" | "narration";
  } | null;
}) {
  return {
    collectorUserId: wallet.collectorUserId,
    status: wallet.status,
    frozenAt: wallet.frozenAt === null ? null : wallet.frozenAt.toISOString(),
    frozenReason: wallet.frozenReason,
    overdueSince: wallet.overdueSince === null ? null : wallet.overdueSince.toISOString(),
    floatCeilingMinor:
      wallet.floatCeilingMinor === null ? null : wallet.floatCeilingMinor.toString(),
    balanceMinor: wallet.balanceMinor.toString(),
    openIntakeTotalMinor: wallet.openIntakeTotalMinor.toString(),
    oldestOpenIntakeAt:
      wallet.oldestOpenIntakeAt === null ? null : wallet.oldestOpenIntakeAt.toISOString(),
    lastDepositAt: wallet.lastDepositAt === null ? null : wallet.lastDepositAt.toISOString(),
    depositInstruction: wallet.depositInstruction,
  };
}

function toIntakeJson(intake: CashIntakeRow) {
  return {
    id: intake.id,
    collectorUserId: intake.collectorUserId,
    assetId: intake.assetId,
    zoneId: intake.zoneId,
    businessDate: intake.businessDate,
    amountMinor: intake.amountMinor.toString(),
    currency: intake.currency,
    status: intake.status,
    receiptNumber: intake.receiptNumber,
    recordedAt: intake.recordedAt.toISOString(),
  };
}

function toDepositJson(deposit: CashDepositRow) {
  return {
    id: deposit.id,
    provider: deposit.provider,
    providerReference: deposit.providerReference,
    collectorUserId: deposit.collectorUserId,
    amountMinor: deposit.amountMinor.toString(),
    currency: deposit.currency,
    status: deposit.status,
    createdAt: deposit.createdAt.toISOString(),
  };
}

/**
 * Maps a cash failure onto the status the caller can act on.
 *
 * The codes come from the domain (`CashErrorCode`), so this is the single place
 * where a business refusal becomes HTTP: unknown things are 404, a conflict
 * with the wallet or the day is 409, and a malformed request is 400.
 */
const CASH_ERROR_STATUS: Readonly<Record<CashErrorCode, number>> = {
  asset_unknown: 404,
  wallet_unknown: 404,
  intake_unknown: 404,
  deposit_unknown: 404,
  wallet_frozen: 409,
  already_paid: 409,
  deposit_state: 409,
  intake_state: 409,
  duplicate_reference: 409,
  ceiling_exceeded: 409,
  provider_required: 409,
  amount_mismatch: 400,
  invalid_amount: 400,
  reason_required: 400,
  cash_disabled: 400,
};

/** A cash refusal, translated; anything else keeps bubbling to the handler. */
function sendCashError(request: FastifyRequest, reply: FastifyReply, error: CashError) {
  return reply
    .code(CASH_ERROR_STATUS[error.code])
    .send(errorEnvelope(error.code, error.message, request.id));
}

function parseMinor(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

/**
 * Whether the caller may see collectors other than themselves.
 *
 * A collector holds `cash:read` and `cash:intake` only; every other cash role
 * (supervisor, finance, auditor) also holds one of the wider read permissions.
 * Until user↔zone assignment exists (D39), that is the whole scoping rule:
 * supervisors and finance see the tenant, a collector sees their own wallet.
 */
function seesWholeTenant(principal: Principal): boolean {
  const wider: readonly Permission[] = ["cash:freeze", "cash:unfreeze", "cash:deposit:read"];
  return wider.some((permission) => principal.permissions.includes(permission));
}

function assertMaySeeCollector(principal: Principal, collectorUserId: string): void {
  if (collectorUserId !== principal.userId && !seesWholeTenant(principal)) {
    throw new ForbiddenError("A collector may only read their own cash wallet", "cash:read");
  }
}

/**
 * Collector cash (Phase 7). Every route is permission-guarded, tenant-scoped by
 * the principal, and audits its state change through `request.audit`.
 */
export function registerCashRoutes(
  app: FastifyInstance,
  context: { readonly services: Services },
): void {
  const { services } = context;

  app.post("/v1/cash/intakes", { schema: createCashIntakeSchema }, async (request, reply) => {
    const principal = requirePermission(request, "cash:intake");
    const body = request.body as {
      collectorUserId?: string;
      clientReference?: string;
      amountMinor?: string;
      currency?: string;
      assetId?: string;
      token?: string;
      reference?: string;
      businessDate?: string;
      zoneId?: string | null;
    };
    const collectorUserId = body.collectorUserId ?? "";
    if (collectorUserId === "") {
      return reply
        .code(400)
        .send(errorEnvelope("bad_request", "collectorUserId is required", request.id));
    }
    // A collector takes cash in their own name; finance and supervisors may
    // record on a collector's behalf, which is the admin form (Step 8).
    if (collectorUserId !== principal.userId && !principal.permissions.includes("cash:freeze")) {
      throw new ForbiddenError("A collector may only record their own cash intake", "cash:intake");
    }

    const amountMinor = parseMinor(body.amountMinor);
    if (amountMinor === undefined) {
      return reply
        .code(400)
        .send(errorEnvelope("bad_request", "amountMinor must be integer minor units", request.id));
    }
    const headerKey = request.headers["idempotency-key"];
    const clientReference =
      body.clientReference?.trim() ?? (typeof headerKey === "string" ? headerKey.trim() : "");
    if (clientReference === "") {
      return reply
        .code(400)
        .send(errorEnvelope("bad_request", "clientReference is required", request.id));
    }

    const config = await services.collectorCash.requireConfig(principal.tenantId);
    try {
      const result = await services.collectorCash.recordIntake({
        tenantId: principal.tenantId,
        collectorUserId,
        amount: { currency: body.currency ?? config.locale.currency, amount: Number(amountMinor) },
        clientReference,
        ...(body.assetId === undefined ? {} : { assetId: body.assetId }),
        ...(body.token === undefined ? {} : { token: body.token }),
        ...(body.reference === undefined ? {} : { reference: body.reference }),
        ...(body.businessDate === undefined ? {} : { businessDate: body.businessDate as never }),
        ...(body.zoneId === undefined ? {} : { zoneId: body.zoneId }),
      });
      request.audit = {
        action: "cash.intake.record",
        entityType: "cash_intake",
        entityId: result.intakeId,
        // Audit payloads are JSON: amounts travel as strings.
        after: {
          collectorUserId,
          amountMinor: amountMinor.toString(),
          currency: body.currency ?? config.locale.currency,
          assetId: result.assetId,
          receiptNumber: result.receiptNumber,
          businessDate: result.businessDate,
          replayed: result.replayed,
        },
      };
      return await Promise.resolve(
        reply.send({
          intakeId: result.intakeId,
          collectorUserId,
          assetId: result.assetId,
          assetRef: result.assetRef,
          receiptNumber: result.receiptNumber,
          businessDate: result.businessDate,
          balanceMinor: result.balanceMinor.toString(),
          smsQueued: result.smsQueued,
          replayed: result.replayed,
        }),
      );
    } catch (error) {
      if (error instanceof CashError) return sendCashError(request, reply, error);
      throw error;
    }
  });

  app.get("/v1/cash/wallets", { schema: listCashWalletsSchema }, async (request, reply) => {
    const principal = requirePermission(request, "cash:read");
    const wallets = await services.collectorCash.listWallets(principal.tenantId);
    const visible = seesWholeTenant(principal)
      ? wallets
      : wallets.filter((wallet) => wallet.collectorUserId === principal.userId);
    return reply.send({ wallets: visible.map((wallet) => toWalletJson(wallet)) });
  });

  app.get<{ Params: { collectorUserId: string }; Querystring: { limit?: string } }>(
    "/v1/cash/wallets/:collectorUserId",
    { schema: getCashWalletSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "cash:read");
      const { collectorUserId } = request.params;
      assertMaySeeCollector(principal, collectorUserId);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      try {
        const wallet = await services.collectorCash.wallet(principal.tenantId, collectorUserId);
        const intakes = await services.collectorCash.listIntakes(principal.tenantId, {
          collectorUserId,
          ...(limit === undefined ? {} : { limit }),
        });
        return await Promise.resolve(
          reply.send({
            wallet: toWalletJson(wallet),
            intakes: intakes.rows.map((intake) => toIntakeJson(intake)),
            nextCursor: intakes.nextCursor,
          }),
        );
      } catch (error) {
        if (error instanceof CashError) return sendCashError(request, reply, error);
        throw error;
      }
    },
  );

  const transition = (path: string, permission: Permission) =>
    app.post<{ Params: { collectorUserId: string }; Body: { reason?: string } }>(
      path,
      { schema: freezeWalletSchema },
      async (request, reply) => {
        const principal = requirePermission(request, permission);
        const { collectorUserId } = request.params;
        const reason = request.body.reason ?? "";
        try {
          const entity =
            permission === "cash:freeze"
              ? await services.collectorCash.freeze({
                  tenantId: principal.tenantId,
                  collectorUserId,
                  reason,
                  actor: principal,
                })
              : await services.collectorCash.unfreeze({
                  tenantId: principal.tenantId,
                  collectorUserId,
                  reason,
                  actor: principal,
                });
          // The wallet service writes its own audit entry (with the before and
          // after state and the reason), so the route adds none: one transition
          // must never produce two entries.
          return await Promise.resolve(reply.send({ wallet: toWalletJson(entity) }));
        } catch (error) {
          if (error instanceof CashError) return sendCashError(request, reply, error);
          throw error;
        }
      },
    );

  transition("/v1/cash/wallets/:collectorUserId/freeze", "cash:freeze");
  transition("/v1/cash/wallets/:collectorUserId/unfreeze", "cash:unfreeze");

  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      collectorUserId?: string;
      status?: string;
    };
  }>("/v1/cash/deposits", { schema: listCashDepositsSchema }, async (request, reply) => {
    const principal = requirePermission(request, "cash:deposit:read");
    const { cursor, collectorUserId, status } = request.query;
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    const page = await services.collectorCash.listDeposits(principal.tenantId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
      ...(collectorUserId === undefined ? {} : { collectorUserId }),
      ...(status === undefined ? {} : { status: status as never }),
    });
    return reply.send({
      deposits: page.rows.map((deposit) => toDepositJson(deposit)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  });

  app.post<{ Params: { id: string }; Body: { intakeId?: string; amountMinor?: string } }>(
    "/v1/cash/deposits/:id/match",
    { schema: matchCashDepositSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "cash:deposit:match");
      const intakeId = request.body.intakeId ?? "";
      if (intakeId === "") {
        return reply
          .code(400)
          .send(errorEnvelope("bad_request", "intakeId is required", request.id));
      }
      const requested =
        request.body.amountMinor === undefined ? undefined : parseMinor(request.body.amountMinor);
      if (request.body.amountMinor !== undefined && requested === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope("bad_request", "amountMinor must be integer minor units", request.id),
          );
      }
      try {
        const result = await services.collectorCash.matchDeposit({
          tenantId: principal.tenantId,
          depositId: request.params.id,
          intakeId,
          approvedByUserId: principal.userId,
          ...(requested === undefined ? {} : { amountMinor: requested }),
        });
        request.audit = {
          action: "cash.deposit.match",
          entityType: "cash_deposit",
          entityId: result.depositId,
          after: {
            intakeId,
            outcome: result.outcome,
            allocatedMinor: result.allocatedMinor.toString(),
            collectorUserId: result.collectorUserId,
            replayed: result.replayed,
          },
        };
        return await Promise.resolve(
          reply.send({
            depositId: result.depositId,
            outcome: result.outcome,
            collectorUserId: result.collectorUserId,
            allocatedMinor: result.allocatedMinor.toString(),
            currency: result.currency,
            replayed: result.replayed,
          }),
        );
      } catch (error) {
        if (error instanceof CashError) return sendCashError(request, reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/cash/intakes/:id/reverse",
    { schema: reverseCashIntakeSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "payment:manage");
      try {
        const result = await services.collectorCash.requestIntakeReversal({
          tenantId: principal.tenantId,
          intakeId: request.params.id,
          reason: request.body.reason ?? "",
          requestedByUserId: principal.userId,
          isSystemAdmin: principal.roles.includes("system_admin"),
        });
        request.audit = {
          action: "cash.intake.reverse_request",
          entityType: "cash_intake",
          entityId: result.intakeId,
          after: {
            reversalRequestId: result.reversalRequestId,
            status: result.status,
            reason: (request.body.reason ?? "").trim(),
          },
        };
        // 202: nothing has moved yet. A second, different finance user approves
        // the reversal through the ledger's dual-approval path.
        return await Promise.resolve(reply.code(202).send(result));
      } catch (error) {
        if (error instanceof CashError) return sendCashError(request, reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: { collectorUserId: string }; Body: { provider?: string } }>(
    "/v1/cash/collectors/:collectorUserId/deposit-instruction",
    { schema: provisionDepositInstructionSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "payment:manage");
      try {
        const instruction = await services.collectorCash.provisionCollectorDepositInstruction({
          tenantId: principal.tenantId,
          collectorUserId: request.params.collectorUserId,
          ...(request.body.provider === undefined ? {} : { provider: request.body.provider }),
        });
        request.audit = {
          action: "cash.deposit_instruction.provision",
          entityType: "collector_deposit_instruction",
          entityId: instruction.id,
          after: {
            collectorUserId: instruction.collectorUserId,
            provider: instruction.provider,
            reference: instruction.reference,
            kind: instruction.kind,
          },
        };
        return await Promise.resolve(
          reply.send({
            instruction: {
              id: instruction.id,
              collectorUserId: instruction.collectorUserId,
              provider: instruction.provider,
              reference: instruction.reference,
              kind: instruction.kind,
              status: instruction.status,
            },
          }),
        );
      } catch (error) {
        if (error instanceof CashError) return sendCashError(request, reply, error);
        throw error;
      }
    },
  );
}
