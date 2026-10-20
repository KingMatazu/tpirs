export type AttributeValue = string | number | boolean;

export type SpanAttributes = Record<string, AttributeValue | undefined>;

export interface Span {
  setAttribute(key: string, value: AttributeValue): void;
  recordException(error: unknown): void;
  end(): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Telemetry {
  startSpan(name: string, attributes?: SpanAttributes): Span;
  counter(name: string, value: number, attributes?: SpanAttributes): void;
  log(level: LogLevel, message: string, attributes?: SpanAttributes): void;
  captureError(error: unknown, context?: SpanAttributes): void;
}
