# ADR 0039: Anomaly rules and how an alert is delivered

## Status

Accepted

## Context

The brief asks for configurable anomaly rules and alerts, with one explicit
prohibition: under `pay_per_use`, "a vehicle with no payments is not an anomaly;
alert on collectors, zones or officers whose volumes or scan outcomes deviate
from trend".

The platform already has audit entries as an append-only notice channel (Phase 7,
D40: the deposit-deadline notice is an audit entry plus a wallet flag, because
`users` has no phone column). It also has a `reconciliation.notifyRole` config
value that nothing reads yet.

An alarm that fires constantly is worse than no alarm: a queue nobody trusts is a
queue nobody reads. The pilot has no baseline at all, so any threshold chosen now
would be invented.

## Decision

- **Rules are tenant config, and every rule ships disabled.** Each rule carries a
  `key`, `enabled`, `windowDays` (trailing baseline length) and a threshold
  (`thresholdPercent` and/or `thresholdMinor`). `tenants/_template` enables none
  of them, so a new tenant reconciles quietly and opts in when it has history.
- **The rule set covers people and places, never a single asset:**

  | Key                          | Subject   | Fires when                                              |
  | ---------------------------- | --------- | ------------------------------------------------------- |
  | `collector_volume_drop`      | collector | intake volume falls below the trailing mean by a margin |
  | `collector_deposit_lag`      | collector | an intake stays open past a multiple of the deadline    |
  | `zone_compliance_drop`       | zone      | compliance rate falls below its trailing mean           |
  | `officer_scan_volume_change` | officer   | scan volume moves away from the trailing mean           |
  | `suspense_growth`            | tenant    | suspense total exceeds a configured ceiling             |

- **No baseline, no alert.** A rule that cannot compute one (fewer than
  `windowDays` of history, or a zero baseline) records nothing. Firing on the
  first data point would alert on every new collector in their first week.
- **An anomaly is a persisted event**, deduplicated on
  `(tenant, rule_key, subject_type, subject_id, window_end)`, carrying observed,
  baseline, threshold and severity. Re-running the same window cannot produce a
  second row.
- **Delivery in v1 is the persisted event plus an audit entry.** `notifyRole`
  names who is expected to look at the queue, not a phone number. Acknowledging
  an event requires `reconciliation:run` and writes an audit entry. SMS or push
  is deferred with a recorded trigger — a verified staff phone or push token —
  following the D40 precedent.
- **Evaluation lives in the domain and runs after each reconciliation run.** The
  rule is a pure function over a window of aggregates, property-tested for the
  "idle asset never fires" invariant.

## Consequences

- The alert queue starts empty and stays credible: it only contains deviations the
  tenant asked to be told about.
- Thresholds are tuned against real data during the pilot, and every tuning
  change is a config change with an audit entry, not a deploy.
- Acknowledging is deliberately distinct from resolving: an anomaly is a
  statistical observation, so "I looked at it and this is expected" is a complete
  answer.
- The same statistics are visible in reports whether or not the rule is enabled,
  so a tenant can watch a metric for a month before turning the alert on.
- No new delivery infrastructure is introduced; when staff phones arrive, the
  event rows and `notifyRole` are already there to address a message.

## Alternatives considered

- **Alerting on assets with no payments** — rejected by the brief: under
  `pay_per_use` an idle vehicle owes nothing, and an alert would turn a correct
  absence into an accusation.
- **Fixed thresholds with no baseline** — rejected: each tenant's normal differs
  (a rural zone and a city park do not share volumes), and a fixed number would
  be either silent or deafening.
- **Sending SMS now** — rejected: there is no staff phone in the schema (D40), so
  the only possible recipient is an invented one, and a noisy first week trains
  people to ignore the channel permanently.
- **Computing anomalies inside the report query** — rejected: an anomaly needs a
  stable, deduplicated identity and an acknowledgement lifecycle, which is a
  table, and a report should stay a read.
- **A separate anomaly scheduler** — rejected: anomalies are a function of a
  closed business day, so they belong to the reconciliation run that closed it
  rather than to a second timer with its own failure modes.
