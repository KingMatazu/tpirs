# ADR 0069: A Virtual Terminal per collector funds a prepaid float

## Status

Accepted. Supersedes the dedicated-virtual-account funding design of
[ADR 0032](0032-cash-deposit-attribution.md) for tenants on the prepaid model.

## Context

A collector takes cash from drivers and owes it to the State. The platform needs
two things: an exact answer to "how much cash is this person holding", and a way
for the collector to put money back without finance matching a bank transfer by
hand.

ADR 0032 gave each collector a dedicated virtual account through Paystack's DVA
API and matched deposits against open intakes. Three problems surfaced:

1. **DVA provisioning is blocked.** The API needs BVN and eligibility data the
   pilot does not have. Nothing in the adapter was ever wired to it, so the
   `createDepositAttribution` contract has had no real implementation.
2. **A postpaid wallet cannot be "funded".** Under the intake-first model, a
   deposit only posts when an open intake exists; a collector who tops up before
   working sees the money sit in suspense. That is the opposite of a pre-funded
   float.
3. **Cash beats the gateway on cost.** Batching a day's takings into one transfer
   costs 1% capped at ₦300 on a terminal NUBAN, versus 1.5% + ₦100 per payment
   when each driver pays the gateway directly. The funding rail should make the
   batched behaviour the easy one.

Paystack's Virtual Terminal product removes the blocker: `POST /virtual_terminal`
needs only a name, up to five WhatsApp destinations and a currency, and in
Nigeria issues a dedicated NUBAN as a `paymentMethods` entry. The webhook names
the terminal in `metadata.virtual_terminal.code` and `source.identifier`.

## Decision

- **One Virtual Terminal per collector**, provisioned by finance or automatically
  when the collector is created. The terminal code (`VT_…`) is the attribution
  key; the NUBAN is what the collector transfers to.
- **The wallet is prepaid for this tenant.** A top-up credits `COLLECTOR_CASH`;
  a cash intake debits it. The derived balance is negative while credit remains,
  positive when the collector holds the State's cash.
- **Gross credit, State-borne fee.** The top-up posts
  `Dr GATEWAY_CLEARING / Cr COLLECTOR_CASH` for the full amount. The settlement
  posts `Dr SETTLEMENT_BANK (net) + Dr GATEWAY_FEES / Cr GATEWAY_CLEARING`, using
  the existing `settlementFeePostings`.
- **No suspense under prepaid.** A top-up credits the wallet regardless of open
  intakes. The postpaid allocation/suspense path stays for tenants that use it.
- **An intake limit, configured.** The collector may take cash while
  `balance + amount <= limit`, where `limit` is the postpaid ceiling or, under
  prepaid, `0` (hard guard, the default) or `graceMinor` (grace). The same number
  drives the app's `availableMinor`, so a phone cannot offer an intake the server
  will refuse.
- **A maximum balance, configured.** Default ₦50,000. An inbound transfer cannot
  be refused, so exceeding it credits the wallet, writes an audit row and raises
  an alert; it is not a silent drop.
- **Configuration, not code.** `cashRules.model`, `maxBalanceMinor`,
  `intakeGuard`, `graceMinor` and `funding` are tenant settings with defaults that
  preserve existing behaviour. No branch on tenant identity.
- **Pay with Transfer is the recorded fallback**, added later behind the same
  `funding` switch: one charge per top-up, our own reference, exact amount. It is
  not implemented in this change.

## Consequences

- A collector can fund the wallet with any amount at any time, from a bank app or
  a teller, and the credit appears in the same webhook request that Paystack
  delivers. The app polls the wallet to show it.
- The State carries the gateway fee on top-ups (1% capped ₦300 on a terminal
  transfer) and a T+1 settlement float while `GATEWAY_CLEARING` holds the gap.
- There is no reference of ours on a terminal payment, so confirmation is
  webhook-only; Paystack's 72-hour retry plus a daily sweep and a manual
  "record a transfer" fallback cover a missed delivery.
- A terminal without a dedicated NUBAN (some markets, and often Test Mode) is a
  normal state: the app shows the terminal page URL instead of an account number.
- Deleting a collector must deactivate the terminal; the runbook makes that part
  of the leaver procedure.
- The postpaid deadline sweeper becomes irrelevant for this tenant but stays in
  the worker for tenants that keep postpaid.

## Alternatives considered

- **Dedicated Virtual Account per collector.** Rejected: blocked on eligibility
  and BVN, and it would still leave the postpaid/suspense problem.
- **Pay with Transfer for every top-up.** Rejected as the primary rail: it fixes
  the amount when the charge is created, so a collector cannot transfer "whatever
  they have", and every top-up needs an app-initiated charge with an expiry.
  Kept as the fallback.
- **One shared terminal for all collectors.** Rejected: the webhook names the
  terminal, not the payer, so a shared terminal cannot say which collector was
  credited.
- **A Paystack Payment Link per collector.** Rejected: the transaction payload
  does not name the page, attribution would rest on undocumented metadata
  propagation, and there is no reference to verify.
- **Storing a balance column.** Rejected: the balance stays a projection of the
  append-only ledger, as in ADR 0031.
- **Refusing an inbound transfer over the maximum balance.** Rejected: the money
  has already left the collector's bank; refusing it would strand it. Alert and
  credit instead.
