# ADR 0065: State branding is self-service, and the firm's mark is separate

## Status

Accepted

## Context

After the first-run wizard a state authority wants its own logo on the screens,
its support phone and email on the driver-facing copy, and its colours on the
dashboard. Before this, the only way to change any of that was the whole-config
`PUT`, which takes a complete validated document — a route an operator should not
be handed, and one the generated API client cannot even type (its body schema is
`object`, which becomes `Record<string, never>`).

Two constraints shape where the logo lives:

- **The hosted pilot runs `OBJECT_STORAGE_ADAPTER=mock`.** Anything uploaded to
  object storage is lost between serverless invocations, so a logo stored there
  would disappear. The S3 adapter exists but is not configured for the pilot.
- **The tenant config is `jsonb`, already read by every screen.** Putting the
  image in it needs no new table, no new route, and no migration.

There is also a second brand in the product. The state is the tenant; Star Galaxy
Innovation and Technology Ltd is the firm that built and runs the platform. A
visitor on the sign-in screen has not named a tenant yet, so there is nothing to
brand the page with — and a footer that says who runs the system is a normal part
of a white-label product.

## Decision

**A narrow, audited identity endpoint.** `PATCH /v1/tenants/current/identity`
(`tenant:configure`, so system admin only) accepts `logoUrl`, `supportEmail`,
`supportPhone`, `legalEntity`, `appName` and `colors`. The server merges the patch
into the **stored** document and validates the result, so:

- a section the screen does not show (fees, providers, channels) is carried
  through untouched, and two admins cannot clobber each other by saving a stale
  full document;
- a configuration written by an older release keeps whatever it had;
- the same rules apply as a full `PUT` — a partial edit cannot produce an
  invalid config, and the 422 names the field (`identity.supportContacts.email`,
  `branding.colors.primary`) so the dashboard can put it back on the input.

Every save bumps `config_version` and writes an audit row with before/after.
`legal_entity` is written to its column as well as the config, because the column
duplicates it. **The receipt header is derived from the state's name** on every
save rather than being a separate choice — a receipt that greets a driver with a
stale name is a support call. The **slug never changes**: it is the sign-in
identifier and appears on handover cards.

**The logo is stored inline in the config.** `branding.logoUrl` holds either an
upload (`data:image/png|jpeg|svg+xml|webp;base64,…`, at most 128 KB) or a hosted
`https://` URL. The dashboard downscales a chosen file in the browser (longest
edge 512 px, PNG first, JPEG if a photograph will not fit) before sending it, so a
phone photo of a letterhead never reaches the API. An empty string means "no
logo": screens show the state's initials and the sticker prints its text header.
The old relative `logo.svg` placeholder reads as "no logo" rather than failing the
load, because the API serves no static assets and it was never a logo.

**The API never fetches a logo URL.** "Use a URL" in the dashboard fetches and
inlines the image in the browser; if the host blocks CORS the operator is told to
download the file and upload it. That keeps an administrator-typed URL from
becoming a request-forgery surface, and it is why the sticker inlines only
`data:` logos — a hosted logo prints the text header instead of making a sticker
download call out to an arbitrary host.

**The firm's branding is separate and lives in one file.**
`@tpirs/ui-tokens/firm.ts` exports the footer line, the website href and the firm
logo. The rule the apps follow is "no tenant yet → firm logo, tenant known →
state logo": the dashboard sign-in, the first-run wizard and both phone sign-in
screens carry the firm's mark, and everything after sign-in carries the state's.
The footer is plain text while the href is empty — a link with no destination
would only reload the page it is on — and becomes a new-tab link the moment the
firm's website is set.

## Consequences

- **No migration.** The logo, contacts and colours are config fields, so there is
  no deploy-order hazard and the demo reset (`db:reset-demo`) is unaffected.
- **Audit rows carry the image.** `audit_log.before_data/after_data` hold the
  whole config, so each logo save duplicates it there (~160 KB per edit). That is
  acceptable for the handful of edits a state makes, and it is why the cap is
  128 KB rather than a megabyte.
- **The officer app caches the logo.** Its config lives in `localStorage` so the
  phone can draw its branding offline; a 100 KB logo is a rounding error against
  the quota, and the cache already drops a config that fails today's validation.
- **A rebrand re-themes in place.** The dashboard reads branding from the
  `tenant-config` query, so saving colours updates the shell, the tab title and
  the header logo without a reload.
- **Hosted logos do not reach the sticker.** Only uploads do. That is stated in
  the card's hint text, and the fix is to upload the file.

## Alternatives considered

- **Store the logo in object storage.** Rejected for the pilot: the mock adapter
  does not survive a serverless invocation, and configuring S3 is a deployment
  task, not a branding feature. Revisit if logos grow beyond a thumbnail.
- **A `tenant_logos` table with `GET /v1/tenants/current/logo`.** Rejected: it
  avoids the audit duplication but adds a table, a migration, a route and a
  content-type negotiation path for a 100 KB asset that the config already has a
  home for. Worth doing if stickers ever need print-resolution images.
- **A public branding endpoint for the sign-in page.** Rejected: the sign-in page
  cannot know the tenant before the slug is typed, and the firm's logo is the
  right mark there anyway. No tenant enumeration surface was added.
- **Keep the whole-config `PUT` as the only write path.** Rejected: it invites
  clobbering, and its generated body type is unusable from the dashboard.
- **Let the state edit its own name and slug.** Rejected for now: the slug is the
  sign-in identifier and renaming it would lock out every account that has it
  saved. The state's name is fixed at setup; the receipt header follows it.
