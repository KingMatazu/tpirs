import type { ReactElement } from "react";
import { FIRM_ATTRIBUTION, firmAttributionHref } from "@tpirs/ui-tokens";

/**
 * "Powered by …" at the foot of every screen.
 *
 * The firm's name and website live in `@tpirs/ui-tokens`, one file to rebrand
 * the product for another reseller. The href is empty until the firm's website
 * exists, and the line is plain text until then rather than a link that reloads
 * the page it is already on.
 */
export function PoweredBy(): ReactElement {
  const href = firmAttributionHref();
  if (href === undefined) {
    return (
      <p className="text-center text-[11px] text-slate-500" data-testid="powered-by">
        {FIRM_ATTRIBUTION.label}
      </p>
    );
  }
  return (
    <p className="text-center text-[11px] text-slate-500" data-testid="powered-by">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-slate-700"
      >
        {FIRM_ATTRIBUTION.label}
      </a>
    </p>
  );
}
