# ADR 0067: A sticker's QR scales to its box, and can carry a verification URL

## Status

Accepted

## Context

Two problems surfaced the first time a driver was registered in the dashboard and
the sticker was scanned by an officer.

**The printed QR was unreadable.** `renderAssetSticker` wrapped the `qrcode`
output like this:

```ts
`<svg x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}">${qrBody.replace(/^<svg[^>]*>/u, "")}</svg>`;
```

Stripping the inner `<svg …>` tag also stripped its `viewBox`. The `<path>`
elements inside are in **module units** (`0..35` for a 49-character token), so
they were drawn at one user unit per millimetre — 35 mm of code — inside a
viewport that was only 28 mm wide. A nested `<svg>` clips to its viewport
(`overflow: hidden` in the UA stylesheet), so roughly 7 modules on the right and
bottom edge, plus the quiet zone, were cut off the print. Nothing could decode
it: not the officer app, not a phone camera. The sticker "carried no
information" because a fifth of the code was missing.

The unit tests did not catch it because they asserted branding and the short
code, never the geometry.

**The QR carried an opaque token, not a URL.** That is deliberate (ADR 0007): the
sticker reveals nothing about the tenant, owner or plate, and a forged one fails
closed. But a civilian who scans a sticker with their camera gets a meaningless
string, and there was no way for a deployment to point the code somewhere
useful. The field scanner already understood a `…/v/<token>` wrapper
(`normaliseToken`), so the capability existed unused.

## Decision

- **The QR wrapper always carries the viewBox taken from the generated code**,
  with `preserveAspectRatio="xMidYMid meet"` and `shape-rendering="crispEdges"`.
  The code is scaled onto the printed box instead of drawn at library units.
- **The QR gets the space the card leaves over**: header 16% of the height
  (capped at 9 mm), footer 12% (capped at 7 mm), and the rest to the code. On the
  default 60 × 60 mm sticker that is 35 mm for a 37-module code — **0.95 mm per
  module**, and no less than 0.9 mm is treated as the floor (asserted in tests).
- **Two payload shapes, one token.** `stickerQrPayload(token, baseUrl)` returns
  the bare token when no base URL is configured, otherwise
  `<base>/v/<token>`. The officer app strips the URL (`normaliseToken`) and the
  verify endpoint receives the token either way, so stickers printed under
  either setting keep working side by side.
- **The base URL is a deployment setting, not tenant config**:
  `PUBLIC_VERIFY_BASE_URL` on the API, unset by default. App addresses are
  deployment settings elsewhere too (ADR 0056), and the API renders the sticker,
  so it is the process that needs the value.
- **A failed camera explains itself.** The field app now names the two reasons a
  phone shows no camera — no secure context, or no browser support — and nudges
  an officer toward manual entry after 12 seconds of an empty viewfinder.

## Consequences

- Stickers printed **before** this change are unscannable and must be reprinted.
  None were in production: the defect was found on the first demo registration.
- Changing `PUBLIC_VERIFY_BASE_URL` only affects stickers rendered afterwards.
  A reprint is not required for old ones: the URL form contains the same token,
  and the scanner reads both.
- The URL form is denser: 41 modules instead of 37, i.e. 0.85 mm per module at
  the default size. Still comfortable for a phone camera, but a long domain
  eats into that budget — keep the verification host short.
- The public verification page **does not exist yet**. `GET /v1/verify/:token`
  returns JSON; a human-facing screen is a later phase. Until it ships, leaving
  `PUBLIC_VERIFY_BASE_URL` empty is the honest setting: a camera shows the
  token rather than a 404.
- A URL payload puts the host name into every sticker, so the host is a
  long-lived commitment once stock is printed.

## Alternatives considered

- **Set `width`/`height` on the inner SVG instead of a viewBox.** Rejected: the
  code is generated without them, and a viewBox is the mechanism that makes
  module units scale.
- **Rasterise the QR to a PNG and embed it.** Rejected: a sticker is printed at
  60 mm; vector survives any printer resolution, and the API would need an image
  encoder it does not otherwise have.
- **Shorten the token so the code is less dense.** Rejected for now: 64 bits of
  checksum and a 128-bit payload are cheap, and a shorter code buys ~0.1 mm per
  module. Revisit if stickers are printed below 40 mm.
- **Put the URL in tenant config.** Rejected: two tenants in one deployment
  would need two public hosts, which is a real requirement only if the
  multi-tenant mode is sold; the setting is one line to move when it is.
- **Print the URL as text under the code instead of encoding it.** Rejected:
  nobody types a URL from a sticker. It stays as an option only if the QR must
  remain a bare token.
