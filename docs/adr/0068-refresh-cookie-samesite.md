# ADR 0068: The refresh cookie is scoped from the request, not from an env var

## Status

Accepted

## Context

The dashboard, officer app and collector app are deployed on Vercel at
`tpirs-admin.vercel.app`, `tpirs-field.vercel.app` and
`tpirs-collector.vercel.app`. The API is a **different site**:
`tpirs.vercel.app`. `vercel.app` is on the Public Suffix List, so those are four
distinct sites, not four subdomains of one.

Sign-in worked and the app worked until the page was reloaded. Every reload
landed on the sign-in screen, on all three apps. The server was healthy: a
cookie jar drove `POST /v1/auth/login` then `POST /v1/auth/refresh` and the
second call returned `200` with a rotated token.

The cookie it issued was:

```
set-cookie: tpirs_refresh=…; Path=/v1/auth/refresh; HttpOnly; SameSite=Strict
```

`SameSite=Strict` cookies are **stored** on a cross-site response but never
**presented** on a cross-site request. So the browser kept a cookie it would
never send, `/v1/auth/refresh` answered `401 Refresh token is missing`, and the
client correctly reported an anonymous session. The deployment had a
`REFRESH_COOKIE_SAMESITE=none` setting available and the runbook asked for it —
one environment variable, easy to miss, and its absence produced a symptom
(instantly signed out) that looks like a bug in the client.

The deeper problem is that a security-relevant cookie attribute depended on an
operator remembering a value that the server can work out for itself.

## Decision

- **Derive the cookie's `SameSite` per request** in `cookiePolicyFor`
  (`apps/api/src/routes/auth.ts`). The browser's `Origin` header is compared with
  the origins the deployment already trusts for CORS, because that list is
  exactly the set of origins that make a request cross-site. A matching origin
  gets `SameSite=None; Secure`; anything else keeps the configured value
  (`strict` by default).
- **`REFRESH_COOKIE_SAMESITE` survives as an override**, not a requirement. A
  deployment that terminates on one origin still gets `strict` with nothing
  configured, and one that needs `none` explicitly can still ask for it.
- **Never emit `SameSite=None` without `Secure`.** Browsers reject that
  combination outright, so a cross-site deployment served over plain http falls
  back to `lax` (which will not authenticate a reload — the honest outcome of
  running a cross-site cookie over http).
- The five routes that mint a session (login, refresh, credential completion,
  password change, temporary password) share one `policyFor(request)` helper, so
  no call site can pass a stale pair of values.

## Consequences

- A split-origin deployment works with **no cookie environment variable at all**.
  Redeploying the API is enough; nothing in the three frontends changes.
- The same-origin development setup (Vite proxies `/v1`) keeps `SameSite=Strict`,
  so local behaviour is unchanged.
- Cross-site cookies are still **third-party cookies** to the browser. Chrome and
  Edge send them; Safari and Firefox block them by default. A pilot that must
  work on an iPhone needs either a shared registrable domain
  (`admin.example.gov` + `api.example.gov`, which are same-site) or the API
  proxied behind each app's own origin. Both are deployment changes, not code
  changes, and the cookie policy above is what makes either work.
- The failure is now visible in one header instead of being inferred from a
  sign-out: `curl -i -X POST …/v1/auth/login -H "Origin: https://<app>"` shows
  the `SameSite` value the deployment will use.

## Alternatives considered

- **Require the environment variable and document it harder.** Rejected: it was
  already documented, and a wrong value fails silently in a way that reads as a
  client bug. Deriving it removes the class of mistake.
- **Always `SameSite=None`.** Rejected: it weakens the same-origin deployment
  (any site could cause the refresh endpoint to be called with the cookie) for
  no benefit there.
- **Store the refresh token in `localStorage` and send it in the body.**
  Rejected: it trades an httpOnly cookie for script-readable long-lived
  credentials, to solve a problem that is really about cookie scoping.
- **Proxy `/v1` through each app's Vercel project.** The right long-term shape
  for a `*.vercel.app` pilot, and the only one that also works in Safari, but it
  needs a rewrite destination per project and a rebuild of three apps. Kept as
  the next step if the pilot must support Safari or a blocked third-party-cookie
  browser.
