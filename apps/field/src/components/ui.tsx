import type { ReactElement, ReactNode } from "react";

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
        <h1 className="flex-1 text-center text-lg font-semibold text-slate-900">{props.title}</h1>
        <span className="w-16" />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 p-3">
        {props.children}
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
