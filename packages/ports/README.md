# @tpirs/ports

TypeScript interfaces for every external dependency (the swap map in AGENTS.md section 3) plus the shared `PortError` taxonomy. Adapters live in `packages/adapters`; domain logic depends only on these interfaces. This package must stay types-only — no vendor SDKs, no framework imports.
