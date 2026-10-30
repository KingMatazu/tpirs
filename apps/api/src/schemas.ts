import type { FastifySchema } from "fastify";

/**
 * OpenAPI 3 sources of truth for the hand-written routes (D28). Route schema
 * objects live here so the shapes of the contract are readable in one place;
 * route files reference them by name. Component schemas carry `$id` and are
 * registered with `app.addSchema` so `$ref` links across routes.
 *
 * Two ground rules keep these safe against Fastify's serializer:
 * 1. every response schema lists exactly the fields the handler sends, so
 *    serialization cannot strip data the dashboard needs;
 * 2. money is never a number — amounts arrive from bigint rows as strings
 *    (`amountMinor`), and dates arrive pre-serialized as ISO strings.
 * `schemas.test.ts` runs representative payloads through the Fastify
 * serializer so a drift between handler and schema fails in CI, not in the
 * field.
 */

const staffUser = {
  $id: "StaffUser",
  type: "object",
  required: ["userId", "tenantId", "displayName", "roles"],
  properties: {
    userId: { type: "string" },
    tenantId: { type: "string" },
    displayName: { type: "string" },
    roles: { type: "array", items: { type: "string" } },
  },
};

const session = {
  type: "object",
  required: ["token", "expiresAt", "user", "refreshToken", "refreshExpiresAt"],
  properties: {
    token: { type: "string" },
    expiresAt: { type: "string" },
    user: { $ref: "StaffUser#" },
    refreshToken: { type: "string" },
    refreshExpiresAt: { type: "string" },
  },
};

const asset = {
  $id: "Asset",
  type: "object",
  required: [
    "id",
    "assetTypeKey",
    "status",
    "zoneId",
    "ownerId",
    "attributes",
    "qrToken",
    "shortCode",
  ],
  properties: {
    id: { type: "string" },
    assetTypeKey: { type: "string" },
    status: { type: "string", enum: ["active", "suspended", "retired"] },
    zoneId: { type: "string", nullable: true },
    ownerId: { type: "string", nullable: true },
    attributes: { type: "object", additionalProperties: true },
    qrToken: { type: "string" },
    shortCode: { type: "string" },
  },
};

/** Photo reference embedded in asset/verify responses; bodies stream separately.
 * Photo lists on asset detail also carry the content type; verify photos omit it. */
const photoRef = {
  type: "object",
  required: ["id", "url"],
  properties: {
    id: { type: "string" },
    url: { type: "string" },
    contentType: { type: "string" },
  },
};

const owner = {
  $id: "Owner",
  type: "object",
  required: ["id", "displayName", "phone", "phoneVerifiedAt"],
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    phone: { type: "string" },
    phoneVerifiedAt: { type: "string", nullable: true },
  },
};

const payment = {
  $id: "Payment",
  type: "object",
  required: [
    "id",
    "status",
    "amountMinor",
    "currency",
    "provider",
    "providerReference",
    "assetId",
    "attributionKind",
    "businessDate",
    "receiptNumber",
    "failureReason",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["applied", "credited", "suspense", "rejected"] },
    // bigint rows are stringified in the route; the dashboard never re-derives it.
    amountMinor: { type: "string" },
    currency: { type: "string" },
    provider: { type: "string" },
    providerReference: { type: "string", nullable: true },
    assetId: { type: "string", nullable: true },
    attributionKind: { type: "string", nullable: true },
    businessDate: { type: "string", nullable: true },
    receiptNumber: { type: "string", nullable: true },
    failureReason: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
};

const outboxMessage = {
  $id: "OutboxMessage",
  type: "object",
  required: ["id", "kind", "recipient", "body", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    recipient: { type: "string" },
    body: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
  },
};

/**
 * Audit entries are append-only and read-only everywhere; before/after are
 * JSON snapshots (null when the handler sent none). Strings may be null so a
 * system action (no actor) serializes cleanly.
 */
