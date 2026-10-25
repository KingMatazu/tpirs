import { type FormEvent, type ReactElement, type ReactNode } from "react";

/**
 * Copy-in component base (ADR 0027): tiny primitives bound to the tenant token
 * CSS variables. Flows that later need dialogs/popovers will layer Radix
 * primitives under the same visual contract — `apps/admin` still owns them.
 */

export function Button(
  props: Readonly<{
    children: ReactNode;
    readonly type?: "button" | "submit";
    readonly variant?: "primary" | "secondary" | "ghost";
    readonly disabled?: boolean;
    readonly onClick?: () => void;
  }>,
): ReactElement {
  const tone =
    props.variant === "secondary"
      ? "bg-[var(--tpirs-color-secondary)] text-white"
      : props.variant === "ghost"
        ? "border border-slate-300 bg-transparent text-slate-800 hover:bg-slate-100"
        : "bg-[var(--tpirs-color-primary)] text-white";
  return (
    <button
      type={props.type ?? "button"}
      className={`rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Field(
  props: Readonly<{ label: string; error?: string; children: ReactNode; hint?: string }>,
): ReactElement {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{props.label}</span>
      {props.children}
      {props.hint !== undefined ? <span className="mt-1 block text-xs text-slate-500">{props.hint}</span> : null}
      {props.error !== undefined ? <span className="mt-1 block text-xs text-red-600">{props.error}</span> : null}
    </label>
  );
}

export function TextInput(
  props: Readonly<{
    readonly value: string;
    readonly onValueChange?: (value: string) => void;
    readonly onChange?: (event: FormEvent<HTMLInputElement>) => void;
    readonly type?: string;
    readonly placeholder?: string;
    readonly autoComplete?: string;
    readonly name?: string;
    readonly inputMode?: "text" | "numeric" | "tel";
  }>,
): ReactElement {
  return (
    <input
      name={props.name}
      type={props.type ?? "text"}
      inputMode={props.inputMode}
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-[var(--tpirs-color-primary)] focus:outline-none"
      placeholder={props.placeholder}
      autoComplete={props.autoComplete}
      value={props.value}
      onInput={(event) => {
        props.onValueChange?.(event.currentTarget.value);
        props.onChange?.(event);
      }}
    />
  );
}

export function Card(
  props: Readonly<{ title?: string; description?: string; children: ReactNode }>,
): ReactElement {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {props.title !== undefined ? (
        <header className="mb-3">
          <h2 className="text-base font-semibold text-slate-900">{props.title}</h2>
          {props.description !== undefined ? (
            <p className="mt-0.5 text-sm text-slate-500">{props.description}</p>
          ) : null}
        </header>
      ) : null}
      {props.children}
    </section>
  );
}

export function Badge(props: Readonly<{ children: ReactNode; tone?: "neutral" | "brand" }>): ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        props.tone === "brand" ? "bg-[var(--tpirs-color-accent)] text-slate-900" : "bg-slate-100 text-slate-700"
      }`}
    >
      {props.children}
    </span>
  );
}

export function ReadOnlyNote(props: Readonly<{ children: ReactNode }>): ReactElement {
  return (
    <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
      {props.children}
    </p>
  );
}

export function EmptyState(props: Readonly<{ message: string }>): ReactElement {
  return <p className="py-6 text-center text-sm text-slate-500">{props.message}</p>;
}
