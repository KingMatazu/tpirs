# 0011: One fee engine port, one pure rule-selection function

## Context

Build brief section 3 lists `FeeEngine` as a port: "compute what is owed for an
asset on a date", with v1 adapters "flat, per-asset-type, effective-dated
rules" and future alternatives "zone-based, tiered, custom plugin". Phase 3
needed to price a payment and to snapshot the price on the obligation period.

The rules were originally split: the obligation service carried its own
matching logic, and a `FeeEngine` port existed separately. Two implementations
of the same rule made it possible for the price a driver was quoted and the
price that was recorded to disagree.

The rules also had to be effective-dated: a fee can change on a date, and the
price that applied on the day of use must survive later changes.

## Decision

- **One pure domain function decides everything:**
  `selectFeeRule(rules, { assetType, zoneId, businessDate })` in
  `packages/domain/src/fee-engine.ts`. It returns the winning rule and the
  precedence that explains why it won. It has no dependency on a tenant, a
  database, a clock, or the fee engine port.
- The port is a thin shell over that function:
  `FeeEngine.resolveFee(request) → { amountMinor, currency, ruleId }`, where
  `request` carries `tenantId`, `assetType`, an optional `zoneId`, and the
  `businessDate`. The port throws `PortError("not_found")` when no rule
  matches.
- Two adapters ship today and pass **one** shared conformance suite in
  `packages/contracts/src/fee-engine.ts`:
  - `@tpirs/fee-engine-config` (`ConfigFeeEngine`) reads the tenant's
    validated config and injects the tenant locale currency.
  - `@tpirs/fee-engine-mock` (`MockFeeEngine`) serves a fixed rule table.
- Selection order, in full:
  1. rules whose `effectiveFrom` is on or before the business date, and
  2. rules that match the asset type (an exact asset-type rule beats a
     default rule that applies to every type), and
  3. rules that match the zone when the request names one,
     then the winner is the **latest effective** rule; ties are broken by
     lexicographic `ruleId` so the result is total and deterministic.
- A rule carries its own `currency`. The config adapter overrides it with the
  tenant locale currency, because v1 has one currency per tenant and no FX
  (decisions-needed D7).
- `TenantFeeRule.assetTypeKey` is optional: omitting it makes a **default
  rule** that prices every asset type. This is what lets a tenant price an
  asset type that the config does not list.
- Tenant config validation rejects overlapping rule windows, a rule that ends
  before it starts, an empty rule list, a rule naming an unknown asset type,
  and an asset type that has neither a type-specific rule nor a default rule.
  A tenant cannot be configured into a state where some asset cannot be
  priced.
- The obligation period snapshots `fee_rule_key` and
  `fee_amount_snapshot_minor` when the period is created and again when it is
  paid, so the recorded price never changes with a later fee change.

## Consequences

- There is exactly one place where "which rule prices this" is decided, and
  it is a pure function, so the property test
  `packages/domain/src/fee-engine.property.test.ts` can compare it against an
  independent reference implementation over generated rule sets.
- A new pricing model (zone-based, tiered) is a new adapter or a plugin
  behind the same port; it does not change the obligation service.
- The conformance suite deliberately does **not** assert that an unknown
  asset type is an error: a default rule makes unknown types valid. It does
  assert that an unknown _tenant_ is `PortError("not_found")`.
- The rule id travels with the price, so a receipt or an audit answer can say
  which rule was applied.

## Alternatives considered

- **Keep the matching logic in the obligation service.** Rejected: the quoted
  price and the recorded price would then have two implementations.
- **Make `FeeEngine` a class hierarchy of rules.** Rejected: the rules are
  data in the tenant config, and a pure function over that data is easier to
  test and to reason about than a type hierarchy.
- **Put the currency in the rule only.** Rejected: a tenant with one currency
  should not have to repeat it on every rule, and the tenant locale is the
  authority.
- **Tie-break by rule insertion order.** Rejected: insertion order is not
  stable across config reloads; a lexicographic id tie-break is total and
  reproducible.
- **Resolve the fee in the database with a SQL query.** Rejected: it would put
  pricing rules in two places (config and SQL) and make the property test
  impossible to write.
