import { type ReactElement } from "react";
import { FIRM_ATTRIBUTION, firmAttributionHref } from "@tpirs/ui-tokens";

/**
 * "Powered by …" at the foot of every screen.
 *
 * The firm's mark and name live in `@tpirs/ui-tokens` (one file to rebrand the
 * product for another reseller). The href is empty until the firm's website
 * exists, and the line is plain text until then rather than a link that reloads
 * the page it is already on.
 */
export function PoweredBy(props: Readonly<{ readonly className?: string }>): ReactElement {
  const href = firmAttributionHref();
  const className = props.className ?? "text-center text-xs text-slate-500";
  if (href === undefined) {
    return (
      <p className={className} data-testid="powered-by">
        {FIRM_ATTRIBUTION.label}
      </p>
    );
  }
  return (
    <p className={className} data-testid="powered-by">
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
