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
- [0010](./0010-ledger-posting-model.md) Double-entry ledger, wallet-first crediting, single unit of work
- [0011](./0011-fee-engine-port.md) One fee engine port, one pure rule-selection function
- [0012](./0012-ledger-immutability.md) Ledger immutability and the deferred balance constraint
- [0013](./0013-reversal-dual-approval.md) Reversal by mirrored entries with dual approval
- [0014](./0014-fast-check-property-tests.md) `fast-check` for property tests, pinned exactly
- [0015](./0015-pg-type-parsers.md) `pg` type parsers for `int8` and `date`
- [0016](./0016-payment-intake-outbox.md) Payment intake as a stored event with an outbox
- [0017](./0017-webhook-endpoint-tokens.md) Webhook tenant resolution by endpoint token
- [0018](./0018-payment-attribution-intent.md) Attributing a payment to an asset by intent
- [0019](./0019-underpayment-wallet-credit.md) Underpayment as declaration-gated wallet credit
- [0020](./0020-postgres-job-queue.md) A Postgres-backed job queue for background work
- [0021](./0021-channel-outbox.md) Channel messages outbox for SMS/USSD replies
- [0022](./0022-tenant-channel-adapter-composition.md) Tenant-scoped channel adapter composition
- [0023](./0023-stateless-ussd-session-replay.md) Stateless USSD session engine via cumulative text replay
- [0024](./0024-rate-limiting-abuse-controls.md) Rate limiting and abuse controls for channels and public verify
