# @tpirs/admin

The admin dashboard (UI track, `docs/ui-track-implementation.md`). A thin client
of the OpenAPI contract: it imports `@tpirs/api-client` (generated types + the
`openapi-fetch` runtime) and `@tpirs/ui-tokens` (branding + locale tokens). It
never touches the database and never imports server code (ADR 0025).

## Stack (ADR 0027)

- Vite + React + TypeScript (strict), Tailwind v4 via `@tailwindcss/vite`
- TanStack Query for server state; zustand for session + toast state
- react-hook-form + zod on forms; lucide icons
- Copy-in component base in `src/components/ui.tsx` (Radix primitives arrive with the flows that need dialogs)
- jsdom + Testing Library tests (`pnpm --filter @tpirs/admin test`)

## Run

- `pnpm dev` — Vite on :5173, proxying `/v1` to the API on :3000 (no CORS, cookies are same-origin)
- `pnpm typecheck` / `pnpm test` as usual

## Session model (D26 / ADR 0026)

- Access token lives only in memory (zustand store); never localStorage.
- The refresh token is an httpOnly cookie scoped to `/v1/auth/refresh`, rotated on every use; refresh runs on app start, on 401 (GET replay via `refreshOnUnauthorized`), and at sign-out.

## Screens currently delivered

- **Step 4 — Configuration viewer** (`#/config`, `tenant:read`): every validated config group rendered read-only, including the pay-per-use wording rules.
- **Step 5 — Channels viewer + USSD simulator** (`#/channels`, `#/ussd`, `tenant:read`): the same menu graph the pure engine (`@tpirs/domain`) consumes, the per-language message catalogue matrix, and a browser simulator that replays `advanceUssdSession` against loaded tenant config with no backend or gateway involved.
- **Step 6 — Audit trail** (`#/audit`, `audit:read`): opaque cursor pagination, filters (actor, kind, action, date range), expandable rows showing before/after snapshots, request id and IP. Strictly read-only — the repository and database reject mutations.

Registry and Payments entries are permission-gated placeholders pending their steps.
