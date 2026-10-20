# 0006: Tenant config schema, YAML parsing, and hand-written validation

## Context

Tenant configuration is the contract that makes the platform white-label: a new
state is onboarded by writing config, not code (build brief section 4). The
config must be parsed and validated at startup and on every audited change, with
actionable errors (which field, why) so operators can fix files without reading
source.

Two decisions are involved: which YAML parser, and which validation approach.

## Decision

- **YAML parser: `yaml` (eemeli/yaml v2).** It is dependency-free, well
  maintained, and already present transitively in the tree. Parsing is isolated
  in `packages/config`'s loader.
- **Validation: hand-written, dependency-free** (`packages/config/src/validate.ts`
  and `validator.ts`). The validator accumulates every issue with a dot-path and
  throws a single `TenantConfigValidationError`, so operators see all problems at
  once.
- The schema is expressed as plain TypeScript interfaces in
  `packages/config/src/schema.ts` — the single source of truth for shape and
  types, consumed by validation and by repositories.

## Consequences

- No runtime schema library in the hot path; the config package has one
  dependency (`yaml`).
- Every rule is explicit and reviewable, including cross-field rules such as
  "`pay_per_use` may not accrue arrears" and "a fee rule must reference a defined
  asset type".
- Adding a config field means editing `schema.ts`, the validator, and the
  template together; a schema library with inference could reduce this, at the
  cost of a heavier dependency and less control over error messages.

## Alternatives considered

- **zod / valibot / arktype**: richer inference and error formatting, but adds a
  dependency to a pure-data package and more coupling to a library's API. The
  cross-field rules we need are custom regardless.
- **JSON Schema + ajv**: language-neutral and could generate docs, but needs a
  build step to keep TS types in sync and is heavier for the same result.
- **`js-yaml`**: also available, but `yaml` is dependency-free and preserves
  comments/anchors if we later round-trip config files.
