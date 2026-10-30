import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvalidQrTokenError, paymentStatusFromPeriod, todayInTimeZone } from "@tpirs/domain";
import type { PaymentStatus } from "@tpirs/domain";
import { AssetNotFoundError } from "@tpirs/application";
import type { TenantConfigLoader } from "@tpirs/application";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, AssetRecord } from "@tpirs/db";
import { requirePermission } from "../auth.js";
import type { Services } from "../services.js";
import {
  createDisputeSchema,
  createScanSchema,
  getDisputeSchema,
  listDisputesSchema,
  listScansSchema,
  verificationSearchSchema,
  syncPaidSchema,
} from "../schemas.js";

/** What a field client may report it saw; never an accusation by itself. */
type ObservedScanStatus = PaymentStatus | "not_in_offline_list";

interface VerificationSearchQuery {
  readonly q?: string;
}

interface SyncPaidQuery {
  readonly since?: string;
  readonly limit?: string;
}

interface ListScansQuery {
  readonly cursor?: string;
  readonly limit?: string;
  readonly officerUserId?: string;
}

interface ScanBody {
  readonly clientScanId?: string;
  readonly source?: string;
  readonly token?: string;
  readonly reference?: string;
  readonly assetId?: string;
  readonly scannedAt?: string;
  readonly observedStatus?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

interface ListDisputesQuery {
  readonly cursor?: string;
  readonly limit?: string;
  readonly status?: string;
}

interface DisputeBody {
  readonly clientDisputeId?: string;
  readonly assetId?: string;
  readonly reference?: string;
  readonly reason?: string;
  readonly description?: string;
  readonly occurredAt?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly evidence?: unknown;
}

interface GetDisputeParams {
  readonly id?: string;
}

/** One row of the officer's manual-search result list. */
interface VerificationSearchResult {
  readonly assetId: string;
  readonly assetTypeKey: string;
  readonly status: string;
  readonly shortCode: string;
  readonly attributes: Record<string, unknown>;
  readonly paymentStatus: PaymentStatus;
  readonly businessDate: string;
}

function badRequest(request: FastifyRequest, message: string) {
  return {
    error: {
      code: "bad_request",
      message,
      requestId: request.id,
    },
  };
}

function notFound(request: FastifyRequest) {
  return {
    error: {
      code: "not_found",
      message: "Asset not found",
      requestId: request.id,
    },
  };
}

function rateLimited(request: FastifyRequest) {
  return {
    error: {
      code: "rate_limited",
      message: "Too many requests",
      requestId: request.id,
    },
  };
}

const ROUTE_RATE_LIMITS = {
  verificationSearch: { limit: 30, windowSeconds: 60 },
  syncPaid: { limit: 20, windowSeconds: 60 },
  scan: { limit: 30, windowSeconds: 60 },
  dispute: { limit: 20, windowSeconds: 60 },
} as const;

/**
 * Reads the optional `evidence` envelope without trusting the wire shape: a
 * partial object is dropped rather than stringified into "[object Object]".
 */
function parseEvidence(
  value: unknown,
): { readonly contentType: string; readonly contentBase64: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { contentType, contentBase64 } = record;
  if (typeof contentType !== "string" || typeof contentBase64 !== "string") return undefined;
  return { contentType, contentBase64 };
}

function parseScanSource(value: string | undefined): "qr" | "manual" | "offline_queue" {
  return value === "manual" || value === "offline_queue" ? value : "qr";
}

/**
 * Anything the client cannot vouch for collapses to "not in the offline list",
 * the one value that never means "unpaid".
 */
function parseObservedStatus(value: string | undefined): ObservedScanStatus {
  return value === "paid" || value === "no_payment_recorded" || value === "unknown"
    ? value
    : "not_in_offline_list";
}

async function enforceRouteRateLimit(
  services: Services,
  request: FastifyRequest,
  key: string,
  rule: (typeof ROUTE_RATE_LIMITS)[keyof typeof ROUTE_RATE_LIMITS],
): Promise<boolean> {
  const decision = await services.rateLimiter.consume(
    `${key}:${request.ip}:${request.principal?.tenantId ?? "anon"}`,
    rule,
  );
  return decision.allowed;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

export function registerVerificationAndSyncRoutes(
  app: FastifyInstance,
  context: {
    readonly services: Services;
    readonly loadConfig: TenantConfigLoader;
    readonly db: AnyDb;
  },
): void {
  const { services, loadConfig, db } = context;

  app.get<{ Querystring: VerificationSearchQuery }>(
    "/v1/verifications/search",
    { schema: verificationSearchSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "asset:read");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-verification-search",
        ROUTE_RATE_LIMITS.verificationSearch,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const tenantId = principal.tenantId;
      const config = await loadConfig(tenantId);
      const businessDate = todayInTimeZone(config?.locale.timezone ?? "UTC", new Date());
      const trimmed = (request.query.q ?? "").trim();

      const results = await withTenant(db, tenantId, async (tx) => {
        // Exact reference first (a scanned short code), then a partial match so
        // a collector typing "MTZ" still finds MTZ56AA on a phone keyboard.
        const exact =
          trimmed === "" ? undefined : await repositories(tx).assets.findByReference(trimmed);
        const matches: readonly AssetRecord[] =
          trimmed === ""
            ? await repositories(tx).assets.listAll(tenantId)
            : exact !== undefined
              ? [exact]
              : await repositories(tx).assets.search({ query: trimmed, limit: 20 });
        const out: VerificationSearchResult[] = [];
        for (const asset of matches.slice(0, 20)) {
          const period = await repositories(tx).obligations.findByAssetAndDate(
            tenantId,
            asset.id,
            businessDate,
          );
          out.push({
            assetId: asset.id,
            assetTypeKey: asset.assetTypeKey,
            status: asset.status,
            shortCode: asset.shortCode,
            attributes: asset.attributes,
            paymentStatus: paymentStatusFromPeriod(period?.status ?? "none"),
            businessDate,
          });
        }
        return out;
      });

      return reply.send({ results });
    },
  );

  app.get<{ Querystring: SyncPaidQuery }>(
    "/v1/sync/paid",
    { schema: syncPaidSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "asset:read");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-sync-paid",
        ROUTE_RATE_LIMITS.syncPaid,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const tenantId = principal.tenantId;
      const { since } = request.query;
      const limit = parseLimit(request.query.limit);
      const result = await services.paidSetSync.sync(tenantId, {
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
      });

      if ("error" in result) {
        const config = await loadConfig(tenantId);
        if (config?.featureFlags.offlineMode !== true) {
          return reply.code(403).send({
            error: {
              code: "forbidden",
              message: "Offline mode disabled",
              requestId: request.id,
            },
          });
        }
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Not found", requestId: request.id } });
      }

      return reply.send(result);
    },
  );

