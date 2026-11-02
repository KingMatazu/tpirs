# Tenant template

A reference tenant configuration: every key the schema accepts, with values that
pass validation. Copy it to develop a new tenant's config, or read it as the
catalogue of what is configurable.

```
tenants/
  _template/
    tenant.config.yaml   # validated against the live schema by a test
    README.md            # this file
  <state-slug>/
    tenant.config.yaml   # committed reference config for a real deployment (optional)
```

A worked example of that reference file is
[`../katsina-state/tenant.config.yaml`](../katsina-state/tenant.config.yaml): it
was exported from a real acceptance run rather than written by hand.

## How a tenant is actually provisioned

The live config lives in the database, not on disk. A new deployment is onboarded
through the first-run wizard in `apps/admin` (see
[`docs/onboarding/README.md`](../../docs/onboarding/README.md)), which builds a
complete config from the answers and validates it before writing anything. After
that, changes go through `PUT /v1/tenants/current/config`, which validates,
audits and versions the config.

The file here is therefore **not loaded by a running deployment**. It exists so
that:

- a reviewer can see every available option and its safe default in one place;
- a deployment can keep a reviewed copy of its intended config under
  `tenants/<state-slug>/` for change review and disaster recovery;
- the schema test in `packages/config/src/config.test.ts` fails if a key is
  renamed, removed or made invalid without this template moving with it.

## What to change first

| Section       | Values that must be state-specific                                     |
| ------------- | ---------------------------------------------------------------------- |
| `identity`    | Name, slug, legal entity, support contacts                             |
| `locale`      | Languages, timezone, currency, number and date formats                 |
| `branding`    | App name, logo, colours, SMS sender ID, receipt header and footer      |
| `assetTypes`  | Labels, attribute schemas, QR/short-code formats, sticker spec         |
| `obligations` | Model (`pay_per_use` for the levy), fee rules and effective dates      |
| `channels`    | USSD code, SMS keyword, every message in every enabled language, menus |
| `providers`   | One binding per port; secrets are references, never values             |

## Rules the validator enforces

- `channels.otpMessageTemplate` must contain `{code}`.
- Once `channels.messages` exists, every key in `CHANNEL_MESSAGE_KEYS`
  (`packages/config/src/channel-contract.ts`) must exist for **every** enabled
  language; the validator reports all gaps at once.
- Money is integer minor units. `feeRules[].amountMinor` is not a decimal string.
- `defaultLanguage` must be one of `enabledLanguages`.
- Fee rules are effective-dated; changing a fee adds a rule rather than editing
  history.
- Provider secrets are references resolved by the deployment's
  `SecretsProvider`.

## What is deliberately absent

- **No code.** Tenant-specific behaviour must be config or a versioned plugin,
  never a branch in a core package.
- **No secrets.** A config file in git contains references only.
- **No demo data.** `pnpm setup --seed` owns the demo tenants; a real deployment
  starts empty and registers its first asset after onboarding.
- **No zones.** A tenant with zero zones is valid; zones are created after
  sign-in (`Zones` screen) because their structure is an operational decision,
  not a setup question.

## Validation

```sh
pnpm --filter @tpirs/config test
```

The suite loads this file through the real loader, so a stale template is a test
failure rather than a surprise during an onboarding.
