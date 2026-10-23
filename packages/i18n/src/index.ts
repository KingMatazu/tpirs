/**
 * Tenant message catalogues and the translator used by every driver channel.
 *
 * A catalogue is plain data keyed by language and then by message key. Core
 * code never contains driver-facing copy; it refers to a key and the tenant
 * config supplies the text. The translator fails loudly on a missing key or a
 * missing interpolation variable so a typo is caught at startup rather than
 * reaching a driver's phone as a literal `{brace}`.
 */

export type MessageCatalog = Readonly<Record<string, string>>;

/** Language code to catalogue, for example `{ en: { "ussd.main.prompt": "..." } }`. */
export type MessageCatalogs = Readonly<Record<string, MessageCatalog>>;

export type MessageCatalogErrorCode = "invalid_catalog" | "missing_key" | "missing_variable";

export class MessageCatalogError extends Error {
  readonly code: MessageCatalogErrorCode;

  constructor(code: MessageCatalogErrorCode, message: string) {
    super(message);
    this.name = "MessageCatalogError";
    this.code = code;
  }
}

export interface TranslatorOptions {
  readonly catalogs: MessageCatalogs;
  readonly defaultLanguage: string;
  /**
   * Languages a caller may request. Omit to accept every catalogue key.
   * The default language is always enabled.
   */
  readonly enabledLanguages?: readonly string[];
}

export interface Translator {
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  /** Translates `key`, falling back to the default language. */
  t(key: string, vars?: Readonly<Record<string, string | number>>, language?: string): string;
  /** True when the key exists in the requested or default language. */
  has(key: string, language?: string): boolean;
}

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

function validateCatalogs(
  catalogs: MessageCatalogs,
  defaultLanguage: string,
  enabledLanguages: readonly string[],
): void {
  if (defaultLanguage.trim() === "") {
    throw new MessageCatalogError("invalid_catalog", "defaultLanguage must not be empty");
  }
  if (enabledLanguages.length === 0) {
    throw new MessageCatalogError("invalid_catalog", "enabledLanguages must not be empty");
  }
  if (!enabledLanguages.includes(defaultLanguage)) {
    throw new MessageCatalogError(
      "invalid_catalog",
      `defaultLanguage '${defaultLanguage}' must be one of enabledLanguages`,
    );
  }
  for (const [language, rawCatalog] of Object.entries(catalogs as Record<string, unknown>)) {
    if (typeof rawCatalog !== "object" || rawCatalog === null || Array.isArray(rawCatalog)) {
      throw new MessageCatalogError(
        "invalid_catalog",
        `catalog for language '${language}' must be an object`,
      );
    }
    for (const [key, value] of Object.entries(rawCatalog as Record<string, unknown>)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new MessageCatalogError(
          "invalid_catalog",
          `message '${key}' for language '${language}' must be a non-empty string`,
        );
      }
    }
  }
  if (Object.keys(catalogs).length > 0 && catalogs[defaultLanguage] === undefined) {
    throw new MessageCatalogError(
      "invalid_catalog",
      `catalogue for default language '${defaultLanguage}' is missing`,
    );
  }
}

function interpolate(
  template: string,
  key: string,
  vars: Readonly<Record<string, string | number>> | undefined,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars?.[name];
    if (value === undefined) {
      throw new MessageCatalogError(
        "missing_variable",
        `message '${key}' requires variable '{${name}}' but it was not supplied`,
      );
    }
    return String(value);
  });
}

/** Creates a translator over validated catalogues. */
export function createTranslator(options: TranslatorOptions): Translator {
  const { catalogs, defaultLanguage } = options;
  const languages =
    options.enabledLanguages ??
    (Object.keys(catalogs).length === 0 ? [defaultLanguage] : Object.keys(catalogs));
  validateCatalogs(catalogs, defaultLanguage, languages);

  function resolveLanguage(requested: string | undefined): string {
    if (
      requested !== undefined &&
      languages.includes(requested) &&
      catalogs[requested] !== undefined
    ) {
      return requested;
    }
    return defaultLanguage;
  }

  function findTemplate(key: string, language: string): string | undefined {
    return catalogs[language]?.[key] ?? catalogs[defaultLanguage]?.[key];
  }

  return {
    defaultLanguage,
    languages,
    t(key, vars, language) {
      const resolved = resolveLanguage(language);
      const template = findTemplate(key, resolved);
      if (template === undefined) {
        throw new MessageCatalogError(
          "missing_key",
          `message '${key}' is missing from language '${resolved}' and '${defaultLanguage}'`,
        );
      }
      return interpolate(template, key, vars);
    },
    has(key, language) {
      return findTemplate(key, resolveLanguage(language)) !== undefined;
    },
  };
}
