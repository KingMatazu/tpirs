# 0025: UI delivery and the generated API client

## Context

The admin dashboard (and the deferred field app) must be replaceable clients of the backend, never coupled to it. There was no OpenAPI document yet: routes are hand-written Fastify. Meanwhile Steps 4–6 of the UI track (config viewer, channels/USSD simulator, audit screen) need typed browser access to `/v1` endpoints.

## Decision

- **Code-first OpenAPI.** `@fastify/swagger` serves `GET /v1/openapi.json`; route schemas in `apps/api/src/schemas.ts` are the contract source. Swagger is registered **before** any route so the document contains all paths (verified empirically: registering after routes yields a document with zero paths). Webhook routes are `hide: true` — their endpoint tokens are secrets, not public contract.
- **Generated types, hand-written runtime.** `packages/api-client` runs `openapi-typescript` against the served document (`scripts/generate.mjs` imports `@tpirs/api/app`) and contains a small hand-written `openapi-fetch` wrapper (`createApiClient`, `ApiError`, `refreshOnUnauthorized`). We do not generate a client SDK.
- **Admin consumes only the client.** `apps/admin` imports `@tpirs/api-client` and `@tpirs/ui-tokens`; it never imports server code or reaches the database. The dev server proxies `/v1` to the API, so no CORS on the happy path.
- **Schemas are strict-ish on responses.** Every serialised route declares a response schema; bigints/Date values are converted to strings by route serializers in `apps/api/src/routes/*.ts`. `apps/api/src/schemas.test.ts` runs the real fastify serializer over sample payloads to guard against stripping unexpected fields. Free-form JSON (asset `attributes`, audit `before`/`after`) is declared as `{ type: "object", additionalProperties: true }` (+ `nullable`) so screenshots of snapshots survive round-trips.

## Consequences

- The dashboard typecheck consumes regenerated types; after changing API shapes run `pnpm --filter @tpirs/api-client generate`. Drift is caught by typecheck, not by runtime failures.
- Adding a route now costs three places (route, schema, client regeneration); accepted in exchange for a single versioned contract.

## Alternatives considered

- **Zod-first / tRPC.** Rejected: the mission is API-first REST with an OpenAPI source of truth; tRPC couples clients to server types beyond HTTP.
- **Retrofit an OpenAPI document by hand.** Rejected: guaranteed drift; the schema objects already exist inline.
