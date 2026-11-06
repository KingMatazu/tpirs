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
 * that links nowhere is worse than one that says it does not know. The one
 * exception is `vite dev`, where the sibling apps are always on this machine at
 * known ports — a local handover card that says "not configured in this build"
 * sends an officer to the dashboard, where they have no pages.
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

/** The ports `scripts/dev.mjs` binds for the three apps. */
const DEV_PORTS: Readonly<Record<AppKey, number>> = { admin: 5173, field: 5174, collector: 5175 };

/**
 * A sibling app's address on the machine serving the dashboard.
 *
 * `vite dev` is the only caller: there the three apps always run side by side.
 * The host is taken from the page rather than hardcoded to `localhost`, because
 * the realistic local test is a phone that opened the dashboard at
 * `http://192.168.0.183:5173` and has to be handed `…:5174`, not loopback. A
 * production build is told its addresses and never guesses.
 */
export function devAddress(key: AppKey, origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}:${String(DEV_PORTS[key])}`;
  } catch {
    return undefined;
  }
}

export function appDestinations(
  origin?: string,
  /** True under `vite dev`; a build must be configured. */
  dev: boolean = import.meta.env.MODE === "development",
): readonly AppDestination[] {
  const dashboard = origin ?? globalThis.location.origin;
  return [
    { key: "admin", label: "Dashboard", url: import.meta.env.VITE_ADMIN_APP_URL ?? dashboard },
    {
      key: "field",
      label: "Officer app",
      url: import.meta.env.VITE_FIELD_APP_URL ?? (dev ? devAddress("field", dashboard) : undefined),
    },
    {
      key: "collector",
      label: "Collector app",
      url:
        import.meta.env.VITE_COLLECTOR_APP_URL ??
        (dev ? devAddress("collector", dashboard) : undefined),
    },
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
