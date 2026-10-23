# @tpirs/ussd-provider-africastalking

Africa's Talking adapter for the `ussd-provider` transport port.

- `parseCallback` reads `sessionId`, `phoneNumber`, cumulative `text` and
  `serviceCode`, and falls back to a configured shortcode when the aggregator
  omits the service code.
- `renderResponse` writes a plain-text body prefixed with `CON` (continue) or
  `END` (session over), and declares the 182-character response limit the
  aggregator enforces.
- The adapter knows nothing about menus. The session engine stays pure domain
  code and is injected by the application layer.

Passes the shared conformance suite in `@tpirs/contracts`. Fixtures are recorded
callbacks; tests never touch the network.
