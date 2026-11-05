import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TenantConfig } from "@tpirs/config";
import type { AssetRecord, OwnerRecord } from "@tpirs/db";
import { isAssetStatus } from "@tpirs/domain";
import { AssetValidationError, AssetNotFoundError, OtpError } from "@tpirs/application";
import type { Services } from "../services.js";
import { requirePermission, requirePrincipal } from "../auth.js";
import {
  attachPhotoSchema,
  confirmOwnerVerifySchema,
  correctAssetSchema,
  createAssetSchema,
  createOwnerSchema,
  getAssetSchema,
  getOwnerSchema,
  photoParamsSchema,
  requestOwnerVerifySchema,
  searchAssetsSchema,
  stickerSchema,
  suspendAssetSchema,
} from "../schemas.js";

export interface AssetRoutesContext {
  readonly services: Services;
  readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * An asset as the contract shows it.
 *
 * `ownerName` sits beside `ownerId` because every screen that lists assets
 * shows the person, not the identifier: an owner id is a database detail, and a
 * registry clerk reading "7f3a…" learns nothing. The id stays in the payload for
 * the clients that need to act on it (filtering, linking a different owner).
 */
function serializeAsset(asset: AssetRecord, ownerName: string | null) {
  return {
    id: asset.id,
    assetTypeKey: asset.assetTypeKey,
    status: asset.status,
    zoneId: asset.zoneId,
    ownerId: asset.ownerId,
    ownerName,
    attributes: asset.attributes,
    qrToken: asset.qrToken,
    shortCode: asset.shortCode,
  };
}

/** Owners carry a Date; the contract serializes it as an ISO string or null. */
function serializeOwner(owner: OwnerRecord) {
  return {
    id: owner.id,
    displayName: owner.displayName,
    phone: owner.phone,
    email: owner.email,
    phoneVerifiedAt: owner.phoneVerifiedAt === null ? null : owner.phoneVerifiedAt.toISOString(),
  };
}

/** The role whose holder registers only inside the zone they are responsible for. */
const SUPERVISOR_ROLE = "zone_supervisor";

/** Why a registration was refused; empty when it was allowed. */
export type ZoneRefusal = "" | "zone_required" | "cross_zone";

/**
 * The zone a registration may land in.
 *
 * A zone supervisor holds `asset:create` and is responsible for one zone: they
 * register there and nowhere else. A system admin has no such limit. A
 * supervisor whose zone was never recorded is refused rather than treated as
 * "everywhere" — failing closed is the only safe reading of a missing answer.
 *
 * The result is a plain record rather than a discriminated union on purpose:
 * `@vercel/node` type-checks the entrypoint with `strict` off, and narrowing a
 * `{ ok: true } | { ok: false }` union depends on `strictNullChecks`. A string
 * refusal narrows under both settings, so the build does not depend on which
 * checker looks at it.
 */
export function registrationZone(
  principal: { readonly roles: readonly string[]; readonly zoneId: string | null },
  requested: string | undefined,
): { readonly zoneId: string | undefined; readonly refusal: ZoneRefusal } {
  if (!principal.roles.includes(SUPERVISOR_ROLE)) return { zoneId: requested, refusal: "" };
  if (principal.zoneId === null) return { zoneId: undefined, refusal: "zone_required" };
  if (requested !== undefined && requested !== principal.zoneId) {
    return { zoneId: undefined, refusal: "cross_zone" };
  }
  return { zoneId: principal.zoneId, refusal: "" };
}

function badRequest(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "bad_request", message, requestId: request.id } });
}

function notFound(request: FastifyRequest, reply: FastifyReply, message = "Asset not found") {
  return reply.code(404).send({ error: { code: "not_found", message, requestId: request.id } });
}

function validationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AssetValidationError,
) {
  return reply.code(422).send({
    error: {
      code: "unprocessable_entity",
      message: error.message,
      requestId: request.id,
      issues: error.errors.map((issue) => ({ path: issue.attribute, message: issue.message })),
    },
  });
}

