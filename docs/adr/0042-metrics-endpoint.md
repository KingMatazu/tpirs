# ADR 0042: Prometheus metrics behind a flag

## Status

Accepted

## Context

Every route already records a counter through the `Telemetry` port, and the OTel
adapter writes structured JSON to stdout. That is enough to debug a request and
useless for alerting: nothing can scrape it, and a log-based alert rule is a
query nobody has written. Phase 10 needs two things from the same data — budgets
that a load test can assert, and rules that fire when a failure path is exercised
in production.

Options considered:

1. **Push to an OTLP collector** — the "real" OpenTelemetry path, but it puts a
   collector in the critical path of every deployment and gives the pilot state
   nothing to scrape if it has no collector. It also makes local and CI
   verification depend on an extra container.
2. **Log-based alerting** — cheapest to build, but the rules would be vendor
   queries over JSON lines, not reviewable files in the repo.
3. **A pull endpoint in Prometheus text format** — one route, no new dependency,
   and the metric names become the contract that alert rules and load budgets
   both reference.

## Decision

- **`GET /metrics` returns Prometheus text format**, rendered by a new telemetry
  sink that reads the same `Telemetry` port call sites already use. No vendor SDK,
  no collector, no new dependency: the format is a few lines per series and is
  hand-rendered in one small module behind the existing port.
- **Disabled unless `METRICS_ENABLED=true`.** When disabled the route 404s, so a
  deployment that has not opted in exposes nothing new.
- **Registered like `/v1/health`**: no authentication, no audit hook, hidden from
  the OpenAPI document. It shares the health endpoint's trust boundary — reachable
  from inside the network, never published at the edge — and that expectation is
  written in the runbook rather than assumed.
- **The metric names are the contract.** `docs/phase-10-implementation.md` lists
  them; the alert rules and the load budgets reference the same names, and a test
  fails when a rule names a metric the contract does not define.
- **No high-cardinality labels.** Labels carry the route pattern
  (`/v1/verify/:token`), never the resolved path; never a tenant slug, asset
  reference, plate, MSISDN, user id or request id. Where a per-tenant series is
  genuinely needed (reconciliation age) it uses the tenant id, which is bounded by
  the number of tenants.
- **Latency is a histogram, not an average.** `http_request_duration_seconds` is
  bucketed so p95 and p99 are computable; an average hides exactly the tail the
  budgets care about.

## Consequences

- The pilot can point any Prometheus-compatible scraper at the API without an
  extra service, and the same endpoint answers in local development and in CI.
- The scrape is a small amount of work per request; the sink keeps counters in
  process memory, so the cost is a map update rather than an allocation per
  series.
- **Metrics are per process.** A restart resets counters, and with several API
  replicas a scraper sees one series per pod. That is normal for counters and is
  the reason alert rules use rates, not absolute totals.
- Hand-rendering the format means we own escaping and float formatting; both are
  covered by a test that parses the output back.
- `/metrics` is unauthenticated. If a deployment ever exposes the API directly to
  the internet, the endpoint has to be blocked at the edge — recorded as a
  deployment requirement, not left to chance.

## Alternatives considered

- **OTLP push via the OTel SDK** — rejected for this phase: a collector in the
  deployment, a real dependency, and nothing scrapeable when the collector is
  absent. The port is already vendor-neutral, so this stays open as a sink.
- **Alerting on JSON logs** — rejected: the rules would live in a log vendor's
  query language instead of the repo, and they would drift from the metric
  contract the load tests use.
- **Exposing `/metrics` with a bearer token** — rejected: it complicates scraping
  and the endpoint carries no personal or financial data, only aggregate counts.
  Network placement is the right control for it.
- **A statsd or CloudWatch adapter now** — rejected: it picks a vendor before a
  deployment target exists, which is the choice ADR 0004 deliberately left open.
