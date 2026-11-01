import { describe, expect, it } from "vitest";
import { assertDemoSeedAllowed } from "./seed.js";

/**
 * The demo seed writes accounts whose passwords are in the repository, so the
 * guard is the only thing standing between `pnpm db:seed` and a production
 * database that suddenly has a working `alpha.admin`.
 */
describe("demo seed guard", () => {
  it("runs anywhere outside production", () => {
    expect(() => assertDemoSeedAllowed({})).not.toThrow();
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "test" })).not.toThrow();
  });

  it("refuses to seed a production database", () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production" })).toThrow(/Refusing to seed/);
  });

  it("allows production only with the explicit override", () => {
    expect(() =>
      assertDemoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "true" }),
    ).not.toThrow();
    // Anything other than the exact string is not consent.
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "1" })).toThrow(
      /Refusing to seed/,
    );
  });
});
