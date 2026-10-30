#!/usr/bin/env sh
# Dependency-audit gate (Phase 10, Step 4). Fails on a critical or high advisory
# in a production dependency, and on a dev-only one without a live allowlist
# entry. Policy and exceptions: docs/security/audit-allowlist.json.
set -eu

pnpm audit --json 2>/dev/null | node scripts/ci/audit.mjs
