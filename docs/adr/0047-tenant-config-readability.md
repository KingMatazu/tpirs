# ADR 0047: Tenant config is readable by staff, writable by admins

## Status

Accepted

## Context

Every dashboard screen renders from the tenant config: the shell needs the
tenant's name, branding and locale; the registry needs the asset schemas; the
cash screens need the float ceilings and deposit deadlines; reconciliation needs
the tolerances. `GET /v1/tenants/current/config` required `tenant:read`, which
only `system_admin` and `auditor` hold.

The consequence was visible on the first manual test: an officer signing in saw
"Missing permission tenant:read" on every page, because the shell asked for the
config to render itself. Finance and collectors were in the same position — the
permission gate was on the wrong resource.

Options considered:

1. **Keep `tenant:read` and project a subset for the shell.** Tried first: a
   `/branding` endpoint with identity, branding and locale. It fixed the shell
   but not the pages — the registry still needs `assetTypes`, the cash screens
   need `cashRules` — so it would have grown into "the config minus a few keys",
   maintained in two places.
2. **Grant `tenant:read` to every role.** Works, but names the permission after
   a role rather than a capability, and leaves the write permission
   `tenant:configure` looking unrelated.
3. **Separate read from write on the same resource.** Reading the config is a
   precondition for rendering; writing it is an administrative act.

## Decision

- **`GET /v1/tenants/current/config` requires an authenticated principal, no
  permission.** Any signed-in staff member may read their own tenant's config.
- **`PUT /v1/tenants/current/config` still requires `tenant:configure`**, is
  audited with before/after, and remains the only way to change it.
- **The config contains secret references, never secret values.** Providers are
  named (`paystack`) and their keys are references resolved by the
  `SecretsProvider`; nothing in the document grants access to anything.
- **It is tenant-scoped by the principal and by row-level security**, so the read
  cannot cross tenants.
- **The dashboard keeps one hook** (`useTenantConfig`) and one endpoint. No
  second, narrower projection to keep in sync.

## Consequences

- Every screen renders for every role without a permission error, and the
  permission model stops describing a resource nobody outside two roles could
  use.
- An officer can read the tenant's fee rules and reconciliation tolerances. That
  is a deliberate widening: it is configuration, not money or personal data, and
  the screens that display it are already gated by their own permissions
  (`payment:read`, `cash:read`, …).
- The write path is unchanged, so the audited, dual-control surface for changing
  fee rules or tolerances is untouched.
- If a state ever treats its configuration as confidential from staff, the
  projection has to come back — with a schema generated from the config type so
  it cannot drift, and with the pages that need more moved to it deliberately.
  That is a product decision, not a default.

## Alternatives considered

- **A branding-only projection** — tried and rejected: it fixed the shell and
  left the registry, cash and reconciliation pages broken for the same roles.
- **Per-page projections** — rejected: each one drifts from the config type and
  needs its own client regeneration and tests.
- **Granting `tenant:read` to every role** — rejected: it makes the permission
  meaningless for reads while leaving writes under a differently named key, and
  hides the actual decision (read is not administrative) inside a role list.