  app.post<{ Body: ScanBody }>(
    "/v1/scans",
    { schema: createScanSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "scan:record");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-scan",
        ROUTE_RATE_LIMITS.scan,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const body = request.body;
      const { clientScanId, scannedAt } = body;
      if (clientScanId === undefined || clientScanId.trim() === "") {
        return reply.code(400).send(badRequest(request, "clientScanId required"));
      }
      if (scannedAt === undefined || scannedAt.trim() === "") {
        return reply.code(400).send(badRequest(request, "scannedAt required"));
      }

      try {
        const result = await services.scan.record({
          tenantId: principal.tenantId,
          clientScanId,
          source: parseScanSource(body.source),
          officerUserId: principal.userId,
          observedStatus: parseObservedStatus(body.observedStatus),
          scannedAt,
          // Device and zone binding arrive with the field session token; until
          // then a scan is attributed to the officer alone.
          deviceId: null,
          zoneId: null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          ...(body.assetId === undefined ? {} : { assetId: body.assetId }),
          ...(body.token === undefined ? {} : { token: body.token }),
          ...(body.reference === undefined ? {} : { reference: body.reference }),
        });
        return await reply.send(result);
      } catch (error) {
        if (error instanceof InvalidQrTokenError || error instanceof AssetNotFoundError) {
          return reply.code(404).send(notFound(request));
        }
        if (error instanceof Error && error.message === "Invalid scannedAt") {
          return reply.code(400).send(badRequest(request, "Invalid scannedAt"));
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: ListScansQuery }>(
    "/v1/scans",
    { schema: listScansSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "scan:read");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-list-scans",
        ROUTE_RATE_LIMITS.scan,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const tenantId = principal.tenantId;
      const { cursor, officerUserId } = request.query;
      const limit = parseLimit(request.query.limit);
      const result = await withTenant(db, tenantId, async (tx) =>
        repositories(tx).scans.list(tenantId, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
          ...(officerUserId === undefined ? {} : { officerUserId }),
        }),
      );
      return reply.send(result);
    },
  );

