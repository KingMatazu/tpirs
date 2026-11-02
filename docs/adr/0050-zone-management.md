# ADR 0050: Zones are created and renamed, never re-parented or deleted

## Status

Accepted

## Context

Phase 11 asks for zone management so an operator can set up a tenant's geography
without a CLI. The table already models a tree (`parent_zone_id` referencing
`zones`), and assets, scans, disputes and reports already point at a zone.

Three operations were considered: create, rename, move, delete.

## Decision

- **Create** takes an optional parent, choosing where in the tree the zone sits.
  The parent must exist in the caller's tenant, checked before the insert.
- **Rename** changes the name only.
- **No move.** Changing `parent_zone_id` is how a tree becomes a cycle (A inside
  B inside A), and nothing in the levy flow re-parents a zone. If a real need
  appears, it belongs in a dedicated operation that walks the chain first, not in
  a general-purpose edit.
- **No delete.** Payments, scans, disputes and the audit trail reference zones by
  id. Deleting one would either orphan those rows or require a cascade that
  rewrites financial history. A zone that should stop being used is renamed
  ("North (retired)") or, later, archived — a reversible, visible act.
- **Uniqueness is the database's job.** Children were already unique within a
  parent. Roots were not: `unique (tenant_id, parent_zone_id, name)` treats two
  `NULL` parents as distinct, so duplicate top-level names were accepted. The
  fix is a partial unique index (`0020`), and the route translates the
  constraint violation (`23505`) into `409` rather than relying on a pre-check
  that races.

## Consequences

- The API is small and hard to misuse: three routes, two of which mutate, and no
  path that can corrupt the tree.
- Retiring a zone leaves a visible trace instead of erasing history.
- A deployment that needs a richer hierarchy (moving zones, merging districts)
  will add it deliberately, with a cycle check, rather than inheriting a PATCH
  that did not have one.
