# ADR 0063: Raw requests use the API base URL, not a relative path

## Status

Accepted

## Context

The dashboard's generated client is constructed with `VITE_API_BASE_URL` (or the
page's own origin), so every typed call reaches the API on a split-origin
deployment. Three places bypassed it and used a relative path: the sticker
download and preview, the report export, and the authenticated photo component
(which fetches a URL the API returned).

On the hosted pilot the API and the dashboard are separate Vercel projects
(ADR 0052), so a relative `/v1/...` resolved against `tpirs-admin.vercel.app`,
whose SPA rewrite answers `index.html` with a 200. The sticker download therefore
saved an HTML file, which the browser refused to render as XML ("StartTag: invalid
element name" at column 2) and showed as a broken image. Exports and asset photos
had the same defect; nothing had exercised them cross-origin yet.

## Decision

- **`apiUrl(path)` in `apps/admin/src/api/client.ts` is the one place that turns
  an API path into a URL.** It resolves against the same `VITE_API_BASE_URL` the
  generated client uses. Every hand-rolled `fetch` and every `<img>`/download that
  points at the API goes through it.
- **The API exposes `content-disposition`.** A cross-origin client cannot read a
  response header that is not listed in `Access-Control-Expose-Headers`, so an
  export's server-chosen filename was invisible and the dashboard fell back to its
  own name. The header is now exposed alongside `x-request-id`.
- **The libs keep their injected `fetchImpl`.** `downloadSticker`,
  `fetchSticker` and `downloadReport` still accept a test fetch; only the URL they
  build changed, so the tests assert the path suffix rather than an exact relative
  string.

## Consequences

- Sticker download and preview, report export and asset photos work on both
  deployment shapes: one origin (relative to the page) and split origin (absolute
  to the API).
- A wrong `VITE_API_BASE_URL` now fails loudly on every one of these paths instead
  of silently serving the SPA's HTML.
- Anything new that fetches a `/v1/...` path by hand must call `apiUrl`; the
  relative form is only correct in the single-origin deployment, which is not the
  one the pilot runs.

## Alternatives considered

- **Add a `/v1` rewrite to the dashboard project.** Rejected: it would proxy the
  API through the dashboard, doubling bandwidth and putting the API behind the
  dashboard's caching and headers; the generated client already expects a real
  base URL.
- **Return the sticker as a data URL in the API response.** Rejected: it inflates
  every asset payload and puts the QR in JSON where the collector bug (parsing an
  SVG as JSON) came from.
