import { describe, expect, it } from "vitest";
import { createTelemetryConformanceSuite } from "@tpirs/contracts";
import { createMockTelemetry } from "./index.js";

createTelemetryConformanceSuite({ describe, it, expect }, () => ({ port: createMockTelemetry() }));

describe("createMockTelemetry capture", () => {
  it("records spans, logs, counters, and errors for assertions", () => {
    const telemetry = createMockTelemetry();
    const span = telemetry.startSpan("op", { tenant: "t1" });
    span.setAttribute("step", "half");
    span.recordException(new Error("boom"));
    span.end();
    telemetry.counter("calls", 2);
    telemetry.log("warn", "careful");
    telemetry.captureError(new Error("captured"));

    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]?.ended).toBe(true);
    expect(telemetry.spans[0]?.attributes["step"]).toBe("half");
    expect(telemetry.logs[0]?.level).toBe("warn");
    expect(telemetry.counters[0]?.value).toBe(2);
    expect(telemetry.errors).toHaveLength(1);
  });
});
