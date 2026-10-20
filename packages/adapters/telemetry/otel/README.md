# @tpirs/adapters-otel-telemetry

`Telemetry` adapter that emits OpenTelemetry-shaped structured spans, counters, logs, and errors. It writes to a pluggable `TelemetrySink` (default: JSON to stdout) so the process can boot without a vendor SDK; supply an OTLP or Sentry sink for a real deployment. Passes the shared telemetry conformance suite.
