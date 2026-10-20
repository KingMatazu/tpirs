# 0002: Ports and adapters with conformance suites

## Context

The design brief requires swapping gateways, SMS providers, storage, queues, and
other vendors per tenant without touching core code, and warns that "a new
adapter is accepted only when it passes the suite".

## Decision

- Every external dependency is behind a port interface in `packages/ports`.
- Each port has a reusable conformance suite in `packages/contracts`. Suites take
  an injected harness and an adapter factory; they are framework-agnostic and
  assert only port behaviour.
- Each port ships at least a mock adapter under `packages/adapters/<port>/mock`,
  wired to its suite, so the suite is proven against a known-good adapter.
- Shared fixture values live in `conformanceFixtures`; factories are expected to
  be pre-configured with them.
- Errors are a shared `PortError { port, code, retryable, provider }` with a
  fixed code set; `unavailable`, `timeout`, and `rate_limited` are retryable.

## Consequences

- Adding a real adapter means implementing the port and passing the suite.
- Adapters must return rejected promises (not throw synchronously) for the
  conformance contract to hold, since callers `await` uniformly.
- Vendor SDKs may only appear inside `packages/adapters`.

## Alternatives considered

- Ad-hoc interface documentation: rejected; suites make swapping verifiable.
- Per-port bespoke test setup: rejected; an injected harness keeps suites
  portable across test frameworks.
