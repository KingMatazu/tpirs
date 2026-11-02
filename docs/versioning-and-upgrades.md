# Versioning, licensing and upgrades

How a release is cut, what a tenant may rely on staying stable, and how a state
takes a new core release **without forking**. This is the policy for the
deployments sold from this repository; it does not grant any licence by itself.

## Versioning

The repository is one product and is versioned **as a whole**: a release is a git
tag `v<major>.<minor>.<patch>`. The workspace packages stay `0.0.0` and private;
they are internal modules, not independently published libraries, and treating
them as separately semver-versioned would imply a compatibility promise nobody
can enforce across the monorepo.

| Part    | Changes when                                                                       |
| ------- | ---------------------------------------------------------------------------------- |
| `major` | A tenant must change config, data or an integration to keep working                |
| `minor` | New capability, backwards compatible: route, permission, config field with default |
| `patch` | Fix only; no new behaviour a tenant can observe except the bug disappearing        |

Every deployment records the tag it runs. "Which version is this state on?" must
be answerable from the deployment record, not from a git status on a server.

### What counts as a compatibility promise

- **HTTP API.** `/v1` is additive. Existing routes keep their request and
  response shapes; new fields are optional; a breaking change is `/v2`, served
  alongside `/v1` until tenants move. The generated client in
  `packages/api-client` is regenerated per release and never hand-edited.
- **Tenant config.** New keys ship with defaults, so an existing config keeps
  validating. A key that must disappear is deprecated for one minor (the
  validator warns, the loader still accepts), then removed in the next major.
  `tenants/_template` is updated in the same change that adds a key.
- **Database migrations.** Every migration must roll back (CI runs
  `scripts/ci/migration-check.sh`). Removing a column or table uses
  expand/contract across two releases: stop reading it, ship, then drop it.
  Ledger and audit rows are never rewritten by a migration; corrections are
  reversing entries.
- **Permissions and roles.** New permission keys are additive. A role's seeded
  permission set may grow in a minor; shrinking it is a major, because it removes
  access a tenant may depend on.
- **Provider adapters.** A port interface may gain an optional method in a minor;
  a required method is a major. Adapters are accepted only through the shared
  conformance suite, so a tenant's configured adapter keeps working across an
  upgrade or the release is not cut.

### What is explicitly not promised

- The internal shape of `dist/` output, internal package exports, and the
  generated `schema.gen.ts` file beyond what it is generated from.
- The admin dashboard's visual layout and navigation grouping.
- Anything under `/metrics` beyond the documented metric names in
  `docs/performance-budgets.md`.

## Licensing

**There is no licence file in the repository, so no licence is granted.** Until a
licence is added, the code is all-rights-reserved: it may only be used by the
firm and by parties with a written agreement.

Before the first resale, choose and commit one of:

1. **Proprietary per-state licence** — each state gets a deployment right, no
   source redistribution. Matches government procurement and keeps the upgrade
   path single-source.
2. **Source-available with a support contract** — the state can audit the code
   (a real procurement requirement) but not redistribute it. Requires an explicit
   licence text and a contribution policy.
3. **Open source** — only if the business model is support and hosting rather than
   licence fees; it also makes forks likely, which weakens the upgrade path.

Whichever is chosen, add the `LICENSE` file, state it in `README.md`, and make the
customer contract reference the same terms. Third-party dependencies stay under
their own licences; `pnpm licenses list` is the check before shipping.

## Upgrades: how a tenant takes a release without forking

A fork is the failure mode this policy exists to prevent: it silently stops
receiving security fixes, and it cannot pass the shared conformance suite against
the upstream ports. Tenant-specific behaviour belongs in **configuration**, and
only where configuration cannot express it, in a **plugin** under
`tenants/<slug>/plugins` with a versioned hook — never in an
`if (tenant === ...)` branch.

### Release checklist (maintainer)

1. All gates pass: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `scripts/ci/integration.sh`, `scripts/ci/migration-check.sh`.
2. `pnpm smoke` passes against staging.
3. The API client is regenerated (`pnpm build` covers `@tpirs/api` →
   `@tpirs/api-client`).
4. `docs/onboarding/provider-matrix.md` is current
   (`pnpm docs:providers:check`).
5. `CHANGELOG`-style release notes state: new routes, new config keys and their
   defaults, permission changes, migrations and their reversibility, and any
   behaviour a tenant will notice.
6. Tag `v<major>.<minor>.<patch>`; deploy staging from the tag, not from a branch.

### Upgrade procedure (deployment)

1. Read the release notes; note config keys, migrations and permission changes.
2. **Back up first** (`pnpm db:backup`) and confirm the backup restores in a
   scratch database (`pnpm db:restore-drill`). A backup that has never been
   restored is not a backup.
3. Deploy the tag to staging (or a scratch copy of production) and run
   `pnpm smoke <staging-url>`. Sign in, open the registry, verify one QR.
4. Apply migrations (`pnpm db:migrate`). Migrations are reversible; if the
   release must be abandoned, `pnpm db:migrate:down` returns to the previous
   schema **before** the old code is started.
5. Deploy the API, worker and static UIs from the same tag. Never mix versions
   across the API and worker: they share the database schema and the outbox.
6. Run `pnpm smoke <production-url>` and check the first reconciliation for
   unexpected exceptions.
7. Record the tag in the deployment record.

### Support window (recommended)

Each release is supported until **two minors after it**; security fixes are
backported to the current and previous minor. This is a commercial commitment, so
confirm it in the first customer contract rather than assuming it. A tenant on an
unsupported release can always upgrade — that is the point of avoiding forks —
but the upgrade is then a project, not a patch.

## When a tenant needs behaviour the core does not have

1. **Check config first.** Most asks are a new option on an existing rule
   (fee rule, reconciliation tolerance, channel copy, field settings). Add the
   option with a default and update the template; every tenant benefits.
2. **Check the plugin hook** for fee rules or report columns. A plugin is
   versioned, lives under the tenant's directory, and is loaded only if present.
3. **Only then change the core.** A change that is generally useful ships as a
   minor for everyone; a change that is useful to one state and harmful to the
   rest is a sign the configuration model is missing an axis, and the fix is to
   add that axis.

Under no circumstances is a change made by editing `dist/`, patching a generated
file, or keeping a private branch that diverges from the release tag.
