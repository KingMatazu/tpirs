# Katsina State reference tenant

`tenant.config.yaml` here is the configuration the Phase 11 acceptance run
produced. It was not hand-written: a scratch database was migrated, the first-run
wizard's HTTP flow was exercised against it (`GET /v1/setup/status` →
`POST /v1/setup/tenant` → temporary sign-in → `POST /v1/auth/complete-onboarding`),
and the resulting config was exported from `GET /v1/tenants/current/config`.

It is kept because it is useful:

- a reviewer can see a complete, real config rather than the template's
  placeholders;
- a deployment can use it as the reviewed artifact for disaster recovery (the
  live config is in Postgres);
- `packages/config/src/config.test.ts` loads it through the real validator, so a
  schema change that would reject an existing tenant's config fails the suite.

Values that are deployment-specific (support phone, USSD code, sender ID, fees)
are placeholders recorded by the run and must be replaced with the state's
approved values before a real launch. The single enabled language is English; enabling
another language requires a complete message catalogue in that language, which
the validator enforces.

The acceptance record (timing, checks, and the places the runbook still needed
someone who had seen the code) is in
[`docs/phase-11-implementation.md`](../../docs/phase-11-implementation.md#step-11-katsina-acceptance-run-delivered).
