import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sharedSchemas } from "./schemas.js";
import {
  authMeSchema,
  createAssetSchema,
  createOwnerSchema,
  getAssetSchema,
  getOwnerSchema,
  listOutboxSchema,
  listPaymentsSchema,
  listAuditSchema,
  resolveSuspenseSchema,
  searchAssetsSchema,
  verifyTokenSchema,
} from "./schemas.js";

/**
 * Run representative payloads through Fastify's real response serializer with
 * the schemas the routes declare. If a handler and its schema ever drift, the
 * dashboard silently loses fields — this test catches that in CI instead of
 * in the field. Dates must arrive as ISO strings (handlers convert), money as
 * strings.
 */

const sampleAsset = {
  id: "as_1",
  assetTypeKey: "bike",
  status: "active",
  zoneId: null,
  ownerId: null,
  attributes: { plate_number: "AB-123", year: 2021 },
  qrToken: "tok_1",
  shortCode: "AB12CD",
};

const samplePayment = {
  id: "pay_1",
  status: "suspense",
  amountMinor: "123450",
  currency: "NGN",
  provider: "paystack",
  providerReference: null,
  assetId: null,
  attributionKind: null,
  businessDate: null,
  receiptNumber: null,
  failureReason: "reference_not_found",
  createdAt: "2026-10-23T10:00:00.000Z",
};

const sampleOwner = {
  id: "own_1",
  displayName: "Ada Obi",
  phone: "+2348000000001",
  phoneVerifiedAt: null,
};

function buildSampleApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(swagger, {
    openapi: { openapi: "3.0.3", info: { title: "test", version: "0" } },
  });
  for (const shared of sharedSchemas) {
    app.addSchema(shared);
  }
  return app;
}

describe("declared response schemas serialize complete payloads", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildSampleApp();

    app.post("/v1/assets", { schema: createAssetSchema }, async () => ({ asset: sampleAsset }));
    app.get("/v1/assets/:id", { schema: getAssetSchema }, async () => ({
      asset: sampleAsset,
      photos: [{ id: "ph_1", contentType: "image/jpeg", url: "/v1/assets/as_1/photos/ph_1" }],
    }));
    app.get("/v1/assets", { schema: searchAssetsSchema }, async () => ({
      assets: [sampleAsset],
    }));
    app.post("/v1/owners", { schema: createOwnerSchema }, async () => ({ owner: sampleOwner }));
    app.get("/v1/owners/:id", { schema: getOwnerSchema }, async () => ({ owner: sampleOwner }));
    app.get("/v1/payments", { schema: listPaymentsSchema }, async () => ({
      payments: [samplePayment],
    }));
    app.post("/v1/payments/:id/resolve", { schema: resolveSuspenseSchema }, async () => ({
      payment: { ...samplePayment, status: "applied", assetId: "as_1" },
    }));
    app.get("/v1/payments/:id/outbox", { schema: listOutboxSchema }, async () => ({
      messages: [
        {
          id: "msg_1",
          kind: "receipt",
          recipient: "+2348000000001",
          body: "Payment received",
          status: "sent",
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
    }));
    app.get("/v1/auth/me", { schema: authMeSchema }, async () => ({
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["finance_admin"],
      permissions: ["payment:read"],
    }));
    app.get("/v1/verify/:token", { schema: verifyTokenSchema }, async () => ({
      status: "active",
      assetTypeKey: "bike",
      assetTypeLabel: "Bike",
      shortCode: "AB12CD",
      attributes: { plate_number: "AB-123" },
      photos: [{ id: "ph_1", url: "/v1/assets/as_1/photos/ph_1" }],
      paymentStatus: "unknown",
    }));
    app.get("/v1/audit", { schema: listAuditSchema }, async () => ({
      entries: [
        {
          id: "a_1",
          action: "asset.register",
          entityType: "asset",
          entityId: "as_1",
          actorUserId: "u1",
          before: null,
          after: { plate_number: "AB-123" },
          requestId: "req-1",
          ip: "127.0.0.1",
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serializes an asset create response without stripping fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/assets",
      payload: { assetTypeKey: "bike", attributes: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ asset: sampleAsset });
  });

  it("keeps attribute keys and nullables in asset lists", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/assets" });
    const body = response.json() as {
      assets: Record<string, unknown>[];
    };
    expect(body.assets[0]?.attributes).toEqual(sampleAsset.attributes);
    expect(body.assets[0]?.zoneId).toBe(null);
    expect(body.assets[0]?.ownerId).toBe(null);
  });

  it("serializes asset detail with photo references", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/assets/as_1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asset: sampleAsset,
      photos: [{ id: "ph_1", contentType: "image/jpeg", url: "/v1/assets/as_1/photos/ph_1" }],
    });
  });

  it("serializes owner responses with a nullable verification date", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/owners",
      payload: { displayName: "Ada Obi", phone: "+2348000000001" },
    });
    expect(create.json()).toEqual({ owner: sampleOwner });
    const get = await app.inject({ method: "GET", url: "/v1/owners/own_1" });
    expect(get.json()).toEqual({ owner: sampleOwner });
  });

  it("serializes payment rows with nulls kept and amounts as strings", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/payments" });
    const body = response.json() as { payments: Record<string, unknown>[] };
    expect(body.payments[0]).toEqual(samplePayment);
    expect(typeof body.payments[0]?.amountMinor).toBe("string");
  });

  it("serializes a resolved payment with attribution fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/payments/pay_1/resolve",
      payload: { assetId: "as_1" },
    });
    const body = response.json() as { payment: Record<string, unknown> };
    expect(body.payment.status).toBe("applied");
    expect(body.payment.assetId).toBe("as_1");
    expect(body.payment.providerReference).toBe(null);
  });

  it("serializes outbox messages", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/payments/pay_1/outbox" });
    expect(response.json()).toEqual({
      messages: [
        {
          id: "msg_1",
          kind: "receipt",
          recipient: "+2348000000001",
          body: "Payment received",
          status: "sent",
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
    });
  });

  it("serializes /me with permissions", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(response.json()).toEqual({
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["finance_admin"],
      permissions: ["payment:read"],
    });
  });

  it("serializes verification payloads with attributes intact", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/verify/some-token" });
    const body = response.json() as { attributes: Record<string, unknown>; photos: unknown[] };
    expect(body.attributes).toEqual({ plate_number: "AB-123" });
    expect(body.photos).toEqual([{ id: "ph_1", url: "/v1/assets/as_1/photos/ph_1" }]);
    expect((response.json() as { paymentStatus: string }).paymentStatus).toBe("unknown");
  });

  it("serializes audit entries with snapshots preserved", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/audit" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBe(null);
    expect(body.entries[0]).toEqual({
      id: "a_1",
      action: "asset.register",
      entityType: "asset",
      entityId: "as_1",
      actorUserId: "u1",
      before: null,
      after: { plate_number: "AB-123" },
      requestId: "req-1",
      ip: "127.0.0.1",
      createdAt: "2026-10-23T10:00:00.000Z",
    });
  });
});
