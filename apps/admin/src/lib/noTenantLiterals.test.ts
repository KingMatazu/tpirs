import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The Phase 9 acceptance rule in code: the dashboard carries no tenant names,
 * currencies, timezones or provider keys. Everything tenant-specific comes from
 * config through the API. Tests and fixtures are excluded because they must
 * contain sample values to prove the rule.
 */
const FORBIDDEN = [
  "alpha-state",
  "beta-state",
  "Alpha State",
  "Beta State",
  "Template State",
  "Example State",
  "Africa/Lagos",
  "Africa/Accra",
  '"NGN"',
  '"GHS"',
];

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test-support") return [];
      return sourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("admin source has no tenant literals", () => {
  it("reads every tenant value from config, not from code", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const token of FORBIDDEN) {
        if (text.includes(token)) {
          offenders.push(`${relative(ROOT, file)} contains ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