export function registerAssetRoutes(app: FastifyInstance, context: AssetRoutesContext): void {
  const { services, loadConfig } = context;

  /** One extra query per page, not per row: the owner names for a set of assets. */
  async function presentAssets(tenantId: string, assets: readonly AssetRecord[]) {
    const names = await services.asset.ownerNames(
      tenantId,
      assets.map((asset) => asset.ownerId),
    );
    return assets.map((asset) =>
      serializeAsset(asset, asset.ownerId === null ? null : (names[asset.ownerId] ?? null)),
    );
  }

  async function presentAsset(tenantId: string, asset: AssetRecord) {
    const [presented] = await presentAssets(tenantId, [asset]);
    return presented ?? serializeAsset(asset, null);
  }

  app.post("/v1/assets", { schema: createAssetSchema }, async (request, reply) => {
    // Registering is a supervisory act: a collector takes cash, a zone
    // supervisor or a system admin adds the vehicle. Correcting an existing
    // asset stays on `asset:manage`, which a collector still holds.
    const principal = requirePermission(request, "asset:create");
    const body = asRecord(request.body);
    if (body === undefined) return badRequest(request, reply, "A JSON body is required");
    const assetTypeKey = asString(body.assetTypeKey);
    const attributes = asRecord(body.attributes);
    if (assetTypeKey === undefined || attributes === undefined) {
      return badRequest(request, reply, "assetTypeKey and attributes are required");
    }
    const ownerRecord = asRecord(body.owner);
    const zoneId = asString(body.zoneId);
    const ownerId = asString(body.ownerId);
    const ownerEmail = ownerRecord === undefined ? undefined : asString(ownerRecord.email);
    const ownerInput =
      ownerRecord === undefined
        ? undefined
        : {
            displayName: asString(ownerRecord.displayName) ?? "",
            phone: asString(ownerRecord.phone) ?? "",
            ...(ownerEmail === undefined ? {} : { email: ownerEmail }),
          };
    const zone = registrationZone(principal, zoneId);
    if (zone.refusal !== "") {
      return reply.code(403).send({
        error: {
          code: zone.refusal,
          message:
            zone.refusal === "zone_required"
              ? "Your account has no zone, so it cannot register a driver. Ask an administrator to assign one."
              : "You can only register a driver in your own zone.",
          requestId: request.id,
        },
      });
    }
    try {
      const asset = await services.asset.register({
        tenantId: principal.tenantId,
        assetTypeKey,
        attributes,
        ...(zone.zoneId === undefined ? {} : { zoneId: zone.zoneId }),
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(ownerInput === undefined ? {} : { owner: ownerInput }),
        createdByUserId: principal.userId,
      });
      const presented = await presentAsset(principal.tenantId, asset);
      request.audit = {
        action: "asset.register",
        entityType: "asset",
        entityId: asset.id,
        after: presented,
      };
      return await reply.code(201).send({ asset: presented });
    } catch (error) {
      if (error instanceof AssetValidationError) return validationError(request, reply, error);
      throw error;
    }
  });

  app.get("/v1/assets", { schema: searchAssetsSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:read");
    const query = request.query as Record<string, unknown>;
    const limitRaw = asString(query.limit);
    const offsetRaw = asString(query.offset);
    const assetTypeKey = asString(query.assetTypeKey);
    const statusRaw = asString(query.status);
    const status = statusRaw !== undefined && isAssetStatus(statusRaw) ? statusRaw : undefined;
    const zoneId = asString(query.zoneId);
    const ownerId = asString(query.ownerId);
    const text = asString(query.query);
    const assets = await services.asset.search({
      tenantId: principal.tenantId,
      ...(text === undefined ? {} : { query: text }),
      ...(assetTypeKey === undefined ? {} : { assetTypeKey }),
      ...(status === undefined ? {} : { status }),
      ...(zoneId === undefined ? {} : { zoneId }),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
      ...(offsetRaw === undefined ? {} : { offset: Number(offsetRaw) }),
    });
    return reply.send({ assets: await presentAssets(principal.tenantId, assets) });
  });

  app.get("/v1/assets/:id", { schema: getAssetSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:read");
    const { id } = request.params as { id: string };
    try {
      const asset = await services.asset.getById(principal.tenantId, id);
      const photos = await services.asset.listPhotos(principal.tenantId, id);
      return await reply.send({
        asset: await presentAsset(principal.tenantId, asset),
        photos: photos.map((photo) => ({
          id: photo.id,
          contentType: photo.contentType,
          url: `/v1/assets/${id}/photos/${photo.id}`,
        })),
      });
    } catch (error) {
      if (error instanceof AssetNotFoundError) return notFound(request, reply);
      throw error;
    }
  });

  // Photos are base64 JSON, so this route opts into a larger body than the
  // 1 MiB global limit (Phase 10, Step 7).
  app.post(
    "/v1/assets/:id/photos",
    { schema: attachPhotoSchema, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = requirePermission(request, "asset:manage");
      const { id } = request.params as { id: string };
      const body = asRecord(request.body);
      if (body === undefined) return badRequest(request, reply, "A JSON body is required");
      const contentType = asString(body.contentType);
      const content = asString(body.content);
      if (contentType === undefined || content === undefined) {
        return badRequest(request, reply, "contentType and base64 content are required");
      }
      try {
        await services.asset.attachPhoto({
          tenantId: principal.tenantId,
          assetId: id,
          contentType,
          body: new Uint8Array(Buffer.from(content, "base64")),
          createdByUserId: principal.userId,
        });
        request.audit = { action: "asset.photo.attach", entityType: "asset", entityId: id };
        return await reply.code(201).send({ ok: true });
      } catch (error) {
        if (error instanceof AssetNotFoundError) return notFound(request, reply);
        throw error;
      }
    },
  );

  app.get(
    "/v1/assets/:id/photos/:photoId",
    { schema: photoParamsSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "asset:read");
      const { id, photoId } = request.params as { id: string; photoId: string };
      try {
        const photo = await services.asset.getPhoto(principal.tenantId, id, photoId);
        return await reply
          .code(200)
          .header("content-type", photo.contentType)
          .header("cache-control", "private, max-age=300")
          .send(Buffer.from(photo.body));
      } catch (error) {
        if (error instanceof AssetNotFoundError)
          return notFound(request, reply, "Asset photo not found");
        throw error;
      }
    },
  );

  app.get("/v1/assets/:id/sticker", { schema: stickerSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:read");
    const { id } = request.params as { id: string };
    try {
      const svg = await services.asset.getSticker(principal.tenantId, id);
      return await reply
        .code(200)
        .header("content-type", "image/svg+xml")
        .header("cache-control", "private, max-age=300")
        .send(svg);
    } catch (error) {
      if (error instanceof AssetNotFoundError) return notFound(request, reply);
      throw error;
    }
  });

  app.post("/v1/assets/:id/suspend", { schema: suspendAssetSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:manage");
    const { id } = request.params as { id: string };
    const reason = asString((request.body as Record<string, unknown>).reason);
    if (reason === undefined || reason.trim() === "") {
      return badRequest(request, reply, "reason is required");
    }
    try {
      const asset = await services.asset.setStatus(principal.tenantId, id, "suspended");
      const presented = await presentAsset(principal.tenantId, asset);
      request.audit = {
        action: "asset.suspend",
        entityType: "asset",
        entityId: id,
        after: { ...presented, reason: reason.trim() },
      };
      return await reply.send({ asset: presented });
    } catch (error) {
      if (error instanceof AssetNotFoundError) return notFound(request, reply);
      throw error;
    }
  });

  app.patch("/v1/assets/:id", { schema: correctAssetSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:manage");
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    const attributes = body === undefined ? undefined : asRecord(body.attributes);
    if (attributes === undefined) return badRequest(request, reply, "attributes is required");
    try {
      const asset = await services.asset.correctAttributes(principal.tenantId, id, attributes);
      const presented = await presentAsset(principal.tenantId, asset);
      request.audit = {
        action: "asset.correct",
        entityType: "asset",
        entityId: id,
        after: presented,
      };
      return await reply.send({ asset: presented });
    } catch (error) {
      if (error instanceof AssetValidationError) return validationError(request, reply, error);
      if (error instanceof AssetNotFoundError) return notFound(request, reply);
      throw error;
    }
  });

  app.post("/v1/owners", { schema: createOwnerSchema }, async (request, reply) => {
    // Creating an owner is the other half of registering a driver, so it travels
    // with `asset:create` rather than with corrections.
    const principal = requirePermission(request, "asset:create");
    const body = asRecord(request.body);
    const displayName = body === undefined ? undefined : asString(body.displayName);
    const phone = body === undefined ? undefined : asString(body.phone);
    const email = body === undefined ? undefined : asString(body.email);
    if (displayName === undefined || phone === undefined) {
      return badRequest(request, reply, "displayName and phone are required");
    }
    const owner = await services.owner.create({
      tenantId: principal.tenantId,
      displayName,
      phone,
      ...(email === undefined ? {} : { email }),
    });
    request.audit = { action: "owner.create", entityType: "owner", entityId: owner.id };
    return reply.code(201).send({ owner: serializeOwner(owner) });
  });

  app.get("/v1/owners/:id", { schema: getOwnerSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:read");
    const { id } = request.params as { id: string };
    const owner = await services.owner.findById(principal.tenantId, id);
    if (owner === undefined) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Owner not found", requestId: request.id } });
    }
    return reply.send({ owner: serializeOwner(owner) });
  });

  app.post(
    "/v1/owners/verify/request",
    { schema: requestOwnerVerifySchema },
    async (request, reply) => {
      const principal = requirePermission(request, "asset:manage");
      const body = asRecord(request.body);
      const ownerId = body === undefined ? undefined : asString(body.ownerId);
      const phoneInput = body === undefined ? undefined : asString(body.phone);
      if (ownerId === undefined && phoneInput === undefined) {
        return badRequest(request, reply, "ownerId or phone is required");
      }
      const config = await loadConfig(principal.tenantId);
      if (config === undefined) return notFound(request, reply, "Tenant not found");

      let phone = phoneInput;
      if (ownerId !== undefined) {
        const owner = await services.owner.findById(principal.tenantId, ownerId);
        if (owner === undefined) return notFound(request, reply, "Owner not found");
        phone = owner.phone;
      }
      if (phone === undefined) return badRequest(request, reply, "ownerId or phone is required");

      try {
        await services.otp.requestOtp({
          tenantId: principal.tenantId,
          phone,
          senderId: config.branding.smsSenderId,
          message: (code) => config.channels.otpMessageTemplate.replaceAll("{code}", code),
        });
        request.audit = {
          action: "owner.verify.request",
          entityType: "owner",
          ...(ownerId === undefined ? {} : { entityId: ownerId }),
        };
        return await reply.send({ sent: true });
      } catch (error) {
        if (error instanceof OtpError && error.code === "rate_limited") {
          return reply.code(429).send({
            error: { code: "rate_limited", message: error.message, requestId: request.id },
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/owners/verify/confirm",
    { schema: confirmOwnerVerifySchema },
    async (request, reply) => {
      requirePrincipal(request);
      const principal = requirePermission(request, "asset:manage");
      const body = asRecord(request.body);
      const ownerId = body === undefined ? undefined : asString(body.ownerId);
      const code = body === undefined ? undefined : asString(body.code);
      if (ownerId === undefined || code === undefined) {
        return badRequest(request, reply, "ownerId and code are required");
      }
      const owner = await services.owner.findById(principal.tenantId, ownerId);
      if (owner === undefined) return notFound(request, reply, "Owner not found");
      try {
        await services.otp.verifyOtp({ tenantId: principal.tenantId, phone: owner.phone, code });
      } catch (error) {
        if (error instanceof OtpError) {
          return reply.code(422).send({
            error: { code: "unprocessable_entity", message: error.message, requestId: request.id },
          });
        }
        throw error;
      }
      const verified = await services.owner.markPhoneVerified(principal.tenantId, ownerId);
      request.audit = { action: "owner.verify.confirm", entityType: "owner", entityId: ownerId };
      return reply.send({ owner: serializeOwner(verified) });
    },
  );
}
