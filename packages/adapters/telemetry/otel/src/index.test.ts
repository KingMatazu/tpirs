import { describe, expect, it } from "vitest";
import { createTelemetryConformanceSuite } from "@tpirs/contracts";
import { createOtelTelemetry } from "./index.js";

createTelemetryConformanceSuite({ describe, it, expect }, () => ({
  port: createOtelTelemetry({ serviceName: "tpirs-conformance" }),
}));

describe("createOtelTelemetry sink", () => {
  it("forwards spans, counters, logs, and errors to the injected sink", () => {
    const events: string[] = [];
    const telemetry = createOtelTelemetry({
      serviceName: "test",
      sink: {
        onSpanEnd: (name) => events.push(`span:${name}`),
        onCounter: (name) => events.push(`counter:${name}`),
        onGauge: (name) => events.push(`gauge:${name}`),
        onLog: (level) => events.push(`log:${level}`),
        onError: () => events.push("error"),
      },
    });

    const span = telemetry.startSpan("op");
    span.recordException(new Error("boom"));
    span.end();
    telemetry.counter("hits", 1);
    telemetry.log("info", "hello");
    telemetry.captureError(new Error("caught"));

    expect(events).toEqual(["error", "span:op", "counter:hits", "log:info", "error"]);
  });
});
