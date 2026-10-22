import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { money } from "@tpirs/domain";
import { hashPassword } from "@tpirs/crypto";
import { LedgerOperationError, withLedger } from "./ledger-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

describeIntegration("LedgerService (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  let otherTenantId: string;
  let requesterId: string;
  let approverId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const stamp = Date.now().toString();
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `ledger-${stamp}`,
        name: "Ledger State",
        legalEntity: "Ledger Revenue",
        config: {},
      });
      const other = await repos.tenants.create({
        slug: `ledger-other-${stamp}`,
        name: "Other State",
        legalEntity: "Other Revenue",
        config: {},
      });
      tenantId = tenant.id;
      otherTenantId = other.id;

      const requester = await repos.users.create({
        tenantId,
        username: `ledger.requester.${stamp}`,
        displayName: "Ledger Requester",
        passwordHash: await hashPassword("requester-password"),
        totpSecret: null,
      });
      const approver = await repos.users.create({
        tenantId,
        username: `ledger.approver.${stamp}`,
        displayName: "Ledger Approver",
        passwordHash: await hashPassword("approver-password"),
        totpSecret: null,
      });
      requesterId = requester.id;
      approverId = approver.id;
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("posts a balanced transaction and derives the balances from the entries", async () => {
    const posted = await withLedger(db, tenantId, async ({ ledger, repos }) => {
      const result = await ledger.postTransaction(tenantId, {
        idempotencyKey: "post-1",
        sourceType: "payment",
        description: "Wallet credit",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 20_000),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 20_000),
          },
        ],
      });
      expect(result.replayed).toBe(false);
      expect(result.entries).toHaveLength(2);
      expect(await repos.ledger.accountBalance(tenantId, "ASSET_WALLET")).toBe(20_000n);
      expect(await repos.ledger.accountBalance(tenantId, "GATEWAY_CLEARING")).toBe(-20_000n);
      return result;
    });

    expect(posted.transaction.sourceType).toBe("payment");
    expect(posted.transaction.idempotencyKey).toBe("post-1");
  });

  it("rejects a transaction whose debits do not equal its credits", async () => {
    await expect(
      withLedger(db, tenantId, ({ ledger }) =>
        ledger.postTransaction(tenantId, {
          sourceType: "payment",
          postings: [
            {
              accountCode: "GATEWAY_CLEARING",
              direction: "debit",
              amount: money("NGN", 20_000),
            },
            {
              accountCode: "ASSET_WALLET",
              direction: "credit",
              amount: money("NGN", 19_999),
            },
          ],
        }),
      ),
    ).rejects.toThrow(/balanced/i);
  });

  it("returns the original transaction when the idempotency key is replayed", async () => {
    const first = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "replay-1",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 5_000),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 5_000),
          },
        ],
      }),
    );
    expect(first.replayed).toBe(false);

    const second = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "replay-1",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 5_000),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 5_000),
          },
        ],
      }),
    );

    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(second.entries).toHaveLength(2);

    // A replay must not move any money.
    const balance = await withLedger(db, tenantId, ({ repos }) =>
      repos.ledger.accountBalance(tenantId, "ASSET_WALLET"),
    );
    expect(balance).toBe(25_000n);
  });

  it("never lets a system admin touch ledger data", async () => {
    await expect(
      withLedger(db, tenantId, ({ ledger }) =>
        ledger.requestReversal(tenantId, {
          originalTransactionId: "00000000-0000-0000-0000-000000000000",
          reason: "not needed",
          requestedByUserId: requesterId,
          isSystemAdmin: true,
        }),
      ),
    ).rejects.toThrow(LedgerOperationError);

    await expect(
      withLedger(db, tenantId, ({ ledger }) =>
        ledger.approveReversal(tenantId, {
          reversalRequestId: "00000000-0000-0000-0000-000000000000",
          approverUserId: approverId,
          isSystemAdmin: true,
          hasFinanceApproval: true,
        }),
      ),
    ).rejects.toThrow(/system admin/);
  });

  it("requires a second approver and mirrors the original entries", async () => {
    const original = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "reversal-original",
        sourceType: "payment",
        description: "Payment to reverse",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 7_500),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 7_500),
          },
        ],
      }),
    );

    const request = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.requestReversal(tenantId, {
        originalTransactionId: original.transaction.id,
        reason: "duplicate payment",
        requestedByUserId: requesterId,
      }),
    );
    expect(request.status).toBe("pending");

    // The requester cannot approve their own request.
    await expect(
      withLedger(db, tenantId, ({ ledger }) =>
        ledger.approveReversal(tenantId, {
          reversalRequestId: request.id,
          approverUserId: requesterId,
          hasFinanceApproval: true,
        }),
      ),
    ).rejects.toThrow(/own reversal request/);

    // A second approver with finance approval posts the mirror.
    const reversed = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.approveReversal(tenantId, {
        reversalRequestId: request.id,
        approverUserId: approverId,
        hasFinanceApproval: true,
      }),
    );
    expect(reversed.entries).toHaveLength(2);
    for (const entry of reversed.entries) {
      const originalEntry = original.entries.find(
        (candidate) => candidate.accountId === entry.accountId,
      );
      expect(originalEntry).toBeDefined();
      expect(entry.direction).not.toBe(originalEntry?.direction);
      expect(entry.amountMinor).toBe(originalEntry?.amountMinor);
    }

    // The pair nets to zero for every account.
    const wallet = await withLedger(db, tenantId, ({ repos }) =>
      repos.ledger.accountBalance(tenantId, "ASSET_WALLET"),
    );
    expect(wallet).toBe(25_000n);
  });

  it("refuses to approve a reversal without finance approval", async () => {
    const original = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "reversal-no-finance",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 1_000),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 1_000),
          },
        ],
      }),
    );
    const request = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.requestReversal(tenantId, {
        originalTransactionId: original.transaction.id,
        reason: "no finance approval",
        requestedByUserId: requesterId,
      }),
    );

    await expect(
      withLedger(db, tenantId, ({ ledger }) =>
        ledger.approveReversal(tenantId, {
          reversalRequestId: request.id,
          approverUserId: approverId,
        }),
      ),
    ).rejects.toThrow(/finance approval/);
  });

  it("rejects an update or a delete on a transaction", async () => {
    const posted = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "immutable-transaction",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 250),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 250),
          },
        ],
      }),
    );

    // Even the table owner cannot change a posted transaction.
    await expect(
      withSystem(db, async (tx) => {
        await tx
          .updateTable("transactions")
          .set({ description: "tampered" })
          .where("id", "=", posted.transaction.id)
          .execute();
      }),
    ).rejects.toThrow(/append-only/);

    await expect(
      withSystem(db, async (tx) => {
        await tx.deleteFrom("transactions").where("id", "=", posted.transaction.id).execute();
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects an update or a delete on a ledger entry", async () => {
    const posted = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "immutable-entry",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 250),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 250),
          },
        ],
      }),
    );
    const entryId = posted.entries[0]?.id;
    expect(entryId).toBeDefined();

    await expect(
      withSystem(db, async (tx) => {
        await tx
          .updateTable("ledgerEntries")
          .set({ amountMinor: 1n })
          .where("id", "=", entryId ?? "")
          .execute();
      }),
    ).rejects.toThrow(/append-only/);

    await expect(
      withSystem(db, async (tx) => {
        await tx
          .deleteFrom("ledgerEntries")
          .where("id", "=", entryId ?? "")
          .execute();
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("does not let the application role update or delete ledger rows", async () => {
    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx
          .updateTable("ledgerEntries")
          .set({ amountMinor: 1n })
          .where("tenantId", "=", tenantId)
          .execute();
      }),
    ).rejects.toThrow();

    await expect(
      withTenant(db, tenantId, async (tx) => {
        await tx.deleteFrom("transactions").where("tenantId", "=", tenantId).execute();
      }),
    ).rejects.toThrow();
  });

  it("does not expose another tenant's ledger", async () => {
    const posted = await withLedger(db, tenantId, ({ ledger }) =>
      ledger.postTransaction(tenantId, {
        idempotencyKey: "isolated",
        sourceType: "payment",
        postings: [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", 100),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", 100),
          },
        ],
      }),
    );

    const found = await withLedger(db, otherTenantId, ({ repos }) =>
      repos.ledger.findTransactionWithEntries(otherTenantId, posted.transaction.id),
    );
    expect(found).toBeUndefined();
  });
});
