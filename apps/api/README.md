# @tpirs/api

HTTP delivery layer (Fastify). Thin: it wires ports/adapters and exposes the versioned API. Phase 0 ships `/v1/health` and `/v1/ready` plus the request-ID and error-envelope conventions. Business endpoints arrive in later phases.

Run locally: `pnpm --filter @tpirs/api dev`.
