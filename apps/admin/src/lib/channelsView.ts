import type { TenantConfig, TenantMenu } from "@tpirs/config";

/**
 * Step 5 (channels viewer): flattens the tenant's USSD menu graph and builds the
 * per-language message catalogue matrix. Pure functions — the viewer and the
 * simulator are views over this data, so config-only menu edits change behavior
 * with no code changes (Phase 5 acceptance).
 */

export interface MenuOptionView {
  readonly key: string;
  readonly labelKey: string;
  readonly next: string | null;
  readonly action: string | null;
}

export interface MenuNodeView {
  readonly key: string;
  readonly type: string;
  readonly promptKey: string | null;
  readonly invalidKey: string | null;
  readonly action: string | null;
  readonly inputKey: string | null;
  readonly inputPattern: string | null;
  readonly inputErrorKey: string | null;
  readonly options: readonly MenuOptionView[];
}

/** Flattens the graph breadth-first from `startMenu`; detached nodes go last. */
export function flattenMenus(config: TenantConfig): readonly MenuNodeView[] {
  const byKey = new Map<string, TenantMenu>(config.channels.menus.map((menu) => [menu.key, menu]));
  const ordered: MenuNodeView[] = [];
  const visited = new Set<string>();

  const start = config.channels.startMenu ?? config.channels.menus[0]?.key ?? "";
  const frontier: string[] = start === "" ? [] : [start];
  while (frontier.length > 0) {
    const key = frontier.shift();
    if (key === undefined) continue;
    if (visited.has(key)) continue;
    visited.add(key);
    const menu = byKey.get(key);
    if (menu === undefined) continue;
    ordered.push(toView(menu));
    for (const option of "options" in menu ? menu.options : []) {
      if (option.next !== undefined) frontier.push(option.next);
    }
    if (menu.type === "input") frontier.push(menu.next);
  }

  // Detached nodes (not reachable from the start menu) still show, last.
  for (const menu of config.channels.menus) {
    if (!visited.has(menu.key)) ordered.push(toView(menu));
  }
  return ordered;
}

function toView(menu: TenantMenu): MenuNodeView {
  const base = {
    key: menu.key,
    type: menu.type,
    promptKey: "promptKey" in menu ? menu.promptKey : null,
    invalidKey: "invalidKey" in menu ? (menu.invalidKey ?? null) : null,
    action: "action" in menu ? ((menu as { action?: string }).action ?? null) : null,
    inputKey: menu.type === "input" ? menu.input.key : null,
    inputPattern: menu.type === "input" ? (menu.input.pattern ?? null) : null,
    inputErrorKey: menu.type === "input" ? menu.input.errorKey : null,
    options:
      "options" in menu
        ? menu.options.map((option) => ({
            key: option.key,
            labelKey: option.labelKey,
            next: option.next ?? null,
            action: option.action ?? null,
          }))
        : [],
  };
  return base;
}

export interface CatalogMatrixCell {
  readonly language: string;
  readonly value: string | null;
}

export interface CatalogMatrixRow {
  readonly key: string;
  readonly cells: readonly CatalogMatrixCell[];
}

/** Rows of message keys with one column per enabled language (null = missing). */
export function catalogMatrix(config: TenantConfig): Readonly<{
  languages: readonly string[];
  rows: readonly CatalogMatrixRow[];
}> {
  const messages = config.channels.messages ?? {};
  const languages = config.locale.enabledLanguages.filter(
    (language) => messages[language] !== undefined,
  );
  const keys = new Set<string>();
  for (const catalogue of Object.values(messages)) {
    for (const key of Object.keys(catalogue)) keys.add(key);
  }
  const rows = [...keys].sort().map((key) => ({
    key,
    cells: languages.map((language) => ({
      language,
      value: messages[language]?.[key] ?? null,
    })),
  }));
  return { languages, rows };
}
