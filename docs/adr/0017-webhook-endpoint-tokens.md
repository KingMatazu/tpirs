# 0017: Webhook tenant resolution by endpoint token

## Context

Every money table is scoped by `tenant_id` through row-level security, so a
webhook transaction must set `app.tenant_id` before it can write anything. The
webhook route has no staff session to resolve that from.

The obvious shortcut is to read the tenant from the payload, but the payload is
exactly what has not been verified yet, and each tenant has its own gateway
secret. Choosing the secret based on unverified input is a signature-verification
bypass: an attacker can send a payload naming a tenant whose secret they know, or
name a tenant whose secret they do not, and steer which check runs.

## Decision

- Webhooks arrive at `POST /webhooks/:provider/:endpointToken`. The token is an
  unguessable value that maps to exactly one tenant, one provider, and one secret
  reference.
- Only a SHA-256 hash of the token is stored, in `webhook_endpoints`. A database
  read therefore does not yield working webhook URLs, and the token cannot be
  recovered from a backup.
- `webhook_endpoints` is deliberately outside row-level security, because it has
  to answer a question that precedes tenant scoping. The application role has no
  `SELECT` on it. The only access path is a narrow `SECURITY DEFINER` function
  that takes a token hash and returns tenant id, provider, and secret reference,
  or nothing.
- The order is fixed and load-bearing: resolve the token, verify the signature
  with that tenant's secret, then set `app.tenant_id` and open the transaction
  that stores and processes the event. No tenant-scoped read happens before
  verification.
- An unknown token is a 404. A valid token with a bad signature is a 401 and is
  audited under that tenant with actor `system`, because the tenant is known by
  then. An unknown token cannot produce an audit row — there is no tenant to
  attribute it to — so it is recorded as telemetry and counted by the rate
  limiter, keyed by IP and token prefix.
- Dedicated deployments whose gateway cannot be configured with a path segment
  may fall back to a configured default tenant. The token path remains the
  supported configuration, and the fallback is explicit config, never an
  inference.
- The token is redacted from logs, traces, and proxy access logs. A secret in a
  URL leaks to every hop that records the URL.

## Consequences

- Rotating a webhook secret is a config operation per tenant, not a deployment.
- A leaked token can be revoked by rotating one row without touching other
  tenants.
- Multi-tenant and dedicated deployments share one code path; the default-tenant
  fallback is the only difference and it is configuration.
- A timing difference between "token unknown" and "signature invalid" exists, but
  the token is high-entropy, so it is not a guessable oracle.

## Alternatives considered

- **Resolve the tenant from the payload's account or email field.** Rejected: it
  trusts unverified input to choose the verification secret.
- **One endpoint per deployment with the tenant in config.** Rejected as the only
  mechanism: it is correct for dedicated deployments but cannot express the
  multi-tenant mode the brief requires with the same code.
- **A single shared secret across tenants.** Rejected: one leaked secret would
  let a caller post events for every tenant.
- **Store the token in plaintext for easier operations.** Rejected: webhook URLs
  would become bearer credentials recoverable from any database dump.
