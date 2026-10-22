# 0016: Payment intake as a stored event with an outbox

## Context

Gateways retry webhooks on timeouts, network errors, and non-2xx responses, and
they sometimes deliver the same event twice for reasons of their own. The money
work cannot happen inside the request: verifying a signature, recording the
event, crediting a wallet, allocating a period, posting ledger entries, and
rendering a receipt is far too slow to hold a gateway connection, and a crash
halfway through would leave a payment the gateway believes was delivered.

There is also a crash window that only an outbox closes. If the route records the
event and returns 200, then a worker picks it up, a crash between the two loses
money that the gateway will never retry. If instead the route enqueues a job
first and writes the event afterwards, the inverse window exists. Both directions
have to be eliminated at once.

## Decision

- The raw delivery is stored in `webhook_events` before anything else happens:
  provider, provider event id, raw body, headers, received timestamp.
- A unique constraint on `(tenant_id, provider, provider_event_id)` is the
  deduplication mechanism. An insert that conflicts is a duplicate, and the route
  answers 200 without touching money tables.
- `webhook_events` **is** the queue. Rows with `processed_at IS NULL` are the
  work to do; a worker claims them with `SELECT ... FOR UPDATE SKIP LOCKED`,
  processes the payment transactionally, and sets `processed_at`. `attempts` and
  `last_error` carry retry state, and exceeding the limit marks the row dead.
- The HTTP response is sent as soon as the event is stored, before any money
  work. The gateway is told "received", not "settled".
- Processing is idempotent twice over: the unique event id prevents duplicate
  rows, and every ledger posting carries a `payment:<paymentId>` idempotency key
  so a retried job cannot post twice even if the event row were reprocessed.
- The `JobQueue` port is not used for payment intake. It stays for follow-on
  work such as receipt delivery, where losing a job is recoverable from
  `sms_log` state rather than from a gateway conversation.

## Consequences

- A gateway that gives up after its retry window is harmless: the event is
  already durable.
- A crash during processing leaves the row unprocessed and the job is retried on
  the next claim, because the money transaction rolled back with it.
- The route stays fast, which matters in peak hours when a state's whole fleet
  pays in the same half hour.
- The queue is in Postgres, so retry visibility is a SQL query rather than a
  separate system's dashboard.
- Duplicate deliveries still consume a row insert attempt, but no unique index
  churn: `ON CONFLICT DO NOTHING` reports the duplicate without an exception.

## Alternatives considered

- **Process synchronously in the webhook handler.** Rejected: a slow allocation
  becomes a gateway timeout, which becomes a retry, which becomes a duplicate
  delivery of an event already half-processed.
- **Enqueue on the job queue and store the event later.** Rejected: the job can
  run before the event exists, and a crash after enqueueing but before storing
  loses the only record of what was received.
- **Rely on ledger idempotency alone, with no stored event.** Rejected: without
  the raw body there is no way to re-derive a normalisation bug in production,
  and no way to see events that legitimately failed to normalise.
- **A separate Redis queue with its own durability settings.** Rejected for
  intake: it adds a second system whose loss semantics have to be reasoned about
  separately from the database that already holds the money.
