import type { AttributeValue, LogLevel, Span, SpanAttributes, Telemetry } from "@tpirs/ports";

/**
 * Structural sink the adapter writes to. The default implementation writes to
 * the console as structured JSON so no vendor SDK is required to boot the API.
 * A real OTLP/Sentry bridge can be supplied without changing call sites.
 */
export interface TelemetrySink {
  onSpanEnd(name: string, attributes: SpanAttributes, durationMs: number): void;
  onCounter(name: string, value: number, attributes: SpanAttributes): void;
  onGauge(name: string, value: number, attributes: SpanAttributes): void;
  onLog(level: LogLevel, message: string, attributes: SpanAttributes): void;
  onError(error: unknown, context: SpanAttributes): void;
}

export interface OtelTelemetryOptions {
  readonly serviceName: string;
  readonly sink?: TelemetrySink;
}

function consoleSink(serviceName: string): TelemetrySink {
  const write = (payload: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ service: serviceName, ...payload })}\n`);
  };
  return {
    onSpanEnd(name, attributes, durationMs) {
      write({ kind: "span", name, durationMs, attributes });
    },
    onCounter(name, value, attributes) {
      write({ kind: "counter", name, value, attributes });
    },
    onGauge(name, value, attributes) {
      write({ kind: "gauge", name, value, attributes });
    },
    onLog(level, message, attributes) {
      write({ kind: "log", level, message, attributes });
    },
    onError(error, context) {
      write({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        context,
      });
    },
  };
}

export function createOtelTelemetry(options: OtelTelemetryOptions): Telemetry {
  const sink = options.sink ?? consoleSink(options.serviceName);

  return {
    startSpan(name, attributes = {}) {
      const started = Date.now();
      const attrs: SpanAttributes = { ...attributes };

      const span: Span = {
        setAttribute(key: string, value: AttributeValue) {
          attrs[key] = value;
        },
        recordException(error: unknown) {
          sink.onError(error, { ...attrs, span: name });
        },
        end() {
          sink.onSpanEnd(name, attrs, Date.now() - started);
        },
      };
      return span;
    },
    counter(name, value, attributes = {}) {
      sink.onCounter(name, value, { ...attributes });
    },
    gauge(name, value, attributes = {}) {
      sink.onGauge(name, value, { ...attributes });
    },
    log(level, message, attributes = {}) {
      sink.onLog(level, message, { ...attributes });
    },
    captureError(error, context = {}) {
      sink.onError(error, { ...context });
    },
  };
}
