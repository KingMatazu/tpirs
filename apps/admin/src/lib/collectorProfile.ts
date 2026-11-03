/**
 * The collector profile, as the account form needs to describe it.
 *
 * A national identification number is the state's own format, and the tenant's
 * config carries the rule (`collectors.nationalIdPattern`). A form cannot render
 * a regular expression, so this turns the common case into words — "11 digits" —
 * and keeps a generic wording for anything more unusual. Nothing here is a tenant
 * literal: the pattern always comes from the config the dashboard holds.
 */

/** Shown when the config has not loaded, or the pattern is not a simple length. */
const GENERIC_HINT = "As issued by the state";

/** `^\d{11}$` → "11 digits"; anything else keeps the generic wording. */
export function nationalIdHint(pattern: string | undefined): string {
  const match = pattern === undefined ? null : /^\^\\d\{(\d+)\}\$$/.exec(pattern);
  const digits = match?.[1];
  return digits === undefined ? GENERIC_HINT : `${digits} digits`;
}
