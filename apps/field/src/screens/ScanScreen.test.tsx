import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScanScreen } from "./ScanScreen.js";
import { useSession } from "../session.js";
import { testConfig } from "../test-support/config.js";

/**
 * jsdom has no camera, which is exactly the case a pilot tester hits when they
 * open the app on a plain http address: the screen must say why, not quietly
 * fall back to typing.
 */

afterEach(() => {
  cleanup();
  useSession.setState({ config: undefined });
});

function renderScan(): void {
  useSession.setState({ config: testConfig() });
  render(<ScanScreen onBack={() => undefined} onScanned={() => undefined} />);
}

describe("scan screen without a camera", () => {
  it("explains that this browser cannot scan instead of showing a silent tab", () => {
    renderScan();
    expect(screen.getByText(/cannot scan QR codes here/i)).toBeDefined();
  });

  it("names the secure-connection requirement when the page is not https", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    Object.defineProperty(globalThis, "isSecureContext", {
      configurable: true,
      value: false,
    });
    try {
      renderScan();
      expect(screen.getByText(/secure \(https\) connection/i)).toBeDefined();
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "isSecureContext");
      } else {
        Object.defineProperty(globalThis, "isSecureContext", original);
      }
    }
  });
});
