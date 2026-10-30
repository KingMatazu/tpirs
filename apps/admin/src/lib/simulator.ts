import { advanceUssdSession } from "@tpirs/domain";
import {
  createTranslator,
  MessageCatalogError,
  type MessageCatalogs,
  type Translator,
} from "@tpirs/i18n";
import type { TenantConfig } from "@tpirs/config";

/**
 * USSD simulator (Step 5): runs the pure session engine from @tpirs/domain
 * against the tenant's configured menu graph and renders prompts through the
 * tenant's message catalogues — in the browser, with no backend involved. Type
 * a selection and this mirrors what a driver's handset would show.
 */

export interface SimulatorOption {
  readonly key: string;
  readonly label: string;
}

export interface SimulatorCollected {
  readonly key: string;
  readonly value: string;
}

export type SimulatorFrame = Readonly<
  | {
      kind: "prompt";
      prompt: string;
      errorLine: string | null;
      choices: readonly SimulatorOption[];
      expectsInput: boolean;
    }
  | { kind: "action"; action: string; collected: readonly SimulatorCollected[] }
  | { kind: "end"; endReason: string; collected: readonly SimulatorCollected[] }
>;

/** Builds the tenant translator; caller passes the active language per call. */
export function createTenantTranslator(config: TenantConfig): Translator {
  const messages: MessageCatalogs = config.channels.messages ?? {};
  const languages =
    Object.keys(messages).length === 0
      ? [config.locale.defaultLanguage]
      : config.locale.enabledLanguages;
  return createTranslator({
    catalogs: messages,
    defaultLanguage: config.locale.defaultLanguage,
    enabledLanguages: languages,
  });
}

/**
 * Variables the session has not collected yet render as their own placeholder
 * (`{amount}`) instead of throwing. A simulator must show the prompt a handset
 * would, including the parts the driver has not supplied.
 */
function simulatorVars(collected: Readonly<Record<string, string>>): Record<string, string> {
  return new Proxy(
    { ...collected },
    {
      get: (target, property) => target[String(property)] ?? `{${String(property)}}`,
    },
  );
}

/** Missing catalogue keys render as a visible marker, never a thrown error. */
function safeTranslate(
  translator: Translator,
  key: string,
  language: string,
  collected: Readonly<Record<string, string>> = {},
): string {
  try {
    return translator.t(key, simulatorVars(collected), language);
  } catch (error) {
    if (error instanceof MessageCatalogError && error.code === "missing_key") {
      return `[${key}]`;
    }
    throw error;
  }
}

/**
 * Replays the cumulative USSD `text` (segments joined by `*`, as providers send)
 * and returns the frame the handset should display next.
 */
export function simulateUssd(config: TenantConfig, text: string, language: string): SimulatorFrame {
  const translator = createTenantTranslator(config);
  const startMenu = config.channels.startMenu ?? config.channels.menus[0]?.key ?? "";
  const step = advanceUssdSession({
    menus: config.channels.menus,
    startMenu,
    text,
    ...(config.channels.ussd === undefined
      ? {}
      : {
          maxSteps: config.channels.ussd.maxSteps,
          maxInputLength: config.channels.ussd.maxInputLength,
        }),
  });

  if (step.kind === "prompt") {
    return {
      kind: "prompt",
      prompt: safeTranslate(translator, step.promptKey, language, step.collected),
      errorLine:
        step.errorKey === undefined
          ? null
          : safeTranslate(translator, step.errorKey, language, step.collected),
      choices: config.channels.menus.some(
        (menu) => menu.key === step.menuKey && menu.type === "menu",
      )
        ? stepMenu(config, step.menuKey).options.map((option) => ({
            key: option.key,
            label: safeTranslate(translator, option.labelKey, language, step.collected),
          }))
        : [],
      expectsInput: config.channels.menus.some(
        (menu) => menu.key === step.menuKey && menu.type === "input",
      ),
    };
  }

  const collected = Object.entries(step.collected).map(([key, value]) => ({ key, value }));
  if (step.kind === "action") {
    return { kind: "action", action: step.action, collected };
  }
  return { kind: "end", endReason: step.reason, collected };
}

export function eraseCatalogues(source: TenantConfig): TenantConfig {
  return {
    ...source,
    channels: {
      ...source.channels,
      messages: {},
    },
  };
}

function stepMenu(
  config: TenantConfig,
  menuKey: string,
): { options: readonly { key: string; labelKey: string }[] } {
  const menu = config.channels.menus.find((candidate) => candidate.key === menuKey);
  if (menu?.type === "menu") {
    return { options: menu.options };
  }
  return { options: [] };
}
