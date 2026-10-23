# Phase 5 implementation: driver channels (USSD and SMS)

This document is the working plan for Phase 5 of `AGENTS.md`. It is scoped to the
driver channels phase: a provider-agnostic USSD session engine, data-driven
menus, inbound SMS commands, template catalogues, and abuse/cost controls.

## Scope decisions carried into this phase

- **DVA creation is deferred.** The platform will support virtual-account
  attribution in the port and configuration now, but the Paystack adapter's
  dedicated virtual account (DVA) creation and webhook normalisation land in a
  later change. Until then the mock and reference-based path remain usable.
- **Both attribution styles are allowed.** A tenant may bind a provider that
  offers `virtual_account` or `intent_reference` attribution. Preference is
  configuration, not code.
- **Pay-per-use wording is strict.** A day with no payment is "no payment
  recorded today", never "unpaid" or a debt. No SMS reminders about unpaid days
  are introduced.
- **No tenant literals.** Menus, prompts, labels, keywords, action messages and
  rate/cost limits come from tenant config and message catalogues.

## Step 0: Record decisions

Add to `docs/decisions-needed.md` and record ADRs:

| ID  | Question                         | Default                                                            |
| --- | -------------------------------- | ------------------------------------------------------------------ |
| D5  | Rate limiting on verify/USSD/SMS | Per-key fixed window through `Cache`, shared limiter               |
| D22 | Channel callback tenancy         | Per-tenant endpoint token, reusing ADR 0017                        |
| D23 | USSD session state               | Stateless replay of cumulative `text`; cache responses for retries |
| D24 | Inbound SMS delivery             | Provider callback parsing as primary, polling as fallback          |
| D25 | Message catalogue location       | `channels.messages` in tenant config, audited with config          |

ADRs: `0021-ussd-session-engine-and-menu-model.md`,
`0022-driver-channel-callbacks.md`, `0023-tenant-message-catalogs.md`,
`0024-rate-limiting-and-sms-cost-guards.md`.

## Step 1: Message catalogues and i18n

1. Add `packages/i18n` (`@tpirs/i18n`) with a translator that interpolates
   `{name}` placeholders, falls back to the default language, and fails loudly
   on a missing key or variable.
2. Add `channels.messages` to the tenant config schema as a map of language to
   message key to text.
3. Validate that every language is in `locale.enabledLanguages`, that the
   default language catalogue exists when keys are referenced, and that every
   referenced key exists in every enabled language.
4. Populate the template tenant and seed tenants with complete catalogues,
   including a second language for the seed.

## Step 2: Menu graph and channel settings

1. Model USSD menus as a typed graph:
   - `menu` nodes: prompt plus options, each option moves to `next` or runs an
     `action`;
   - `input` nodes: prompt plus input key, optional pattern, error message, and
     `next`;
   - `action` nodes: `status`, `pay`, `pay_from_balance`, or `cancel`.
2. Add `channels.startMenu`, session limits (`sessionTimeoutSeconds`,
   `maxInputLength`, `maxSteps`), and rate/cost settings for USSD and SMS.
3. Validate the graph at config load:
   - start menu resolves;
   - every `next` resolves;
   - menu keys are unique;
   - option keys are unique within a menu;
   - every option has exactly one of `next` or `action`;
   - every referenced message key exists in every enabled language.
4. Update `tenants/_template` and the seed with real status and pay flows.

## Step 3: Pure USSD session engine

1. Add `packages/domain/src/ussd.ts` with `advanceUssdSession`.
2. The engine replays the provider's cumulative `text` against the graph and
   returns one of:
   - a prompt (`menuKey`, `promptKey`, optional `errorKey`, collected values);
   - an action (`status`, `pay`, `pay_from_balance`, `cancel`) with collected
     values;
   - an end reason (`cancelled`, `invalid_option`, `too_many_steps`,
     `no_start`, `invalid_menu`).
3. Invalid input or an unknown option re-prompts with the configured error key
   instead of ending the session.
4. The engine is pure: no Fastify, Kysely, provider SDK, or message rendering.

## Step 4: Driver channel service

