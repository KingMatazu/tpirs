import { useEffect, useState } from "react";

/**
 * Whether a CSS media query currently matches.
 *
 * The shell needs one viewport fact the CSS alone cannot give it: when the
 * window grows past the drawer breakpoint, an open mobile menu has to close
 * itself — otherwise it stays in state and reappears the next time the window
 * shrinks. Everything else about responsiveness is classes.
 *
 * `matchMedia` is optional on purpose: jsdom does not implement it, so tests and
 * any non-browser render fall back to "does not match", which is the safe
 * answer for a menu (closed).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => queryMatches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = (): void => {
      setMatches(list.matches);
    };
    // The query may have changed between the initial render and this effect.
    update();
    list.addEventListener("change", update);
    return () => {
      list.removeEventListener("change", update);
    };
  }, [query]);

  return matches;
}

function queryMatches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}
