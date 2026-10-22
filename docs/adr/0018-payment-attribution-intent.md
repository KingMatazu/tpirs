# 0018: Attributing a payment to an asset by intent

## Context

Under `pay_per_use` a driver pays roughly once per working day, and the money must
land on the right asset without a human deciding. A payment arriving on a shared
state account carries very little: an amount, a payer name, and whatever the payer
typed into a narration field.

Narration is the cheapest attribution mechanism and the least reliable. Drivers
type it on feature-phone bank USSD menus, banks truncate it, some drop it
entirely on transfers to other banks, and one typo sends a working driver's money
to suspense while they stand at the roadside. Making it the default would trade a
one-time integration cost for a permanent operational cost.

## Decision

- Attribution is chosen by the adapter and declared up front. `capabilities()`
  returns `attributionKinds`, an ordered list drawn from
  `intent_reference`, `virtual_account`, and `narration`.
  `createPaymentIntent` returns the `attribution` it actually used, with the kind
  and the instruction to show the driver.
- **Primary: intent reference.** The driver dials USSD and enters the sticker's
  short code. The platform creates an intent for that asset at
  `fee − wallet balance`, and the gateway returns a reference (a one-time
  transfer account where it supports one). The webhook carries that reference,
  which maps to the intent and therefore to the asset. Narration is not read.
- **Optional: per-asset virtual account.** A persistent dedicated account,
  available when the adapter declares `virtual_account`, for tenants that can
  afford one account per asset.
- **Last resort: narration reference.** Shared account plus a short alphanumeric
  reference with a check character, matched tolerantly (case and whitespace
  ignored). Supported so a gateway with no better mechanism can still be used; it
  is never selected silently.
- If the wallet already covers the fee, no intent is issued: the correct action is
  "pay today from balance" (ADR 0019).
- An adapter that cannot issue an intent reference declares that, and the
  platform surfaces it at configuration time rather than discovering it when the
  first driver pays.
- Unmatched or unattributable payments still exist and still go to suspense.

## Consequences

- The happy path needs no matching heuristics, so suspense becomes genuinely
  exceptional rather than the normal outcome of a typo.
- The gateway's intent expiry becomes a real operational parameter: a driver who
  waits too long must request a new reference. The expiry is shown in the USSD
  response.
- Intent creation costs a gateway call per working day per paying asset, which is
  the same order as the number of payments.
- The `intent_reference` mapping must be durable and unique per provider
  reference, because it is the only thing standing between a payment and
  suspense.

## Alternatives considered

- **Narration as the default.** Rejected: bank-layer truncation and typos push
  ordinary payments into suspense, and finance cannot fix that at fleet scale.
- **One dedicated virtual account per asset as the default.** Rejected: cost and
  per-tenant account limits make it unaffordable for thousands of bikes, even
  where the gateway allows it.
- **Payer phone number as the key.** Rejected: drivers change SIMs, a phone can
  own several assets, and the payer is not necessarily the owner.
- **Manual finance matching for everything.** Rejected: it defeats the point of
  unattended daily collection.
