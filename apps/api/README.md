# @tpirs/api

HTTP delivery layer (Fastify). Thin: it wires ports/adapters and exposes the versioned API. Business endpoints arrive in later phases.

Run locally: `pnpm --filter @tpirs/api dev`.

## Endpoints

- `GET /v1/health`, `GET /v1/ready` — liveness/readiness.
- `POST /v1/auth/login`, `GET /v1/auth/me` — staff authentication (password, optional TOTP via the identity provider).
- `GET/PUT /v1/tenants/current/config` — read and audited update of the caller's tenant config.
- `POST/GET/PATCH /v1/assets`, `POST /v1/assets/:id/suspend` — asset registry (Phase 2).
- `POST /v1/assets/:id/photos`, `GET /v1/assets/:id/photos/:photoId` — photo upload and proxied download (ADR 0008).
- `GET /v1/assets/:id/sticker` — printable SVG sticker, branded from tenant config (ADR 0009).
- `GET /v1/verify/:token` — public QR verification; HMAC-checked, fail-closed 404, no payment status yet (ADR 0007).
- `POST /v1/owners`, `POST /v1/owners/verify/request|confirm` — owner registry and OTP phone verification.

Every mutating request is audited (`auditLog`, append-only). Errors use the shared envelope with `requestId`.

## Tests

DB-backed route tests skip unless `TEST_DATABASE_URL` is set; run `sh scripts/ci/integration.sh` (or export the variable against a migrated database) for the full suite, including `src/routes/assets.routes.test.ts` (asset registry e2e).
