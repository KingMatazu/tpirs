# ADR 0044: Alert rules now, delivery at the deploy target

## Status

Accepted

## Context

The platform already records the signals an operator needs — 5xx counts, webhook
outcomes, outbox backlog age, worker heartbeat, reconciliation age, rate-limit
rejections — but nothing turns them into a page. Phase 10 has to leave the
repository able to alert without pretending a pager exists.

Options considered:

1. **Pick a paging vendor now** (PagerDuty, Opsgenie, e-mail relay) — it would put
   a vendor, an account and a secret into a repo whose deployment target is still
   `noop` (ADR 0004), and the first state will have its own procurement.
2. **Rules as documentation only** — cheap, but the rule file would not be tested
   against the metric names and would drift the first time a metric is renamed.
3. **Rules as machine-readable files, delivered by the target** — the rules are
   reviewable in a diff, testable against the metric contract, and portable to
   whatever the pilot uses.

## Decision

- **`infra/alerts/tpirs.rules.yml`** holds Prometheus-format rules: 5xx rate,
  per-route p95 latency against the budgets, webhook failures and dead-letter
  rows, outbox backlog age, worker heartbeat, reconciliation age,
  rate-limit-rejection spikes, and audit-write or RLS-denial signals.
- **The rules are the contract with the metrics.** A test asserts every metric
  name and label used by a rule exists in the Phase 10 metric contract, so a
  rename breaks the build instead of the alert.
- **Delivery is a deploy-target adapter.** The runbook states that until a target
  wires Alertmanager, e-mail or a pager, the rules evaluate but nothing notifies,
  and the daily check is the reconciliation and health dashboards. No silent
  assumption that someone is watching.
- **Every alert has a runbook section.** `docs/runbooks/alerting.md` says what it
  means, the first three things to check, and who to escalate to. An alert
  without a first action is noise.
- **Alerts are about failure paths, not vanity.** No alert on total payments or
  daily revenue; those are business figures, and an operator cannot act on them
  at 03:00.

## Consequences

- The repository is portable: any Prometheus-compatible stack can consume the
  rules, and a target that uses something else translates one file.
- Until delivery is wired, the rules are a smoke detector with no siren. That is
  recorded in the runbook and repeated in the Phase 10 delivery notes, because the
  alternative — implying monitoring exists — is worse than saying it does not.
- Thresholds live in one file and reference the same budget numbers as the load
  tests, so a budget change is visible in both places in one diff.
- Rule evaluation needs a scraper and a rule evaluator at the target; the repo
  cannot verify a rule fires without them, so the tests cover the metric contract
  and a synthetic evaluation of each expression where practical.

## Alternatives considered

- **A hosted monitoring SaaS** — rejected for this phase: a vendor decision
  belongs with the deployment target, and the state's procurement will decide it.
- **Log-based alerting with no rule files** — rejected: the rules would not be in
  the repo, could not be reviewed in a diff, and would not be tested.
- **Alerting only on the reconciliation outcome** — rejected: it is the last line
  of defence, hours after a webhook or outbox failure started.
- **Silencing alerts until delivery exists** — rejected: it hides the gap. The
  rules ship, and the gap is documented.
