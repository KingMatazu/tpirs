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
  getReportSchema,
  listAnomaliesSchema,
  listAuditSchema,
  listOutboxSchema,
  listPaymentsSchema,
  listReconciliationExceptionsSchema,
  listReconciliationRunsSchema,
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

const sampleChecklistItem = {
  check: "clearing_balance",
  severity: "blocking",
  subjectType: null,
  subjectId: null,
  expectedMinor: "0",
  actualMinor: "0",
  expectedCount: null,
  actualCount: null,
  differenceMinor: "0",
  differenceCount: null,
  withinTolerance: true,
};

const sampleRun = {
  id: "run_1",
  businessDate: "2026-06-15",
  runSeq: 1,
  status: "completed",
  toleranceMinor: "0",
  feeToleranceMinor: "1000",
  checklist: [sampleChecklistItem],
  exceptionCount: 0,
  failureReason: null,
  startedAt: "2026-06-16T02:00:00.000Z",
  completedAt: "2026-06-16T02:00:05.000Z",
  signedOffByUserId: null,
  signedOffAt: null,
  signOffNote: null,
};

const sampleException = {
  id: "exc_1",
  runId: "run_1",
  kind: "settlement_rows_matched",
  severity: "blocking",
  status: "open",
  subjectType: "settlement_row",
  subjectId: "row_1",
  businessDate: "2026-06-15",
  expectedMinor: "0",
  actualMinor: "20000",
  differenceMinor: "20000",
  currency: "NGN",
  detail: { providerReference: "ref-1" },
  resolutionNote: null,
  resolvedByUserId: null,
  resolvedAt: null,
  firstSeenRunId: "run_1",
  lastSeenRunId: "run_1",
  createdAt: "2026-06-16T02:00:05.000Z",
};

const sampleAnomaly = {
  id: "an_1",
  ruleKey: "suspense_growth",
  subjectType: "tenant",
  subjectId: "t1",
  windowStart: "2026-06-09",
  windowEnd: "2026-06-16",
  observed: "7777.0000",
  baseline: "0.0000",
  threshold: "5000.0000",
  severity: "warning",
  status: "open",
  detail: { observations: 0 },
  acknowledgedByUserId: null,
  acknowledgedAt: null,
  createdAt: "2026-06-16T02:00:05.000Z",
};

const sampleReport = {
  reportKey: "daily_collections",
  from: "2026-06-15",
  to: "2026-06-15",
  generatedAt: "2026-06-16T02:00:05.000Z",
  columns: [{ key: "revenueMinor", header: "revenueMinor", kind: "money" }],
  rows: [{ businessDate: "2026-06-15", revenueMinor: "20000", paymentsCount: 1 }],
  totals: { revenueMinor: "20000" },
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
      businessDate: "2026-10-23",
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
    app.get("/v1/reconciliation/runs", { schema: listReconciliationRunsSchema }, async () => ({
      runs: [sampleRun],
    }));
    app.get(
      "/v1/reconciliation/exceptions",
      { schema: listReconciliationExceptionsSchema },
      async () => ({ exceptions: [sampleException] }),
    );
    app.get("/v1/anomalies", { schema: listAnomaliesSchema }, async () => ({
      anomalies: [sampleAnomaly],
    }));
    app.get("/v1/reports/:key", { schema: getReportSchema }, async () => ({
      report: sampleReport,
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

  it("serializes reconciliation runs with their checklist intact", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reconciliation/runs" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { runs: unknown[] }).runs[0]).toEqual(sampleRun);
  });

  it("serializes exceptions and anomalies without stripping detail", async () => {
    const exceptions = await app.inject({
      method: "GET",
      url: "/v1/reconciliation/exceptions",
    });
    expect(exceptions.statusCode).toBe(200);
    expect((exceptions.json() as { exceptions: unknown[] }).exceptions[0]).toEqual(sampleException);

    const anomalies = await app.inject({ method: "GET", url: "/v1/anomalies" });
    expect(anomalies.statusCode).toBe(200);
    expect((anomalies.json() as { anomalies: unknown[] }).anomalies[0]).toEqual(sampleAnomaly);
  });

  it("serializes report rows and totals", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/reports/daily_collections?from=2026-06-15&to=2026-06-15",
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { report: unknown }).report).toEqual(sampleReport);
  });
});
