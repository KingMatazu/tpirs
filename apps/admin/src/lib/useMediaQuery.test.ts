import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery.js";

/**
 * The hook the shell uses to auto-collapse its drawer. jsdom has no
 * `matchMedia`, so the two behaviours that matter are: it must not throw when
 * the API is missing, and it must follow the query when it exists.
 */

type Listener = (event: { readonly matches: boolean }) => void;

function stubMatchMedia(initial: boolean): {
  readonly setMatches: (matches: boolean) => void;
  readonly listeners: Set<Listener>;
} {
  const state = { matches: initial };
  const listeners = new Set<Listener>();
  const list = {
    get matches() {
      return state.matches;
    },
    media: "(min-width: 1024px)",
    addEventListener: (_event: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: Listener) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", () => list);
  return {
    setMatches: (matches: boolean) => {
      state.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
    listeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("reports a miss where matchMedia does not exist", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });

  it("follows the query, and stops listening on unmount", () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);

    act(() => {
      media.setMatches(true);
    });
    expect(result.current).toBe(true);

    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("starts from the query's current answer, not from false", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });
});
