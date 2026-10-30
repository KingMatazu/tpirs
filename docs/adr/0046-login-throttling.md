# ADR 0046: Login throttling by IP and by username, fixed window

## Status

Accepted

## Context

`POST /v1/auth/login` is the only unauthenticated route that accepts a password.
The existing limiter (ADR 0024) protects public verify, USSD and SMS with a fixed
window over the `Cache` port; login is not covered. Staff accounts are
high-value: an authenticated `system_admin` can configure tenants and an
authenticated finance user can approve reversals.

Options considered:

1. **Account lockout after N failures** — the classic answer. It is also a
   denial-of-service lever: anyone who knows a staff member's username can lock
   them out at will, and unlocking needs a support path and persistent state.
2. **Per-IP only** — stops one host spraying many accounts, but a shared
   government-office NAT means the limit has to be generous, and a distributed
   attacker is unaffected.
3. **Per-username only** — stops distributed guessing against one account, but a
   single host can still walk a list of usernames at one attempt each.
4. **Both, as independent fixed windows, with no lockout** — each counter covers
   the other's blind spot, and neither creates a lasting lock.

## Decision

- **Two counters, both must pass**, using the existing
  `createRateLimiter({ cache, clock })` and its `consume(key, { limit, windowSeconds })`:

  | Counter                          | Limit | Window |
  | -------------------------------- | ----- | ------ |
  | `login:ip:<ip>`                  | 60    | 60 s   |
  | `login:user:<tenant>:<username>` | 5     | 60 s   |
  | `auth.refresh:ip:<ip>`           | 30    | 60 s   |
  | `login:totp:user:<userId>`       | 5     | 60 s   |

- **Fixed window, not a token bucket.** One integer per key with a TTL, which is
  what the existing limiter already implements and is enough for a login form.
  The cost is a 2× burst across a window boundary; the per-username counter makes
  that seam worth little to an attacker, and a human cannot type five passwords
  in a second.
- **The username key includes the tenant id** and the username is trimmed and
  lower-cased, so the same person in two tenants does not share a counter and
  `Alpha.Admin` cannot dodge the limit by changing case.
- **The limiter runs before the identity lookup.** A throttled response is
  identical for existing and non-existent usernames, so the control cannot be
  used to enumerate accounts.
- **Throttling, never lockout.** The response is the standard `429` envelope with
  `Retry-After`; the key expires and the account recovers by itself. No state, no
  unlock path, no support burden, no attacker-triggered lockout.
- **Successful attempts also consume.** Simpler and harder to game; five per
  minute is far above legitimate staff use.
- **TOTP gets its own counter, after the password succeeds**, so guessing a
  six-digit code is bounded independently of the password attempt rate.
- **The numbers are platform constants**, like the verify limit in ADR 0024, not
  tenant config: the risk is the same for every tenant and a tenant should not be
  able to weaken it.

## Consequences

- A single host cannot spray usernames, and a botnet cannot grind one account.
- A 30-person office signing in at 08:00 stays under the per-IP limit; if a
  deployment shows otherwise the constant is one line to change, with the reason
  recorded here.
- **Counters are per process** while `Cache` is the mock adapter, so two API
  replicas double the effective limit. Acceptable for the single-replica pilot;
  the Redis `Cache` adapter is the fix when the API scales out, and this ADR is
  the reason that adapter is on the Deferred list.
- The counters protect availability, not credential quality: low-and-slow
  credential stuffing across many usernames and IPs still needs an anomaly rule
  or a breached-password check. That is recorded in the runbook rather than
  claimed as solved.
- Because no lockout state exists, an auditor cannot be shown "this account was
  locked at 14:02" — they are shown the rejection counts per key, which is the
  evidence that matters for throttling.

## Alternatives considered

- **Account lockout with an admin unlock** — rejected: turns a guess into an
  outage for a named employee and adds persistent state plus a support process.
- **Exponential backoff per account** — rejected for now: harder to reason about
  and to explain to an operator than a fixed window, for a marginal gain at these
  volumes.
- **Per-IP only** — rejected: shared NAT forces a generous limit and distributed
  guessing defeats it.
- **Per-username only** — rejected: one host can still try one password against
  every account it knows.
- **A CAPTCHA after N failures** — rejected: an external dependency and an
  accessibility problem for staff on low-end devices, for a problem the two
  counters already bound.
