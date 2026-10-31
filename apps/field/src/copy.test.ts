import { describe, expect, it } from "vitest";
import { copy } from "./copy.js";

/**
 * The one rule this app cannot break.
 *
 * Under pay-per-use a day without a payment is not a debt, and a phone that
 * cannot reach the ledger knows nothing about who did not pay. So no officer-
 * facing string may use the vocabulary of accusation — not "unpaid", not
 * "debt", not "owing".
 *
 * This is a blunt string check over the whole copy module rather than a test of
 * each screen, because the next person to add a string will not think about it.
 */
describe("officer copy", () => {
  const strings = flatten(copy);

  it("has strings to check", () => {
    expect(strings.length).toBeGreaterThan(20);
  });

  it("never accuses a driver of owing money", () => {
    const banned = ["unpaid", "debt", "owe", "owing", "arrears", "defaulter"];
    for (const value of strings) {
      for (const word of banned) {
        expect(value.toLowerCase(), `"${value}" contains "${word}"`).not.toContain(word);
      }
    }
  });

  it("never promises that absence from the cache means non-payment", () => {
    for (const value of strings) {
      expect(value.toLowerCase()).not.toContain("has not paid");
      expect(value.toLowerCase()).not.toContain("did not pay");
    }
  });
});

function flatten(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((entry) => flatten(entry));
}
