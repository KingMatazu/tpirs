import { useSyncExternalStore } from "react";

/**
 * Minimal hash router: the dashboard replaces native navigation state with the
 * URL fragment so deep links survive refreshes without history-API plumbing.
 */
export function navigate(path: string): void {
  window.location.hash = normalise(path);
}

export function currentPath(): string {
  const hash = window.location.hash;
  if (hash === "" || hash === "#") return "/";
  return hash.slice(1);
}

function normalise(path: string): string {
  return path.startsWith("/") ? `#${path}` : `#/${path}`;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
  };
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}
