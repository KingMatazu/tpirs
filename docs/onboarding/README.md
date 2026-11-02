# Onboarding a new state

This is the checklist a new deployment follows, in order. It assumes the person
running it has not worked on the codebase: every command is copy-pasteable and
every decision points at the document that explains it.

Two things this guide will not pretend:

- **Infrastructure provisioning is manual.** D1 (hosting and data residency) is
  still open in [`../decisions-needed.md`](../decisions-needed.md). The steps
  below cover one host; a production topology is a deployment decision.
- **A few integrations still need engineering.** They are listed as
  [known gaps](#known-gaps) at the end, so nobody discovers them during a pilot.

## 0. Decisions and approvals to start on day one

These have the longest lead time. Start them before touching a server.

| Item                        | What is needed                                                              | Why it blocks launch                                                                 |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hosting and data residency  | A Postgres instance, a host for the API/worker/UIs, and where data may live | D1; decides latency, backups and procurement paperwork                               |
| Settlement account          | A state-controlled bank account the gateway may settle to                   | Money must not land in a personal or aggregator account                              |
| Payment gateway             | Paystack or Remita, with the settlement account attached                    | Webhook secret and merchant credentials are needed before payments can be tested     |
| USSD shortcode              | An application with the aggregator for the state's own code                 | Approval takes weeks; the code is printed on every poster and sticker                |
| SMS sender ID               | Approval of the 11-character sender ID shown on receipts                    | Messages from an unapproved sender are filtered or spoofed                           |
| Sticker production          | A print supplier, weatherproof vinyl, and the QR/short-code format          | A vehicle is not verifiable without a sticker in the field                           |
| Existing register           | The current vehicle list (CSV or paper) and its column meanings             | Determines how assets get into the registry                                          |
| Languages                   | Which languages the USSD menus, SMS receipts and dashboard must speak       | The config validator requires complete copy for every enabled language               |
| Fees                        | Per-asset-type daily amount in major units, and the effective date          | Becomes the fee rule; changing it later is a new effective-dated rule, not an edit   |
| Currency, timezone, formats | ISO currency, IANA timezone, number/date format                             | Fixed for the tenant at onboarding; changing currency later is a migration, not a UI |
| Branding                    | App name, logo file, colours, receipt header/footer                         | Rendered into the dashboard, field app, stickers and SMS receipts                    |
| Support contacts            | Email and phone shown to drivers and collectors                             | Printed on receipts and used by the support process                                  |
| Staff roles                 | Who is a zone supervisor, finance admin, officer, collector, auditor        | Accounts are created after the wizard, but the list should exist before training     |

Record the answers in one place (a deployment ticket is fine). The wizard asks
for a subset; the rest are set by config update after sign-in.

## 1. Install and migrate

Prerequisites: Docker, Node 24, pnpm 11.1.3. See
[`../runbooks/local-development.md`](../runbooks/local-development.md) for the
per-platform notes.

```sh
git clone <deployment-repo>
cd tpirs
pnpm install
pnpm setup
```

`pnpm setup` copies `.env.example` to `.env` if it is missing, starts Postgres,
Redis and object storage, and applies every migration. It creates **no tenant**:
the first tenant is onboarded in the browser, so the same path is exercised in
development, staging and production.

Do **not** run `pnpm setup --seed` for a real deployment. The seed installs demo
tenants with passwords that are written in the repository.

Then set the deployment values in `.env` (never commit this file):

| Variable                      | Deployment value                                                              |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                | The state's Postgres connection string                                        |
| `SECRET_QR_TOKEN_SIGNING_KEY` | A long random secret, unique per deployment; rotating it invalidates stickers |
| `OBJECT_STORAGE_*`            | The bucket and credentials for sticker/photo/export storage                   |
| `DEPLOYMENT_REGION`           | A label that appears in logs and health output                                |
| `REQUIRE_STAFF_TOTP`          | Leave `false` until the field app has a code field; see known gaps            |
| `METRICS_ENABLED`             | `true` only behind the internal network                                       |
| `ALLOW_DEMO_SEED`             | Must stay unset                                                               |

Start the services:

```sh
pnpm dev
```

For a deployment, run the API, worker and built UIs as services instead; the
local script is only for evaluation. Only the API and worker need to reach the
database; the UIs are static files that call `/v1` on the same origin.

## 2. Onboard the tenant in the browser

Open the admin dashboard (locally <http://localhost:5173>). With zero tenants the
app shows the first-run wizard instead of a sign-in form.

1. **State details** — name, slug, legal entity, support email and phone,
   timezone, currency, primary language. The slug appears in the sign-in form and
   URLs; choose it once.
2. **Administrator email** — an identifier for the first account, not a channel.
   Nothing is emailed in this phase; it exists for the password-reset flow that
   arrives with a mail sender.
3. **Fees and channels** — motorbike and tuk-tuk daily amount in major units,
   USSD code, SMS sender ID. Amounts are stored in minor units.
4. **Choose your credentials** — replaces the temporary `admin` / `password`
   pair created by provisioning. The username may not be `admin`, the password
   must be at least 6 characters, may not be `password`, and may not equal the
   username. Completing this step signs you in.

What the wizard writes: one tenant row and its validated config, the seven
system roles, the first account (now with your credentials), and no zones.
Zones are optional and are created after sign-in — see step 3.

The setup endpoints return `404` from the moment the first tenant exists. There
is no second run.

## 3. Configure the tenant

Sign in as the new administrator.

### Zones

Open **Zones** and create the state's operating zones (parks, markets,
districts). A zone may have a parent, which makes the hierarchy. Zones can be
renamed; they cannot be re-parented or deleted, because payments, scans and audit
rows reference them (ADR 0050). Create the structure you intend to keep.

If the state does not use zones, leave the list empty. Assets, scans and cash
intakes all accept a missing zone.

### Staff accounts

Open **Users** and create one account per person, with:

- a username they will use to sign in (lowercase, 3–40 characters),
- an email identifier (required; used for the reset flow once a sender exists),
- at least one role from the seven system roles,
- a temporary password you hand over in person.

The account must replace that password at first sign-in. Disabling an account
ends its access immediately; resetting a password ends every open session. An
administrator cannot edit their own account — a second administrator is required
by design (ADR 0051).

| Role              | Use it for                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `system_admin`    | Deployment administrator: config, accounts, zones, read-only finance |
| `finance_admin`   | Payments, ledger reversals, reconciliation, reports, dispute resolve |
| `zone_supervisor` | Zone-level assets, scans, cash freeze, reports                       |
| `officer`         | Field scanning and disputes                                          |
| `collector`       | Registering assets and taking cash                                   |
| `auditor`         | Read-only across the ledger, payments, assets and audit trail        |
| `driver`          | Driver self-service (no back-office screens)                         |

### Provider bindings and secrets

Providers are tenant config; credentials are deployment secrets. See
[`provider-decision-guide.md`](./provider-decision-guide.md) for the binding
shape and the secret-reference convention. At minimum, before payments can be
tested:

1. Bind `PaymentProvider` to `paystack` or `remita`.
2. Put the gateway's webhook signing secret in the deployment's
   `SecretsProvider` (environment).
3. Give the gateway the webhook URL for this tenant. The token is provisioned
   programmatically today — see [known gaps](#known-gaps).
4. Bind `SmsProvider` and `UssdProvider` only after their approvals are in hand;
   an unapproved sender ID fails at the aggregator, not here.

### Fees and obligations

The first deployment uses `pay_per_use`: a vehicle owes the fee only on a day it
is used for work. A day with no payment is never a debt, and no reminders are
sent about unpaid days. Changing the fee creates a new effective-dated rule; it
does not rewrite history.

## 4. Verify the deployment

Run the smoke suite against the deployment URL:

```sh
pnpm smoke https://levy.example.state.gov
```

It waits for `/v1/health` and `/v1/ready`, checks the response body and confirms
every response carries a request id. Then, in the dashboard:

1. **Registry** — register one test vehicle and download its sticker.
2. **Field app** — sign in as an officer on a phone, scan the sticker, confirm
   the result shows the identifier and photo.
3. **Payments** — take one test payment through the gateway sandbox and confirm
   it appears with the right amount and reference.
4. **Reconciliation** — run a reconciliation for today and confirm no
   unexplained exceptions.

Suspend the test asset before real registration starts; there is no delete route
for an asset, because scans and payments reference it.

## 5. Register migration and stickers

There is no bulk import screen yet. For a register of more than a few hundred
vehicles, agree a one-off script with engineering that calls `POST /v1/assets`
with an idempotency key per row, and reconcile the created count against the
source list before cutover. For a small pilot, the **Registry** screen and the
collector app are enough.

Sticker production:

- The sticker format (`qrFormat`, `shortCodeFormat`, `stickerSpec`) comes from
  tenant config per asset type.
- `GET /v1/assets/:id/sticker` renders the printable SVG with tenant branding,
  the QR token and the human short code. Print at the configured size
  (`60x60mm` in the template).
- Use weatherproof vinyl. The QR encodes an opaque token with an HMAC checksum;
  it reveals no personal data, and a forged token fails verification.
- Keep the sticker's short code visible: it is the fallback when a driver cannot
  scan or the phone camera fails.

## 6. Train staff and go live

| Audience         | What they must be able to do                                                              |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Officers         | Scan in sunlight, read `NOT_IN_OFFLINE_LIST` correctly, queue a dispute, sync after shift |
| Collectors       | Register a vehicle, take cash, issue the SMS receipt, deposit before the deadline         |
| Zone supervisors | Create and rename zones, freeze a collector, read zone reports                            |
| Finance          | Resolve suspense, approve reversals (two people), run reconciliation, read exceptions     |
| Administrators   | Create/disable accounts, change config, read the audit trail                              |

Two points need saying out loud in every training session:

- The field app never says **UNPAID**. Offline, a vehicle not in the cached paid
  set is `NOT_IN_OFFLINE_LIST`; only an online check, an SMS check or a receipt
  can establish that no payment was recorded.
- Cash is not a gateway payment. The collector's receipt and the deposit are the
  record; the float is restored when the deposit is matched.

## 7. Operate it

| Concern             | Runbook                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| Backups and restore | [`../runbooks/backup-and-restore.md`](../runbooks/backup-and-restore.md) |
| Disaster recovery   | [`../runbooks/disaster-recovery.md`](../runbooks/disaster-recovery.md)   |
| Alerts              | [`../runbooks/alerting.md`](../runbooks/alerting.md)                     |
| Reconciliation      | [`../runbooks/reconciliation.md`](../runbooks/reconciliation.md)         |
| Reports             | [`../runbooks/reports.md`](../runbooks/reports.md)                       |
| Payments            | [`../runbooks/payments.md`](../runbooks/payments.md)                     |
| Ledger corrections  | [`../runbooks/ledger-operations.md`](../runbooks/ledger-operations.md)   |
| Collector cash      | [`../runbooks/collector-cash.md`](../runbooks/collector-cash.md)         |
| Driver channels     | [`../runbooks/driver-channels.md`](../runbooks/driver-channels.md)       |
| Field operations    | [`../runbooks/field-operations.md`](../runbooks/field-operations.md)     |

Run a restore drill before the pilot, not after the first incident. The drill
script is `pnpm db:restore-drill` and the runbook records what a pass looks like.

## Known gaps

State these during planning; none of them is hidden in the code.

1. **Payment webhook endpoints have no screen.** `POST /webhooks/:provider/:endpointToken`
   needs a per-tenant token, and the only way to mint one today is the
   application service call `payment.provisionEndpoint(...)` (used by tests).
   Engineering must provision the token and hand the URL to the gateway. This is
   the first thing to productize after the pilot.
2. **No email is sent.** Email is an account identifier only. Password resets are
   an administrator setting a temporary password; self-service reset waits for a
   mail sender.
3. **OTP delivery uses the composition root's mock SMS provider.** Per-tenant SMS
   banners and receipts use the configured aggregator; the OTP path does not yet.
   Wire a real provider into the OTP service before owner phone verification is
   used in production.
4. **Cache, lock service and clock are mock-only.** One worker process is
   assumed. Redis is already in the compose file; a Redis adapter is not written.
5. **No staff TOTP field in the UIs.** `REQUIRE_STAFF_TOTP=true` locks staff out
   until the sign-in forms expose a code field.
6. **No bulk asset import.** See step 5.
7. **Infrastructure provisioning is manual.** See the note at the top.
