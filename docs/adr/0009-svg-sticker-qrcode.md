# 0009: SVG sticker export generated with the `qrcode` library

## Context

Registered assets need a printable QR sticker whose size comes from the
tenant's `stickerSpec` (e.g. `60x60mm vinyl`) and whose branding comes from
tenant config (build brief section 3, `ReceiptRenderer` port). Phase 2 needs a
minimal export — QR token, short code, asset-type label, tenant branding — with
no PDF toolchain yet.

## Decision

- `GET /v1/assets/{id}/sticker` returns `image/svg+xml` rendered by
  `packages/application/src/sticker.ts`.
- QR codes are generated with the `qrcode` npm library (v1.5.4, MIT) at error
  correction level `M`; only its `svg` renderer is used, so no canvas/binary
  dependencies are pulled into the server runtime.
- Dimensions are parsed from `stickerSpec` with a `WIDTHxHEIGHTmm` pattern and
  fall back to 60x60mm; branding colors and app name come from the tenant's
  stored config. Nothing tenant-specific is hardcoded.
- SVG (not PNG/PDF) keeps the rendering path pure-string and testable without
  native image libraries; a print shop or browser prints vector output at any
  scale.

## Consequences

- `@tpirs/application` gains one runtime dependency (`qrcode`); it is
  dependency-light otherwise and the import is isolated to `sticker.ts`.
- A future `ReceiptRenderer` adapter can wrap the same function for PDF export
  (e.g. headless Chromium or a vector-to-PDF step) without changing routes.
- Sticker layout is deliberately minimal; richer layouts (logos, zone names)
  stay in tenant-driven template data when a later phase needs them.

## Alternatives considered

- **`pdfkit` / server-side PDF**: heavier native surface, harder to snapshot
  test; deferred until printable PDFs are actually required.
- **QR generation in the browser/dashboard**: would move the signing key
  handling into clients — unacceptable; the token must be minted server-side.
- **`qr-code-styling` / other wrappers**: built on canvas; no SVG-first story.