const auditEntry = {
  $id: "AuditEntry",
  type: "object",
  required: [
    "id",
    "action",
    "entityType",
    "entityId",
    "actorUserId",
    "before",
    "after",
    "requestId",
    "ip",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    entityType: { type: "string" },
    entityId: { type: "string", nullable: true },
    actorUserId: { type: "string", nullable: true },
    before: { type: "object", additionalProperties: true, nullable: true },
    after: { type: "object", additionalProperties: true, nullable: true },
    requestId: { type: "string", nullable: true },
    ip: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
};

const errorEnvelopeSchema = {
  $id: "ErrorEnvelope",
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
};

const cashWallet = {
  $id: "CashWallet",
  type: "object",
  required: [
    "collectorUserId",
    "status",
    "frozenAt",
    "frozenReason",
    "overdueSince",
    "floatCeilingMinor",
    "balanceMinor",
    "openIntakeTotalMinor",
    "oldestOpenIntakeAt",
    "lastDepositAt",
    "depositInstruction",
  ],
  properties: {
    collectorUserId: { type: "string" },
    status: { type: "string", enum: ["active", "frozen"] },
    frozenAt: { type: "string", nullable: true },
    frozenReason: { type: "string", nullable: true },
    overdueSince: { type: "string", nullable: true },
    floatCeilingMinor: { type: "string", nullable: true },
    /** Derived COLLECTOR_CASH position; bigint rows serialize as strings. */
    balanceMinor: { type: "string" },
    openIntakeTotalMinor: { type: "string" },
    /** Oldest still-open intake, and the last deposit, for the collector list. */
    oldestOpenIntakeAt: { type: "string", nullable: true },
    lastDepositAt: { type: "string", nullable: true },
    /** The collector's dedicated deposit account, when finance provisioned one. */
    depositInstruction: {
      type: "object",
      nullable: true,
      required: ["provider", "reference", "kind"],
      properties: {
        provider: { type: "string" },
        reference: { type: "string" },
        kind: { type: "string", enum: ["virtual_account", "narration"] },
      },
    },
  },
};

const cashIntake = {
  $id: "CashIntake",
  type: "object",
  required: [
    "id",
    "collectorUserId",
    "assetId",
    "zoneId",
    "businessDate",
    "amountMinor",
    "currency",
    "status",
    "receiptNumber",
    "recordedAt",
  ],
  properties: {
    id: { type: "string" },
    collectorUserId: { type: "string" },
    assetId: { type: "string" },
    zoneId: { type: "string", nullable: true },
    businessDate: { type: "string" },
    amountMinor: { type: "string" },
    currency: { type: "string" },
    status: { type: "string", enum: ["open", "matched", "reversed"] },
    receiptNumber: { type: "string" },
    recordedAt: { type: "string" },
  },
};

const cashDeposit = {
  $id: "CashDeposit",
  type: "object",
  required: [
    "id",
    "provider",
    "providerReference",
    "collectorUserId",
    "amountMinor",
    "currency",
    "status",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    provider: { type: "string" },
    providerReference: { type: "string" },
    collectorUserId: { type: "string", nullable: true },
    amountMinor: { type: "string" },
    currency: { type: "string" },
    status: { type: "string", enum: ["matched", "partial", "suspense"] },
    createdAt: { type: "string" },
  },
};

const reconciliationChecklistItem = {
  $id: "ReconciliationChecklistItem",
  type: "object",
  required: [
    "check",
    "severity",
    "subjectType",
    "subjectId",
    "expectedMinor",
    "actualMinor",
    "expectedCount",
    "actualCount",
    "differenceMinor",
    "differenceCount",
    "withinTolerance",
  ],
  properties: {
    check: { type: "string" },
    severity: { type: "string", enum: ["blocking", "warning", "info"] },
    subjectType: { type: "string", nullable: true },
    subjectId: { type: "string", nullable: true },
    // Money is persisted as minor-unit strings; counts stay integers.
    expectedMinor: { type: "string", nullable: true },
    actualMinor: { type: "string", nullable: true },
    expectedCount: { type: "integer", nullable: true },
    actualCount: { type: "integer", nullable: true },
    differenceMinor: { type: "string", nullable: true },
    differenceCount: { type: "integer", nullable: true },
    withinTolerance: { type: "boolean", nullable: true },
  },
};

const reconciliationRun = {
  $id: "ReconciliationRun",
  type: "object",
  required: [
    "id",
    "businessDate",
    "runSeq",
    "status",
    "toleranceMinor",
    "feeToleranceMinor",
    "checklist",
    "exceptionCount",
    "failureReason",
    "startedAt",
    "completedAt",
    "signedOffByUserId",
    "signedOffAt",
    "signOffNote",
  ],
  properties: {
    id: { type: "string" },
    businessDate: { type: "string" },
    runSeq: { type: "integer" },
    status: { type: "string", enum: ["running", "completed", "failed", "signed_off"] },
    toleranceMinor: { type: "string" },
    feeToleranceMinor: { type: "string" },
    checklist: { type: "array", items: { $ref: "ReconciliationChecklistItem#" } },
    exceptionCount: { type: "integer" },
    failureReason: { type: "string", nullable: true },
    startedAt: { type: "string" },
    completedAt: { type: "string", nullable: true },
    signedOffByUserId: { type: "string", nullable: true },
    signedOffAt: { type: "string", nullable: true },
    signOffNote: { type: "string", nullable: true },
  },
};

const reconciliationException = {
  $id: "ReconciliationException",
  type: "object",
  required: [
    "id",
    "runId",
    "kind",
    "severity",
    "status",
    "subjectType",
    "subjectId",
    "businessDate",
    "expectedMinor",
    "actualMinor",
    "differenceMinor",
    "currency",
    "detail",
    "resolutionNote",
    "resolvedByUserId",
    "resolvedAt",
    "firstSeenRunId",
    "lastSeenRunId",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    kind: { type: "string" },
    severity: { type: "string", enum: ["blocking", "warning", "info"] },
    status: { type: "string", enum: ["open", "resolved", "waived"] },
    subjectType: { type: "string" },
    subjectId: { type: "string" },
    businessDate: { type: "string" },
    expectedMinor: { type: "string", nullable: true },
    actualMinor: { type: "string", nullable: true },
    differenceMinor: { type: "string", nullable: true },
    currency: { type: "string", nullable: true },
    detail: { type: "object", additionalProperties: true },
    resolutionNote: { type: "string", nullable: true },
    resolvedByUserId: { type: "string", nullable: true },
    resolvedAt: { type: "string", nullable: true },
    firstSeenRunId: { type: "string" },
    lastSeenRunId: { type: "string" },
    createdAt: { type: "string" },
  },
};

const anomalyEvent = {
  $id: "AnomalyEvent",
  type: "object",
  required: [
    "id",
    "ruleKey",
    "subjectType",
    "subjectId",
    "windowStart",
    "windowEnd",
    "observed",
    "baseline",
    "threshold",
    "severity",
    "status",
    "detail",
    "acknowledgedByUserId",
    "acknowledgedAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    ruleKey: { type: "string" },
    subjectType: { type: "string" },
    subjectId: { type: "string" },
    windowStart: { type: "string" },
    windowEnd: { type: "string" },
    observed: { type: "string" },
    baseline: { type: "string" },
    threshold: { type: "string" },
    severity: { type: "string", enum: ["warning", "info"] },
    status: { type: "string", enum: ["open", "acknowledged"] },
    detail: { type: "object", additionalProperties: true },
    acknowledgedByUserId: { type: "string", nullable: true },
    acknowledgedAt: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
};

const reportColumn = {
  $id: "ReportColumn",
  type: "object",
  required: ["key", "header", "kind"],
  properties: {
    key: { type: "string" },
    header: { type: "string" },
    kind: { type: "string", enum: ["money", "count", "text"] },
  },
};

const reversalRequest = {
  $id: "ReversalRequest",
  type: "object",
  required: [
    "id",
    "originalTransactionId",
    "reason",
    "status",
    "requestedByUserId",
    "approvedByUserId",
    "rejectedByUserId",
    "approvedAt",
    "rejectedAt",
    "reversingTransactionId",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    originalTransactionId: { type: "string" },
    reason: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "rejected"] },
    requestedByUserId: { type: "string" },
    approvedByUserId: { type: "string", nullable: true },
    rejectedByUserId: { type: "string", nullable: true },
    approvedAt: { type: "string", nullable: true },
    rejectedAt: { type: "string", nullable: true },
    reversingTransactionId: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
};

/** Component schemas registered once; routes reference them via $ref. */
export const sharedSchemas: readonly Record<string, unknown>[] = [
  staffUser,
  asset,
  owner,
  payment,
  outboxMessage,
  auditEntry,
  errorEnvelopeSchema,
  cashWallet,
  cashIntake,
  cashDeposit,
  reconciliationChecklistItem,
  reconciliationRun,
  reconciliationException,
  anomalyEvent,
  reportColumn,
  reversalRequest,
];

export const errorResponseSchema = { $ref: "ErrorEnvelope#" };

const deviceObject = {
  type: "object",
  required: ["deviceId", "platform"],
  properties: {
    deviceId: { type: "string" },
    platform: { type: "string" },
  },
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const photoParams = {
  type: "object",
  required: ["id", "photoId"],
  properties: { id: { type: "string" }, photoId: { type: "string" } },
} as const;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const healthSchema: FastifySchema = {
  response: {
    200: {
      type: "object",
      required: ["status", "service", "region", "version"],
      properties: {
        status: { type: "string", enum: ["ok"] },
        service: { type: "string" },
        region: { type: "string" },
        version: { type: "string" },
      },
    },
  },
};

export const readySchema: FastifySchema = {
  response: {
    200: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["ready"] } },
    },
    503: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["not_ready"] } },
    },
  },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const authLoginSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["tenantSlug", "username", "password"],
    properties: {
      tenantSlug: { type: "string" },
      username: { type: "string" },
      password: { type: "string" },
      totpCode: { type: "string" },
      device: deviceObject,
    },
  },
  response: { 200: session },
};

