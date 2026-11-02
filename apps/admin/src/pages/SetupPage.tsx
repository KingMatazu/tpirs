import { type ReactElement } from "react";

/**
 * First-run onboarding: turns an empty deployment into one with a tenant.
 *
 * This file is the shell the four wizard steps hang off. It renders outside
 * `Layout` on purpose: there is no tenant yet, so there is no branding or
 * navigation to show, and a `useTenantConfig` call here would loop on a 404.
 * Every colour comes from the `--tpirs-color-*` CSS variables, whose `:root`
 * defaults are neutral — the wizard must not inherit a tenant's branding before
 * one has been chosen.
 *
 * The steps are listed here once; the later parts fill them in with their forms.
 * Order matters and is the user's mental model, not an implementation detail:
 * state details, levy amounts, a review, then the sign-in that replaces the
 * provisioning account.
 */
const STEPS = ["State", "Levy", "Review", "Sign in"] as const;

export function SetupPage(): ReactElement {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tpirs-color-accent)]">
            First-run setup
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Welcome to your revenue platform
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            This deployment has no tenant yet. Four short steps turn it into a working levy
            system.
          </p>
        </header>

        <ol className="mb-8 flex flex-wrap items-center gap-2" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--tpirs-color-primary)] text-xs font-semibold text-white">
                {index + 1}
              </span>
              <span className="text-sm text-slate-700">{label}</span>
              {index < STEPS.length - 1 ? (
                <span className="h-px w-6 bg-slate-300" aria-hidden="true" />
              ) : null}
            </li>
          ))}
        </ol>

        <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">State details</h2>
          <p className="mt-1 text-sm text-slate-600">
            The tenant&rsquo;s identity, currency and channels are captured in the next step.
          </p>
        </section>
      </div>
    </main>
  );
}
