import { createTranslator } from "@tpirs/i18n";
import type { Translator } from "@tpirs/i18n";
import type { TenantConfig, TenantMenu } from "@tpirs/config";
import type { UssdPromptStep } from "@tpirs/domain";
import { findUssdMenu } from "@tpirs/domain";
import type { Telemetry } from "@tpirs/ports";

/** Turns message keys into a driver-facing string for one tenant. */
export interface ChannelRenderer {
  readonly translator: Translator;
  /** Translates a key, throwing on a missing key or variable. */
  text(key: string, vars?: Readonly<Record<string, string | number>>): string;
  /**
   * Like `text`, but reports the failure and returns the key itself instead of
   * throwing. Used on paths where a provider is waiting for a reply and there
   * is no useful way to fail the callback: a diagnostic beats silence.
   */
  safeText(key: string, vars?: Readonly<Record<string, string | number>>): string;
  /** Renders a prompt step: an optional error line, the prompt, and any options. */
  prompt(step: UssdPromptStep, menus: readonly TenantMenu[]): string;
  /** Truncates to a provider's maximum response length. */
  fit(text: string, maxLength: number): string;
}

export interface ChannelRendererDeps {
  readonly telemetry?: Telemetry;
}

/**
 * Builds the translator for a tenant from `channels.messages`.
 *
 * The catalogue is data. Nothing here decides wording, language, or menu text;
 * it only looks up the key the runtime asked for. Config validation guarantees
 * that every key the runtime can reach exists in every enabled language, so a
 * failure here is an operator error that telemetry records immediately.
 */
export function createChannelRenderer(
  config: TenantConfig,
  deps: ChannelRendererDeps = {},
): ChannelRenderer {
  const translator = createTranslator({
    catalogs: config.channels.messages ?? {},
    defaultLanguage: config.locale.defaultLanguage,
    enabledLanguages: config.locale.enabledLanguages,
  });

  function text(key: string, vars?: Readonly<Record<string, string | number>>): string {
    return translator.t(key, vars);
  }

  function safeText(key: string, vars?: Readonly<Record<string, string | number>>): string {
    try {
      return text(key, vars);
    } catch (error) {
      deps.telemetry?.captureError(error, { stage: "channel-render", key });
      return key;
    }
  }

  function prompt(step: UssdPromptStep, menus: readonly TenantMenu[]): string {
    const lines: string[] = [];
    if (step.errorKey !== undefined) {
      lines.push(safeText(step.errorKey, step.collected));
    }
    lines.push(safeText(step.promptKey, step.collected));

    const node = findUssdMenu(menus, step.menuKey);
    if (node?.type === "menu") {
      for (const option of node.options) {
        lines.push(`${option.key}. ${safeText(option.labelKey, step.collected)}`);
      }
    }
    return lines.join("\n");
  }

  function fit(value: string, maxLength: number): string {
    if (!Number.isInteger(maxLength) || maxLength < 1) return value;
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  }

  return { translator, text, safeText, prompt, fit };
}
