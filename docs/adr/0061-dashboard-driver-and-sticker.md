# ADR 0061: The dashboard registers a driver and prints their sticker

## Status

Accepted

## Context

With registration gone from the collector app (ADR 0058), the dashboard had to
provide it: it could search, correct and suspend a vehicle but never create one.
The pilot also asked for the obvious output of that form — the sticker the officer
scans — to be visible and printable, and for the collector app's sticker bug to be
understood: it fetched the SVG through the generated client, which parses JSON, so
`response.json()` threw and the screen showed "The sticker could not be loaded."

The dashboard's only sticker action was a download. A state printing stickers for
a batch of new drivers needs to see the code and put it on paper from the same
screen.

## Decision

- **A driver is an owner plus an asset, never a login.** The form asks for full
  name, phone, plate and an optional email. No password field, no account: drivers
  pay by USSD or SMS with the short code, so an account would be a credential
  nobody uses. Drivers therefore appear in the registry, not in Accounts.
- **The plate is written to the tenant's own attribute.** `plateAttributeKey`
  prefers `plate_number`, then the type's first required string attribute, so a
  state that names it `registration` still gets a working form with no code
  change. A vehicle-type picker appears only when the tenant configures more than
  one type.
- **The optional email lives on the owner.** Migration 0026 adds `owners.email`
  rather than hiding a contact address in free-form attributes, where search
  cannot see it and nothing validates it. Nothing sends to it yet.
- **The sticker is shown, printed and downloaded from one panel.** The SVG is
  fetched with the in-memory bearer (the generated client parses JSON, which is
  the collector bug this avoids) and rendered from an object URL.
- **Printing reuses the handover card's rule.** `@media print` now keys on
  `[data-print]` rather than `data-print="handover"`, so a sticker prints alone —
  QR with the short code underneath — with no second stylesheet. The PDF is the
  browser's Save as PDF.
- **The collector app no longer fetches a sticker at all.** Its registration
  screen is deleted; the "could not be loaded" message goes with it. Printing
  belongs to the dashboard and the zone supervisor.

## Consequences

- What admin prints is byte-identical to what the collector would have printed:
  the same server-rendered SVG, so a sticker produced before and after this change
  is the same artefact.
- A supervisor's form locks the zone to their session's zone; a system admin may
  leave a vehicle unzoned, which the API accepts.
- The sticker panel issues a GET per asset opened. Acceptable for a dashboard
  screen that shows one asset at a time; a list preview would need a different
  design.
- `QR` generation is entirely server-side (`qrcode` in `@tpirs/application`), so
  the dashboard has no second QR implementation and no extra dependency.

## Alternatives considered

- **A client-side QR library in the dashboard.** Rejected: the API already renders
  the sticker with the tenant's branding and dimensions; a second renderer would
  drift from the printed sticker.
- **Generating a driver account so "drivers appear under Accounts".** Rejected:
  drivers do not sign in, and a user row for every driver would put a
  money-relevant identity in the accounts table with no purpose.
- **Keeping the collector's sticker screen with the JSON bug fixed.** Rejected:
  the screen existed only because registration did, and the requirement is that
  registration is supervisory.
