import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The install module keeps the deferred browser event and the "installed" flag in
 * module scope, so each test imports a fresh copy rather than sharing state.
 */
async function freshInstall(): Promise<typeof import("./install.js")> {
  vi.resetModules();
  return await import("./install.js");
}

function userAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value });
}

function installableEvent(outcome: "accepted" | "dismissed"): Event {
  return Object.assign(new Event("beforeinstallprompt"), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
}

describe("install state", () => {
  const originalUserAgent = window.navigator.userAgent;

  beforeEach(() => {
    userAgent(originalUserAgent);
    delete (window.navigator as Navigator & { standalone?: boolean }).standalone;
  });

  afterEach(() => {
    userAgent(originalUserAgent);
    delete (window as unknown as Record<string, unknown>).matchMedia;
    vi.restoreAllMocks();
  });

  it("is unsupported on a desktop browser that has not offered an install", async () => {
    userAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120");
    const { installKind } = await freshInstall();
    expect(installKind()).toBe("unsupported");
  });

  it("turns into a prompt when the browser makes one available", async () => {
    userAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
    const { installKind } = await freshInstall();

    window.dispatchEvent(installableEvent("accepted"));

    expect(installKind()).toBe("prompt");
  });

  it("reports the outcome and then treats the app as installed", async () => {
    userAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
    const { installKind, promptInstall } = await freshInstall();

    window.dispatchEvent(installableEvent("accepted"));
    await expect(promptInstall()).resolves.toBe("accepted");

    expect(installKind()).toBe("installed");
    // A second tap has nothing left to prompt.
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("stops offering the prompt once the person dismisses it", async () => {
    userAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
    const { installKind, promptInstall } = await freshInstall();

    window.dispatchEvent(installableEvent("dismissed"));
    await expect(promptInstall()).resolves.toBe("dismissed");

    // A beforeinstallprompt event is single-use, so the spent offer is gone and
    // the screen falls back to the browser menu rather than a dead button.
    expect(installKind()).toBe("unsupported");
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("explains the Share menu on iOS, where no prompt exists", async () => {
    userAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15");
    const { installKind } = await freshInstall();
    expect(installKind()).toBe("ios");
  });

  it("recognises an app that is already running standalone", async () => {
    userAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(display-mode: standalone)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const { installKind } = await freshInstall();
    expect(installKind()).toBe("installed");
  });
});
