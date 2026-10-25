import { useEffect, type ReactElement } from "react";
import { buildDesignTokens, tokensToCssRoot } from "@tpirs/ui-tokens";
import type { TenantConfig } from "@tpirs/config";

/**
 * Re-themes the dashboard from tenant branding (ADR 0027): one CSS block of
 * custom properties is injected, and components bind Tailwind utilities to
 * those variables. No component code ever branches on a tenant.
 */
export function TenantTheme({ config }: { readonly config: TenantConfig | undefined }): ReactElement | null {
  useEffect(() => {
    if (config === undefined) return;
    const id = "tpirs-theme";
    let style = document.getElementById(id);
    if (style === null) {
      style = document.createElement("style");
      style.id = id;
      document.head.append(style);
    }
    style.textContent = tokensToCssRoot(buildDesignTokens(config));
    document.title = `${config.branding.appName} — Admin`;
  }, [config]);
  return null;
}
