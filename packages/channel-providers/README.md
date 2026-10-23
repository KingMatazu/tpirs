# @tpirs/channel-providers

Composition for the driver channels: tenant config + `SecretsProvider` become a
live `SmsProvider` and `UssdProvider`.

Both `apps/api` (provider callbacks) and `apps/worker` (queued SMS replies) need
the same mapping, so it lives here once. Core packages never learn an
aggregator's name: only tenant config and this package do.

## Supported adapter keys

| Port           | Keys                               |
| -------------- | ---------------------------------- |
| `SmsProvider`  | `mock`, `africastalking`, `termii` |
| `UssdProvider` | `mock`, `africastalking`           |

A tenant with no binding for a port gets no adapter for that port. Callers must
treat the absence as "not enabled", not as a transient failure.

## Secrets

`providers[].secrets` maps an adapter setting to a secret **reference**. Only
the reference is stored in tenant config; the value is read at composition time
through `SecretsProvider`. Options are plain values:

```yaml
providers:
  - port: "SmsProvider"
    adapter: "termii"
    secrets:
      apiKey: "tenant/example/termii-key"
  - port: "UssdProvider"
    adapter: "africastalking"
    options:
      shortcode: "*347*9#"
```

Required settings: `africastalking` SMS needs `username` and `apiKey`; `termii`
SMS needs `apiKey`; the sender id always comes from `branding.smsSenderId`.

## Tests

No test, conformance suite, or fixture in this package or its adapters reaches
the network. Inject `createRecordedHttpTransport` from either SMS adapter to
replay recorded responses.
