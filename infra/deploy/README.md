# Deploy target contract

#

# Every deploy target is a POSIX shell script named `infra/deploy/<target>.sh`.

# It is invoked as:

#

# infra/deploy/<target>.sh <image-tag>

#

# Contract:

# * Argument 1 is the immutable image tag (e.g. `sha-<git-sha>`).

# * The script resolves the full image reference itself (registry/repo from

# its own environment; never hardcoded in this repo).

# * Exit 0 on success, non-zero on failure. The CI `deploy` step fails closed.

# * It must be idempotent: re-running with the same tag is a no-op.

# * It must never read secrets from this repo; use the target's own secret store.

#

# The selected target comes from the `DEPLOY_TARGET` variable; CI defaults to

# `noop` until a real target exists. See docs/runbooks/adding-a-deploy-target.md.
