import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { buildApp } from "../server.js";
import type { AppConfig } from "../config.js";
import { buildServices, makeTenantConfigLoader } from "../services.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createMockCache } from "@tpirs/cache-mock";
import { createMockClock } from "@tpirs/clock-mock";
import { createMockLockService } from "@tpirs/lock-service-mock";
import { createMockObjectStorage } from "@tpirs/object-storage-mock";
import { createMockSecretsProvider } from "@tpirs/secrets-provider-mock";
import { createMockPaymentProvider, mockWebhookSignature } from "@tpirs/payment-provider-mock";
import { createCsvSettlementImport } from "@tpirs/settlement-import-csv";
import { createCsvExportService } from "@tpirs/export-service-csv";
import { createPdfExportService } from "@tpirs/export-service-pdf";
import { createXlsxExportService } from "@tpirs/export-service-xlsx";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { hashPassword } from "@tpirs/crypto";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const appConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
  metricsEnabled: false,
};

const FEE_MINOR = 20_000;

function validConfig(slug: string): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: "Recon API State",
      slug,
      legalEntity: "Recon API Revenue",
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Etc/UTC",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: "Recon API",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#0a5a4a", secondary: "#053b33", accent: "#f2c200" },
      smsSenderId: "RECONAPI",
      receiptHeader: "Recon API",
      receiptFooter: "Thanks",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "RA-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: FEE_MINOR,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [{ port: "PaymentProvider", adapter: "mock" }],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "RECON",
      otpMessageTemplate: "Recon code: {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 5_000_000,
      depositDeadlineHours: 8,
      freezeOnShortfall: true,
    },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: {
      schedule: "0 2 * * *",
      toleranceMinor: 0,
      feeToleranceMinor: 1_000,
      suspenseAgeingDays: 7,
      notifyRole: "finance_admin",
      anomalyRules: [],
      settlementImport: {
        provider: "mock",
        defaultCurrency: "NGN",
        columns: {
          reference: "reference",
          amount: "amount",
          fee: "fee",
          currency: "currency",
          settledAt: "settled_at",
          description: "narration",
        },
        dateFormat: "YYYY-MM-DD",
        amountInMinorUnits: true,
        decimalSeparator: ".",
      },
    },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

function statementCsv(rows: readonly string[]): string {
  return ["reference,amount,fee,currency,settled_at,narration", ...rows].join("\n") + "\n";
}

