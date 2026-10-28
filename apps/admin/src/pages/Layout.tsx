import { Banknote, ClipboardList, LogOut, MessageSquare, ScrollText, Settings, Smartphone, Wallet, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { currentPath, navigate, useRoute } from "../lib/router.js";
import { TenantTheme } from "../components/Theme.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { useSession } from "../session.js";

/**
 * Layout nav shell (Step 1). Navigation is permission-aware: entries the signed
 * in user cannot use are hidden. Branding comes only from tenant tokens; the
 * shell itself has no tenant knowledge.
 */
interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly permission: string;
  readonly icon: LucideIcon;
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  { path: "/registry", label: "Registry", permission: "asset:read", icon: ClipboardList },
  { path: "/payments", label: "Payments", permission: "payment:read", icon: Wallet },
  { path: "/collectors", label: "Collectors", permission: "cash:read", icon: Banknote },
  { path: "/channels", label: "Channels", permission: "tenant:read", icon: MessageSquare },
  { path: "/ussd", label: "USSD simulator", permission: "tenant:read", icon: Smartphone },
  { path: "/config", label: "Configuration", permission: "tenant:read", icon: Settings },
  { path: "/audit", label: "Audit", permission: "audit:read", icon: ScrollText },
];

export function Layout(props: Readonly<{ readonly children: ReactElement }>): ReactElement {
  const route = useRoute();
  const user = useSession((state) => state.user);
  const logout = useSession((state) => () => state.logout());
  const hasPermission = useSession((state) => (permission: string) => state.hasPermission(permission));
  const { config } = useTenantConfig();
  const appName = config?.config.branding.appName ?? "Admin";

  const signOut = async (): Promise<void> => {
    try {
      await logout();
    } finally {
      navigate("/");
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <TenantTheme config={config?.config} />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-block h-5 w-5 rounded bg-[var(--tpirs-color-primary)]" aria-hidden={true} />
            <span className="font-semibold text-slate-900">{appName}</span>
          </div>
          {user !== undefined ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-600">
                {user.displayName}{" "}
                <span className="font-mono text-xs text-slate-400">{user.roles.join(", ")}</span>
              </span>
              <button type="button" className="cursor-pointer text-slate-600 underline" onClick={() => void signOut()}>
                <span className="inline-flex items-center gap-1">
                  <LogOut size={14} /> Sign out
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6">
        <nav className="w-48 shrink-0" aria-label="Primary">
          <ul className="space-y-1">
            {NAV_ENTRIES.filter((entry) => hasPermission(entry.permission)).map((entry) => {
              const active = currentPath() === entry.path || route === entry.path;
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => { navigate(entry.path); }}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm ${
                      active ? "bg-[var(--tpirs-color-primary)] font-medium text-white" : "text-slate-700 hover:bg-white"
                    }`}
                  >
                    <entry.icon size={16} />
                    {entry.label}
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
