import {
  Banknote,
  ClipboardList,
  FileBarChart,
  Gavel,
  LogOut,
  Menu,
  MessageSquare,
  RotateCcw,
  Scale,
  ScrollText,
  Settings,
  Smartphone,
  Tags,
  UsersRound,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { currentPath, navigate, useRoute } from "../lib/router.js";
import { TenantTheme } from "../components/Theme.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { dashboardTranslator } from "../lib/uiCopy.js";
import { useUiLanguage } from "../lib/uiLanguage.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { useSession } from "../session.js";
import { BrandingLogo } from "../components/BrandingLogo.js";
import { PoweredBy } from "../components/PoweredBy.js";

/**
 * Layout nav shell. Navigation is permission-aware: entries the signed-in user
 * cannot use are hidden. Labels come from the dashboard catalogue in the
 * tenant's enabled languages; branding comes only from tenant tokens. The shell
 * itself has no tenant knowledge.
 *
 * Responsive behaviour is one breakpoint (`lg`, 1024px). Above it the sidebar
 * sits in the flow beside the content, as before. Below it the same navigation
 * becomes an off-canvas drawer with a backdrop, opened from a button in the
 * header and closed by Escape, the backdrop, a close button, choosing a page, or
 * the window growing past the breakpoint — so a menu opened on a phone never
 * reappears on a desktop, and a rotation does not leave a dead overlay.
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
    | "nav.zones"
    | "nav.users"
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
  { path: "/zones", labelKey: "nav.zones", permission: "zone:read", icon: Tags },
  { path: "/users", labelKey: "nav.users", permission: "user:read", icon: UsersRound },
  { path: "/audit", labelKey: "nav.audit", permission: "audit:read", icon: ScrollText },
];

const NO_PERMISSIONS: readonly string[] = [];

/** The breakpoint where the sidebar stops being a drawer (Tailwind's `lg`). */
const DESKTOP_QUERY = "(min-width: 1024px)";

/** The permission a route needs, from the same list the sidebar renders. */
export function permissionForRoute(route: string): string | undefined {
  return NAV_ENTRIES.find((entry) => entry.path === route)?.permission;
}

/**
 * Where a role should land. The dashboard used to hardcode `/registry`, which a
 * system admin or finance admin cannot see — they arrived on a page missing from
 * their own sidebar.
 */
export function firstPermittedRoute(permissions: readonly string[]): string | undefined {
  return NAV_ENTRIES.find((entry) => permissions.includes(entry.permission))?.path;
}

export function Layout(props: Readonly<{ readonly children: ReactElement }>): ReactElement {
  const route = useRoute();
  const user = useSession((state) => state.user);
  // Subscribe to the permission list (a stable array), not to a selector that
  // builds a closure: a fresh function each render makes useSyncExternalStore
  // re-render forever.
  const permissions = useSession((state) => state.user?.permissions ?? NO_PERMISSIONS);
  const selectedLanguage = useUiLanguage((state) => state.language);
  const { config } = useTenantConfig();
  const tenantConfig = config?.config;
  const appName = tenantConfig?.branding.appName ?? "Admin";
  const copy =
    tenantConfig === undefined ? undefined : dashboardTranslator(tenantConfig, selectedLanguage);

  const [menuOpen, setMenuOpen] = useState(false);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Auto-collapse: growing past the breakpoint closes a drawer opened on a
  // phone, so the state cannot outlive the layout it belongs to.
  useEffect(() => {
    if (isDesktop) setMenuOpen(false);
  }, [isDesktop]);

  // Choosing a page closes the drawer; the desktop sidebar is unaffected
  // because it renders the same list without the callback.
  useEffect(() => {
    setMenuOpen(false);
  }, [route]);

  // Move focus into the drawer when it opens, and stop the page behind it from
  // scrolling under the overlay. Both are undone on close.
  useEffect(() => {
    if (!menuOpen) return undefined;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  /**
   * Escape closes the drawer and hands focus back to the button that opened it.
   *
   * Tab is kept inside the drawer for the same reason: it is declared
   * `aria-modal`, so the page behind it is meant to be unavailable, and a
   * keyboard user tabbing into a hidden sidebar is the usual way a drawer
   * leaks.
   */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (drawer === null) return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>("button, [href], select, input")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const signOut = async (): Promise<void> => {
    try {
      await useSession.getState().logout();
    } finally {
      navigate("/");
    }
  };

  const visibleEntries = NAV_ENTRIES.filter((entry) => permissions.includes(entry.permission));
  const navList = (onChosen?: () => void): ReactElement => (
    <ul className="space-y-1">
      {visibleEntries.map((entry) => {
        const active = currentPath() === entry.path || route === entry.path;
        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => {
                navigate(entry.path);
                onChosen?.();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                active
                  ? "bg-[var(--tpirs-color-primary)] font-medium text-white"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <entry.icon size={16} className="shrink-0" />
              {copy?.t(entry.labelKey) ?? entry.labelKey}
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="min-h-screen bg-slate-100">
      <TenantTheme config={tenantConfig} />
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2 sm:px-4 sm:py-3">
          <button
            ref={menuButtonRef}
            type="button"
            className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 lg:hidden"
            aria-label={copy?.t("shell.openMenu") ?? "Open navigation"}
            aria-expanded={menuOpen}
            aria-controls="primary-nav-drawer"
            onClick={() => {
              setMenuOpen(true);
            }}
          >
            <Menu size={22} />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <BrandingLogo
              logoUrl={tenantConfig?.branding.logoUrl}
              name={appName}
              className="h-7 w-7 rounded"
            />
            <span className="truncate font-semibold text-slate-900">{appName}</span>
            {tenantConfig === undefined ? null : (
              <span
                className="hidden truncate text-xs text-slate-500 sm:inline"
                data-testid="tenant-name"
              >
                {tenantConfig.identity.name}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm sm:gap-3">
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
                <span className="hidden text-slate-600 md:inline">
                  {user.displayName}{" "}
                  <span className="font-mono text-xs text-slate-400">{user.roles.join(", ")}</span>
                </span>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-slate-600 underline hover:bg-slate-100"
                  onClick={() => void signOut()}
                >
                  <LogOut size={16} />
                  <span className="hidden sm:inline">{copy?.t("shell.signOut") ?? "Sign out"}</span>
                  <span className="sr-only sm:hidden">
                    {copy?.t("shell.signOut") ?? "Sign out"}
                  </span>
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* The backdrop is a control for pointers only: Escape and the close
              button are the keyboard path, so it stays out of the a11y tree. */}
          <div
            className="absolute inset-0 bg-slate-900/40"
            aria-hidden={true}
            data-testid="nav-backdrop"
            onClick={() => {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
          />
          <div
            ref={drawerRef}
            id="primary-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={copy?.t("shell.navigation") ?? "Navigation"}
            className="absolute inset-y-0 left-0 flex w-64 max-w-[85%] flex-col bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="flex min-w-0 items-center gap-2">
                <BrandingLogo
                  logoUrl={tenantConfig?.branding.logoUrl}
                  name={appName}
                  className="h-7 w-7 rounded"
                />
                <span className="truncate font-semibold text-slate-900">{appName}</span>
              </span>
              <button
                ref={closeButtonRef}
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
                aria-label={copy?.t("shell.closeMenu") ?? "Close navigation"}
                onClick={() => {
                  setMenuOpen(false);
                  menuButtonRef.current?.focus();
                }}
              >
                <X size={20} />
              </button>
            </div>
            <nav aria-label="Primary" className="flex-1 overflow-y-auto p-3">
              {navList(() => {
                setMenuOpen(false);
              })}
            </nav>
          </div>
        </div>
      ) : null}

      <div className="mx-auto flex max-w-6xl gap-6 px-3 py-4 sm:px-4 sm:py-6">
        <nav className="hidden w-48 shrink-0 lg:block" aria-label="Primary" data-testid="sidebar">
          {navList()}
        </nav>
        <main className="min-w-0 flex-1">{props.children}</main>
      </div>
      <footer className="mx-auto max-w-6xl px-3 pb-6 sm:px-4">
        <PoweredBy />
      </footer>
    </div>
  );
}
