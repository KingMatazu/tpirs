import type { Telemetry } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createTelemetryConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<Telemetry>,
): void {
  const { describe, it, expect } = harness;

  describe("Telemetry conformance", () => {
    it("starts, annotates, and ends a span", () =>
      withAdapter(factory, (telemetry) => {
        const span = telemetry.startSpan("conformance.span", { "conf.test": true });
        span.setAttribute("conf.step", "middle");
        span.recordException(new Error("conformance exception"));
        expect(() => {
          span.end();
        }).not.toThrow();
      }));

    it("records counters, logs, and errors without throwing", () =>
      withAdapter(factory, (telemetry) => {
        expect(() => {
          telemetry.counter("conformance.counter", 1, { "conf.test": true });
          telemetry.log("info", "conformance log message", { "conf.test": true });
          telemetry.captureError(new Error("conformance capture"), { "conf.test": true });
        }).not.toThrow();
      }));
  });
}
