import type { FastifyInstance } from "fastify";
import { InvalidQrTokenError } from "@tpirs/domain";
import { AssetNotFoundError } from "@tpirs/application";
import type { TenantConfigLoader } from "@tpirs/application";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";

/**
 * Public sticker verification. Officers scan a QR and resolve it to the asset;
 * the endpoint is unauthenticated and rate limiting arrives with the driver
 * channels phase (see docs/decisions-needed.md). Payment status is included
 * when the ledger is available, but an absent/missing value is never a signal
 * that the asset is unpaid.
 */

function notFound(request: { id: unknown }) {
  return errorEnvelope("not_found", "Asset not found", String(request.id));
}

export function registerVerifyRoutes(
  app: FastifyInstance,
  context: { readonly services: Services; readonly loadConfig: TenantConfigLoader },
): void {
  const { services, loadConfig } = context;

  app.get("/v1/verify/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    let verified: Awaited<ReturnType<typeof services.asset.verifyQrToken>>;
    try {
      verified = await services.asset.verifyQrToken(token);
    } catch (error) {
      if (error instanceof InvalidQrTokenError || error instanceof AssetNotFoundError) {
        return reply.code(404).send(notFound(request));
      }
      throw error;
    }

    const { asset, photos } = verified;
    const config = await loadConfig(asset.tenantId);
    const type = config?.assetTypes.find((t) => t.key === asset.assetTypeKey);

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
      // Payment status is never "unpaid" by absence; consumers must not infer a
      // debt from a missing field under pay-per-use.
      paymentStatus: "unknown",
    });
  });
}
