# @tpirs/sms-provider-termii

Termii adapter for the `sms-provider` port: JSON send and inbound callback
parsing. Passes the same shared conformance suite as the mock and Africa's
Talking adapters.

- `send` posts `to`, `from`, `sms`, `type`, `channel` and `api_key` and maps a
  `code: "ok"` response to an accepted result. A 429 becomes
  `PortError("rate_limited")`; a provider error payload becomes
  `PortError("invalid_request")`; a 5xx becomes `PortError("unavailable")`.
- `parseInboundCallback` reads Termii's push payload (`message_id`, `from`,
  `text`, `date`).
- `fetchDeliveryReceipts` and `fetchInbound` return an empty list because Termii
  pushes these events; see `docs/decisions-needed.md` D28.

Transport is injected (`HttpTransport`), so tests replay recorded payloads via
`createRecordedHttpTransport` and never touch the network.
