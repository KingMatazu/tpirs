import { useEffect, useState, type ReactElement } from "react";
import { useSession } from "../session.js";
import { Eye, EyeOff } from "lucide-react";
import { Field, PrimaryButton, inputClass } from "../components/ui.js";

/** Sign-in. The collector signs in once per shift; the session is not persisted. */
export function LoginScreen(): ReactElement {
  const [tenantSlug, setTenantSlug] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Typing a long password on a shared handset is where sign-ins fail; showing
  // what was typed is the fix, and it never leaves the tab.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Remember the tenant on this handset only: it is not a secret and typing it
    // every morning is the kind of friction that ends with a shared password.
    const remembered = globalThis.localStorage.getItem("tpirs.collector.tenant");
    if (remembered !== null) setTenantSlug(remembered);
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await useSession.getState().login({ tenantSlug, username, password });
      globalThis.localStorage.setItem("tpirs.collector.tenant", tenantSlug);
    } catch {
      setError("Check the tenant, username and password, then try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Collector sign-in</h1>
        <p className="mt-1 text-sm text-slate-500">Take the daily levy in cash.</p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="State">
          <input
            className={inputClass}
            value={tenantSlug}
            onChange={(event) => {
              setTenantSlug(event.currentTarget.value);
            }}
            autoComplete="organization"
            placeholder="alpha-state"
          />
        </Field>
        <Field label="Username">
          <input
            className={inputClass}
            value={username}
            onChange={(event) => {
              setUsername(event.currentTarget.value);
            }}
            autoComplete="username"
          />
        </Field>
        <Field label="Password" {...(error === undefined ? {} : { error })}>
          <div className="relative">
            <input
              className={`${inputClass} pr-12`}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => {
                setPassword(event.currentTarget.value);
              }}
              autoComplete="current-password"
            />
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                setShowPassword((current) => !current);
              }}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-slate-600 active:text-slate-900"
            >
              {showPassword ? (
                <EyeOff size={20} aria-hidden="true" />
              ) : (
                <Eye size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </PrimaryButton>
      </form>
    </main>
  );
}
