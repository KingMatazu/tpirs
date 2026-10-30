import type { FastifyInstance } from "fastify";
import { InvalidQrTokenError, paymentStatusFromPeriod } from "@tpirs/domain";
import { AssetNotFoundError } from "@tpirs/application";
import type { TenantConfigLoader } from "@tpirs/application";
import { todayInTimeZone } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";
import { verifyTokenSchema } from "../schemas.js";

const VERIFY_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * Public sticker verification. Officers scan a QR and resolve it to the asset;
 * the endpoint is unauthenticated (ADR 0007) but rate-limited per source IP
 * (ADR 0024/D5). Payment status reflects the recorded period for the current
 * business day and is never inferred as a debt from absence under pay-per-use.
 */

function notFound(request: { id: unknown }) {
  return errorEnvelope("not_found", "Asset not found", String(request.id));
}

export function registerVerifyRoutes(
  app: FastifyInstance,
  context: {
    readonly services: Services;
    readonly loadConfig: TenantConfigLoader;
    readonly db: import("@tpirs/db").AnyDb;
  },
): void {
  const { services, loadConfig, db } = context;

  app.get("/v1/verify/:token", { schema: verifyTokenSchema }, async (request, reply) => {
    const limit = await services.rateLimiter.consume(`verify:ip:${request.ip}`, VERIFY_RATE_LIMIT);
    if (!limit.allowed) {
      services.telemetry?.counter("verify.lookups", 1, { result: "rate_limited" });
      services.telemetry?.counter("rate_limit.rejections", 1, { scope: "verify" });
      void reply.header("Retry-After", String(limit.retryAfterSeconds));
      return reply.code(429).send(errorEnvelope("rate_limited", "Too many requests", request.id));
    }

    const { token } = request.params as { token: string };
    let verified: Awaited<ReturnType<typeof services.asset.verifyQrToken>>;
    try {
      verified = await services.asset.verifyQrToken(token);
    } catch (error) {
      if (error instanceof InvalidQrTokenError || error instanceof AssetNotFoundError) {
        services.telemetry?.counter("verify.lookups", 1, { result: "not_found" });
        return reply.code(404).send(notFound(request));
      }
      throw error;
    }

    const { asset, photos } = verified;
    const config = await loadConfig(asset.tenantId);
    const type = config?.assetTypes.find((t) => t.key === asset.assetTypeKey);
    const businessDate = todayInTimeZone(config?.locale.timezone ?? "UTC", new Date());

    let paymentStatus: "paid" | "no_payment_recorded" | "unknown" = "unknown";
    if (config !== undefined) {
      const period = await withTenant(db, asset.tenantId, async (tx) =>
        repositories(tx).obligations.findByAssetAndDate(asset.tenantId, asset.id, businessDate),
      );
      paymentStatus = paymentStatusFromPeriod(period?.status ?? "none");
    }

    services.telemetry?.counter("verify.lookups", 1, { result: paymentStatus });

    return reply.send({
      status: asset.status,
      assetTypeKey: asset.assetTypeKey,
      assetTypeLabel: type?.label ?? asset.assetTypeKey,
      shortCode: asset.shortCode,
      attributes: asset.attributes,
      photos: photos.map((photo) => ({
        id: photo.id,
        url: `/v1/assets/${asset.id}/photos/${photo.id}`,
      })),
      paymentStatus,
      businessDate,
    });
  });
}
