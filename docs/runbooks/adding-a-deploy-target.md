# Runbook: adding a deploy target

The pipeline deploys through a target contract so the hosting provider stays
swappable. To add a target:

1. Create `infra/deploy/<target>.sh`, executable, POSIX shell (`#!/usr/bin/env sh`).
2. Accept the image tag as `$1`. Reject a missing tag with a non-zero exit.
3. Resolve the full image reference from the target's own environment (registry,
   repository, credentials). Never hardcode them in the repo.
4. Make it idempotent: deploying the same tag twice must be a no-op.
5. Never read secrets from the repo; read them from the target's secret store.
6. Exit `0` on success and non-zero on failure. The deploy step fails closed.
7. Point the pipeline at it: set `DEPLOY_TARGET=<target>` (workflow env or repo
   variable). Commit and open a PR.

Validate locally against the noop target first:

```sh
DEPLOY_TARGET=noop pnpm ci:deploy sha-local-test
```

## Contract recap

- Path: `infra/deploy/<target>.sh`
- Invocation: `infra/deploy/<target>.sh <image-tag>`
- Selection: `DEPLOY_TARGET` (default `noop`)
- Caller: `scripts/ci/deploy.sh <image-tag>`
