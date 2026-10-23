/**
 * Pure USSD session engine.
 *
 * Providers replay the whole session as a cumulative `text` value, for example
 * `1*ABC123*1`. The engine walks the tenant's menu graph from the start menu
 * and returns the next prompt, an action for the application layer to perform,
 * or an end reason. It has no provider, HTTP, database, or message-rendering
 * dependency, so it can be tested exhaustively and replayed idempotently.
 */

/** Actions the application layer performs when a session reaches a leaf. */
export type UssdAction = "status" | "pay" | "pay_from_balance" | "cancel";

export interface UssdMenuOption {
  readonly key: string;
  readonly labelKey: string;
  readonly next?: string;
  readonly action?: UssdAction;
}

export interface UssdMenuNodeMenu {
  readonly type: "menu";
  readonly key: string;
  readonly promptKey: string;
  /** Optional message shown after an unrecognised option. */
  readonly invalidKey?: string;
  readonly options: readonly UssdMenuOption[];
}

export interface UssdMenuNodeInput {
  readonly type: "input";
  readonly key: string;
  readonly promptKey: string;
  readonly input: {
    readonly key: string;
    /** JavaScript regular expression source; omitted means any non-empty input. */
    readonly pattern?: string;
    readonly errorKey: string;
  };
  readonly next: string;
}

export interface UssdMenuNodeAction {
  readonly type: "action";
  readonly key: string;
  readonly action: UssdAction;
}

export type UssdMenuNode = UssdMenuNodeMenu | UssdMenuNodeInput | UssdMenuNodeAction;

export type UssdEndReason =
  "cancelled" | "invalid_menu" | "invalid_option" | "no_start" | "too_many_steps";

export interface UssdPromptStep {
  readonly kind: "prompt";
  readonly menuKey: string;
  readonly promptKey: string;
  /** Set when the previous segment was rejected; the renderer shows this too. */
  readonly errorKey?: string;
  readonly collected: Readonly<Record<string, string>>;
}

export interface UssdActionStep {
  readonly kind: "action";
  readonly menuKey: string;
  readonly action: UssdAction;
  readonly collected: Readonly<Record<string, string>>;
}

export interface UssdEndStep {
  readonly kind: "end";
  readonly reason: UssdEndReason;
  readonly collected: Readonly<Record<string, string>>;
}

export type UssdSessionStep = UssdPromptStep | UssdActionStep | UssdEndStep;

export interface UssdSessionInput {
  readonly menus: readonly UssdMenuNode[];
  readonly startMenu: string;
  /** Cumulative provider text; segments are separated by `*`. */
  readonly text: string;
  readonly maxSteps?: number;
  readonly maxInputLength?: number;
}

export const DEFAULT_USSD_MAX_STEPS = 12;
export const DEFAULT_USSD_MAX_INPUT_LENGTH = 32;

/** Finds a node by key; useful to the application layer for validation and logs. */
export function findUssdMenu(
  menus: readonly UssdMenuNode[],
  key: string,
): UssdMenuNode | undefined {
  return menus.find((menu) => menu.key === key);
}

function end(reason: UssdEndReason, collected: Record<string, string>): UssdEndStep {
  return { kind: "end", reason, collected: { ...collected } };
}

function prompt(
  node: UssdMenuNodeMenu | UssdMenuNodeInput,
  errorKey: string | undefined,
  collected: Record<string, string>,
): UssdPromptStep {
  return errorKey === undefined
    ? {
        kind: "prompt",
        menuKey: node.key,
        promptKey: node.promptKey,
        collected: { ...collected },
      }
    : {
        kind: "prompt",
        menuKey: node.key,
        promptKey: node.promptKey,
        errorKey,
        collected: { ...collected },
      };
}

function matchesPattern(pattern: string | undefined, value: string): boolean {
  if (pattern === undefined) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // Config validation rejects invalid patterns; a malformed graph must not
    // accept arbitrary input if it ever reaches here.
    return false;
  }
}

/**
 * Replays a cumulative USSD session and returns the next step.
 *
 * An unknown menu option or an invalid input consumes that segment and
 * re-prompts with the configured error key, so a driver can correct a mistyped
 * code without redialling.
 */
export function advanceUssdSession(input: UssdSessionInput): UssdSessionStep {
  const menusByKey = new Map(input.menus.map((menu) => [menu.key, menu]));
  let node = menusByKey.get(input.startMenu);
  if (node === undefined) return end("no_start", {});

  const segments = input.text === "" ? [] : input.text.split("*").map((segment) => segment.trim());
  const maxSteps = input.maxSteps ?? DEFAULT_USSD_MAX_STEPS;
  const maxInputLength = input.maxInputLength ?? DEFAULT_USSD_MAX_INPUT_LENGTH;
  if (segments.length > maxSteps) return end("too_many_steps", {});

  const collected: Record<string, string> = {};
  let index = 0;
  let errorKey: string | undefined;

  for (;;) {
    if (node.type === "menu") {
      if (index >= segments.length) return prompt(node, errorKey, collected);
      const segment = segments[index++] ?? "";
      const option = node.options.find((candidate) => candidate.key === segment);
      if (option === undefined) {
        errorKey = node.invalidKey;
        continue;
      }
      errorKey = undefined;
      if (option.action !== undefined) {
        if (option.action === "cancel") return end("cancelled", collected);
        return {
          kind: "action",
          menuKey: node.key,
          action: option.action,
          collected: { ...collected },
        };
      }
      if (option.next === undefined) return end("invalid_option", collected);
      const next = menusByKey.get(option.next);
      if (next === undefined) return end("invalid_menu", collected);
      node = next;
      continue;
    }

    if (node.type === "input") {
      if (index >= segments.length) return prompt(node, errorKey, collected);
      const segment = segments[index++] ?? "";
      if (
        segment === "" ||
        segment.length > maxInputLength ||
        !matchesPattern(node.input.pattern, segment)
      ) {
        errorKey = node.input.errorKey;
        continue;
      }
      errorKey = undefined;
      collected[node.input.key] = segment;
      const next = menusByKey.get(node.next);
      if (next === undefined) return end("invalid_menu", collected);
      node = next;
      continue;
    }

    if (node.action === "cancel") return end("cancelled", collected);
    return {
      kind: "action",
      menuKey: node.key,
      action: node.action,
      collected: { ...collected },
    };
  }
}
