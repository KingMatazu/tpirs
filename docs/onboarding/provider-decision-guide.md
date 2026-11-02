# Provider decision guide

The platform reaches every external system through a port, and a port is only
ever used through an adapter that has passed the shared conformance suite in
`@tpirs/contracts`. This guide is for the person choosing adapters during
onboarding: what each port needs, what the shipped adapters declare, and what it
takes to add one.

The numeric capabilities in [`provider-matrix.md`](./provider-matrix.md) are
generated from the adapters' own `capabilities()` calls. Do not copy them into
another document; regenerate the file with:

```sh
pnpm build                     # adapters are read from dist/
pnpm docs:providers            # rewrite docs/onboarding/provider-matrix.md
pnpm docs:providers:check      # fail if the committed file is stale
```

## How a tenant selects an adapter

Adapter choice is tenant configuration, never a code branch. A tenant config has
one binding per port:

```yaml
providers:
  - port: "PaymentProvider"
    adapter: "paystack"
  - port: "SmsProvider"
    adapter: "africastalking"
    options:
      username: "levy-live" # non-secret setting
    secrets:
      apiKey: "payments/sms/africastalking-api-key" # a reference, never the key
  - port: "UssdProvider"
    adapter: "africastalking"
```

- `options` are non-secret settings (usernames, channels, shortcodes).
- `secrets` maps a setting to a **reference**. The env `SecretsProvider` turns
  `payments/sms/africastalking-api-key` into
  `SECRET_PAYMENTS_SMS_AFRICASTALKING_API_KEY` unless a deployment maps it
  differently. A missing secret fails the first request that needs the channel,
  loudly; it is never silently replaced by the mock.
- An adapter key the composition root does not know is an error for that
  channel, not a fallback.

## Where each port is wired

| Port                                                                   | Selected by                                                                     | Shipped adapters                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `PaymentProvider`                                                      | Tenant config binding; `apps/api/src/index.ts` registers the available adapters | Paystack, Remita                                     |
| `SmsProvider`                                                          | Tenant config binding, resolved by `@tpirs/channel-providers`                   | Africa's Talking, Termii                             |
| `UssdProvider`                                                         | Tenant config binding, resolved by `@tpirs/channel-providers`                   | Africa's Talking                                     |
| `SettlementImport`                                                     | Deployment wiring (`apps/api/src/index.ts`)                                     | CSV statement reader                                 |
| `ObjectStorage`                                                        | `OBJECT_STORAGE_ADAPTER=s3\|localdisk`                                          | S3-compatible (SeaweedFS locally), local disk        |
| `ExportService`                                                        | Deployment wiring                                                               | CSV, PDF, XLSX                                       |
| `IdentityProvider`                                                     | Deployment wiring                                                               | Postgres (password + optional TOTP + device binding) |
| `SecretsProvider`                                                      | Deployment wiring                                                               | Environment variables                                |
| `JobQueue`                                                             | Deployment wiring                                                               | Postgres                                             |
| `Telemetry`                                                            | Deployment wiring                                                               | OpenTelemetry, Prometheus, mock                      |
| `Cache`, `LockService`, `Clock`, `BusinessCalendar`, `ReceiptRenderer` | Deployment wiring                                                               | **Mock only** — see known gaps below                 |

## Choosing a payment gateway

Both shipped gateways declare the same attribution mechanism
(`intent_reference`): each payment intent carries a reference the platform
generated, and the webhook returns it. Neither declares per-asset virtual
accounts or payer-typed narration, so **do not promise a driver a dedicated
virtual account number**. A driver pays through the instruction the gateway
returns for that intent (checkout link, transfer with the reference, or USSD
bank transfer).

Choose on what the deployment can actually operate, not only on the matrix:

1. **Settlement account control.** Levy money must land in a state-controlled
   account. Confirm with the gateway that settlement can be pointed at that
   account, and record the account reference in the onboarding checklist. A
   gateway that only settles to a personal or aggregator account is not usable
   for this deployment.
