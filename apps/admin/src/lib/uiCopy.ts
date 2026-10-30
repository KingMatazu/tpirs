import { createTranslator } from "@tpirs/i18n";
import type { TenantConfig } from "@tpirs/config";

/**
 * Dashboard copy, as data.
 *
 * The driver channels already keep their copy in tenant config; dashboard copy
 * is not tenant-authored, so it lives here in the languages the product ships.
 * A tenant enables languages in `locale.enabledLanguages`; the shell offers the
 * ones that have a catalogue and falls back to English. Adding a language is a
 * catalogue, not a component change.
 *
 * Scope: the shell and navigation are catalogue-driven. The pre-Phase-9 pages
 * still carry English literals and are migrated as they are touched (recorded
 * in docs/ui-track-implementation.md).
 */
export const UI_CATALOGS = {
  en: {
    "nav.registry": "Registry",
    "nav.payments": "Payments",
    "nav.collectors": "Collectors",
    "nav.reconciliation": "Reconciliation",
    "nav.reports": "Reports",
    "nav.disputes": "Disputes",
    "nav.reversals": "Reversals",
    "nav.channels": "Channels",
    "nav.ussd": "USSD simulator",
    "nav.config": "Configuration",
    "nav.audit": "Audit",
    "shell.signOut": "Sign out",
    "shell.language": "Language",
    "shell.tenant": "Tenant",
    "shell.roles": "Roles",
  },
  fr: {
    "nav.registry": "Registre",
    "nav.payments": "Paiements",
    "nav.collectors": "Collecteurs",
    "nav.reconciliation": "Rapprochement",
    "nav.reports": "Rapports",
    "nav.disputes": "Litiges",
    "nav.reversals": "Contre-passations",
    "nav.channels": "Canaux",
    "nav.ussd": "Simulateur USSD",
    "nav.config": "Configuration",
    "nav.audit": "Audit",
    "shell.signOut": "Se déconnecter",
    "shell.language": "Langue",
    "shell.tenant": "Locataire",
    "shell.roles": "Rôles",
  },
} as const;

export type UiLanguage = keyof typeof UI_CATALOGS;

export const UI_LANGUAGES: readonly UiLanguage[] = Object.keys(UI_CATALOGS) as UiLanguage[];

/**
 * The languages this dashboard can actually speak for a tenant: its enabled
 * languages intersected with the shipped catalogues. Always at least English,
 * and the tenant's default when it has a catalogue.
 */
export function dashboardLanguages(config: { readonly locale: TenantConfig["locale"] }): {
  readonly languages: readonly UiLanguage[];
  readonly defaultLanguage: UiLanguage;
} {
  const enabled = config.locale.enabledLanguages.filter((language): language is UiLanguage =>
    (UI_LANGUAGES as readonly string[]).includes(language),
  );
  const languages = enabled.length === 0 ? (["en"] as const) : enabled;
  const configured = config.locale.defaultLanguage;
  const defaultLanguage = (languages as readonly string[]).includes(configured)
    ? (configured as UiLanguage)
    : "en";
  return { languages, defaultLanguage };
}

export function dashboardTranslator(
  config: { readonly locale: TenantConfig["locale"] },
  selected: string | undefined,
): {
  readonly t: (key: keyof (typeof UI_CATALOGS)["en"]) => string;
  readonly languages: readonly UiLanguage[];
  readonly language: UiLanguage;
  readonly defaultLanguage: UiLanguage;
} {
  const { languages, defaultLanguage } = dashboardLanguages(config);
  const catalogs = Object.fromEntries(
    languages.map((language) => [language, UI_CATALOGS[language]]),
  );
  const translator = createTranslator({
    catalogs,
    defaultLanguage,
    enabledLanguages: languages,
  });
  const language =
    selected !== undefined && (languages as readonly string[]).includes(selected)
      ? (selected as UiLanguage)
      : defaultLanguage;
  return {
    t: (key) => translator.t(key, undefined, language),
    languages,
    language,
    defaultLanguage,
  };
}
