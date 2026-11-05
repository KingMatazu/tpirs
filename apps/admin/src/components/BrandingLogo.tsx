import { type ReactElement } from "react";

/**
 * The state's mark, wherever a tenant is already known.
 *
 * The logo lives in tenant config as an upload (`data:image/…`) or a hosted
 * `https://` URL. Anything else — including the old relative `logo.svg`
 * placeholder — is treated as "no logo", so a tenant that never uploaded one
 * gets its initials instead of a broken image icon.
 */
export function logoSource(logoUrl: string | undefined): string | undefined {
  if (logoUrl === undefined) return undefined;
  const value = logoUrl.trim();
  if (value.startsWith("data:image/")) return value;
  if (value.startsWith("https://")) return value;
  return undefined;
}

/** "Katsina State" → "KS", "Katsina" → "K". */
export function initialsFor(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  const first = words[0]?.charAt(0) ?? "?";
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

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
