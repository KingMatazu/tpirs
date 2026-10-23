# Payments runbook

## Webhooks

- Endpoints are tokenised: `POST /webhooks/:provider/:endpointToken`. Tokens are stored hashed; the application role resolves them via `resolve_webhook_endpoint()` (SECURITY DEFINER). Never log raw tokens.
- Capture the raw body before JSON parsing (byte-for-byte signature verification). Bad signatures return `accepted: false` with status 400; duplicates and successfully processed deliveries return 200.
- Each provider adapter verifies signatures (`verifyWebhook`) and normalizes payloads (`normalizeWebhook`). All adapters must pass the payment provider conformance and fixture suites.

## Attribution

- Payments are attributed by intent where possible (ADR 0018). Adapters declare `attributionKinds`; intent references map through `payment_intents`/`payment_attributions`.
- If the wallet already covers the fee, no intent is issued. Partial payments credit the asset wallet first (ADR 0019). Unattributable payments go to suspense with an alert path.

## Receipts and outbox

- SMS receipts are enqueued transactionally into `sms_log` (status `pending`). A sweeper lists pending rows via `list_pending_sms()` (SECURITY DEFINER, ids only) and enqueues delivery jobs onto the Postgres job queue. Delivery marks rows `sent` or `failed`; the queue owns retries/backoff (ADR 0020).

## Finance operations

- Finance routes require `payments:read` or `payments:resolve`. Resolve suspense by assigning a payment to an asset (`POST /v1/payments/:id/resolve`) — resolution records an audit entry attributed to the approving user.
- Amounts are serialized as strings to clients. Never infer unpaid from an absent `paymentStatus` on verification (always `unknown` when unknown).

## Adapters

- Real adapters live in `packages/adapters/payment-provider/{paystack,remita}` and must pass the shared conformance suite. Use recorded fixtures for tests; sandbox credentials come from secrets (never committed). Settlement import is deferred to Phase 8.
