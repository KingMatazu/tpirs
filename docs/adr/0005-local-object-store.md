# 0005: Local S3-compatible object store and MinIO drop

## Context

Local development and CI need an S3-compatible object store that starts with
`docker compose up` and pulls anonymously. MinIO is the conventional pick, but
its Docker Hub images now require authentication to pull (`minio/minio:latest`
returns `pull access denied`), which breaks one-command onboarding and
credential-free CI. Mirrors and community tags can disappear, so relying on them
is not viable either.

## Decision

- Use **SeaweedFS** (`chrislusf/seaweedfs`, pinned to an exact version, never
  `latest`) as the local/CI S3-compatible store. It pulls anonymously, exposes
  an S3 gateway, and needs no login bootstrap.
- Treat the local store as a **dev and CI convenience only**. Production uses
  whatever S3-compatible store the state's host provides.
- Provide a **no-container fallback**: a filesystem-backed `ObjectStorage`
  adapter for unit tests and developers who do not want to run a store.
- The `ObjectStorage` port keeps this choice out of domain code; both adapters
  (`@tpirs/adapters-s3-storage`, `@tpirs/adapters-localdisk-storage`) pass the
  shared conformance suite, and the S3 adapter's contract tests run against
  SeaweedFS when an endpoint is configured.

## Consequences

- If SeaweedFS fails a behaviour we need, switch to Garage (also anonymous,
  S3-compatible) and change only the compose file and adapter config.
- The pinned image tag must be bumped deliberately; upstream changes cannot
  silently break local setup.
- Adding a real S3 store for a tenant is configuration, not code.

## Alternatives considered

- MinIO with `docker login`: rejected; requires credentials for local setup and CI.
- MinIO via a quay.io/community mirror: rejected; mirrors are unreliable.
- Garage now: acceptable fallback, but SeaweedFS needs no config/bootstrap.
