# @tpirs/sms-provider-africastalking

Africa's Talking adapter for the `sms-provider` port: form-encoded send and
inbound callback parsing. Passes the shared conformance suite in
`@tpirs/contracts`.

- `send` posts `username`, `to`, `message` and `from` to the aggregator's
  messaging endpoint and reads the first recipient's `messageId` and status code.
  Statuses 100/101/102 count as accepted; anything else is a `PortError`.
- `parseInboundCallback` reads the aggregator's push payload (`id`, `from`,
  `text`, `date`).
- `fetchDeliveryReceipts` and `fetchInbound` return an empty list. Africa's
  Talking only pushes receipts and inbound messages, and the port models a
  polling fallback; returning nothing is honest, inventing receipts is not.
  See `docs/decisions-needed.md` D28.

Transport is injected (`HttpTransport`), so tests replay recorded payloads via
`createRecordedHttpTransport` and never touch the network. The composition root
supplies a real HTTP client.
