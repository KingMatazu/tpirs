# ADR 0045: Internal adversarial review instead of a paid pen test

## Status

Accepted

## Context

Phase 10's acceptance check says "external pen test if possible". A paid
engagement needs budget, a vendor and a signed scope, none of which exist while
the first deployment is still a pilot and the hosting target is `noop`. The
question is not whether security review happens, but what it is and how it is
described afterwards.

Options considered:

1. **Paid external pen test** — the strongest evidence, and the only way to claim
   an independent assessment. It needs procurement and calendar time this phase
   does not control.
2. **No review, rely on tests** — the automated suites cover access control and
   tenant isolation, but nobody has tried to break the system adversarially.
3. **Internal adversarial review** — two engineers, a written scope, a time box,
   and a findings register with the same severity scale an external tester would
   use. Not independent, but honest and repeatable.

## Decision

- **Run an internal adversarial review in this phase**, with the same artefacts a
  paid engagement would produce: `docs/security/pen-test-scope.md` (targets,
  roles, test data, out-of-scope, rules of engagement) and
  `docs/security/findings.md` (id, severity, area, owner, status, fix commit,
  retest evidence).
- **Two people, one attacker and one defender**, so findings are not one
  person's blind spots. The defender does not sign off their own fix.
- **Time-boxed and evidence-based.** Each finding carries a reproduction and a
  retest result; "looks fine" is not a finding status.
- **The record says which review happened.** Delivery notes and the findings
  register label the result "internal adversarial review", never "pen tested".
- **An external test remains open.** D54 records it as available when procurement
  funds it; the scope document is written so it can be handed to a vendor
  unchanged, and the register carries forward.
- **Severity gates the phase.** No open critical or high finding at delivery;
  medium and low findings are accepted with an owner and a date, and the
  acceptance table lists them explicitly rather than rounding them to zero.

## Consequences

- The phase can close without a vendor, and the acceptance check is evidenced by
  a register rather than an assurance.
- The review is not independent, and a state procurement may still require an
  external test before go-live. That is a known, recorded gap — not a surprise
  during onboarding.
- The scope document doubles as onboarding material: a new engineer can read what
  is in scope and why, and the same list seeds the Phase 11 checklist.
- Two engineers' time is the cost, which is affordable and repeatable every
  release; the register becomes a living document rather than a one-off report.

## Alternatives considered

- **Commissioning an external test now** — deferred, not rejected: procurement is
  the blocker, and the scope document is deliberately vendor-ready for when it
  clears.
- **Automated scanning only (dependency audit plus ZAP)** — rejected as a
  substitute: scanners find known classes, not authorisation mistakes in a
  multi-tenant ledger.
- **Bug bounty** — rejected for a pilot: no budget, no triage capacity, and the
  system handles money for a government.
- **Claiming the automated suites are a pen test** — rejected: they prove the
  controls we thought of. An adversarial review exists to find the ones we did
  not.