2. **Settlement reporting.** Both adapters declare `supportsSettlementFetch`.
   Confirm the deployment has the credential and the interval for it, or plan a
   CSV statement import instead (D21). Reconciliation needs one of the two.
3. **Webhook signing.** The adapter ships signature verification against a
   per-deployment secret. Confirm the gateway can send the webhook to
   `/webhooks/<adapter>` over HTTPS and that the secret is set in the deployment's
   `SecretsProvider`.
4. **Channel reach.** A checkout link assumes a smartphone; the brief's drivers
   use feature phones. Confirm the gateway supports USSD or bank-transfer
   references for the same intent before the pilot.
5. **Commercials.** Fees, settlement lag and dispute process are captured per
   tenant in `payments`/`reconciliation` config and must match the signed
   contract.

Paystack is the first deployment's choice; Remita remains the alternative and
stays in the tree so a second state is a configuration change, not a port.

## Choosing an SMS or USSD aggregator

- Sender ID and shortcode are approvals, not settings you can invent. Start the
  application for both on day one; they are the longest lead time in onboarding.
- Both SMS adapters declare `supportsInbound: true` and
  `supportsDeliveryReceipts: false`: delivery receipts arrive as push callbacks,
  and the port's polling method returns an empty list rather than inventing data.
  A deployment that needs receipt-based reporting must consume the pushed
  callback, not poll.
- The USSD adapter declares `maxResponseLength: 182` and
  `supportsServiceCode: true`. Keep menu prompts inside the budget; the session
  engine truncates rather than sends a message the handset will cut.
- Add a **second** `SmsProvider` binding only as a replacement, not a fallback:
  one channel has one adapter, so an outage is an operational incident with a
  known owner.

## The acceptance bar for a new adapter

A new adapter is usable when all of the following are true. None of them can be
waived "temporarily":

1. **The port is unchanged.** If the port interface must grow, that is a port
   change with a compatibility story, not an adapter change.
2. **`capabilities()` is honest.** Every declared flag matches behaviour, and
   `attributionKinds` is the source of truth for payment attribution. The
   conformance suite fails an adapter whose flags disagree with each other.
3. **The shared suite passes.** Copy the pattern from a sibling's
   `src/index.test.ts` and run the suite from `@tpirs/contracts` against recorded
   fixtures or a sandbox. `packages/contracts/README.md` shows the injection
   pattern.
4. **Webhooks are verified and recorded.** Payment adapters verify the signature
   and normalize the event; the raw payload is stored before processing.
5. **No vendor SDK outside `packages/adapters`.** HTTP goes through the injected
   transport, so tests never touch the network.
6. **The docs and matrix are regenerated.** Add the adapter to
   `scripts/provider-matrix.mjs`, run `pnpm build && pnpm docs:providers`, and
   update this guide if the choice criteria change.
7. **A tenant can select it from config alone.** If using it requires an
   `if (adapter === ...)` in a core package, the work is in the wrong place.

## Known gaps to state plainly during onboarding

- **OTP delivery uses the composition root's mock SMS provider.** The
  per-tenant `SmsProvider` binding is used for channel replies and receipts. A
  production deployment must wire a real SMS provider into the OTP service
  before owner phone verification is used for real. This is a wiring task, not
  an adapter task; the adapters are complete and conformance-tested.
- **Cache, lock service and clock are mock-only.** Jobs guarded by a distributed
  lock assume one worker process; a multi-worker deployment needs a Redis
  adapter (the compose file already runs Redis).
- **Receipt rendering and the business calendar are mock-only.** Receipts are
  rendered by the built-in template path for now; holidays are not consulted.
- **Infrastructure provisioning is not automated.** D1 (hosting and data
  residency) is still open. The deployment guide covers a single host; a
  production topology is a deployment decision, not a wizard step.
