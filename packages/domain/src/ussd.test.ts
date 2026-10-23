import { describe, expect, it } from "vitest";
import {
  DEFAULT_USSD_MAX_STEPS,
  advanceUssdSession,
  findUssdMenu,
  type UssdMenuNode,
} from "./ussd.js";

const menus: readonly UssdMenuNode[] = [
  {
    type: "menu",
    key: "main",
    promptKey: "ussd.main.prompt",
    invalidKey: "ussd.main.invalid",
    options: [
      { key: "1", labelKey: "ussd.main.pay", next: "pay.enter" },
      { key: "2", labelKey: "ussd.main.status", next: "status.enter" },
      { key: "0", labelKey: "ussd.main.cancel", action: "cancel" },
    ],
  },
  {
    type: "input",
    key: "pay.enter",
    promptKey: "ussd.pay.enter",
    input: {
      key: "assetRef",
      pattern: "^[A-Z0-9]{3,8}$",
      errorKey: "ussd.pay.invalid",
    },
    next: "pay.confirm",
  },
  {
    type: "menu",
    key: "pay.confirm",
    promptKey: "ussd.pay.confirm",
    options: [
      { key: "1", labelKey: "ussd.common.confirm", action: "pay" },
      { key: "2", labelKey: "ussd.common.cancel", action: "cancel" },
    ],
  },
  {
    type: "input",
    key: "status.enter",
    promptKey: "ussd.status.enter",
    input: { key: "assetRef", errorKey: "ussd.status.invalid" },
    next: "status.run",
  },
  { type: "action", key: "status.run", action: "status" },
  {
    type: "action",
    key: "wallet.pay",
    action: "pay_from_balance",
  },
];

function session(text: string, options: { maxSteps?: number; maxInputLength?: number } = {}) {
  return advanceUssdSession({
    menus,
    startMenu: "main",
    text,
    ...options,
  });
}

