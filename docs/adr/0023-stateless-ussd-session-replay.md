# 0023: Stateless USSD session engine via cumulative text replay

## Context

USSD sessions are short-lived and stateful in the driver’s menu navigation, but aggregators behave differently (some pass cumulative input, some stepwise). We need a pure, testable session engine in `@tpirs/domain` (no framework/SDK imports) that works across providers and can be simulated in the UI (Phase 5 acceptance). Sessions must be resilient to retries and not rely on server-held sticky sessions that break behind load balancers or on provider retries.

## Decision

- **Stateless replay.** The domain exports `advanceUssdSession(state, input)` where input is the cumulative `text` from the provider callback (D23). The engine reconstructs the path from the menu graph + current input, handling back/navigation per config, and produces `UssdSessionResult` (type `continue`/`end`, message).
- **Menus from config.** `channels.menus` is a typed graph in tenant config; messages come from `channels.messages` with i18n keys. No menu logic in code.
- **Provider translation only.** `UsspProvider` adapters parse callbacks to `UssdSessionRequest` and render `UssdSessionResponse` to provider format. The application layer (`UssdService`) applies cache/rate limiting/locks before calling the engine.
- **Deterministic simulation.** The same engine can run in-browser against tenant config for the USSD simulator (UI track Step 5).

## Consequences

- No server session store required for correctness; sessions are idempotent across retries.
- Menu changes require only config changes (satisfies acceptance).
- Engine is trivially testable and provider-agnostic.

## Alternatives considered

- **Server-side session store.** Rejected: adds state, harder to scale/retry across instances, and provider semantics vary.
- **Provider-managed state only.** Rejected: not portable across aggregators.
- **Stepwise parsing.** Rejected: doesn’t match cumulative-input providers and makes cross-provider support harder.