export const authRefreshSchema: FastifySchema = {
  response: { 200: session },
};

export const authLogoutSchema: FastifySchema = {
  // 204 sends no body; declaring one would risk serializer surprises.
};

export const authMeSchema: FastifySchema = {
  // /me returns the session user augmented with resolved permissions.
  response: {
    200: {
      type: "object",
      required: ["userId", "tenantId", "displayName", "roles", "permissions"],
      properties: {
        userId: { type: "string" },
        tenantId: { type: "string" },
        displayName: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        permissions: { type: "array", items: { type: "string" } },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tenant config (document payload passes through; validation is authoritative)
// ---------------------------------------------------------------------------

export const tenantConfigPutSchema: FastifySchema = {
  body: { type: "object" },
};

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const createAssetSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["assetTypeKey", "attributes"],
    properties: {
      assetTypeKey: { type: "string" },
      attributes: { type: "object", additionalProperties: true },
      zoneId: { type: "string" },
      ownerId: { type: "string" },
      owner: {
        type: "object",
        required: ["displayName", "phone"],
        properties: { displayName: { type: "string" }, phone: { type: "string" } },
      },
    },
  },
  response: {
    201: { type: "object", required: ["asset"], properties: { asset: { $ref: "Asset#" } } },
  },
};

export const searchAssetsSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      limit: { type: "string" },
      offset: { type: "string" },
      query: { type: "string" },
      assetTypeKey: { type: "string" },
      status: { type: "string" },
      zoneId: { type: "string" },
      ownerId: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["assets"],
      properties: { assets: { type: "array", items: { $ref: "Asset#" } } },
    },
  },
};

