/**
 * Small, pure helpers the profile screen renders with. Kept out of the component
 * so the edge cases — an empty name, a short ID — are unit-testable.
 */

/** Up to two initials for the header avatar; "?" when there is no name at all. */
export function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  const initials = `${first}${last}`.toUpperCase();
  return initials === "" ? "?" : initials;
}

/**
 * Everything but the last four characters, so a collector can read the number
 * out to support without the whole ID sitting on screen in a shared handset.
 */
export function maskNationalId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

/** `finance_admin` → `Finance Admin`, for the role row. */
export function roleLabel(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
