# 0022: Tenant-scoped channel adapter composition

## Context

Phase 5 needs `SmsProvider` and `UssdProvider` adapters per tenant, but tenants may use different aggregators (or mocks). Core code must remain vendor-agnostic (ports/adapters), secrets must never leak, and webhook tenancy must be resolved before reading tenant data (ADR 0017, D22). The composition logic cannot live in each app; both API (callbacks) and worker (delivery) need the same mapping.

## Decision

- **ChannelProviderFactory.** `packages/channel-providers` exports `createChannelProviderFactory({ secrets, transport? })`. `forTenant(config)` resolves bindings from `config.providers` (by port `SmsProvider`/`UssdProvider`), reads options/secrets via `SecretsProvider`, instantiates the correct adapter (`mock`, `africastalking`, `termii`), caches per config object, and returns only configured channels.
- **URL/key binding.** The webhook URL includes the provider/adapter key (`/webhooks/{provider}/{endpointToken}`); routes require `resolved.adapters.{channel}.adapter === provider`, otherwise return 404 identically to unknown tokens (anti-enumeration).
- **Secrets and validation.** Required credentials are validated at composition time with clear errors; unsupported options (e.g., Termii channel) are rejected. `HttpTransport` is injectable for tests.
- **Tenant isolation.** Tenancy is resolved via `resolveWebhookEndpoint(db, provider, token)` before adapter selection/loading tenant adapters.

## Consequences

- One place to add new aggregators; apps stay thin.
- Tests use mocks/injected transports with no network calls.
- Secrets are referenced, never logged.

## Alternatives considered

- **Per-route adapter construction.** Rejected: duplication and easy to leak secrets/config.
- **Global adapter registry by name only.** Rejected: no per-tenant secrets/options/enablement.
- **Hardcode adapter in env.** Rejected: breaks multi-tenant/white-label requirement.
