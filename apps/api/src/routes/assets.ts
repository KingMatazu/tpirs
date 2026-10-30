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

function serializeAsset(asset: AssetRecord) {
  return {
    id: asset.id,
    assetTypeKey: asset.assetTypeKey,
    status: asset.status,
    zoneId: asset.zoneId,
    ownerId: asset.ownerId,
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
    phoneVerifiedAt: owner.phoneVerifiedAt === null ? null : owner.phoneVerifiedAt.toISOString(),
  };
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

  app.post("/v1/assets", { schema: createAssetSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:manage");
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
    const ownerInput =
      ownerRecord === undefined
        ? undefined
        : {
            displayName: asString(ownerRecord.displayName) ?? "",
            phone: asString(ownerRecord.phone) ?? "",
          };
    try {
      const asset = await services.asset.register({
        tenantId: principal.tenantId,
        assetTypeKey,
        attributes,
        ...(zoneId === undefined ? {} : { zoneId }),
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(ownerInput === undefined ? {} : { owner: ownerInput }),
        createdByUserId: principal.userId,
      });
      request.audit = {
        action: "asset.register",
        entityType: "asset",
        entityId: asset.id,
        after: serializeAsset(asset),
      };
      return await reply.code(201).send({ asset: serializeAsset(asset) });
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
    return reply.send({ assets: assets.map(serializeAsset) });
  });

  app.get("/v1/assets/:id", { schema: getAssetSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:read");
    const { id } = request.params as { id: string };
    try {
      const asset = await services.asset.getById(principal.tenantId, id);
      const photos = await services.asset.listPhotos(principal.tenantId, id);
      return await reply.send({
        asset: serializeAsset(asset),
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
      request.audit = {
        action: "asset.suspend",
        entityType: "asset",
        entityId: id,
        after: { ...serializeAsset(asset), reason: reason.trim() },
      };
      return await reply.send({ asset: serializeAsset(asset) });
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
      request.audit = {
        action: "asset.correct",
        entityType: "asset",
        entityId: id,
        after: serializeAsset(asset),
      };
      return await reply.send({ asset: serializeAsset(asset) });
    } catch (error) {
      if (error instanceof AssetValidationError) return validationError(request, reply, error);
      if (error instanceof AssetNotFoundError) return notFound(request, reply);
      throw error;
    }
  });

  app.post("/v1/owners", { schema: createOwnerSchema }, async (request, reply) => {
    const principal = requirePermission(request, "asset:manage");
    const body = asRecord(request.body);
    const displayName = body === undefined ? undefined : asString(body.displayName);
    const phone = body === undefined ? undefined : asString(body.phone);
    if (displayName === undefined || phone === undefined) {
      return badRequest(request, reply, "displayName and phone are required");
    }
    const owner = await services.owner.create({
      tenantId: principal.tenantId,
      displayName,
      phone,
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
