import { useSyncExternalStore } from "react";

/**
 * Installing the collector on the handset.
 *
 * Chromium fires `beforeinstallprompt` once, early, and only if the manifest is
 * installable. By the time a collector taps Profile the event is long gone, so
 * this module listens at import time (App imports the profile screen, so it is
 * loaded with the app) and holds the deferred event until the button asks for
 * it. Safari has no such event: on iOS the honest answer is the Share menu.
 */

export type InstallKind = "installed" | "prompt" | "ios" | "unsupported";
export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferred: BeforeInstallPromptEvent | undefined;
let installed = false;
let listening = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
  // iOS Safari predates the display-mode media query and reports this instead.
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;
  // iPadOS 13+ reports a desktop Safari user agent; touch points give it away.
  return /macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
}

/** The browser's current offer, recomputed rather than cached: it changes. */
export function installKind(): InstallKind {
  if (installed || isStandalone()) return "installed";
  if (deferred !== undefined) return "prompt";
  if (isIos()) return "ios";
  return "unsupported";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The install state as a hook; a string snapshot, so React compares by value. */
export function useInstallKind(): InstallKind {
  return useSyncExternalStore(subscribe, installKind, () => "unsupported");
}

export function startInstallCapture(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // The app offers its own button, in the place a collector will look for it;
    // Chrome's mini-infobar would cover the cash figure on Home.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = undefined;
    emit();
  });
}

/** Shows the browser's install prompt, if it made one available. */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = deferred;
  if (event === undefined) return "unavailable";
  try {
    await event.prompt();
    const choice = await event.userChoice;
    deferred = undefined;
    if (choice.outcome === "accepted") installed = true;
    emit();
    return choice.outcome;
  } catch {
    deferred = undefined;
    emit();
    return "unavailable";
  }
}

// Capture from the moment the module is evaluated. The event fires after load,
// and App imports the profile screen, so this runs in time.
startInstallCapture();
