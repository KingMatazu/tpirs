/**
 * Where the three frontends live, and what to say about them.
 *
 * One deployment serves every tenant from the same three apps, so the addresses
 * are deployment settings (`VITE_ADMIN_APP_URL`, `VITE_FIELD_APP_URL`,
 * `VITE_COLLECTOR_APP_URL` on the dashboard project) and not tenant config: a
 * new state gets a new address for the whole product, not a per-tenant one.
 * The dashboard defaults to wherever it is being served, which is always right
 * and needs no configuration at all.
 *
 * An unset address is reported as undefined rather than guessed: a handover card
 * that links nowhere is worse than one that says it does not know.
 */
export type AppKey = "admin" | "field" | "collector";

export interface AppDestination {
  readonly key: AppKey;
  readonly label: string;
  /** Undefined when this build was not told the address. */
  readonly url: string | undefined;
}

/** Roles that sign in somewhere other than the dashboard. */
const ROLE_APPS: Readonly<Record<string, AppKey>> = {
  officer: "field",
  collector: "collector",
};

export function appDestinations(origin?: string): readonly AppDestination[] {
  const dashboard = origin ?? globalThis.location.origin;
  return [
    { key: "admin", label: "Dashboard", url: import.meta.env.VITE_ADMIN_APP_URL ?? dashboard },
    { key: "field", label: "Officer app", url: import.meta.env.VITE_FIELD_APP_URL },
    { key: "collector", label: "Collector app", url: import.meta.env.VITE_COLLECTOR_APP_URL },
  ];
}

/**
 * The apps an account with these roles can use. Every role that is not an
 * officer or a collector works in the dashboard, which is also the fallback for
 * a role this build has never heard of.
 */
export function destinationsForRoles(
  roles: readonly string[],
  destinations: readonly AppDestination[] = appDestinations(),
): readonly AppDestination[] {
  const wanted = new Set<AppKey>(roles.map((role) => ROLE_APPS[role] ?? "admin"));
  if (wanted.size === 0) wanted.add("admin");
  return destinations.filter((destination) => wanted.has(destination.key));
}

export interface HandoverDetails {
  readonly displayName: string;
  readonly username: string;
  /** Known only at the moment an administrator creates or resets the account. */
  readonly password?: string;
  /** The tenant slug every sign-in form asks for. */
  readonly slug: string | undefined;
}

/**
 * One message an administrator can paste into whatever channel they already use
 * — WhatsApp, SMS, a printed slip. It repeats what the sign-in forms ask for in
 * the order they ask for it, because that is where handovers go wrong.
 */
export function handoverText(
  details: HandoverDetails,
  destinations: readonly AppDestination[],
): string {
  const lines: string[] = ["Your account", ""];
  if (destinations.length === 0) {
    lines.push("Sign in at: ask the administrator for the address");
  }
  for (const destination of destinations) {
    const address = destination.url ?? "ask the administrator for the address";
    lines.push(
      destinations.length === 1
        ? `Sign in at: ${address}`
        : `Sign in at (${destination.label}): ${address}`,
    );
  }
  if (details.slug !== undefined) lines.push(`State: ${details.slug}`);
  lines.push(`Username: ${details.username}`);
  lines.push(
    details.password === undefined
      ? "Temporary password: ask the administrator who created the account"
      : `Temporary password: ${details.password}`,
  );
  lines.push("", "You will be asked to choose your own password the first time you sign in.");
  return lines.join("\n");
}
