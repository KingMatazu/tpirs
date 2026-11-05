/**
 * Reading a tenant's logo value, shared by every frontend.
 *
 * The logo lives in tenant config as an upload (`data:image/…`) or a hosted
 * `https://` URL (ADR 0065). Anything else — including the old relative
 * `logo.svg` placeholder — is "no logo", so a tenant that never uploaded one
 * gets its initials instead of a broken image.
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
