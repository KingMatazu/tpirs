#!/usr/bin/env sh
# Runs the static checks. Kept as a script (not inline YAML) so the CI vendor
# can be swapped without rewriting pipeline logic.
set -eu

corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

pnpm lint --continue
pnpm typecheck --continue
pnpm build --continue
# The provider matrix is generated from the built adapters; a hand-edited or
# stale table would tell a deployer something the code does not declare.
pnpm docs:providers:check
