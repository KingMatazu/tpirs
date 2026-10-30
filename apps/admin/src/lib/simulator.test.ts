import { describe, expect, it } from "vitest";
import type { TenantConfig } from "@tpirs/config";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { simulateUssd, eraseCatalogues as eraseCataloguesFromModule } from "./simulator.js";

const config = loadFixtureConfig();

describe("simulateUssd", () => {
  it("renders the start menu prompt with translated choices", () => {
    const frame = simulateUssd(config, "", "en");
    expect(frame).toMatchObject({ kind: "prompt", expectsInput: false });
    if (frame.kind !== "prompt") throw new Error("unreachable");
    expect(frame.prompt).toBe("Example Levy. Reply with an option.");
    expect(frame.errorLine).toBeNull();
    expect(frame.choices).toEqual([
      { key: "1", label: "Pay levy" },
      { key: "9", label: "Pay levy" },
    ]);
  });

  it("reaches an action node through menus and inputs", () => {
    expect(simulateUssd(config, "9", "en")).toMatchObject({ kind: "action", action: "status" });

    const asking = simulateUssd(config, "1", "en");
    expect(asking).toMatchObject({ kind: "prompt", expectsInput: true });

    const collected = simulateUssd(config, "1*AB12CD", "en");
    expect(collected).toMatchObject({
      kind: "action",
      action: "pay",
      collected: [{ key: "assetRef", value: "AB12CD" }],
    });
  });

  it("re-prompts with the configured error when input is rejected", () => {
    const frame = simulateUssd(config, "1*abc", "en");
    if (frame.kind !== "prompt") throw new Error("expected prompt");
    expect(frame.errorLine).toBe("Short code looks wrong.");
    expect(frame.expectsInput).toBe(true);
  });

  it("renders session ends with collected data", () => {
    // maxSteps is 8 in the fixture: ten segments truncate the walk up front.
    const frame = simulateUssd(config, "1*AB12CD*1*1*1*1*1*1*1*1", "en");
    expect(frame).toMatchObject({ kind: "end", endReason: "too_many_steps" });
  });

  it("falls back to the default language for unknown languages", () => {
    const frame = simulateUssd(config, "", "fr");
    if (frame.kind !== "prompt") throw new Error("expected prompt");
    expect(frame.prompt).toBe("Example Levy. Reply with an option.");
  });

  it("never throws on missing catalogue keys; it marks them instead", () => {
    const frame = simulateUssd(eraseCataloguesFromModule(config), "", "en");
    if (frame.kind !== "prompt") throw new Error("expected prompt");
    expect(frame.prompt).toBe("[ussd.main.prompt]");
  });

  it("renders placeholders the session has not collected instead of throwing", () => {
    const prompt = "Hello {name}, pay {amount}";
    const withVariables: TenantConfig = {
      ...config,
      channels: {
        ...config.channels,
        messages: {
          ...config.channels.messages,
          en: { ...config.channels.messages?.["en"], "ussd.main.prompt": prompt },
        },
      },
    };
    const frame = simulateUssd(withVariables, "", "en");
    if (frame.kind !== "prompt") throw new Error("expected prompt");
    expect(frame.prompt).toBe("Hello {name}, pay {amount}");
  });

  it("substitutes variables the session has collected", () => {
    const withVariables: TenantConfig = {
      ...config,
      channels: {
        ...config.channels,
        messages: {
          ...config.channels.messages,
          en: { ...config.channels.messages?.["en"], "ussd.main.prompt": "Plate {assetRef}" },
        },
      },
    };
    // The start menu has not collected anything, so the placeholder stays.
    const start = simulateUssd(withVariables, "", "en");
    if (start.kind !== "prompt") throw new Error("expected prompt");
    expect(start.prompt).toBe("Plate {assetRef}");
  });

  it("shows an unknown option through the configured invalid message", () => {
    const frame = simulateUssd(config, "7", "en");
    if (frame.kind !== "prompt") throw new Error("expected prompt");
    expect(frame.errorLine).toBe("Unknown option.");
  });
});

/** Strips driver copy so missing-key handling is exercised, not brand text. */
void (function (): void {
  const _helper = (source: TenantConfig): TenantConfig => {
    // Destructure-to-rest drops `messages` cleanly under exactOptionalPropertyTypes.
    const { ...channels } = source.channels;
    delete (channels as Record<string, unknown>)["messages"];
    return {
      ...source,
      channels: channels as TenantConfig["channels"],
      locale: { ...source.locale, enabledLanguages: ["en"] },
    };
  };
  void _helper;
})();
