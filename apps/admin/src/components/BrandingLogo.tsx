import { type ReactElement } from "react";
import { initialsFor, logoSource } from "@tpirs/ui-tokens";

/**
 * The state's mark, wherever a tenant is already known.
 *
 * The logo lives in tenant config as an upload (`data:image/…`) or a hosted
 * `https://` URL. Anything else — including the old relative `logo.svg`
 * placeholder — is treated as "no logo", so a tenant that never uploaded one
 * gets its initials instead of a broken image icon. The two helpers come from
 * `@tpirs/ui-tokens` so the officer and collector apps behave identically.
 */
export { initialsFor, logoSource };

export function BrandingLogo(
  props: Readonly<{
    readonly logoUrl: string | undefined;
    readonly name: string;
    /** Sizing and shape, e.g. `h-9 w-9 rounded-lg`. */
    readonly className: string;
  }>,
): ReactElement {
  const source = logoSource(props.logoUrl);
  if (source !== undefined) {
    return (
      <img
        src={source}
        alt={props.name}
        className={`${props.className} shrink-0 object-contain`}
        data-testid="branding-logo"
      />
    );
  }
  return (
    <span
      aria-hidden={true}
      data-testid="branding-initials"
      className={`${props.className} inline-flex shrink-0 items-center justify-center bg-[var(--tpirs-color-primary)] text-xs font-semibold text-white`}
    >
      {initialsFor(props.name)}
    </span>
  );
}
