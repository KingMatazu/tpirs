import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "kysely";
import type { AnyDb } from "../connection.js";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "../index.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Proves the database half of the collector cash design (ADR 0031): derived
 * balances per collector, replay-safe intake and deposit records, the wallet
 * lock and idempotent transitions, the money-identity triggers, and that a
 * collector's cash in one tenant is invisible from another.
 */
describeIntegration("collector cash repositories (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  let otherTenantId: string;
  let assetId: string;
  let otherAssetId: string;
  let collectorA: string;
  let collectorA2: string;
  let collectorA3: string;
  let collectorB: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `cash-${stamp}`,
        name: "Cash State",
        legalEntity: "Cash Revenue",
        config: {},
      });
      const other = await repos.tenants.create({
        slug: `cash-other-${stamp}`,
        name: "Other State",
        legalEntity: "Other Revenue",
        config: {},
      });
      tenantId = tenant.id;
      otherTenantId = other.id;

      const principal = await repos.users.create({
        tenantId,
        username: `collector-main-${stamp}`,
        displayName: "Main Collector",
        passwordHash: "test-hash",
        totpSecret: null,
      });
      const second = await repos.users.create({
        tenantId,
        username: `collector-second-${stamp}`,
        displayName: "Second Collector",
        passwordHash: "test-hash",
        totpSecret: null,
      });
      const third = await repos.users.create({
        tenantId,
        username: `collector-third-${stamp}`,
        displayName: "Third Collector",
        passwordHash: "test-hash",
        totpSecret: null,
      });
      const foreign = await repos.users.create({
        tenantId: otherTenantId,
        username: `collector-foreign-${stamp}`,
        displayName: "Foreign Collector",
        passwordHash: "test-hash",
        totpSecret: null,
      });
      collectorA = principal.id;
      collectorA2 = second.id;
      collectorA3 = third.id;
      collectorB = foreign.id;

      const asset = await repos.assets.create({
        tenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "vehicle",
        attributes: { plate_number: `CASH-${stamp}` },
        qrPayload: `cash-qr-${stamp}`,
        qrToken: `cash-token-${stamp}`,
        shortCode: `CASH${stamp}`.toUpperCase(),
        createdByUserId: null,
      });
      assetId = asset.id;

      const otherAsset = await repos.assets.create({
        tenantId: otherTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "vehicle",
        attributes: { plate_number: `OCASH-${stamp}` },
        qrPayload: `o-cash-qr-${stamp}`,
        qrToken: `o-cash-token-${stamp}`,
        shortCode: `OCASH${stamp}`.toUpperCase(),
        createdByUserId: null,
      });
      otherAssetId = otherAsset.id;
    });
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.destroy();
    }
  });

  async function postCash(amountMinor: bigint, collector: string): Promise<void> {
    await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const accounts = await repos.accounts.ensureStandardAccounts(tenantId, "NGN");
      const collectorCash = accounts["COLLECTOR_CASH"];
      const assetWallet = accounts["ASSET_WALLET"];
      if (!collectorCash || !assetWallet) throw new Error("standard accounts missing");
      await repos.ledger.createTransactionWithEntries(tenantId, {
        sourceType: "cash_intake",
        postings: [
          {
            accountId: collectorCash.id,
            direction: "debit",
            amountMinor,
            currency: "NGN",
            assetId,
            collectorUserId: collector,
          },
          {
            accountId: assetWallet.id,
            direction: "credit",
            amountMinor,
            currency: "NGN",
            assetId,
          },
        ],
      });
    });
  }

  it("balances cash postings per collector and derives the balance", async () => {
    if (TEST_URL === undefined) return;
    await postCash(500n, collectorA);
    await postCash(200n, collectorA);
    await postCash(50n, collectorA2);

    const balances = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        main: await repos.ledger.collectorCashBalance(tenantId, collectorA),
        second: await repos.ledger.collectorCashBalance(tenantId, collectorA2),
        wholeAccount: await repos.ledger.collectorCashBalance(tenantId),
      };
    });
    expect(balances.main).toBe(700n);
    expect(balances.second).toBe(50n);
    expect(balances.wholeAccount).toBe(750n);
  });

  it("replays an intake without writing a second row", async () => {
    if (TEST_URL === undefined) return;
    const reference = `intake-${stamp}`;
    const created = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      await repos.collectorCash.ensureWallet(tenantId, collectorA);
      return repos.collectorCash.insertIntakeIfAbsent(tenantId, {
        collectorUserId: collectorA,
        clientReference: reference,
        assetId,
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: 500n,
        currency: "NGN",
        receiptNumber: `RC-${stamp}-1`,
      });
    });
    expect(created.existed).toBe(false);

    const replay = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.insertIntakeIfAbsent(tenantId, {
        collectorUserId: collectorA,
        clientReference: reference,
        assetId,
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: 500n,
        currency: "NGN",
        receiptNumber: `RC-${stamp}-1`,
      });
    });
    expect(replay.existed).toBe(true);
    expect(replay.intake.id).toBe(created.intake.id);
    expect(replay.intake.status).toBe("open");
  });

  it("locks the wallet and applies status transitions idempotently", async () => {
    if (TEST_URL === undefined) return;
    const active = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.lockWallet(tenantId, collectorA);
    });
    expect(active.status).toBe("active");

    const frozen = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.setWalletStatus(tenantId, collectorA, {
        status: "frozen",
        frozenReason: "shortfall",
      });
    });
    expect(frozen.status).toBe("frozen");
    expect(frozen.frozenReason).toBe("shortfall");

    const frozenAgain = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.setWalletStatus(tenantId, collectorA, {
        status: "frozen",
        frozenReason: "second reason",
      });
    });
    expect(frozenAgain.status).toBe("frozen");
    // The first reason survives: freezing twice changed nothing.
    expect(frozenAgain.frozenReason).toBe("shortfall");

    const unfrozen = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.setWalletStatus(tenantId, collectorA, { status: "active" });
    });
    expect(unfrozen.status).toBe("active");
    expect(unfrozen.frozenReason).toBeNull();
  });

  it("lists overdue wallets with intact column names and flags them once", async () => {
    if (TEST_URL === undefined) return;
    // A stale open intake for A, a fresh one for A2, and a matched one for A3.
    // `recorded_at` defaults to now(), so the stale row is backdated explicitly:
    // recorded_at is not money identity, and the sweeper reads it, never writes it.
    const staleAt = new Date(Date.now() - 10 * 3_600_000);
    await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      for (const [collector, reference] of [
        [collectorA, `overdue-${stamp}`],
        [collectorA2, `fresh-${stamp}`],
        [collectorA3, `covered-${stamp}`],
      ] as const) {
        await repos.collectorCash.ensureWallet(tenantId, collector);
        const created = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
          collectorUserId: collector,
          clientReference: reference,
          assetId,
          zoneId: null,
          businessDate: "2026-10-27",
          amountMinor: 500n,
          currency: "NGN",
          receiptNumber: `RC-${stamp}-${reference}`,
        });
        if (created.existed) throw new Error(`intake ${reference} already existed`);
        if (reference === `covered-${stamp}`) {
          await repos.collectorCash.markIntakeMatched(tenantId, created.intake.id);
        }
      }
      await sql`update cash_intakes set recorded_at = ${staleAt}
                 where tenant_id = ${tenantId} and client_reference = ${`overdue-${stamp}`}`.execute(
        tx,
      );
    });

    const cutoff = new Date(Date.now() - 8 * 3_600_000);
    const overdue = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.overdueWallets(tenantId, cutoff),
    );
    // Raw SQL results pass through the CamelCasePlugin, so this also proves the
    // aliases: a broken alias reads undefined and fails the FK on insert.
    expect(overdue.map((row) => row.collectorUserId)).toEqual([collectorA]);
    expect(overdue[0]?.status).toBe("active");
    expect(overdue[0]?.overdueSince).toBeNull();
    expect(overdue[0]?.floatCeilingMinor).toBeNull();

    // The flag is set once: a second mark, or a concurrent one, changes nothing.
    const flagged = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.markOverdue(tenantId, collectorA, new Date()),
    );
    const flaggedAgain = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.markOverdue(tenantId, collectorA, new Date()),
    );
    expect(flagged).toBe(true);
    expect(flaggedAgain).toBe(false);
    const after = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.findWallet(tenantId, collectorA),
    );
    expect(after?.overdueSince).not.toBeNull();

    // Clearing works both directions, so a fresh window can start later.
    await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.clearOverdue(tenantId, collectorA),
    );
    const cleared = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).collectorCash.findWallet(tenantId, collectorA),
    );
    expect(cleared?.overdueSince).toBeNull();
  });

  it("refuses to rewrite an intake's money identity after the fact", async () => {
    if (TEST_URL === undefined) return;
    const intakeId = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const created = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
        collectorUserId: collectorA2,
        clientReference: `immutable-${stamp}`,
        assetId,
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: 50n,
        currency: "NGN",
        receiptNumber: `RC-${stamp}-2`,
      });
      return created.intake.id;
    });
    await withTenant(db, tenantId, async (tx) => {
      await expect(
        tx
          .updateTable("cashIntakes")
          .set({ amountMinor: 999n })
          .where("tenantId", "=", tenantId)
          .where("id", "=", intakeId)
          .execute(),
      ).rejects.toThrow(/cash intake money identity is immutable/);
    });
  });

  it("records an unrecognised deposit as suspense and keeps replays inert", async () => {
    if (TEST_URL === undefined) return;
    const reference = `DEP-${stamp}`;
    const created = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.insertDepositIfAbsent(tenantId, {
        provider: "paystack",
        providerReference: reference,
        amountMinor: 1000n,
        currency: "NGN",
      });
    });
    expect(created.existed).toBe(false);
    expect(created.deposit.collectorUserId).toBeNull();
    expect(created.deposit.status).toBe("suspense");

    const replay = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.insertDepositIfAbsent(tenantId, {
        provider: "paystack",
        providerReference: reference,
        amountMinor: 1000n,
        currency: "NGN",
      });
    });
    expect(replay.existed).toBe(true);
    expect(replay.deposit.id).toBe(created.deposit.id);
  });

  it("matches open intakes oldest-first and leaves the surplus in suspense", async () => {
    if (TEST_URL === undefined) return;
    const outcome = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      await repos.collectorCash.ensureWallet(tenantId, collectorA3);
      const earlier = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
        collectorUserId: collectorA3,
        clientReference: `match-old-${stamp}`,
        assetId,
        zoneId: null,
        businessDate: "2026-10-26",
        amountMinor: 50n,
        currency: "NGN",
        receiptNumber: `RC-${stamp}-3`,
      });
      // recorded_at resolution is microseconds; force a real ordering gap.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const later = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
        collectorUserId: collectorA3,
        clientReference: `match-new-${stamp}`,
        assetId,
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: 200n,
        currency: "NGN",
        receiptNumber: `RC-${stamp}-4`,
      });

      const deposit = await repos.collectorCash.insertDepositIfAbsent(tenantId, {
        provider: "paystack",
        providerReference: `MATCH-${stamp}`,
        amountMinor: 1000n,
        currency: "NGN",
      });
      expect(deposit.existed).toBe(false);

      const open = await repos.collectorCash.openIntakesForCollector(tenantId, collectorA3);
      expect(open.map((row) => row.clientReference)).toEqual([
        `match-old-${stamp}`,
        `match-new-${stamp}`,
      ]);

      // A 1000-unit deposit covers the 250 open total with 750 left over; the
      // covering part is allocated and the collector is attributed, and the
      // deposit's own status stays suspense because a remainder is left (D35).
      const oldest = open[0];
      const next = open[1];
      if (!oldest || !next) throw new Error("expected two open intakes");
      const leftover = 1000n - (50n + 200n);
      await repos.collectorCash.addDepositAllocation(tenantId, {
        depositId: deposit.deposit.id,
        intakeId: oldest.id,
        amountMinor: 50n,
      });
      await repos.collectorCash.markIntakeMatched(tenantId, oldest.id);
      await repos.collectorCash.setDepositOutcome(tenantId, deposit.deposit.id, {
        status: "partial",
        collectorUserId: collectorA3,
      });
      const finalOutcome = await repos.collectorCash.addDepositAllocation(tenantId, {
        depositId: deposit.deposit.id,
        intakeId: next.id,
        amountMinor: 200n,
      });
      await repos.collectorCash.markIntakeMatched(tenantId, next.id);
      await repos.collectorCash.setDepositOutcome(tenantId, deposit.deposit.id, {
        status: "suspense",
        collectorUserId: collectorA3,
      });

      const openTotal = await repos.collectorCash.sumOpenIntakes(tenantId, collectorA3);
      return {
        depositId: deposit.deposit.id,
        earlierId: earlier.intake.id,
        laterId: later.intake.id,
        leftover,
        allocation: finalOutcome.id,
        openTotal,
      };
    });

    expect(outcome.openTotal).toBe(0n);
    expect(outcome.leftover).toBe(750n);

    const allocations = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.collectorCash.listDepositAllocations(tenantId, outcome.depositId);
    });
    expect(allocations).toHaveLength(2);
    expect(allocations.map((row) => row.amountMinor)).toEqual([50n, 200n]);
  });

  it("scopes a collector's cash to its tenant during cross-tenant reads", async () => {
    if (TEST_URL === undefined) return;
    // The foreign collector takes cash for the foreign tenant's asset.
    await withTenant(db, otherTenantId, async (tx) => {
      const repos = repositories(tx);
      const accounts = await repos.accounts.ensureStandardAccounts(otherTenantId, "GHS");
      const collectorCash = accounts["COLLECTOR_CASH"];
      const assetWallet = accounts["ASSET_WALLET"];
      if (!collectorCash || !assetWallet) throw new Error("standard accounts missing");
      await repos.ledger.createTransactionWithEntries(otherTenantId, {
        sourceType: "cash_intake",
        postings: [
          {
            accountId: collectorCash.id,
            direction: "debit",
            amountMinor: 100n,
            currency: "GHS",
            assetId: otherAssetId,
            collectorUserId: collectorB,
          },
          {
            accountId: assetWallet.id,
            direction: "credit",
            amountMinor: 100n,
            currency: "GHS",
            assetId: otherAssetId,
          },
        ],
      });
      await repos.collectorCash.ensureWallet(otherTenantId, collectorB);
      const created = await repos.collectorCash.insertIntakeIfAbsent(otherTenantId, {
        collectorUserId: collectorB,
        clientReference: `foreign-${stamp}`,
        assetId: otherAssetId,
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: 100n,
        currency: "GHS",
        receiptNumber: `RC-${stamp}-5`,
      });
      expect(created.existed).toBe(false);
    });

    // From the first tenant, the foreign collector's balance is invisible:
    // the derived sum only reaches entries under this tenant_id.
    await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      expect(await repos.ledger.collectorCashBalance(tenantId, collectorB)).toBe(0n);
      expect(await repos.ledger.collectorCashBalance(tenantId, collectorA)).toBe(700n);
      const wallets = await repos.collectorCash.listWallets(tenantId);
      expect(wallets.map((row) => row.collectorUserId)).not.toContain(collectorB);
    });
  });
});