export const getAssetSchema: FastifySchema = {
  params: idParams,
  response: {
    200: {
      type: "object",
      required: ["asset", "photos"],
      properties: {
        asset: { $ref: "Asset#" },
        photos: { type: "array", items: photoRef },
      },
    },
  },
};

/** Photo and sticker bodies are binary/SVG streams; only params are declared. */
export const attachPhotoSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["contentType", "content"],
    properties: { contentType: { type: "string" }, content: { type: "string" } },
  },
  response: { 201: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
};

export const photoParamsSchema: FastifySchema = { params: photoParams };

export const stickerSchema: FastifySchema = { params: idParams };

export const suspendAssetSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["reason"],
    properties: { reason: { type: "string" } },
  },
  response: {
    200: { type: "object", required: ["asset"], properties: { asset: { $ref: "Asset#" } } },
  },
};

export const correctAssetSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["attributes"],
    properties: { attributes: { type: "object", additionalProperties: true } },
  },
  response: {
    200: { type: "object", required: ["asset"], properties: { asset: { $ref: "Asset#" } } },
  },
};

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

export const createOwnerSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["displayName", "phone"],
    properties: { displayName: { type: "string" }, phone: { type: "string" } },
  },
  response: {
    201: { type: "object", required: ["owner"], properties: { owner: { $ref: "Owner#" } } },
  },
};

