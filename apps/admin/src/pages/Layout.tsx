import {
  Banknote,
  ClipboardList,
  FileBarChart,
  Gavel,
  LogOut,
  MessageSquare,
  RotateCcw,
  Scale,
  ScrollText,
  Settings,
  Smartphone,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { currentPath, navigate, useRoute } from "../lib/router.js";
import { TenantTheme } from "../components/Theme.js";
import { useTenantBranding } from "../lib/tenantConfig.js";
import { dashboardTranslator } from "../lib/uiCopy.js";
import { useUiLanguage } from "../lib/uiLanguage.js";
import { useSession } from "../session.js";

/**
 * Layout nav shell. Navigation is permission-aware: entries the signed-in user
 * cannot use are hidden. Labels come from the dashboard catalogue in the
 * tenant's enabled languages; branding comes only from tenant tokens. The shell
 * itself has no tenant knowledge.
 */
interface NavEntry {
  readonly path: string;
  readonly labelKey:
    | "nav.registry"
    | "nav.payments"
    | "nav.collectors"
    | "nav.reconciliation"
    | "nav.reports"
    | "nav.disputes"
    | "nav.reversals"
    | "nav.channels"
    | "nav.ussd"
    | "nav.config"
    | "nav.audit";
  readonly permission: string;
  readonly icon: LucideIcon;
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  { path: "/registry", labelKey: "nav.registry", permission: "asset:read", icon: ClipboardList },
  { path: "/payments", labelKey: "nav.payments", permission: "payment:read", icon: Wallet },
  { path: "/collectors", labelKey: "nav.collectors", permission: "cash:read", icon: Banknote },
  {
    path: "/reconciliation",
    labelKey: "nav.reconciliation",
    permission: "reconciliation:read",
    icon: Scale,
  },
  { path: "/reports", labelKey: "nav.reports", permission: "report:read", icon: FileBarChart },
  { path: "/disputes", labelKey: "nav.disputes", permission: "dispute:read", icon: Gavel },
  { path: "/reversals", labelKey: "nav.reversals", permission: "ledger:read", icon: RotateCcw },
  { path: "/channels", labelKey: "nav.channels", permission: "tenant:read", icon: MessageSquare },
  { path: "/ussd", labelKey: "nav.ussd", permission: "tenant:read", icon: Smartphone },
  { path: "/config", labelKey: "nav.config", permission: "tenant:read", icon: Settings },
  { path: "/audit", labelKey: "nav.audit", permission: "audit:read", icon: ScrollText },
];

const NO_PERMISSIONS: readonly string[] = [];

export function Layout(props: Readonly<{ readonly children: ReactElement }>): ReactElement {
  const route = useRoute();
  const user = useSession((state) => state.user);
  // Subscribe to the permission list (a stable array), not to a selector that
  // builds a closure: a fresh function each render makes useSyncExternalStore
  // re-render forever.
  const permissions = useSession((state) => state.user?.permissions ?? NO_PERMISSIONS);
  const selectedLanguage = useUiLanguage((state) => state.language);
  const { branding: tenantConfig } = useTenantBranding();
  const appName = tenantConfig?.branding.appName ?? "Admin";
  const copy =
    tenantConfig === undefined ? undefined : dashboardTranslator(tenantConfig, selectedLanguage);

  const signOut = async (): Promise<void> => {
    try {
      await useSession.getState().logout();
    } finally {
      navigate("/");
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <TenantTheme config={tenantConfig} />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-5 w-5 rounded bg-[var(--tpirs-color-primary)]"
              aria-hidden={true}
            />
            <span className="font-semibold text-slate-900">{appName}</span>
            {tenantConfig === undefined ? null : (
              <span className="hidden text-xs text-slate-500 sm:inline" data-testid="tenant-name">
                {tenantConfig.identity.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {copy !== undefined && copy.languages.length > 1 ? (
              <label className="flex items-center gap-1 text-slate-600">
                <span className="sr-only">{copy.t("shell.language")}</span>
                <select
                  aria-label={copy.t("shell.language")}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                  value={copy.language}
                  onChange={(event) => {
                    useUiLanguage.getState().setLanguage(event.target.value);
                  }}
                >
                  {copy.languages.map((language) => (
                    <option key={language} value={language}>
                      {language.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {user !== undefined ? (
              <>
                <span className="text-slate-600">
                  {user.displayName}{" "}
                  <span className="font-mono text-xs text-slate-400">{user.roles.join(", ")}</span>
                </span>
                <button
                  type="button"
                  className="cursor-pointer text-slate-600 underline"
                  onClick={() => void signOut()}
                >
                  <span className="inline-flex items-center gap-1">
                    <LogOut size={14} /> {copy?.t("shell.signOut") ?? "Sign out"}
                  </span>
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6">
        <nav className="w-48 shrink-0" aria-label="Primary">
          <ul className="space-y-1">
            {NAV_ENTRIES.filter((entry) => permissions.includes(entry.permission)).map((entry) => {
              const active = currentPath() === entry.path || route === entry.path;
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(entry.path);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm ${
                      active
                        ? "bg-[var(--tpirs-color-primary)] font-medium text-white"
                        : "text-slate-700 hover:bg-white"
                    }`}
                  >
                    <entry.icon size={16} />
                    {copy?.t(entry.labelKey) ?? entry.labelKey}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="min-w-0 flex-1">{props.children}</main>
      </div>
    </div>
  );
}
