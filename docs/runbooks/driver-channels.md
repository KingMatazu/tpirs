# Driver channels (USSD/SMS) runbook

## Overview

Driver channels are tenant-configured. Adapters are resolved via `ChannelProviderFactory` (ADR 0022) using `config.providers` bindings and secrets from `SecretsProvider`. Tenancy is resolved from per-tenant webhook endpoint tokens (ADR 0017, D22) before any tenant data is read; unknown/revoked/disabled adapters return 404 identically.

## Webhook endpoints

- `POST /webhooks/ussd/:provider/:endpointToken` — form-encoded or JSON callback. URL adapter key must match tenant binding.
- `POST /webhooks/sms/:provider/:endpointToken` — inbound SMS callback. Always returns 200 for parsed callbacks (including duplicates/suppressed) to avoid provider retry storms.

## USSD

- Stateless replay of cumulative `text` via pure domain engine (ADR 0023). Menus and messages come from `channels.menus` and `channels.messages`.
- Rate limited per IP and per MSISDN (tenant config). Cache-first with locks around actions.
- Malformed callbacks return 400 (`bad_request`).
- Simulator available in admin (UI track) against the same engine and config.

## Inbound SMS

- Parsed via adapter `parseInboundCallback` when supported; replies enqueued transactionally to `channel_messages` and delivered by worker (ADR 0021).
- SMS cost guard counts channel replies + `sms_log` receipts per tenant and per recipient per business day (timezone from config). Receipts are never suppressed.
- No scheduled reminders under `pay_per_use`.

## Rate limiting and abuse

- Shared fixed-window limiter (`@tpirs/application/rate-limiter`) over `Cache`/`Clock`.
- Public `GET /v1/verify/:token` limited to 60/min per IP (platform constant, D5) returning 429 with `Retry-After`.

## Configuration

- `channels.ussdCode`, `channels.smsKeyword`, message catalogs, `channels.ussd`, `channels.sms` limits required when channels are used (validated by config).
- Provider bindings: `SmsProvider`, `UssdProvider` with `adapter` and secret references.

## Troubleshooting

- 404 on callback: token unknown/revoked, adapter not enabled for tenant, or URL adapter key mismatch.
- USSD stuck/looping: check menu graph and message keys; use simulator.
- SMS not sent: check cost guard limits, `channel_messages` status, worker delivery, provider credentials.
