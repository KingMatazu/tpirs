# 0021: Channel messages outbox for SMS/USSD replies

## Context

Phase 5 delivers driver channels (USSD and inbound SMS). USSD must respond synchronously to provider callbacks (the aggregator expects an immediate provider-shaped reply), but inbound SMS often produces replies that must go through an `SmsProvider`, cost guards must be enforced per tenant/recipient per business day, and delivery must not block the webhook response. The payment outbox pattern (ADR 0016) uses a transactional outbox; receipts go through the Postgres job queue (ADR 0020). Channel replies need similar durability without forcing synchronous SMS sends in the callback path.

## Decision

- **Transactional enqueue.** When `InboundSmsService` decides to reply, it enqueues a channel message (and may increment counters) in the same transaction boundary where the side effects are recorded. The SMS webhook handler returns 200 quickly and never waits on the aggregator.
- **Pending channel messages.** `channel_messages` (and `pending_channel_messages` view/indexes) track messages by `tenant_id`, channel, status (`pending`/`sent`/`failed`/`suppressed`), recipient, and business date. Replies are deduplicated where appropriate and never double-sent.
- **Worker delivery.** The worker runs a channel outbox sweeper and a `CHANNEL_DELIVERY_QUEUE` handler (`packages/application/src/channel-outbox-sweeper.ts`, `channel-delivery-service.ts`). Delivery uses the tenant's configured `SmsProvider` via `ChannelProviderFactory` (ADR 0022), applies the SMS cost guard (counts replies + `sms_log` receipts; receipts are never suppressed), and records delivery outcomes.
- **USSD is synchronous.** USSD callbacks are parsed, rate-limited, and processed through the stateless session engine (ADR 0023); the provider-shaped response is rendered and returned immediately. No outbox is used for USSD replies.
- **Provider receipts/inbound.** Real adapters may not support delivery receipts or inbound polling; polling returns empty results and delivery is push-only (recorded as needed).

## Consequences

- Webhook handlers stay fast and idempotent; retries happen through the queue with backpressure.
- Cost control is enforced at enqueue/delivery time per tenant config.
- Channel traffic is observable (`sms_log`, `channel_messages`) and tenant-isolated.

## Alternatives considered

- **Synchronous SMS in webhook.** Rejected: slow aggregator responses would hold HTTP connections and risk duplicate deliveries on retries.
- **Reuse `sms_log` only.** Rejected: `sms_log` is keyed to payments; driver-initiated replies need their own queue with different dedup/cost rules.
- **Redis queue first.** Rejected per ADR 0020 posture; Postgres queue fits existing patterns.