describeIntegration("api reconciliation, settlement, reports and anomalies (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  let services: Awaited<ReturnType<typeof buildServices>>;
  const slug = `recon-api-${Date.now().toString()}`;
  const password = "recon-api-password";

  let tenantId: string;
  let otherTenantId: string;
  let assetId: string;
  let day15RunId: string;
  let day17RunId: string;
  let day17ExceptionId: string;
  let anomalyId: string;
  let otherRunId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Recon API",
        legalEntity: "Recon API Revenue",
        config: validConfig(slug),
      });
      tenantId = tenant.id;

      const role = async (key: string, permissions: string[]) => {
        const created = await repos.roles.create({
          tenantId: tenant.id,
          key,
          name: key,
          permissions: permissions as never,
        });
        return created.id;
      };
      const financeRole = await role("finance_admin", [
        "reconciliation:read",
        "reconciliation:run",
        "report:read",
      ]);
      const auditorRole = await role("auditor", [
        "reconciliation:read",
        "report:read",
        "audit:read",
      ]);
      const collectorRole = await role("collector", ["asset:read", "cash:intake"]);

      const user = async (username: string, roleId: string) => {
        const created = await repos.users.create({
          tenantId: tenant.id,
          username,
          displayName: username,
          passwordHash,
          totpSecret: null,
        });
        await repos.roles.assignToUser({ tenantId: tenant.id, userId: created.id, roleId });
        return created.id;
      };
      await user("recon.finance", financeRole);
      await user("recon.auditor", auditorRole);
      await user("recon.collector", collectorRole);

      const asset = await repos.assets.create({
        tenantId: tenant.id,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: {},
        qrPayload: `recon-${slug}`,
        qrToken: `recon-token-${slug}`,
        shortCode: "RA1",
        createdByUserId: null,
      });
      assetId = asset.id;

      // A second tenant proves cross-tenant ids fail closed.
      const other = await repos.tenants.create({
        slug: `${slug}-other`.slice(0, 30),
        name: "Other Recon",
        legalEntity: "Other Recon Revenue",
        config: {},
      });
      otherTenantId = other.id;
    });

    services = await buildServices({
      db,
      objectStorage: createMockObjectStorage(),
      secrets: createMockSecretsProvider({ "qr-token-signing-key": "recon-api-qr-key" }),
      sms: createMockSmsProvider(),
      cache: createMockCache(),
      locks: createMockLockService(),
      clock: createMockClock(),
      qrKeyRef: "qr-token-signing-key",
      paymentProviders: { mock: createMockPaymentProvider() },
      settlementReader: createCsvSettlementImport(),
      exporters: {
        csv: createCsvExportService(),
        pdf: createPdfExportService(),
        xlsx: createXlsxExportService(),
      },
    });

    app = await buildApp({
      config: appConfig,
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      services,
      loadConfig: makeTenantConfigLoader(db),
    });
    await app.ready();
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await app.close();
    await db.destroy();
  });

  async function login(username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username, password },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  }

  function auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  /** One gateway levy payment for one asset/day, through the real intake path. */
  async function payLevyDay(day: string): Promise<string> {
    const endpointToken = await services.payment.provisionEndpoint({
      tenantId,
      provider: "mock",
    });
    const intent = await services.payment.createIntent({
      tenantId,
      provider: "mock",
      assetId,
      businessDate: day as never,
    });
    const rawBody = JSON.stringify({
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      providerReference: intent.reference,
      amount: { amount: Number(intent.amountMinor), currency: intent.currency },
      status: "success",
      paidAt: `${day}T12:00:00Z`,
    });
    const result = await services.payment.ingestWebhookEvent({
      provider: "mock",
      endpointToken,
      headers: { "x-signature": mockWebhookSignature(rawBody) },
      rawBody,
    });
    expect(result.outcome).toBe("applied");
    return intent.reference;
  }

  async function runDay(day: string): Promise<string> {
    const run = await services.reconciliation.run({
      tenantId,
      businessDate: day as never,
      timeZone: "Etc/UTC",
      tolerances: {
        toleranceMinor: 0n,
        feeToleranceMinor: 1_000n,
        depositDeadlineHours: 8,
        suspenseAgeingDays: 7,
      },
      actor: { kind: "system" },
    });
    return run.id;
  }

  it("imports a statement, then treats the same bytes as a no-op", async () => {
    const token = await login("recon.finance");
    const reference = await payLevyDay("2026-06-15");
    const content = statementCsv([`${reference},20000,300,NGN,2026-06-15,Settlement`]);

    const first = await app.inject({
      method: "POST",
      url: "/v1/settlements/import",
      headers: auth(token),
      payload: { filename: "june-15.csv", content },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      outcome: string;
      postedCount: number;
      unmatchedCount: number;
      skipped: unknown[];
    };
    expect(firstBody.outcome).toBe("imported");
    expect(firstBody.postedCount).toBe(1);
    expect(firstBody.unmatchedCount).toBe(0);

    const again = await app.inject({
      method: "POST",
      url: "/v1/settlements/import",
      headers: auth(token),
      payload: { filename: "june-15.csv", content },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { outcome: string }).outcome).toBe("duplicate");

    // Clearing drained exactly once: the fee leg posted, the replay did not.
    const balances = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        clearing: await repos.ledger.accountBalance(tenantId, "GATEWAY_CLEARING"),
        fees: await repos.ledger.accountBalance(tenantId, "GATEWAY_FEES"),
      };
    });
    expect(balances.clearing).toBe(0n);
    expect(balances.fees).toBe(0n - 300n);

    day15RunId = await runDay("2026-06-15");
  });

  it("lists runs and signs a clean day off over HTTP", async () => {
    const token = await login("recon.finance");
    const list = await app.inject({
      method: "GET",
      url: "/v1/reconciliation/runs?from=2026-06-15&to=2026-06-15",
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: { id: string; status: string; checklist: unknown[] }[] })
      .runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(day15RunId);
    expect(runs[0]?.status).toBe("completed");
    expect(Array.isArray(runs[0]?.checklist)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/reconciliation/runs/${day15RunId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);

    const signed = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/runs/${day15RunId}/sign-off`,
      headers: auth(token),
      payload: { note: "checked against the bank statement" },
    });
    expect(signed.statusCode).toBe(200);
    expect((signed.json() as { run: { status: string } }).run.status).toBe("signed_off");

    const again = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/runs/${day15RunId}/sign-off`,
      headers: auth(token),
      payload: { note: "again" },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe("run_already_signed_off");

    const missingNote = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/runs/${day15RunId}/sign-off`,
      headers: auth(token),
      payload: {},
    });
    expect(missingNote.statusCode).toBe(400);
  });

  it("refuses rows the evidence cannot support and queues them as exceptions", async () => {
    const token = await login("recon.finance");
    const gapReference = await payLevyDay("2026-06-16");
    const overReference = await payLevyDay("2026-06-17");

    const summary = await app.inject({
      method: "POST",
      url: "/v1/settlements/import",
      headers: auth(token),
      payload: {
        filename: "discrepancies.csv",
        content: statementCsv([
          // The gateway kept more than the tolerance allows.
          `${gapReference},20000,3000,NGN,2026-06-16,Gap`,
          // The bank received more than the driver was charged.
          `${overReference},21000,0,NGN,2026-06-17,Over`,
          // A reference no payment ever carried.
          "ghost-ref,5000,0,NGN,2026-06-17,Ghost",
        ]),
      },
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      postedCount: number;
      unmatchedCount: number;
      skipped: { providerReference: string; reason: string }[];
    };
    expect(body.postedCount).toBe(0);
    expect(body.unmatchedCount).toBe(3);
    const reasons = new Map(body.skipped.map((row) => [row.providerReference, row.reason]));
    expect(reasons.get(gapReference)).toBe("fee_beyond_tolerance");
    expect(reasons.get(overReference)).toBe("over_settlement");
    expect(reasons.get("ghost-ref")).toBe("no_unique_payment");

    // The day with unmatched rows completes with blocking exceptions, and the
    // queue refuses sign-off until finance resolves them.
    day17RunId = await runDay("2026-06-17");
    const open = await app.inject({
      method: "GET",
      url: "/v1/reconciliation/exceptions?status=open",
      headers: auth(token),
    });
    expect(open.statusCode).toBe(200);
    const exceptions = (
      open.json() as {
        exceptions: { id: string; kind: string; severity: string; status: string }[];
      }
    ).exceptions;
    const blocking = exceptions.filter((row) => row.kind === "settlement_rows_matched");
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking.every((row) => row.severity === "blocking")).toBe(true);
    day17ExceptionId = blocking[0]?.id ?? "";

    const refused = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/runs/${day17RunId}/sign-off`,
      headers: auth(token),
      payload: { note: "trying anyway" },
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("blocking_exceptions");

    const noNote = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/exceptions/${day17ExceptionId}/resolve`,
      headers: auth(token),
      payload: { note: "   " },
    });
    expect(noNote.statusCode).toBe(400);

    const resolved = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/exceptions/${day17ExceptionId}/resolve`,
      headers: auth(token),
      payload: { note: "statement line belongs to another tenant" },
    });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { exception: { status: string } }).exception.status).toBe(
      "resolved",
    );

    // The day still cannot be signed off: an unposted payment leaves gateway
    // money in clearing, which is its own blocking exception. That is the
    // honest outcome for a day whose statement could not be settled.
    const stillBlocked = await app.inject({
      method: "POST",
      url: `/v1/reconciliation/runs/${day17RunId}/sign-off`,
      headers: auth(token),
      payload: { note: "resolved the row, but clearing is still open" },
    });
    expect(stillBlocked.statusCode).toBe(409);
    expect((stillBlocked.json() as { error: { code: string } }).error.code).toBe(
      "blocking_exceptions",
    );
  });

  it("serves reports and exports, refusing oversized ranges", async () => {
    const token = await login("recon.auditor");

    const daily = await app.inject({
      method: "GET",
      url: "/v1/reports/daily_collections?from=2026-06-15&to=2026-06-15",
      headers: auth(token),
    });
    expect(daily.statusCode).toBe(200);
    const report = (
      daily.json() as {
        report: {
          reportKey: string;
          rows: Record<string, unknown>[];
          totals: Record<string, string>;
          columns: { key: string }[];
        };
      }
    ).report;
    expect(report.reportKey).toBe("daily_collections");
    expect(report.rows[0]?.["revenueMinor"]).toBe("20000");
    expect(report.totals["revenueMinor"]).toBe("20000");
    expect(report.columns.some((column) => column.key === "revenueMinor")).toBe(true);

    const exported = await app.inject({
      method: "GET",
      url: "/v1/reports/daily_collections/export?from=2026-06-15&to=2026-06-15&format=csv",
      headers: auth(token),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.headers["content-disposition"]).toContain(
      'filename="daily_collections-2026-06-15-2026-06-15.csv"',
    );
    expect(exported.body).toContain("revenueMinor");

    const tooWide = await app.inject({
      method: "GET",
      url: "/v1/reports/daily_collections?from=2026-01-01&to=2026-06-15",
      headers: auth(token),
    });
    expect(tooWide.statusCode).toBe(400);
    expect((tooWide.json() as { error: { code: string } }).error.code).toBe("range_too_large");

    const unknown = await app.inject({
      method: "GET",
      url: "/v1/reports/no_such_report?from=2026-06-15&to=2026-06-15",
      headers: auth(token),
    });
    expect(unknown.statusCode).toBe(404);

    const badFormat = await app.inject({
      method: "GET",
      url: "/v1/reports/daily_collections/export?from=2026-06-15&to=2026-06-15&format=docx",
      headers: auth(token),
    });
    expect(badFormat.statusCode).toBe(400);
  });

  it("lists and acknowledges anomalies", async () => {
    const finance = await login("recon.finance");
    const auditor = await login("recon.auditor");

    const recorded = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).anomalies.record(tenantId, {
        ruleKey: "suspense_growth",
        subjectType: "tenant",
        subjectId: tenantId,
        windowStart: "2026-06-10",
        windowEnd: "2026-06-16",
        observed: "7777",
        baseline: "0",
        threshold: "5000",
        severity: "warning",
        detail: { note: "suspense above ceiling" },
      }),
    );
    anomalyId = recorded.event.id;

    const listed = await app.inject({
      method: "GET",
      url: "/v1/anomalies?status=open",
      headers: auth(auditor),
    });
    expect(listed.statusCode).toBe(200);
    const anomalies = (listed.json() as { anomalies: { id: string; ruleKey: string }[] }).anomalies;
    expect(anomalies.some((row) => row.id === anomalyId)).toBe(true);

    const auditorCannotAcknowledge = await app.inject({
      method: "POST",
      url: `/v1/anomalies/${anomalyId}/acknowledge`,
      headers: auth(auditor),
    });
    expect(auditorCannotAcknowledge.statusCode).toBe(403);

    const acknowledged = await app.inject({
      method: "POST",
      url: `/v1/anomalies/${anomalyId}/acknowledge`,
      headers: auth(finance),
    });
    expect(acknowledged.statusCode).toBe(200);
    expect((acknowledged.json() as { anomaly: { status: string } }).anomaly.status).toBe(
      "acknowledged",
    );
  });

  it("lets an auditor read but never mutate, and hides other tenants' runs", async () => {
    const auditor = await login("recon.auditor");
    const collector = await login("recon.collector");

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/reconciliation/runs",
          headers: auth(auditor),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/settlements/import",
          headers: auth(auditor),
          payload: { filename: "x.csv", content: "reference\n" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/reconciliation/runs/${day15RunId}/sign-off`,
          headers: auth(auditor),
          payload: { note: "auditor note" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/reconciliation/exceptions/${day17ExceptionId}/waive`,
          headers: auth(auditor),
          payload: { note: "auditor waive" },
        })
      ).statusCode,
    ).toBe(403);

    // A collector has no reconciliation permission at all.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/reconciliation/runs",
          headers: auth(collector),
        })
      ).statusCode,
    ).toBe(403);

    // A run belonging to another tenant is not found, never forbidden-with-data.
    otherRunId = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const run = await repos.reconciliation.createRun({
        tenantId: otherTenantId,
        businessDate: "2026-06-15",
        toleranceMinor: 0n,
        feeToleranceMinor: 0n,
      });
      await repos.reconciliation.completeRun(otherTenantId, run.id, {
        checklist: [],
        exceptionCount: 0,
        completedAt: new Date(),
      });
      return run.id;
    });
    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/reconciliation/runs/${otherRunId}`,
      headers: auth(auditor),
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});
