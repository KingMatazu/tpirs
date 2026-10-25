# @tpirs/ui-tokens

Design tokens and tenant-aware formatting for the admin dashboard (ADR 0027).

- `buildDesignTokens(config)` — maps a validated `TenantConfig` (branding colors, locale) into CSS custom property names/values.
- `tokensToCssRoot(tokens)` — renders them as a `:root { ... }` block the app injects at startup, so switching tenants re-themes the UI with no component edits.
- `formatMoneyMinor(amountMinor, currency, locale)` — integer minor units → localized currency string (bigint/number/string amounts, matching the API's decimal-string money).
- `formatBusinessDate(value, locale, pattern)` — business-day display using the tenant date pattern (`dd/MM/yyyy`, `yyyy-MM-dd`).
- `formatTimestamp(value, locale, timezone)` — display formatting of instants in the tenant timezone.

The package is pure TypeScript with a single data dependency on `@tpirs/config`; it never invents colors (fallbacks live in the app CSS) and never contains tenant-specific literals.
