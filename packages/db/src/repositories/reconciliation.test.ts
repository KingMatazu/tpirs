import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { AnyDb } from "../connection.js";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "../index.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Proves the database half of Phase 8 (ADR 0035–0039): a statement file is
 * identified by its hash, a run is append-only and only signable from
 * `completed`, an open exception is carried forward rather than duplicated, and
 * an anomaly window is recorded once. Also proves the tenant boundary holds for
 * every new table.
 */
describeIntegration("reconciliation repositories (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  let otherTenantId: string;
  let financeUserId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `recon-${stamp}`,
        name: "Recon State",
        legalEntity: "Recon Revenue",
        config: {},
      });
      const other = await repos.tenants.create({
        slug: `recon-other-${stamp}`,
        name: "Other Recon State",
        legalEntity: "Other Recon Revenue",
        config: {},
      });
      tenantId = tenant.id;
      otherTenantId = other.id;

      const finance = await repos.users.create({
        tenantId,
        username: `recon-finance-${stamp}`,
        displayName: "Finance User",
        passwordHash: "test-hash",
        totpSecret: null,
      });
      financeUserId = finance.id;
    });
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.destroy();
    }
  });

  async function recordImport(hash: string, filename = "statement.csv") {
    return withTenant(db, tenantId, async (tx) =>
      repositories(tx).settlementImports.record({
        tenantId,
        provider: "paystack",
        filename,
        fileHash: hash,
        rowCount: 1,
        rejectedCount: 0,
      }),
    );
  }

  async function newRun(businessDate: string) {
    return withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.createRun({
        tenantId,
        businessDate,
        toleranceMinor: 100n,
        feeToleranceMinor: 250n,
      }),
    );
  }

  it("records one statement per file hash, whatever it is called", async () => {
    if (TEST_URL === undefined) return;
    const hash = `hash-${stamp}-a`;

    const first = await recordImport(hash, "monday.csv");
    const second = await recordImport(hash, "monday-copy.csv");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.import.id).toBe(first.import.id);
    expect(second.import.filename).toBe("monday.csv");
    expect(second.import.status).toBe("imported");
  });

  it("keeps the accepted rows of an import once", async () => {
    if (TEST_URL === undefined) return;
    const { import: recorded } = await recordImport(`hash-${stamp}-rows`);

    const row = {
      tenantId,
      importId: recorded.id,
      rowNumber: 2,
      rowHash: `row-${stamp}`,
      providerReference: `PSK-${stamp}`,
      amountMinor: 50_000n,
      feeMinor: 250n,
      currency: "NGN",
      settledAt: new Date("2026-10-27T00:00:00.000Z"),
      description: "Levy 500",
      raw: { narration: "Levy 500" },
    };

    const [inserted, replayed] = await withTenant(db, tenantId, async (tx) => {
      const settlements = repositories(tx).settlements;
      return [await settlements.insertRows([row]), await settlements.insertRows([row])] as const;
    });

    expect(inserted).toHaveLength(1);
    expect(replayed).toHaveLength(0);
    expect(inserted[0]?.amountMinor).toBe(50_000n);
    expect(inserted[0]?.feeMinor).toBe(250n);
    expect(inserted[0]?.status).toBe("unmatched");

    const matched = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).settlements.markExcluded(tenantId, inserted[0]?.id ?? ""),
    );
    expect(matched?.status).toBe("excluded");

    // The money a statement row recorded is evidence and cannot be edited; only
    // matching state may move.
    const tampered = await withSystem(db, async (tx) =>
      tx
        .updateTable("settlementRows")
        .set({ amountMinor: 1n })
        .where("id", "=", inserted[0]?.id ?? "")
        .execute()
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
    );
    expect(tampered).toBeInstanceOf(Error);
    expect(tampered?.message).toContain("immutable");
  });

  it("numbers runs per day and only lets a completed run be signed off", async () => {
    if (TEST_URL === undefined) return;
    const businessDate = "2026-10-27";

    const first = await newRun(businessDate);
    const second = await newRun(businessDate);
    expect(first.runSeq).toBe(1);
    expect(second.runSeq).toBe(2);
    expect(first.status).toBe("running");

    const completed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.completeRun(tenantId, first.id, {
        checklist: [{ key: "provider_settlement", status: "passed" }],
        exceptionCount: 0,
        completedAt: new Date("2026-10-28T01:00:00.000Z"),
      }),
    );
    expect(completed?.status).toBe("completed");

    // A completed run keeps the evidence it was completed with.
    const tampered = await withSystem(db, async (tx) =>
      tx
        .updateTable("reconciliationRuns")
        .set({ checklist: [] })
        .where("id", "=", first.id)
        .execute()
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
    );
    expect(tampered).toBeInstanceOf(Error);
    expect(tampered?.message).toContain("immutable");

    const deleted = await withSystem(db, async (tx) =>
      tx
        .deleteFrom("reconciliationRuns")
        .where("id", "=", first.id)
        .execute()
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
    );
    expect(deleted).toBeInstanceOf(Error);
    expect(deleted?.message).toContain("append-only");

    const signed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.signOff(tenantId, first.id, {
        signedOffByUserId: financeUserId,
        note: "checked against the bank statement",
        signedOffAt: new Date("2026-10-28T09:00:00.000Z"),
      }),
    );
    expect(signed?.status).toBe("signed_off");
    expect(signed?.signedOffByUserId).toBe(financeUserId);

    // Signing off twice changes nothing: the second call finds no `completed`
    // run to move, so the recorded signature stays the first one.
    const resigned = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.signOff(tenantId, first.id, {
        signedOffByUserId: financeUserId,
        note: "second signature",
        signedOffAt: new Date("2026-10-28T10:00:00.000Z"),
      }),
    );
    expect(resigned).toBeUndefined();
    const reread = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.findById(tenantId, first.id),
    );
    expect(reread?.signOffNote).toBe("checked against the bank statement");

    // A running run cannot be signed off directly: completion comes first.
    const premature = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.signOff(tenantId, second.id, {
        signedOffByUserId: financeUserId,
        note: "too early",
        signedOffAt: new Date("2026-10-28T09:05:00.000Z"),
      }),
    );
    expect(premature).toBeUndefined();
  });

  it("carries one open exception forward and opens a new row after resolution", async () => {
    if (TEST_URL === undefined) return;
    const businessDate = "2026-10-26";
    const runOne = await newRun(businessDate);
    const runTwo = await newRun(businessDate);

    const exception = {
      dedupeKey: `provider-variance:${stamp}`,
      kind: "provider_variance",
      severity: "blocking" as const,
      subjectType: "provider",
      subjectId: "paystack",
      expectedMinor: 100_000n,
      actualMinor: 99_500n,
      differenceMinor: 500n,
      currency: "NGN",
      detail: { day: businessDate },
    };

    const [first, second] = await withTenant(db, tenantId, async (tx) => {
      const exceptions = repositories(tx).exceptions;
      return [
        await exceptions.upsertForRun({
          tenantId,
          runId: runOne.id,
          businessDate,
          exceptions: [exception],
        }),
        await exceptions.upsertForRun({
          tenantId,
          runId: runTwo.id,
          businessDate,
          exceptions: [exception],
        }),
      ] as const;
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.runId).toBe(runTwo.id);
    expect(second[0]?.lastSeenRunId).toBe(runTwo.id);
    expect(second[0]?.firstSeenRunId).toBe(runOne.id);

    const open = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).exceptions.list(tenantId, { status: "open" }),
    );
    expect(open).toHaveLength(1);

    const resolved = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).exceptions.resolve(tenantId, first[0]?.id ?? "", {
        status: "resolved",
        note: "bank corrected the statement",
        resolvedByUserId: financeUserId,
        resolvedAt: new Date("2026-10-27T10:00:00.000Z"),
      }),
    );
    expect(resolved?.status).toBe("resolved");

    const again = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).exceptions.upsertForRun({
        tenantId,
        runId: runTwo.id,
        businessDate,
        exceptions: [exception],
      }),
    );
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first[0]?.id);
    expect(again[0]?.status).toBe("open");

    const all = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).exceptions.list(tenantId, {}),
    );
    expect(all).toHaveLength(2);
  });

  it("records an anomaly window once and acknowledges it once", async () => {
    if (TEST_URL === undefined) return;
    const event = {
      ruleKey: "collector_volume_spike",
      subjectType: "collector",
      subjectId: `collector-${stamp}`,
      windowStart: "2026-10-20",
      windowEnd: "2026-10-26",
      observed: "3.5000",
      baseline: "1.2000",
      threshold: "3.0000",
      severity: "warning" as const,
      detail: { zScore: 3.4 },
    };

    const first = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).anomalies.record(tenantId, event),
    );
    const second = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).anomalies.record(tenantId, { ...event, observed: "3.6000" }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.observed).toBe("3.5000");

    const acknowledged = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).anomalies.acknowledge(tenantId, first.event.id, {
        acknowledgedByUserId: financeUserId,
        acknowledgedAt: new Date("2026-10-27T11:00:00.000Z"),
      }),
    );
    expect(acknowledged?.status).toBe("acknowledged");

    const open = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).anomalies.list(tenantId, { status: "open" }),
    );
    expect(open).toHaveLength(0);
  });

  it("cannot see another tenant's runs, exceptions or anomalies", async () => {
    if (TEST_URL === undefined) return;
    const foreign = await withTenant(db, otherTenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        runs: await repos.reconciliation.list(otherTenantId, {}),
        exceptions: await repos.exceptions.list(otherTenantId, {}),
        anomalies: await repos.anomalies.list(otherTenantId, {}),
        imports: await repos.settlementImports.findByHash(
          otherTenantId,
          "paystack",
          `hash-${stamp}-a`,
        ),
      };
    });

    expect(foreign.runs).toHaveLength(0);
    expect(foreign.exceptions).toHaveLength(0);
    expect(foreign.anomalies).toHaveLength(0);
    expect(foreign.imports).toBeUndefined();

    // A transaction scoped to one tenant cannot read the other's rows even when
    // it asks for them by id.
    const crossTenant = await withTenant(db, tenantId, async (tx) =>
      tx
        .selectFrom("reconciliationRuns")
        .selectAll()
        .where("tenantId", "=", otherTenantId)
        .execute(),
    );
    expect(crossTenant).toHaveLength(0);
  });
});
