/**
 * The reseller's own branding — Star Galaxy Innovation and Technology Ltd.
 *
 * Deliberately separate from the tenant's branding (ADR 0065). The tenant is the
 * state whose levy system this is; the firm is who built and runs it. The rule
 * the apps follow is "no tenant yet → firm logo, tenant known → state logo":
 * the sign-in and first-run screens have no tenant to brand with, and every
 * screen after sign-in belongs to the state.
 *
 * Everything the firm needs to change lives in this one file, so re-branding the
 * product for a different reseller is a single edit rather than a hunt through
 * three frontends.
 */

export const FIRM_NAME = "Star Galaxy Innovation and Technology Ltd";

export interface FirmAttribution {
  /** The footer line, exactly as it should read. */
  readonly label: string;
  /**
   * Where the footer links to. Empty means "no website yet": the footer renders
   * as plain text rather than a dead link that reloads the page. Setting it to a
   * URL turns the same text into a link that opens in a new tab.
   */
  readonly href: string;
}

export const FIRM_ATTRIBUTION: FirmAttribution = {
  label: `Powered by ${FIRM_NAME}`,
  href: "",
};

/**
 * A placeholder mark: dark tile, star, wordmark. It is obviously not the final
 * logo, which is the point — nobody should mistake it for the firm's real mark
 * during a demo.
 *
 * Replacing it is one edit: point `FIRM_LOGO` at the real file, either as an
 * `https://` URL, or as a data URL (`data:image/svg+xml;base64,…` for vector,
 * `data:image/png;base64,…` for a bitmap). An SVG keeps its edge on the sign-in
 * card at any size, so it is the better format if the firm has one.
 */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 72" role="img" aria-label="${FIRM_NAME}">
  <rect width="320" height="72" rx="10" fill="#0f172a"/>
  <path d="M36 18l4.6 9.8 10.4 1.4-7.6 7.3 1.9 10.5L36 41.9 26.7 47l1.9-10.5-7.6-7.3 10.4-1.4z" fill="#f8fafc"/>
  <text x="60" y="35" font-family="system-ui, sans-serif" font-size="21" font-weight="700" fill="#f8fafc">STAR GALAXY</text>
  <text x="61" y="52" font-family="system-ui, sans-serif" font-size="9" letter-spacing="2.6" fill="#94a3b8">INNOVATION &amp; TECHNOLOGY LTD</text>
</svg>`;

/** `data:` URL for the placeholder mark; URL-encoded so the source stays readable. */
export const FIRM_LOGO = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

/** True when the firm has supplied a website for the footer to link to. */
export function firmAttributionHref(): string | undefined {
  return FIRM_ATTRIBUTION.href.trim() === "" ? undefined : FIRM_ATTRIBUTION.href.trim();
}
