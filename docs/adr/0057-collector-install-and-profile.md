# ADR 0057: The collector app is installable, and its profile is read-only

## Status

Accepted

## Context

The collector app was configured as a PWA from the start — `vite-plugin-pwa`, a
manifest and a service worker were all in the build — but it could never be
installed. The manifest declared `icons: []` and the app had no `public/`
directory, so Chrome never considered it installable and "Add to Home screen"
degraded to a bookmark; iOS had no `apple-touch-icon` and used a screenshot tile.
The officer app had solved this with a generated-icon script of its own.

Separately, a collector had nowhere to see who they were signed in as. The
dashboard shows an account's phone, national ID and home address, but a collector
cannot open the dashboard, and `GET /v1/auth/me` returned only the session
identity, roles and permissions. A support call ("which state? which username?
which phone number?") started with a guess.

## Decision

- **One icon generator, two marks.** The PNG encoder moves from
  `apps/field/scripts/generate-icons.mjs` to `scripts/generate-pwa-icons.mjs`,
  taking `--out` and `--mark`. `lens` is the officer's mark, `cash` (a banknote
  with a coin punched out) is the collector's. Field's committed icons regenerate
  byte-identical, so its appearance does not change.
- **The collector manifest gets the icon set, a description and an explicit
  `id`.** The `id` matters: Chrome falls back to `start_url`, so a later change
  to `start_url` would silently install a second app instead of updating the
  first.
- **Install is offered in the app, not only in the browser menu.**
  `beforeinstallprompt` fires once, early, so `lib/install.ts` captures it when
  the module is evaluated (App imports the profile screen, so this happens at
  startup) and holds it until the collector taps the button. The event is
  single-use: once the prompt has been shown, the deferred event is discarded,
  including after a dismissal, and the screen falls back to the browser menu.
  iOS has no such event, so it gets the Share → Add to Home Screen instruction.
- **The profile reads the caller's own row from `/v1/auth/me`.** The route adds
  `username`, `phone`, `nationalId` and `homeAddress`, nullable. They are not
  added to the principal: contact details have no business on every
  authenticated request, and this route runs once per app load.
- **Contact details are read-only, and the ID is masked.** The dashboard owns
  these fields (ADR 0054). The profile shows the last four digits of the
  national ID and reveals the rest only when **Show** is tapped, because a
  collector's handset is often shared.
- **No self-service password change yet.** It is deferred until email and
  password recovery exist; ADR 0051 already decided that account management is
  administrator-only. The profile tells the collector to ask for a reset, and
  the dashboard's reset produces a new handover card (ADR 0056).

## Consequences

- `/v1/auth/me` grows four fields. The response is the caller's own record over
  an authenticated connection; nothing new is logged, and none of the three
  contact fields is written to the audit trail.
- The national ID is in the response body, so it is visible to anything that can
  read the collector's own session. That is the same trust boundary as the
  dashboard row; masking is shoulder-surfing protection, not access control.
- The install event is captured at module evaluation. A browser that fires it
  before the app's JavaScript runs offers no prompt; the fallback text covers
  that case rather than a button that would do nothing.
- `apps/field` changes only in how its icons are generated; its runtime,
  manifest and icons are unchanged.
- Deferring password change means a collector who suspects their password is
  known must ask a supervisor. That is acceptable for the pilot and is recorded
  here so it is not mistaken for an oversight.

## Alternatives considered

- **A PDF or native shell.** Rejected: the app is a web app behind a browser
  session, and an installable PWA is the smallest step that puts it on the home
  screen.
- **`next-pwa` or a service-worker framework.** Rejected: the app is Vite and
  `vite-plugin-pwa` was already configured; the gap was assets, not tooling.
- **Adding the contact fields to the principal.** Rejected: it would put a
  national ID on every request and every log context, for one screen.
- **A separate `GET /v1/auth/profile` route.** Rejected: `/me` is already "who
  am I", a second route would need its own schema and permission story, and the
  payload is four fields.
- **Editable contact details in the app.** Rejected for now: identity data is
  registry data, and a collector editing their own phone number weakens the
  record a dispute is resolved against.
- **Self-service password change in this change.** Deferred deliberately, with
  the profile pointing at an administrator reset instead.
