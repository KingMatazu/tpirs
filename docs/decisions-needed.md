# Decisions needed

Open questions where guessing would be unsafe. Each entry lists options and a
recommendation. Until resolved, the safest default is used behind a config flag.

## D1: Hosting provider and data residency

**Status:** open (deferred in Phase 0).

The first states impose data-residency expectations that constrain where the
database and object storage may live. Until a provider is chosen, the deploy
step runs through the `noop` target.

- Options: managed Postgres + object storage in-region; self-hosted in a state
  data centre; sovereign cloud.
- Recommendation: managed Postgres in-region per tenant, one deployment per
  state (the default deployment model), chosen during Phase 11 onboarding.

## D2: Verification token format details

**Status:** open (Phase 2/6).

The brief fixes the shape (opaque ID plus HMAC checksum, revealing nothing) but
not the checksum algorithm, key rotation, or short-code length.

- Recommendation: HMAC-SHA256 over the opaque ID with a per-tenant key from
  `SecretsProvider`; short code length from tenant config.

## D3: Payment instruction model per adapter

**Status:** open (Phase 4).

Adapters declare whether they support virtual accounts or references only. The
per-asset assignment strategy depends on the first gateway chosen.

- Recommendation: model both behind the `PaymentProvider` capability declaration;
  default to references until a virtual-account gateway is confirmed.

## D4: Tenant resolution at login

**Status:** open (Phase 1). Default chosen: explicit `tenantSlug` in the login body.

Session tokens are opaque and do not reveal their tenant, so login must resolve a
tenant before authentication. This is required for the multi-tenant deployment
mode (several states in one deployment).

- Options: require `tenantSlug` in the login body (current default); infer the
  tenant from the request hostname/subdomain; infer it when the deployment hosts
  exactly one tenant and require it otherwise.
- Recommendation: keep the explicit `tenantSlug` behind a config flag, and add
  hostname-based resolution for single-tenant deployments in Phase 9/11 when the
  dashboard and onboarding flows are built.
