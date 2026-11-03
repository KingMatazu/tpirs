/**
 * Options for the two fields an operator should never have to type from memory.
 *
 * A timezone is an IANA identifier and a currency is an ISO 4217 code; both are
 * closed sets that the browser already knows. Asking for free text invites
 * trailing spaces or near-miss variants that fail three validators later, so the
 * wizard offers the platform's own list. Nothing here is tenant-specific: every
 * supported value is present, sorted, and the server still validates the answer.
 */
export interface Option {
  readonly value: string;
  readonly label: string;
}

const currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });

function currencyLabel(code: string): string {
  const name = currencyNames.of(code);
  return name === undefined || name === code ? code : `${code} — ${name}`;
}

/** Every currency the runtime knows, by code, with its English name. */
export const CURRENCY_OPTIONS: readonly Option[] = Intl.supportedValuesOf("currency")
  .map((code) => ({ value: code, label: currencyLabel(code) }))
  .sort((left, right) => left.value.localeCompare(right.value));

/**
 * Every IANA zone the runtime knows, by identifier. The identifier is the label:
 * a translated city name would be ambiguous, and operators recognise their own
 * zone. The browser's current zone is offered as the first option so the common
 * case is one click.
 */
export const TIME_ZONE_OPTIONS: readonly Option[] = (() => {
  const zones = Intl.supportedValuesOf("timeZone");
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const values = new Set(zones);
  if (current !== "" && !values.has(current)) values.add(current);
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  // The operator's own zone first, then everywhere else alphabetically.
  const own = sorted.indexOf(current);
  if (own > 0) sorted.unshift(...sorted.splice(own, 1));
  return sorted.map((zone) => ({ value: zone, label: zone }));
})();

/** The browser's zone when it is a real IANA identifier, for the empty draft. */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return TIME_ZONE_OPTIONS.some((option) => option.value === zone) ? zone : "";
}
