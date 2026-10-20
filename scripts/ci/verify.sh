#!/usr/bin/env sh
# Runs the static checks. Kept as a script (not inline YAML) so the CI vendor
# can be swapped without rewriting pipeline logic.
set -eu

corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

pnpm lint
pnpm typecheck
pnpm build
