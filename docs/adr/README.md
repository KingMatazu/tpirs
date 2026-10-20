# Architecture Decision Records

Short records of significant choices. Newest decisions get the next number.
Format: context, decision, consequences, alternatives considered.

- [0001](./0001-monorepo-and-tooling.md) Monorepo, package manager, and tooling
- [0002](./0002-ports-and-adapters.md) Ports and adapters with conformance suites
- [0003](./0003-ci-strategy.md) CI as thin callers over scripts
- [0004](./0004-delivery-and-deploy.md) Images to GHCR, compose smoke, deploy targets
- [0005](./0005-local-object-store.md) Local S3-compatible store (SeaweedFS) and MinIO drop
- [0006](./0006-tenant-config.md) Tenant config schema, YAML parsing, hand-written validation
- [0007](./0007-public-verify-system-scope.md) Public QR verification resolves assets under the system scope
- [0008](./0008-photo-serving-through-api.md) Asset photos are served through the API, not presigned URLs
- [0009](./0009-svg-sticker-qrcode.md) SVG sticker export generated with the `qrcode` library
