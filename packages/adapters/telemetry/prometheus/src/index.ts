import type { AttributeValue, LogLevel, Span, SpanAttributes, Telemetry } from "@tpirs/ports";

/**
 * Prometheus text exposition behind the existing `Telemetry` port (ADR 0042).
 *
 * Every call site already reports counters and spans; this adapter turns those
 * into scrapeable series so the API can expose `GET /metrics` without a vendor
 * SDK or a collector. It optionally forwards every event to another adapter
 * (the OTel console sink), so structured logs survive.
 *
 * Naming: a counter `http.requests` becomes `http_requests_total`, and a span
 * `http.request` becomes the histogram `http_request_duration_seconds`. Dots and
 * dashes become underscores; anything else outside the Prometheus name grammar
 * becomes an underscore.
 */

export interface PrometheusTelemetry extends Telemetry {
  /** Prometheus text exposition format for the current process. */
  render(): string;
}

export interface PrometheusTelemetryOptions {
  /** Receives every event as well, e.g. the OTel console sink for logs. */
  readonly forward?: Telemetry;
  /**
   * Whether spans are also forwarded. Defaults to true; the API turns it off so
   * a per-request span does not become a log line on every call — the duration
   * still lands in the histogram.
   */
  readonly forwardSpans?: boolean;
  /** Histogram bucket bounds in seconds. */
  readonly buckets?: readonly number[];
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  readonly labels: Readonly<Record<string, string>>;
  value: number;
}

interface HistogramSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly buckets: number[];
  sum: number;
  count: number;
}

function metricName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function counterName(name: string): string {
  const sanitized = metricName(name);
  return sanitized.endsWith("_total") ? sanitized : `${sanitized}_total`;
}

function histogramName(spanName: string): string {
  const sanitized = metricName(spanName);
  return sanitized.endsWith("_duration_seconds") ? sanitized : `${sanitized}_duration_seconds`;
}

function labelValue(value: AttributeValue): string {
  return typeof value === "string" ? value : String(value);
}

/** Sorted, stable label set; undefined attributes are dropped, never rendered. */
function toLabels(attributes: SpanAttributes = {}): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (value !== undefined) labels[key] = labelValue(value);
  }
  return labels;
}

function seriesKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Readonly<Record<string, string>>, extra?: [string, string]): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  if (extra !== undefined) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(9)));
}

export function createPrometheusTelemetry(
  options: PrometheusTelemetryOptions = {},
): PrometheusTelemetry {
  const buckets = [...(options.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b);
  const forward = options.forward;
  const forwardSpans = options.forwardSpans ?? true;
  const counters = new Map<string, Map<string, Series>>();
  const histograms = new Map<string, Map<string, HistogramSeries>>();

  function recordCounter(name: string, value: number, attributes?: SpanAttributes): void {
    const metric = counterName(name);
    const labels = toLabels(attributes);
    const key = seriesKey(labels);
    let series = counters.get(metric);
    if (series === undefined) {
      series = new Map();
      counters.set(metric, series);
    }
    const existing = series.get(key);
    if (existing === undefined) {
      series.set(key, { labels, value });
    } else {
      existing.value += value;
    }
  }

  function recordDuration(spanName: string, durationMs: number, attributes?: SpanAttributes): void {
    const metric = histogramName(spanName);
    const labels = toLabels(attributes);
    const key = seriesKey(labels);
    let series = histograms.get(metric);
    if (series === undefined) {
      series = new Map();
      histograms.set(metric, series);
    }
    let entry = series.get(key);
    if (entry === undefined) {
      entry = { labels, buckets: buckets.map(() => 0), sum: 0, count: 0 };
      series.set(key, entry);
    }
    const seconds = durationMs / 1000;
    entry.sum += seconds;
    entry.count += 1;
    for (let index = 0; index < buckets.length; index += 1) {
      const bound = buckets[index];
      if (bound !== undefined && seconds <= bound)
        entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
    }
  }

  function render(): string {
    const lines: string[] = [];
    for (const name of [...counters.keys()].sort()) {
      lines.push(`# TYPE ${name} counter`);
      const series = counters.get(name);
      if (series === undefined) continue;
      for (const key of [...series.keys()].sort()) {
        const entry = series.get(key);
        if (entry === undefined) continue;
        lines.push(`${name}${renderLabels(entry.labels)} ${formatNumber(entry.value)}`);
      }
    }
    for (const name of [...histograms.keys()].sort()) {
      lines.push(`# TYPE ${name} histogram`);
      const series = histograms.get(name);
      if (series === undefined) continue;
      for (const key of [...series.keys()].sort()) {
        const entry = series.get(key);
        if (entry === undefined) continue;
        // Bucket counters are cumulative: a sample increments every bound it is
        // at or under, so rendering is a direct read.
        for (let index = 0; index < buckets.length; index += 1) {
          const bound = buckets[index];
          if (bound === undefined) continue;
          lines.push(
            `${name}_bucket${renderLabels(entry.labels, ["le", String(bound)])} ${formatNumber(entry.buckets[index] ?? 0)}`,
          );
        }
        lines.push(
          `${name}_bucket${renderLabels(entry.labels, ["le", "+Inf"])} ${formatNumber(entry.count)}`,
        );
        lines.push(`${name}_sum${renderLabels(entry.labels)} ${formatNumber(entry.sum)}`);
        lines.push(`${name}_count${renderLabels(entry.labels)} ${formatNumber(entry.count)}`);
      }
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  return {
    render,

    startSpan(name: string, attributes: SpanAttributes = {}): Span {
      const startedAt = Date.now();
      // Attributes set during the span are part of the recorded labels, the same
      // way an OTel span carries them to its exporter (route and status are only
      // known when the response is written).
      const collected: SpanAttributes = { ...attributes };
      const inner = forwardSpans ? forward?.startSpan(name, attributes) : undefined;
      return {
        setAttribute(key: string, value: AttributeValue) {
          collected[key] = value;
          inner?.setAttribute(key, value);
        },
        recordException(error: unknown) {
          inner?.recordException(error);
        },
        end() {
          recordDuration(name, Date.now() - startedAt, collected);
          inner?.end();
        },
      };
    },

    counter(name: string, value: number, attributes?: SpanAttributes) {
      recordCounter(name, value, attributes);
      forward?.counter(name, value, attributes);
    },

    log(level: LogLevel, message: string, attributes?: SpanAttributes) {
      forward?.log(level, message, attributes);
    },

    captureError(error: unknown, context?: SpanAttributes) {
      forward?.captureError(error, context);
    },
  };
}
