# @tpirs/i18n

Tenant message catalogues and the translator shared by SMS, USSD, and receipts.

Core packages refer to message **keys**; the tenant config supplies the text in
`channels.messages`. This package performs the lookup, default-language fallback,
and `{name}` interpolation.

## Usage

```ts
import { createTranslator } from "@tpirs/i18n";

const translator = createTranslator({
  catalogs: config.channels.messages,
  defaultLanguage: config.locale.defaultLanguage,
  enabledLanguages: config.locale.enabledLanguages,
});

translator.t("ussd.status.paid", { assetRef: "B12345" }, "fr");
```

`t` falls back to the default language when the requested language has no entry.
It throws `MessageCatalogError` when a key is missing everywhere or when a
placeholder variable was not supplied. Missing copy is a programming/config
error, not something to show a driver as a literal `{brace}`.

`has(key, language?)` reports whether a key is available. `languages` is the
enabled list, and `defaultLanguage` is exposed for callers that need it.

## Validation

Tenant config validation (`@tpirs/config`) checks that every message referenced
by the USSD menu graph exists in **every** enabled language, so a newly enabled
language cannot silently fall back for driver-facing copy.
