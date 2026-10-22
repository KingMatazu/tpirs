import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planAllocation } from "./allocation.js";
import type { AllocatablePeriod } from "./allocation.js";
import { addDays, businessDate } from "./business-date.js";
import type { BusinessDate } from "./business-date.js";
import type { AllocationOrder, ObligationModel } from "./obligation.js";
import { checkProperty } from "./test-support/property.js";

const BASE_DATE = businessDate("2026-06-15");

const modelArb = fc.constantFrom<ObligationModel>("pay_per_use", "scheduled");
const orderArb = fc.constantFrom<AllocationOrder>("oldest_first", "today_first");

interface RawPeriod {
  readonly id: string;
  readonly offsetDays: number;
  readonly amountMinor: bigint;
  readonly amountPaidMinor: bigint;
  readonly priority: number;
}

/**
 * A set of periods for one asset.
 *
 * The business dates are unique, because an asset has at most one period per
 * business date, and the amount already paid never exceeds the amount owed.
 */
const periodsArb = fc
  .array(
    fc.record({
      id: fc.uuid(),
      offsetDays: fc.integer({ min: -30, max: 30 }),
      amountMinor: fc.bigInt({ min: 0n, max: 1_000_000n }),
      amountPaidMinor: fc.bigInt({ min: 0n, max: 1_000_000n }),
      priority: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 0, maxLength: 6 },
  )
  .map((records) => {
    const seen = new Set<number>();
    const periods: RawPeriod[] = [];
    for (const record of records) {
      if (seen.has(record.offsetDays)) continue;
      seen.add(record.offsetDays);
      periods.push({
        id: `${record.id}-${record.offsetDays}`,
        offsetDays: record.offsetDays,
        amountMinor: record.amountMinor,
        amountPaidMinor:
          record.amountPaidMinor > record.amountMinor ? record.amountMinor : record.amountPaidMinor,
        priority: record.priority,
      });
    }
    return periods;
  });

function toPeriods(raw: readonly RawPeriod[]): AllocatablePeriod[] {
  return raw.map((period) => ({
    id: period.id,
    periodStartDate: addDays(BASE_DATE, period.offsetDays),
    priority: period.priority,
    createdAt: "2026-01-01T00:00:00.000Z",
    amountMinor: period.amountMinor,
    amountPaidMinor:
      period.amountPaidMinor > period.amountMinor ? period.amountMinor : period.amountPaidMinor,
  }));
}

const allocationInputArb = fc
  .record({
    model: modelArb,
    order: orderArb,
    prepaidAllowed: fc.boolean(),
    walletBalanceMinor: fc.bigInt({ min: 0n, max: 5_000_000n }),
    businessDateOffset: fc.integer({ min: -30, max: 30 }),
    raw: periodsArb,
  })
  .map((input) => {
    const businessDateValue: BusinessDate = addDays(BASE_DATE, input.businessDateOffset);
    return {
      model: input.model,
      order: input.order,
      prepaidAllowed: input.prepaidAllowed,
      walletBalanceMinor: input.walletBalanceMinor,
      businessDate: businessDateValue,
      periods: toPeriods(input.raw),
    };
  });

describe("allocation properties", () => {
  it("never allocates more than a period still owes", () => {
    checkProperty(
      "no period is overpaid",
      fc.property(allocationInputArb, (input) => {
        const plan = planAllocation(input);
        const byId = new Map(input.periods.map((period) => [period.id, period]));
        for (const allocation of plan.allocations) {
          const period = byId.get(allocation.periodId);
          expect(period, `unknown period ${allocation.periodId}`).toBeDefined();
          if (period === undefined) continue;
          const due = period.amountMinor - period.amountPaidMinor;
          expect(
            allocation.amountMinor <= due,
            `allocated ${allocation.amountMinor} but ${period.id} only owes ${due}`,
          ).toBe(true);
          expect(allocation.amountMinor > 0n).toBe(true);
        }
      }),
    );
  });

  it("conserves the wallet balance", () => {
    checkProperty(
      "wallet balance is conserved",
      fc.property(allocationInputArb, (input) => {
        const plan = planAllocation(input);
        expect(plan.appliedMinor + plan.remainingMinor).toBe(input.walletBalanceMinor);
        expect(plan.remainingMinor >= 0n).toBe(true);
      }),
    );
  });

  it("only settles eligible periods", () => {
    checkProperty(
      "allocation eligibility",
      fc.property(allocationInputArb, (input) => {
        const plan = planAllocation(input);
        const byId = new Map(input.periods.map((period) => [period.id, period]));
        for (const allocation of plan.allocations) {
          const period = byId.get(allocation.periodId);
          expect(period, `unknown period ${allocation.periodId}`).toBeDefined();
          if (period === undefined) continue;
          if (input.model === "pay_per_use") {
            // Only the day being paid: an idle day is never a debt.
            expect(period.periodStartDate).toBe(input.businessDate);
          } else if (period.periodStartDate > input.businessDate) {
            // Future periods need an explicit prepay decision.
            expect(input.prepaidAllowed).toBe(true);
          }
        }
      }),
    );
  });

  it("never pays a period that is already settled", () => {
    checkProperty(
      "settled periods are not paid twice",
      fc.property(allocationInputArb, (input) => {
        const plan = planAllocation(input);
        const byId = new Map(input.periods.map((period) => [period.id, period]));
        for (const allocation of plan.allocations) {
          const period = byId.get(allocation.periodId);
          if (period === undefined) continue;
          expect(period.amountPaidMinor < period.amountMinor).toBe(true);
        }
      }),
    );
  });

  it("settles nothing under pay_per_use when the payment is short", () => {
    checkProperty(
      "pay_per_use shortfall settles nothing",
      fc.property(allocationInputArb, (input) => {
        if (input.model !== "pay_per_use") return;
        const today = input.periods.find((period) => period.periodStartDate === input.businessDate);
        if (today === undefined) return;
        const due = today.amountMinor - today.amountPaidMinor;
        if (due <= 0n) return;
        if (input.walletBalanceMinor >= due) return;

        const plan = planAllocation(input);
        expect(plan.allocations).toHaveLength(0);
        expect(plan.appliedMinor).toBe(0n);
        expect(plan.remainingMinor).toBe(input.walletBalanceMinor);
      }),
      {
        examples: [
          [
            {
              model: "pay_per_use",
              order: "oldest_first",
              prepaidAllowed: false,
              walletBalanceMinor: 50n,
              businessDate: businessDate("2026-06-15"),
              periods: [
                {
                  id: "p1",
                  periodStartDate: businessDate("2026-06-15"),
                  priority: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  amountMinor: 100n,
                  amountPaidMinor: 0n,
                },
              ],
            },
          ],
        ],
      },
    );
  });

  it("produces the same plan whatever order the periods arrive in", () => {
    checkProperty(
      "allocation order is stable",
      fc.property(allocationInputArb, (input) => {
        const reversed = planAllocation({ ...input, periods: [...input.periods].reverse() });
        const forward = planAllocation(input);
        expect(reversed.allocations).toEqual(forward.allocations);
        expect(reversed.appliedMinor).toBe(forward.appliedMinor);
        expect(reversed.remainingMinor).toBe(forward.remainingMinor);
      }),
    );
  });

  it("produces the same plan when the same input is planned twice", () => {
    checkProperty(
      "allocation is deterministic",
      fc.property(allocationInputArb, (input) => {
        expect(planAllocation(input)).toEqual(planAllocation(input));
      }),
    );
  });

  it("never allocates the same period twice in one plan", () => {
    checkProperty(
      "one allocation per period",
      fc.property(allocationInputArb, (input) => {
        const plan = planAllocation(input);
        const ids = plan.allocations.map((allocation) => allocation.periodId);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });
});