export const getOwnerSchema: FastifySchema = {
  params: idParams,
  response: {
    200: { type: "object", required: ["owner"], properties: { owner: { $ref: "Owner#" } } },
  },
};

export const requestOwnerVerifySchema: FastifySchema = {
  body: {
    type: "object",
    properties: { ownerId: { type: "string" }, phone: { type: "string" } },
  },
  response: {
    200: { type: "object", required: ["sent"], properties: { sent: { type: "boolean" } } },
  },
};

export const confirmOwnerVerifySchema: FastifySchema = {
  body: {
    type: "object",
    required: ["ownerId", "code"],
    properties: { ownerId: { type: "string" }, code: { type: "string" } },
  },
  response: {
    200: { type: "object", required: ["owner"], properties: { owner: { $ref: "Owner#" } } },
  },
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const paymentList = {
  type: "object",
  required: ["payments"],
  properties: { payments: { type: "array", items: { $ref: "Payment#" } } },
} as const;

export const listPaymentsSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: { status: { type: "string" }, limit: { type: "string" } },
  },
  response: { 200: paymentList },
};

export const listSuspenseSchema: FastifySchema = {
  querystring: { type: "object", properties: { limit: { type: "string" } } },
  response: { 200: paymentList },
};

export const listOutboxSchema: FastifySchema = {
  params: idParams,
  response: {
    200: {
      type: "object",
      required: ["messages"],
      properties: { messages: { type: "array", items: { $ref: "OutboxMessage#" } } },
    },
  },
};

export const resolveSuspenseSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["assetId"],
    properties: { assetId: { type: "string" } },
  },
  response: {
    200: { type: "object", required: ["payment"], properties: { payment: { $ref: "Payment#" } } },
  },
};

// ---------------------------------------------------------------------------
// Audit (Step 6)
// ---------------------------------------------------------------------------

/** Parses a cursor of the form `<ISO createdAt>|<id>`; null → first page. */
export function parseAuditCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const separator = raw.lastIndexOf("|");
  if (separator <= 0) return undefined;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id === "") return undefined;
  return { createdAt, id };
}

export const listAuditSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      limit: { type: "string" },
      cursor: { type: "string" },
      action: { type: "string" },
      kind: { type: "string" },
      actor: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["entries", "nextCursor"],
      properties: {
        entries: { type: "array", items: { $ref: "AuditEntry#" } },
        nextCursor: { type: "string", nullable: true },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const verifyTokenSchema: FastifySchema = {
  params: {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: [
        "status",
        "assetTypeKey",
        "assetTypeLabel",
        "shortCode",
        "attributes",
        "photos",
        "paymentStatus",
        "businessDate",
      ],
      properties: {
        status: { type: "string" },
        assetTypeKey: { type: "string" },
        assetTypeLabel: { type: "string" },
        shortCode: { type: "string" },
        attributes: { type: "object", additionalProperties: true },
        photos: { type: "array", items: photoRef },
        paymentStatus: { type: "string", enum: ["paid", "no_payment_recorded", "unknown"] },
        businessDate: { type: "string" },
      },
    },
    429: errorResponseSchema,
  },
};

