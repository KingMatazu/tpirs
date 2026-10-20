import type { AttributeValue, LogLevel, SpanAttributes, Telemetry } from "@tpirs/ports";

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: SpanAttributes;
  readonly exceptions: unknown[];
  readonly ended: boolean;
}

export interface RecordedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly attributes: SpanAttributes;
}

export interface RecordedCounter {
  readonly name: string;
  readonly value: number;
  readonly attributes: SpanAttributes;
}

export interface MockTelemetry extends Telemetry {
  readonly spans: RecordedSpan[];
  readonly logs: RecordedLog[];
  readonly counters: RecordedCounter[];
  readonly errors: { readonly error: unknown; readonly context: SpanAttributes }[];
}

interface MutableSpan extends Omit<RecordedSpan, "ended"> {
  ended: boolean;
}

export function createMockTelemetry(): MockTelemetry {
  const spans: MutableSpan[] = [];
  const logs: RecordedLog[] = [];
  const counters: RecordedCounter[] = [];
  const errors: { error: unknown; context: SpanAttributes }[] = [];

  return {
    spans,
    logs,
    counters,
    errors,
    startSpan(name, attributes = {}) {
      const span: MutableSpan = {
        name,
        attributes: { ...attributes },
        exceptions: [],
        ended: false,
      };
      spans.push(span);
      return {
        setAttribute(key: string, value: AttributeValue) {
          span.attributes[key] = value;
        },
        recordException(error: unknown) {
          span.exceptions.push(error);
        },
        end() {
          span.ended = true;
        },
      };
    },
    counter(name, value, attributes = {}) {
      counters.push({ name, value, attributes: { ...attributes } });
    },
    log(level, message, attributes = {}) {
      logs.push({ level, message, attributes: { ...attributes } });
    },
    captureError(error, context = {}) {
      errors.push({ error, context: { ...context } });
    },
  };
}
