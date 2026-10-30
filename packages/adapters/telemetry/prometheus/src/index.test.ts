import { describe, expect, it } from "vitest";
import { createTelemetryConformanceSuite } from "@tpirs/contracts";
import type { Telemetry } from "@tpirs/ports";
import { createPrometheusTelemetry } from "./index.js";

createTelemetryConformanceSuite({ describe, it, expect }, () => ({
  port: createPrometheusTelemetry(),
}));

/** Parses the exposition text into `name{labels} value` lines, ignoring TYPE. */
function series(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)$/.exec(line);
    if (match === null) throw new Error(`unparseable line: ${line}`);
    result.set(`${match[1] ?? ""}${match[2] ?? ""}`, Number(match[3]));
  }
  return result;
}

describe("createPrometheusTelemetry", () => {
  it("renders nothing before anything is recorded", () => {
    expect(createPrometheusTelemetry().render()).toBe("");
  });

  it("names counters with a _total suffix and sanitises dots", () => {
    const metrics = createPrometheusTelemetry();
    metrics.counter("http.requests", 2, { method: "GET", status: 200 });
    metrics.counter("http.requests", 1, { method: "GET", status: 200 });
    const rendered = metrics.render();
    expect(rendered).toContain("# TYPE http_requests_total counter");
    expect(series(rendered).get('http_requests_total{method="GET",status="200"}')).toBe(3);
  });

  it("keeps one series per label set and sorts labels", () => {
    const metrics = createPrometheusTelemetry();
    metrics.counter("verify.lookups", 1, { result: "paid", scope: "ip" });
    metrics.counter("verify.lookups", 4, { scope: "ip", result: "paid" });
    metrics.counter("verify.lookups", 2, { result: "unknown", scope: "ip" });
    const parsed = series(metrics.render());
    expect(parsed.get('verify_lookups_total{result="paid",scope="ip"}')).toBe(5);
    expect(parsed.get('verify_lookups_total{result="unknown",scope="ip"}')).toBe(2);
  });

  it("escapes quotes, backslashes and newlines in label values", () => {
    const metrics = createPrometheusTelemetry();
    metrics.counter("errors", 1, { detail: 'a"b\\c\nd' });
    expect(metrics.render()).toContain('errors_total{detail="a\\"b\\\\c\\nd"} 1');
  });

  it("drops undefined attributes instead of rendering empty labels", () => {
    const metrics = createPrometheusTelemetry();
    metrics.counter("hits", 1, { method: "GET", tenant: undefined });
    expect(metrics.render()).toContain('hits_total{method="GET"} 1');
  });

  it("turns a span into a cumulative duration histogram", () => {
    const metrics = createPrometheusTelemetry({ buckets: [0.1, 1] });
    metrics.startSpan("http.request", { route: "/v1/health" }).end();
    const parsed = series(metrics.render());
    expect(parsed.get('http_request_duration_seconds_bucket{route="/v1/health",le="0.1"}')).toBe(1);
    expect(parsed.get('http_request_duration_seconds_bucket{route="/v1/health",le="1"}')).toBe(1);
    expect(parsed.get('http_request_duration_seconds_bucket{route="/v1/health",le="+Inf"}')).toBe(
      1,
    );
    expect(parsed.get('http_request_duration_seconds_count{route="/v1/health"}')).toBe(1);
    expect(
      parsed.get('http_request_duration_seconds_sum{route="/v1/health"}'),
    ).toBeGreaterThanOrEqual(0);
  });

  it("includes attributes set after the span started", () => {
    const metrics = createPrometheusTelemetry({ buckets: [1] });
    const span = metrics.startSpan("http.request", { method: "GET" });
    span.setAttribute("route", "/v1/health");
    span.setAttribute("status", 200);
    span.end();
    const parsed = series(metrics.render());
    expect(
      parsed.get(
        'http_request_duration_seconds_count{method="GET",route="/v1/health",status="200"}',
      ),
    ).toBe(1);
  });

  it("counts every span end, including ones that record an exception", () => {
    const metrics = createPrometheusTelemetry({ buckets: [0.001] });
    const span = metrics.startSpan("worker.job");
    span.recordException(new Error("boom"));
    span.end();
    metrics.startSpan("worker.job").end();
    const parsed = series(metrics.render());
    expect(parsed.get("worker_job_duration_seconds_count")).toBe(2);
  });

  it("does not forward spans when forwardSpans is off", () => {
    const events: string[] = [];
    const inner: Telemetry = {
      startSpan: () => {
        events.push("span");
        return {
          setAttribute: () => events.push("attribute"),
          recordException: () => events.push("exception"),
          end: () => events.push("span-end"),
        };
      },
      counter: () => events.push("counter"),
      log: () => events.push("log"),
      captureError: () => events.push("error"),
    };
    const metrics = createPrometheusTelemetry({ forward: inner, forwardSpans: false });
    metrics.startSpan("http.request", { route: "/v1/health" }).end();
    expect(events).toEqual([]);
    expect(metrics.render()).toContain("http_request_duration_seconds_count");
  });

  it("forwards every event to the inner telemetry", () => {
    const events: string[] = [];
    const inner: Telemetry = {
      startSpan: (_name) => ({
        setAttribute: () => events.push("attribute"),
        recordException: () => events.push("exception"),
        end: () => events.push("span-end"),
      }),
      counter: (counter) => events.push(`counter:${counter}`),
      log: (level, message) => events.push(`log:${level}:${message}`),
      captureError: () => events.push("error"),
    };
    const metrics = createPrometheusTelemetry({ forward: inner });

    const span = metrics.startSpan("op");
    span.setAttribute("k", "v");
    span.recordException(new Error("boom"));
    span.end();
    metrics.counter("hits", 1);
    metrics.log("info", "hello");
    metrics.captureError(new Error("caught"));

    expect(events).toEqual([
      "attribute",
      "exception",
      "span-end",
      "counter:hits",
      "log:info:hello",
      "error",
    ]);
    // The same counter also reached the registry.
    expect(metrics.render()).toContain("hits_total 1");
  });
});