export const verificationSearchSchema: FastifySchema = {
  querystring: {
    type: "object",
    required: ["q"],
    properties: { q: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            required: [
              "assetId",
              "assetTypeKey",
              "status",
              "shortCode",
              "attributes",
              "paymentStatus",
              "businessDate",
            ],
            properties: {
              assetId: { type: "string" },
              assetTypeKey: { type: "string" },
              status: { type: "string" },
              shortCode: { type: "string" },
              attributes: { type: "object", additionalProperties: true },
              paymentStatus: { type: "string", enum: ["paid", "no_payment_recorded", "unknown"] },
              businessDate: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export const syncPaidSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      since: { type: "string" },
      limit: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["mode", "businessDate", "entries", "nextCursor", "hasMore", "serverTime"],
      properties: {
        mode: { type: "string", enum: ["snapshot", "delta"] },
        businessDate: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            required: [
              "assetId",
              "qrPayload",
              "shortCode",
              "assetTypeKey",
              "attributes",
              "paid",
              "changedAt",
            ],
            properties: {
              assetId: { type: "string" },
              qrPayload: { type: "string" },
              shortCode: { type: "string" },
              assetTypeKey: { type: "string" },
              attributes: { type: "object", additionalProperties: true },
              paid: { type: "boolean" },
              changedAt: { type: "string" },
            },
          },
        },
        nextCursor: { type: "string", nullable: true },
        hasMore: { type: "boolean" },
        serverTime: { type: "string" },
      },
    },
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const createScanSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["clientScanId", "source", "scannedAt"],
    properties: {
      clientScanId: { type: "string" },
      source: { type: "string", enum: ["qr", "manual", "offline_queue"] },
      token: { type: "string" },
      reference: { type: "string" },
      assetId: { type: "string" },
      scannedAt: { type: "string" },
      observedStatus: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
    },
  },
  response: {
    200: {
      type: "object",
      required: [
        "scanId",
        "assetId",
        "businessDate",
        "observedStatus",
        "authoritativeStatus",
        "paymentStatus",
      ],
      properties: {
        scanId: { type: "string" },
        assetId: { type: "string" },
        businessDate: { type: "string" },
        observedStatus: { type: "string" },
        authoritativeStatus: { type: "string", enum: ["paid", "no_payment_recorded", "unknown"] },
        paymentStatus: { type: "string", enum: ["paid", "no_payment_recorded", "unknown"] },
        shortCode: { type: "string" },
        attributes: { type: "object", additionalProperties: true },
      },
    },
  },
};

export const listScansSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      cursor: { type: "string" },
      limit: { type: "string" },
      officerUserId: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["scans", "nextCursor", "hasMore"],
      properties: {
        scans: { type: "array", items: { type: "object", additionalProperties: true } },
        nextCursor: { type: "string", nullable: true },
        hasMore: { type: "boolean" },
      },
    },
  },
};

export const createDisputeSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["clientDisputeId", "reason", "description", "occurredAt"],
    properties: {
      clientDisputeId: { type: "string" },
      assetId: { type: "string" },
      reference: { type: "string" },
      reason: { type: "string" },
      description: { type: "string" },
      occurredAt: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
      evidence: {
        type: "object",
        required: ["contentType", "contentBase64"],
        properties: {
          contentType: { type: "string" },
          contentBase64: { type: "string" },
        },
      },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["disputeId", "status"],
      properties: {
        disputeId: { type: "string" },
        status: { type: "string" },
      },
    },
    403: errorResponseSchema,
  },
};

export const listDisputesSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      cursor: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["disputes", "nextCursor", "hasMore"],
      properties: {
        disputes: { type: "array", items: { type: "object", additionalProperties: true } },
        nextCursor: { type: "string", nullable: true },
        hasMore: { type: "boolean" },
      },
    },
  },
};

export const getDisputeSchema: FastifySchema = {
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  response: {
    200: {
      type: "object",
      required: ["dispute"],
      properties: { dispute: { type: "object", additionalProperties: true } },
    },
  },
};

// ---------------------------------------------------------------------------
// Collector cash (Phase 7, Step 7)
// ---------------------------------------------------------------------------

const collectorParams = {
  type: "object",
  required: ["collectorUserId"],
  properties: { collectorUserId: { type: "string" } },
} as const;

const cashPageQuery = {
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "string" },
    collectorUserId: { type: "string" },
    status: { type: "string" },
  },
} as const;

