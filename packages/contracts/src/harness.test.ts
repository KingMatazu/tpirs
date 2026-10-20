import { describe, expect, it } from "vitest";
import { createClockConformanceSuite } from "./clock.js";
import type { Clock } from "@tpirs/ports";

describe("conformance harness wiring", () => {
  it("registers and passes a suite against a minimal conforming adapter", () => {
    createClockConformanceSuite({ describe, it, expect }, () => ({
      port: { now: () => new Date() } satisfies Clock,
    }));
  });
});
