import type { ReactElement, ReactNode } from "react";
import { initialsFor, logoSource } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { PoweredBy } from "./PoweredBy.js";

/**
 * The officer app's small component set.
 *
 * Deliberately local rather than shared with the collector app: both are phone
 * apps, but an officer reads this screen at arm's length, outdoors, often in
 * direct sun, so the type is larger, the tap targets are bigger and the contrast
 * is higher than a collector's cash flow needs. A shared package would have to
 * take the union of both, which is how phone UIs become desktop UIs.
 */

const base =
  "w-full rounded-xl px-4 text-lg font-semibold transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";

export function PrimaryButton(
  props: Readonly<{
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
    disabled?: boolean;
  }>,
): ReactElement {
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`${base} min-h-16 bg-slate-900 text-white active:bg-slate-700`}
    >
      {props.children}
    </button>
  );
}

export function SecondaryButton(
  props: Readonly<{
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }>,
): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`${base} min-h-14 border-2 border-slate-400 bg-white text-slate-900 active:bg-slate-100`}
    >
      {props.children}
    </button>
  );
}

export function Card(props: Readonly<{ children: ReactNode; className?: string }>): ReactElement {
  return (
    <section className={`rounded-xl border border-slate-300 bg-white p-4 ${props.className ?? ""}`}>
      {props.children}
    </section>
  );
}

export function Screen(
  props: Readonly<{
    title: string;
    onBack?: () => void;
    children: ReactNode;
    footer?: ReactNode;
  }>,
): ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-slate-100">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-300 bg-white px-3 py-2">
        {props.onBack === undefined ? (
          <span className="w-16" />
        ) : (
          <button
            type="button"
            onClick={props.onBack}
            className="min-h-12 rounded-lg px-2 text-base font-medium text-slate-800"
          >
            Back
          </button>
        )}
        <h1 className="flex flex-1 items-center justify-center gap-2 text-lg font-semibold text-slate-900">
          <HeaderLogo fallbackName={props.title} />
          <span className="truncate">{props.title}</span>
        </h1>
        <span className="w-16" />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 p-3">
        {props.children}
        <div className="mt-auto pt-2">
          <PoweredBy />
        </div>
      </main>
      {props.footer === undefined ? null : (
        <footer className="sticky bottom-0 border-t border-slate-300 bg-white p-3">
          <div className="mx-auto w-full max-w-md">{props.footer}</div>
        </footer>
      )}
    </div>
  );
}

export function Field(
  props: Readonly<{
    label: string;
    hint?: string;
    error?: string;
    children: ReactNode;
  }>,
): ReactElement {
  return (
    <label className="block">
      <span className="mb-1 block text-base font-medium text-slate-800">{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : (
        <span className="mt-1 block text-sm text-slate-600">{props.hint}</span>
      )}
      {props.error === undefined ? null : (
        <span className="mt-1 block text-sm font-medium text-red-700">{props.error}</span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border-2 border-slate-400 bg-white px-3 py-3 text-lg text-slate-900 focus:border-slate-900 focus:outline-none";

export function Banner(
  props: Readonly<{ tone: "info" | "warning" | "danger" | "success"; children: ReactNode }>,
): ReactElement {
  const tones = {
    info: "bg-slate-200 text-slate-900",
    warning: "bg-amber-100 text-amber-950",
    danger: "bg-red-100 text-red-950",
    success: "bg-emerald-100 text-emerald-950",
  } as const;
  return (
    <div className={`rounded-xl p-3 text-base ${tones[props.tone]}`} role="status">
      {props.children}
    </div>
  );
}

/**
 * The state's logo in the screen header. The officer app caches the config, so
 * this reads it from the session store rather than being passed down through
 * every screen. Before sign-in there is no config and the header shows the
 * screen title alone.
 */
export function HeaderLogo(
  props: Readonly<{ readonly fallbackName: string }>,
): ReactElement | null {
  const config = useSession((state) => state.config);
  if (config === undefined) return null;
  const source = logoSource(config.branding.logoUrl);
  const name = config.identity.name === "" ? props.fallbackName : config.identity.name;
  if (source === undefined) {
    return (
      <span
        aria-hidden={true}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--tpirs-color-primary)] text-[10px] font-bold text-white"
      >
        {initialsFor(name)}
      </span>
    );
  }
  // Decorative beside the screen title: the state is already named on the
  // screen, and an alt here would be read out before every heading.
  return (
    <img
      src={source}
      alt=""
      aria-hidden={true}
      className="h-6 w-6 shrink-0 rounded object-contain"
    />
  );
}
