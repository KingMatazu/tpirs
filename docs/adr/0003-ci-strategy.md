# 0003: CI as thin callers over scripts

## Context

The team wants the CI provider to be replaceable without rewriting pipeline
logic, and wants the same checks runnable locally.

## Decision

- All CI logic lives in `scripts/ci/*.sh` and turborepo tasks.
- `.github/workflows/*` are thin callers that set up the toolchain, then invoke
  the scripts. No business logic lives in YAML.
- The verify step runs lint, typecheck, and build; tests run separately; a
  migration check starts a scratch Postgres and proves migrations are reversible.

## Consequences

- Switching to GitLab CI, Buildkite, etc. means writing new thin callers.
- Developers can reproduce each CI step locally with `pnpm ci:verify`, etc.
- Shell scripts assume a POSIX shell (bash on runners, Git Bash/WSL on Windows).

## Alternatives considered

- GitHub Actions with inline logic: rejected as harder to port and reuse.
- A single monolithic CI script: rejected; separate scripts keep failures legible.
