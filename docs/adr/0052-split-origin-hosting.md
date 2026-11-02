# ADR 0052: Split-origin hosting, and a closed setup window in production

## Status

Accepted

## Context

The platform was written for one origin: Vite proxies `/v1` in development and
the dashboard assumes the same origin in production, so no CORS is needed and the
httpOnly refresh cookie is `SameSite=Strict` (ADR 0025, D26). A team pilot on
Vercel changed that constraint: the three Vite apps and the Fastify API are four
deployments with four origins, and a static frontend has no server to proxy
through.

Two problems follow, and one pre-existing one becomes urgent:

1. **CORS.** The browser will not let `admin.vercel.app` call `api.vercel.app`
   unless the API answers preflight and names that origin.
2. **The refresh cookie.** `SameSite=Strict` cookies are neither stored nor sent
   on cross-site requests, so sign-in would work and every reload would sign the
   user out.
3. **First-run setup.** The zero-tenant window is the only unauthenticated route
   that writes rows. On localhost that is fine; on the public internet it means
   "whoever finds this URL first owns the deployment".

## Decision

- **CORS is opt-in by environment.** `CORS_ORIGINS` is a comma-separated
  allowlist. An empty value keeps the original same-origin posture: no CORS
  headers, no preflight. A non-empty value registers `@fastify/cors` with
  `credentials: true`, the normal methods, and the headers the client actually
  uses (`authorization`, `content-type`, `idempotency-key`, `x-request-id`,
  `x-setup-token`), exposing `x-request-id`. Wildcards are not supported.
  Hand-rolling the hook was considered and rejected: preflight, credentials and
  `Vary: Origin` are exactly the details a small in-house implementation gets
  wrong, and `@fastify/cors` is the maintained plugin for this Fastify major.
- **The refresh cookie's `SameSite` is configuration.** Default `strict`;
  `REFRESH_COOKIE_SAMESITE=none` exists for a split-origin deployment, where it
  is paired with `Secure` in production. The cookie stays `HttpOnly` and scoped
  to `/v1/auth/refresh`.
- **The browser client picks credentials mode from the API URL.** Same origin
  keeps `same-origin`; a `VITE_API_BASE_URL` on another origin uses `include`.
  The dashboard, field and collector apps all follow the same rule.
- **Proxied requests are trusted for client IP.** `TRUST_PROXY=true` makes
  Fastify honour `X-Forwarded-For`, so per-IP throttling measures the visitor
  rather than the edge. It is off by default because a local process has no
  trusted proxy in front of it.
- **Production fails closed on open setup.** `SETUP_TOKEN` protects
  `POST /v1/setup/tenant`, compared in constant time against `x-setup-token`.
  The wizard reads it from `?setupToken=` in its URL. If the token is unset on a
  production deployment, the route answers `503 setup_disabled` rather than
  permitting anyone to create the first tenant. Local development and tests keep
  the open behaviour.
- **A hosting pilot may use the mock object store.** `OBJECT_STORAGE_ADAPTER=mock`
  boots a deployment without a bucket; uploads are process-local and explicitly
  not durable. It exists so the rest of the pilot works while storage is chosen,
  and it is named as a testing adapter everywhere.
- **Migration 0021 grants `tpirs_app` to the migrating role.** `SET LOCAL ROLE`
  needs membership when the connecting role is not a superuser, which is the
  normal case on managed Postgres. Without it every tenant-scoped request fails
  after a perfectly successful migration run.

## Consequences

- A same-origin deployment changes nothing and pays no CORS cost.
- A hosted deployment must list exact origins, including preview URLs, and must
  set `SameSite=None`. `SameSite=None` removes the browser's cross-site
  protection for the refresh cookie; the compensating controls are the exact
  origin allowlist, `HttpOnly`, `Secure`, path scoping, rotation, and the fact
  that refresh is the only route the cookie reaches. CSRF on other routes is not
  cookie-based: they use the `Authorization` bearer, which a cross-site form
  cannot set.
- The setup token is a deployment secret with a short life: it is only useful
  until the first tenant exists. Rotating it afterwards is harmless.
- The mock object store is a deliberate hole in durability. It is only acceptable
  because the pilot is not handling real evidence; the onboarding guide says so.
