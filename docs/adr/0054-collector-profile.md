# ADR 0054: A collector's identity details are three fields with one tenant rule, and stay out of the trail

## Status

Accepted

## Context

A collector takes the daily levy in cash on the state's behalf and deposits it into
a dedicated account. Until now the account record held a username, a display name
and an email — enough to sign in, not enough for a levy office to know who is
holding its money, or to reach them during a shift.

The pilot's requirement is concrete: full name, phone number, national
identification number and home address, with the ID being eleven digits. Three
problems follow from that.

1. **Eleven digits is one state's format.** The platform is sold to other states
   (the brief's white-label rule), and a second state's national number may be nine
   digits, alphanumeric, or prefixed.
2. **The same table holds people who do not handle money.** Officers, finance
   users and auditors share `users`; demanding an identity number from them would
   be collecting personal data with no purpose, which the brief forbids.
3. **The audit trail is append-only and readable by auditors.** A national ID or a
   home address written there can never be removed, and an erasure request would
   have nowhere to go.

## Decision

- **Three nullable columns on `users`** (migration 0022): `phone`, `national_id`,
  `home_address`. Nullable because the table also holds staff with no collector
  profile, and because the demo seed predates the fields.
- **Required only for the collector role.** `collectorProfileIssues` demands all
  three when the role list contains `collector`, and validates the formats
  whenever they are present — a phone number that is not one is no use in an
  emergency, whatever the role.
- **The ID's shape is tenant config.** `collectors.nationalIdPattern` is a
  validated regular expression with an eleven-digit default; the section is
  optional so configurations written before it still load. The route loads the
  config and hands the pattern to the service, so the rule lives in one place and
  a new state changes a line of YAML.
- **No personal data in the audit trail.** The `user.create` descriptor names the
  account, its status and its roles — never the ID, phone or address. A test
  asserts the national ID never appears in any audit row.
- **The form asks only when it applies.** The three fields appear when the
  Collector role is ticked and are required then; the hint is derived from the
  pattern ("11 digits"), so the operator is told the rule without the dashboard
  learning a state's format.
- **`displayName` is the full name.** Relabelled in the form rather than adding a
  second name column that could disagree with it.

## Consequences

- A collector cannot be created without a phone, an ID and an address; an officer
  cannot be created _with_ a required one. The cost of a mistaken role choice is a
  validation error, not a silent gap.
- Editing these details is not implemented yet: an administrator can create them
  and read them, and a correction needs the follow-up work recorded in the phase
  plan.
- Personal data now lives in a table that has no retention rule of its own. The
  tenant's `compliance.retentionDays` governs audit rows, not `users`; a
  collector who leaves is disabled, not deleted, and their profile stays. That is
  the next decision when a state asks for erasure.
- If a state's ID format is not a simple length, the form's hint falls back to
  "As issued by the state" — accurate, if less helpful than the digit count.