1. Add `packages/application/src/driver-channel-service.ts`:
   - `status`: resolve the asset by short code or plate, compute the business
     day from tenant timezone, read the obligation period;
   - `pay`: issue an intent or return the tenant's configured instruction;
   - `pay_from_balance`: spend wallet credit when it covers the fee.
2. Status wording maps `paid`/`waived` to "paid today" and `none`/`unpaid` to
   "no payment recorded today". Absence never means debt.
3. Add tenant-scoped asset lookup by plate/identifier where short codes alone
   are insufficient.
4. Tests: paid, no record, waived, unknown reference, intent created once,
   already settled, wallet-covered, provider failure.

## Step 5: Channel message storage

1. Add migration `0008_channel_messages.ts` with a `channel_messages` table:
   tenant, channel, direction, kind, recipient, body, status, provider message
   id, reply linkage, dedupe key, timestamps.
2. Add RLS, grants, reversible `down`, and a unique dedupe index.
3. Add a repository with `recordInbound`, `enqueueOutbound`, `claimPending`,
   `markSent`, `markFailed`, and `countSentOnDate`.
4. Tests: tenant isolation, duplicate inbound no-op, duplicate outbound dedupe,
   migration rollback.

Do not reuse `sms_log`: it is payment- or period-bound and its content is
deliberately immutable once enqueued.

## Step 6: Ports and contracts

1. Split the USSD port into transport and engine:

   ```ts
   interface UssdProvider {
     readonly name: string;
     capabilities(): UssdCapabilities;
     parseCallback(input: UssdCallbackInput): UssdSessionRequest;
     renderResponse(response: UssdSessionResponse): UssdRenderedResponse;
   }
   ```

2. Extend `SmsProvider` with optional inbound callback parsing when
   `supportsInbound` is true; keep `fetchInbound` as a polling fallback.
3. Update the shared conformance suites for round-trips, malformed payloads,
   and declared capabilities.
4. Update the mock adapters and add test helpers for inbound messages.

## Step 7: Real adapters

1. `@tpirs/ussd-provider-africastalking`: parse `sessionId`, `serviceCode`,
   `phoneNumber`, and `text`; render `CON`/`END` text.
2. `@tpirs/sms-provider-africastalking`: send, delivery receipts where honest,
   and inbound callback parsing.
3. `@tpirs/sms-provider-termii`: alternative SMS adapter against the same
   conformance suite.
4. Recorded fixtures only; tests never call the network.
5. **Deferred:** Paystack DVA creation and dedicated-account webhook
   normalisation. The port and config support the capability now; the adapter
   work is a separate change with sandbox fixtures.

## Step 8: Operational services

1. USSD response cache keyed by tenant, provider, session, and cumulative text.
2. `LockService` around action steps so one session cannot create two intents.
3. Rate limiter shared by verify, USSD, and inbound SMS.
4. SMS cost guard counting sends per tenant and per recipient per day.
5. Channel outbox delivery through the worker; no scheduled reminders.

## Step 9: API and composition

1. Add `POST /webhooks/ussd/:provider/:endpointToken` and
   `POST /webhooks/sms/:provider/:endpointToken`.
2. Resolve the tenant through the existing endpoint-token function before any
   tenant data is read. Reject adapters the tenant has not enabled.
3. Add a form-urlencoded parser for provider callbacks.
4. Apply the shared rate limiter to `GET /v1/verify/:token` (closes D5).
5. Wire USSD/SMS adapters per tenant from `config.providers`.

Acceptance tests:

- changing only `channels.menus` changes USSD behaviour;
- changing only `smsKeyword` or a message changes replies;
- a token from one tenant cannot act on another;
- an unknown short code returns the configured message;
- rate limits return provider-compatible output and 429 on verify.

## Step 10: Documentation and gates

1. Update the template, seed, package READMEs, and runbook.
2. Resolve D5 and record D22-D25.
3. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, then
   `scripts/ci/integration.sh` and `scripts/ci/migration-check.sh`.

## Deferred items

- Paystack DVA creation, preferred-bank selection, account lifecycle, and
  dedicated-account webhook fixtures.
- Narration attribution as a last-resort mechanism.
- Field-app offline verification (Phase 6).
- Collector cash wallet (Phase 7).
