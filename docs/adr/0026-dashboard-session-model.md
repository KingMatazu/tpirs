# 0026: Dashboard session model (short-lived bearer + rotating refresh cookie)

## Context

The dashboard needs staff login that works in a browser. Staff sessions already support access and refresh sessions (`sessions.kind`), but the browser cannot store a long-lived refresh token in localStorage (XSS) and the API must stay usable by non-browser clients (bearer header).

## Decision

- **Login** (`POST /v1/auth/login`) returns the access token in the body and sets the refresh token as an httpOnly, SameSite=strict cookie named `tpirs_refresh`, scoped to `path=/v1/auth/refresh` so no other endpoint ever receives it. `Secure` is set only when the deployment is HTTPS (`nodeEnv === "production"`): over plain `http://localhost` a `Secure` cookie is dropped by the browser and every reload became a sign-out.
- **Refresh** (`POST /v1/auth/refresh`) takes only the cookie, rotates the refresh session (single use — replay fails closed, per ADR 0023-style statelessness), and returns a new access token plus a new cookie.
- **Logout** (`POST /v1/auth/logout`) revokes both the bearer session (if presented) and the cookie session, then clears the cookie.
- **Admin runtime:** the access token lives only in a zustand store variable (memory, never localStorage); on 401 the client attempts one silent refresh and replays the request; on app start it attempts a refresh to restore the session.
- **The generated client defaults to `credentials: "same-origin"`** (`createApiClient`, overridable per client). This is load-bearing, not cosmetic: a request made with `credentials: "omit"` makes the browser discard the response's `Set-Cookie` entirely, so the login cookie was never stored, the reload-time refresh went out without a cookie, and the dashboard signed the user out on every refresh. `same-origin` still never attaches cookies to third-party requests.
- Because refresh is same-origin and the dev proxy serves `/v1` from the same origin, no CORS credentials flow exists on the happy path. Control-plane clients (scripts, tests) that already hold a refresh token may still use the body fields; the cookie is additive, not exclusive.

## Consequences

- XSS cannot reach the refresh token; a stolen access token has a short lifetime.
- CSRF risk on `/v1/auth/refresh` is limited: SameSite=strict blocks cross-site sends, and the endpoint only mints a new session for an existing cookie — it accepts no attacker-controlled body.
- Non-browser clients need the refresh token persisted themselves; acceptable because they are trusted operators (CLI, tests).

## Alternatives considered

- **Store access token in localStorage.** Rejected: any XSS exfiltrates the whole session; the refresh chain exists precisely to avoid this.
- **Server-rendered session cookie for everything.** Rejected: the API contract must stay bearer-based for CLI/field use, and cookie-only auth complicates OpenAPI client generation.
- **No rotation (long-lived refresh).** Rejected: replay of a stolen refresh token would be invisible; rotation makes replay a detection signal and fails closed.
