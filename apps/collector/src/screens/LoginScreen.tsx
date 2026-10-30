import { useEffect, useState, type ReactElement } from "react";
import { useSession } from "../session.js";
import { Field, PrimaryButton, inputClass } from "../components/ui.js";

/** Sign-in. The collector signs in once per shift; the session is not persisted. */
export function LoginScreen(): ReactElement {
  const [tenantSlug, setTenantSlug] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
            onChange={(event) => { setTenantSlug(event.currentTarget.value); }}
            autoComplete="organization"
            placeholder="alpha-state"
          />
        </Field>
        <Field label="Username">
          <input
            className={inputClass}
            value={username}
            onChange={(event) => { setUsername(event.currentTarget.value); }}
            autoComplete="username"
          />
        </Field>
        <Field label="Password" {...(error === undefined ? {} : { error })}>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(event) => { setPassword(event.currentTarget.value); }}
            autoComplete="current-password"
          />
        </Field>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </PrimaryButton>
      </form>
    </main>
  );
}