describe("advanceUssdSession", () => {
  it("prompts the start menu for an empty session", () => {
    expect(session("")).toEqual({
      kind: "prompt",
      menuKey: "main",
      promptKey: "ussd.main.prompt",
      collected: {},
    });
  });

  it("prompts the input field after a menu choice", () => {
    expect(session("1")).toEqual({
      kind: "prompt",
      menuKey: "pay.enter",
      promptKey: "ussd.pay.enter",
      collected: {},
    });
  });

  it("prompts the confirmation after a valid input", () => {
    expect(session("1*ABC123")).toEqual({
      kind: "prompt",
      menuKey: "pay.confirm",
      promptKey: "ussd.pay.confirm",
      collected: { assetRef: "ABC123" },
    });
  });

  it("returns the pay action with collected values", () => {
    expect(session("1*ABC123*1")).toEqual({
      kind: "action",
      menuKey: "pay.confirm",
      action: "pay",
      collected: { assetRef: "ABC123" },
    });
  });

  it("returns the status action for a status lookup", () => {
    expect(session("2*ABC123")).toEqual({
      kind: "action",
      menuKey: "status.run",
      action: "status",
      collected: { assetRef: "ABC123" },
    });
  });

  it("re-prompts after an unknown menu option and still accepts the next choice", () => {
    expect(session("9*1")).toEqual({
      kind: "prompt",
      menuKey: "pay.enter",
      promptKey: "ussd.pay.enter",
      collected: {},
    });
  });

  it("shows the menu error key when an unknown option is the last segment", () => {
    expect(session("9")).toEqual({
      kind: "prompt",
      menuKey: "main",
      promptKey: "ussd.main.prompt",
      errorKey: "ussd.main.invalid",
      collected: {},
    });
  });

  it("re-prompts after invalid input and accepts a subsequent valid value", () => {
    expect(session("1*bad*ABC123")).toEqual({
      kind: "prompt",
      menuKey: "pay.confirm",
      promptKey: "ussd.pay.confirm",
      collected: { assetRef: "ABC123" },
    });
  });

  it("shows the input error key when invalid input is the last segment", () => {
    expect(session("1*bad")).toEqual({
      kind: "prompt",
      menuKey: "pay.enter",
      promptKey: "ussd.pay.enter",
      errorKey: "ussd.pay.invalid",
      collected: {},
    });
  });

  it("rejects an empty input segment", () => {
    expect(session("1*")).toEqual({
      kind: "prompt",
      menuKey: "pay.enter",
      promptKey: "ussd.pay.enter",
      errorKey: "ussd.pay.invalid",
      collected: {},
    });
  });

  it("trims segments around separators", () => {
    expect(session(" 1 * ABC123 * 1 ")).toEqual({
      kind: "action",
      menuKey: "pay.confirm",
      action: "pay",
      collected: { assetRef: "ABC123" },
    });
  });

  it("accepts any non-empty input when no pattern is configured", () => {
    expect(session("2*a b")).toEqual({
      kind: "action",
      menuKey: "status.run",
      action: "status",
      collected: { assetRef: "a b" },
    });
  });

  it("enforces the maximum input length", () => {
    expect(session("1*ABC123", { maxInputLength: 3 })).toEqual({
      kind: "prompt",
      menuKey: "pay.enter",
      promptKey: "ussd.pay.enter",
      errorKey: "ussd.pay.invalid",
      collected: {},
    });
  });

  it("ends a cancelled menu choice", () => {
    expect(session("0")).toEqual({
      kind: "end",
      reason: "cancelled",
      collected: {},
    });
  });

  it("ends when the start menu does not exist", () => {
    expect(advanceUssdSession({ menus, startMenu: "missing", text: "" })).toEqual({
      kind: "end",
      reason: "no_start",
      collected: {},
    });
  });

  it("ends when a next menu is missing", () => {
    const broken: readonly UssdMenuNode[] = [
      {
        type: "menu",
        key: "main",
        promptKey: "ussd.main.prompt",
        options: [{ key: "1", labelKey: "ussd.main.pay", next: "missing" }],
      },
    ];
    expect(advanceUssdSession({ menus: broken, startMenu: "main", text: "1" })).toEqual({
      kind: "end",
      reason: "invalid_menu",
      collected: {},
    });
  });

  it("ends when an option has neither a next menu nor an action", () => {
    const broken: readonly UssdMenuNode[] = [
      {
        type: "menu",
        key: "main",
        promptKey: "ussd.main.prompt",
        options: [{ key: "1", labelKey: "ussd.main.pay" }],
      },
    ];
    expect(advanceUssdSession({ menus: broken, startMenu: "main", text: "1" })).toEqual({
      kind: "end",
      reason: "invalid_option",
      collected: {},
    });
  });

  it("ends when the session exceeds the step limit", () => {
    expect(session("1*ABC123*1", { maxSteps: 2 })).toEqual({
      kind: "end",
      reason: "too_many_steps",
      collected: {},
    });
  });

  it("uses the default step limit", () => {
    const text = Array.from({ length: DEFAULT_USSD_MAX_STEPS + 1 }, () => "9").join("*");
    expect(session(text)).toEqual({
      kind: "end",
      reason: "too_many_steps",
      collected: {},
    });
  });

  it("runs an action node reached directly", () => {
    expect(advanceUssdSession({ menus, startMenu: "wallet.pay", text: "" })).toEqual({
      kind: "action",
      menuKey: "wallet.pay",
      action: "pay_from_balance",
      collected: {},
    });
  });

  it("changes behaviour when only the menu graph changes", () => {
    const changed: readonly UssdMenuNode[] = [
      {
        type: "menu",
        key: "main",
        promptKey: "ussd.main.prompt",
        options: [
          { key: "1", labelKey: "ussd.main.status", next: "status.enter" },
          { key: "2", labelKey: "ussd.main.pay", next: "pay.enter" },
        ],
      },
      ...menus.slice(1),
    ];
    expect(advanceUssdSession({ menus: changed, startMenu: "main", text: "1" })).toMatchObject({
      kind: "prompt",
      menuKey: "status.enter",
      promptKey: "ussd.status.enter",
    });
  });

  it("finds a menu by key", () => {
    expect(findUssdMenu(menus, "pay.confirm")?.key).toBe("pay.confirm");
    expect(findUssdMenu(menus, "missing")).toBeUndefined();
  });
});
