# 0008: Asset photos are served through the API, not presigned URLs

## Context

Registration captures an asset photo so officers can detect swapped stickers
(build brief section 6). Photos live in `ObjectStorage` (S3-compatible in
deployments, local disk or mock locally). Two serving designs were possible:
presigned URLs minted at read time, or the API proxying bytes itself.

## Decision

- `GET /v1/assets/{id}/photos/{photoId}` loads photo metadata inside the
  tenant's scope (a cross-tenant probe never reveals whether a photo id
  exists), then streams the bytes from `ObjectStorage` with the stored
  content-type and `cache-control: private, max-age=300`.
- Authorization stays in one place — the API's permission guards — and the
  storage adapter never needs URL minting, credentials, or a public bucket.

## Consequences

- Every byte of photo traffic transits the API; at pilot scale this is fine
  (small JPEGs, low request volume), and the port keeps a future presigned
  path open without a domain change.
- Local-disk and mock adapters work identically to S3; no per-adapter serving
  behaviour is required by the shared conformance suite.
- Storage credentials never appear in URLs that could leak through logs or
  referrers.

## Alternatives considered

- **Presigned S3 URLs**: cheaper at scale but couples the read path to one
  adapter's capabilities, complicates short-lived auth on field devices, and
  breaks the "no vendor SDK outside adapters" rule less cleanly (URL minting
  would leak into route code). Revisit in Phase 10 if photo volume demands it.
