# 0004: Delivery and deploy targets

## Context

On merge to `main` the platform must build an image, prove it runs, and deploy
it. The hosting provider is not yet chosen (state data-residency requirements are
pending), so the deploy step must not block the pipeline.

## Decision

- On merge: build the image and push it to GHCR tagged `sha-<git-sha>`.
- Bring up the staging compose profile (`infra/docker-compose.staging.yml`) against
  the pushed image inside the pipeline: run migrations, wait for health, run the
  smoke test (`/v1/health` and `/v1/ready` plus the request-id header).
- Deploy via a target contract: `infra/deploy/<target>.sh <image-tag>`, selected
  by `DEPLOY_TARGET`. `infra/deploy/noop.sh` ships first so the whole pipeline is
  wired and green before a real provider exists.
- The deploy step fails closed: a missing or failing target fails the pipeline.

## Consequences

- One image serves both `apps/api` and `apps/worker` (command selects the entry).
- Adding a real target is a single well-documented script; see
  `docs/runbooks/adding-a-deploy-target.md`.
- Hosting choice remains open without leaving the pipeline broken.

## Alternatives considered

- Deploying directly to a provider now: rejected; the provider is undecided.
- Skipping the deploy step: rejected; the pipeline should exercise it from day one.