export const createCashIntakeSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["collectorUserId", "clientReference", "amountMinor"],
    properties: {
      collectorUserId: { type: "string" },
      clientReference: { type: "string" },
      /** Integer minor units as a string; the fee engine checks the exact amount. */
      amountMinor: { type: "string" },
      currency: { type: "string" },
      assetId: { type: "string" },
      token: { type: "string" },
      reference: { type: "string" },
      businessDate: { type: "string" },
      zoneId: { type: "string", nullable: true },
    },
  },
  response: {
    200: {
      type: "object",
      required: [
        "intakeId",
        "collectorUserId",
        "assetId",
        "assetRef",
        "receiptNumber",
        "businessDate",
        "balanceMinor",
        "smsQueued",
        "replayed",
      ],
      properties: {
        intakeId: { type: "string" },
        collectorUserId: { type: "string" },
        assetId: { type: "string" },
        assetRef: { type: "string" },
        receiptNumber: { type: "string" },
        businessDate: { type: "string" },
        balanceMinor: { type: "string" },
        smsQueued: { type: "boolean" },
        replayed: { type: "boolean" },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const listCashWalletsSchema: FastifySchema = {
  response: {
    200: {
      type: "object",
      required: ["wallets"],
      properties: { wallets: { type: "array", items: { $ref: "CashWallet#" } } },
    },
  },
};

export const getCashWalletSchema: FastifySchema = {
  params: collectorParams,
  querystring: {
    type: "object",
    properties: { limit: { type: "string" }, cursor: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["wallet", "intakes"],
      properties: {
        wallet: { $ref: "CashWallet#" },
        intakes: { type: "array", items: { $ref: "CashIntake#" } },
        nextCursor: { type: "string", nullable: true },
      },
    },
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const freezeWalletSchema: FastifySchema = {
  params: collectorParams,
  body: {
    type: "object",
    required: ["reason"],
    properties: { reason: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["wallet"],
      properties: { wallet: { $ref: "CashWallet#" } },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const listCashDepositsSchema: FastifySchema = {
  querystring: cashPageQuery,
  response: {
    200: {
      type: "object",
      required: ["deposits", "nextCursor", "hasMore"],
      properties: {
        deposits: { type: "array", items: { $ref: "CashDeposit#" } },
        nextCursor: { type: "string", nullable: true },
        hasMore: { type: "boolean" },
      },
    },
  },
};

export const matchCashDepositSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["intakeId"],
    properties: {
      intakeId: { type: "string" },
      /** Optional cap, in minor units as a string; defaults to what both sides absorb. */
      amountMinor: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: [
        "depositId",
        "outcome",
        "collectorUserId",
        "allocatedMinor",
        "currency",
        "replayed",
      ],
      properties: {
        depositId: { type: "string" },
        outcome: { type: "string", enum: ["matched", "partial", "suspense"] },
        collectorUserId: { type: "string", nullable: true },
        allocatedMinor: { type: "string" },
        currency: { type: "string" },
        replayed: { type: "boolean" },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const reverseCashIntakeSchema: FastifySchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["reason"],
    properties: { reason: { type: "string" } },
  },
  response: {
    202: {
      type: "object",
      required: ["intakeId", "reversalRequestId", "status"],
      properties: {
        intakeId: { type: "string" },
        reversalRequestId: { type: "string" },
        status: { type: "string" },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const provisionDepositInstructionSchema: FastifySchema = {
  params: collectorParams,
  body: {
    type: "object",
    properties: { provider: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["instruction"],
      properties: {
        instruction: {
          type: "object",
          required: ["id", "collectorUserId", "provider", "reference", "kind", "status"],
          properties: {
            id: { type: "string" },
            collectorUserId: { type: "string" },
            provider: { type: "string" },
            reference: { type: "string" },
            kind: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
  },
};

// ---------------------------------------------------------------------------
// Reconciliation, settlement import, reports and anomalies (Phase 8)
// ---------------------------------------------------------------------------

const reconciliationRunParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const reconciliationExceptionParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const anomalyParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

export const importSettlementSchema: FastifySchema = {
  body: {
    type: "object",
    required: ["filename", "content"],
    properties: {
      /** Original file name, kept as evidence on the import row. */
      filename: { type: "string" },
      /** Statement text. The tenant's mapping decides how it is read. */
      content: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: [
        "outcome",
        "importId",
        "fileHash",
        "rowCount",
        "rejectedCount",
        "postedCount",
        "unmatchedCount",
        "skipped",
      ],
      properties: {
        outcome: { type: "string", enum: ["imported", "duplicate"] },
        importId: { type: "string" },
        fileHash: { type: "string" },
        rowCount: { type: "integer" },
        rejectedCount: { type: "integer" },
        postedCount: { type: "integer" },
        unmatchedCount: { type: "integer" },
        skipped: {
          type: "array",
          items: {
            type: "object",
            required: ["rowNumber", "providerReference", "reason"],
            properties: {
              rowNumber: { type: "integer" },
              providerReference: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const listReconciliationRunsSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["runs"],
      properties: { runs: { type: "array", items: { $ref: "ReconciliationRun#" } } },
    },
  },
};

export const getReconciliationRunSchema: FastifySchema = {
  params: reconciliationRunParams,
  response: {
    200: {
      type: "object",
      required: ["run"],
      properties: { run: { $ref: "ReconciliationRun#" } },
    },
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const signOffReconciliationRunSchema: FastifySchema = {
  params: reconciliationRunParams,
  body: {
    type: "object",
    required: ["note"],
    properties: { note: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["run"],
      properties: { run: { $ref: "ReconciliationRun#" } },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const listReconciliationExceptionsSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      status: { type: "string" },
      severity: { type: "string" },
      runId: { type: "string" },
      limit: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["exceptions"],
      properties: {
        exceptions: { type: "array", items: { $ref: "ReconciliationException#" } },
      },
    },
  },
};

export const resolveReconciliationExceptionSchema: FastifySchema = {
  params: reconciliationExceptionParams,
  body: {
    type: "object",
    required: ["note"],
    properties: { note: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["exception"],
      properties: { exception: { $ref: "ReconciliationException#" } },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const listAnomaliesSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: {
      status: { type: "string" },
      ruleKey: { type: "string" },
      limit: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["anomalies"],
      properties: { anomalies: { type: "array", items: { $ref: "AnomalyEvent#" } } },
    },
  },
};

export const acknowledgeAnomalySchema: FastifySchema = {
  params: anomalyParams,
  response: {
    200: {
      type: "object",
      required: ["anomaly"],
      properties: { anomaly: { $ref: "AnomalyEvent#" } },
    },
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const getReportSchema: FastifySchema = {
  querystring: {
    type: "object",
    required: ["from", "to"],
    properties: { from: { type: "string" }, to: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["report"],
      properties: {
        report: {
          type: "object",
          required: ["reportKey", "from", "to", "generatedAt", "columns", "rows", "totals"],
          properties: {
            reportKey: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            generatedAt: { type: "string" },
            columns: { type: "array", items: { $ref: "ReportColumn#" } },
            rows: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            totals: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const exportReportSchema: FastifySchema = {
  querystring: {
    type: "object",
    required: ["from", "to", "format"],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      format: { type: "string", enum: ["csv", "pdf", "xlsx"] },
    },
  },
  // The body is the rendered file with its own content type; a JSON response
  // schema would strip it, so only the error shapes are declared here.
  response: {
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

// ---------------------------------------------------------------------------
// Reversals (dual approval)
// ---------------------------------------------------------------------------

const reversalParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

export const listReversalsSchema: FastifySchema = {
  querystring: {
    type: "object",
    properties: { status: { type: "string" }, limit: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["reversals"],
      properties: {
        reversals: { type: "array", items: { $ref: "ReversalRequest#" } },
      },
    },
    403: errorResponseSchema,
  },
};

export const approveReversalSchema: FastifySchema = {
  params: reversalParams,
  body: {
    type: "object",
    properties: { note: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["reversal", "transactionId"],
      properties: {
        reversal: { $ref: "ReversalRequest#" },
        transactionId: { type: "string" },
      },
    },
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const rejectReversalSchema: FastifySchema = {
  params: reversalParams,
  body: {
    type: "object",
    required: ["reason"],
    properties: { reason: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      required: ["reversal"],
      properties: { reversal: { $ref: "ReversalRequest#" } },
    },
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Query-string ids that end up in a `uuid` column must be validated here: a
 * cast error from Postgres is a 500 with the database's own message, which is
 * both the wrong status and a leak (Phase 10 review, finding F-08).
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
