// `@tpirs/config/validate` is the browser-safe half of the package: the root
// entry also exports the YAML loader, which imports `node:fs/promises` and cannot
// be bundled for the browser.
import { validateTenantConfig } from "@tpirs/config/validate";
import type { TenantConfig } from "@tpirs/config";
import { buildDesignTokens, tokensToCssRoot } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";

/**
 * The tenant config the officer app renders from.
 *
 * It is cached in `localStorage` because the app has to draw its branding, its
 * SMS fallback instruction and its dispute reasons while offline, on first paint,
 * before any request can succeed. The config holds references to secrets, never
 * secret values (ADR 0047), so caching it is safe; it is still re-fetched on every
 * sign-in so a tenant that changes its colours or reasons sees the change.
 */
const CONFIG_KEY = "tpirs.field.config";

export function readCachedConfig(): TenantConfig | undefined {
  const raw = read(CONFIG_KEY);
  if (raw === undefined) return undefined;
  try {
    return validateTenantConfig(JSON.parse(raw));
  } catch {
    // A cache written by an older release can fail today's validation. Drop it
    // rather than crash: the next fetch replaces it.
    remove(CONFIG_KEY);
    return undefined;
  }
}

export async function fetchConfig(): Promise<TenantConfig | undefined> {
  const result = await api.GET("/v1/tenants/current/config");
  if (!result.response.ok) return undefined;
  const body = result.data as { config?: unknown } | undefined;
  if (body?.config === undefined) return undefined;
  const config = validateTenantConfig(body.config);
  write(CONFIG_KEY, JSON.stringify(config));
  return config;
}

/**
 * Injects the tenant's branding as CSS custom properties and titles the app.
 * No component branches on a tenant; the token layer is the only place that
 * knows a tenant has colours (ADR 0027).
 */
export function applyTheme(config: TenantConfig): void {
  if (typeof document === "undefined") return;
  const id = "tpirs-field-theme";
  let style = document.getElementById(id);
  if (style === null) {
    style = document.createElement("style");
    style.id = id;
    document.head.append(style);
  }
  style.textContent = tokensToCssRoot(buildDesignTokens(config));
  document.title = `${config.branding.appName} — ${config.identity.name}`;
}

function read(key: string): string | undefined {
  try {
    return globalThis.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // Storage full or disabled: the app keeps working from the in-memory copy.
  }
}

function remove(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}