  app.post<{ Body: DisputeBody }>(
    "/v1/disputes",
    { schema: createDisputeSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "dispute:create");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-dispute",
        ROUTE_RATE_LIMITS.dispute,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const body = request.body;
      const { clientDisputeId, reason, description } = body;
      if (clientDisputeId === undefined || clientDisputeId.trim() === "") {
        return reply.code(400).send(badRequest(request, "clientDisputeId required"));
      }
      if (reason === undefined || reason.trim() === "") {
        return reply.code(400).send(badRequest(request, "reason required"));
      }
      if (description === undefined || description.trim() === "") {
        return reply.code(400).send(badRequest(request, "description required"));
      }
      const evidence = parseEvidence(body.evidence);

      try {
        const result = await services.dispute.create({
          tenantId: principal.tenantId,
          clientDisputeId,
          reason,
          description,
          occurredAt: body.occurredAt ?? new Date().toISOString(),
          officerUserId: principal.userId,
          zoneId: null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          ...(body.assetId === undefined ? {} : { assetId: body.assetId }),
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(evidence === undefined ? {} : { evidence }),
        });
        return await reply.send({ disputeId: result.disputeId, status: result.status });
      } catch (error) {
        if (error instanceof InvalidQrTokenError || error instanceof AssetNotFoundError) {
          return reply.code(404).send(notFound(request));
        }
        if (error instanceof Error && error.message === "Invalid occurredAt") {
          return reply.code(400).send(badRequest(request, "Invalid occurredAt"));
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: ListDisputesQuery }>(
    "/v1/disputes",
    { schema: listDisputesSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "dispute:read");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-list-disputes",
        ROUTE_RATE_LIMITS.dispute,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const tenantId = principal.tenantId;
      const { cursor, status } = request.query;
      const limit = parseLimit(request.query.limit);
      const result = await withTenant(db, tenantId, async (tx) =>
        repositories(tx).disputes.list(tenantId, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
          ...(status === undefined ? {} : { status }),
        }),
      );
      // The repository returns `rows`; the contract names the collection
      // `disputes`, and the response serializer would otherwise strip it.
      return reply.send({
        disputes: result.rows,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    },
  );

  app.get<{ Params: GetDisputeParams }>(
    "/v1/disputes/:id",
    { schema: getDisputeSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "dispute:read");
      const allowed = await enforceRouteRateLimit(
        services,
        request,
        "field-get-dispute",
        ROUTE_RATE_LIMITS.dispute,
      );
      if (!allowed) {
        return reply.code(429).send(rateLimited(request));
      }

      const tenantId = principal.tenantId;
      const disputeId = request.params.id ?? "";
      const dispute = await withTenant(db, tenantId, async (tx) =>
        repositories(tx).disputes.find(tenantId, disputeId),
      );
      if (dispute === undefined) {
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "Dispute not found",
            requestId: request.id,
          },
        });
      }
      return reply.send({ dispute });
    },
  );
}
