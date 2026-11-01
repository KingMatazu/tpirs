import { useEffect, useState, type ReactElement } from "react";
import { ApiError } from "@tpirs/api-client";
import { useSession } from "../session.js";
import { Eye, EyeOff } from "lucide-react";
import { copy } from "../copy.js";
import { Banner, Field, PrimaryButton, inputClass } from "../components/ui.js";

const TENANT_KEY = "tpirs.field.tenant";

/**
 * Sign-in. The officer signs in once per shift, while online, because the paid
 * set and the config have to be fetched before the phone can work offline.
 */
export function LoginScreen(): ReactElement {
  const [tenantSlug, setTenantSlug] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Typing a long password on a shared handset is where sign-ins fail; showing
  // what was typed is the fix, and it never leaves the tab.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [offline, setOffline] = useState(!globalThis.navigator.onLine);

  useEffect(() => {
    // Remembering the tenant is not a secret and saves typing it every morning;
    // the username is not remembered, because handsets are shared.
    try {
      const remembered = globalThis.localStorage.getItem(TENANT_KEY);
      if (remembered !== null) setTenantSlug(remembered);
    } catch {
      // Storage unavailable: type it.
    }
    const update = (): void => {
      setOffline(!globalThis.navigator.onLine);
    };
    globalThis.addEventListener("online", update);
    globalThis.addEventListener("offline", update);
    return () => {
      globalThis.removeEventListener("online", update);
      globalThis.removeEventListener("offline", update);
    };
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await useSession.getState().login({ tenantSlug, username, password });
      try {
        globalThis.localStorage.setItem(TENANT_KEY, tenantSlug);
      } catch {
        // Not remembering the tenant is not a failure.
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 bg-slate-100 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{copy.login.heading}</h1>
        <p className="mt-1 text-base text-slate-600">{copy.login.subheading}</p>
      </div>

      {offline ? <Banner tone="warning">{copy.login.offline}</Banner> : null}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={copy.login.state} hint={copy.login.stateHint}>
          <input
            className={inputClass}
            value={tenantSlug}
            onChange={(event) => {
              setTenantSlug(event.currentTarget.value);
            }}
            autoComplete="organization"
            autoCapitalize="none"
            placeholder="alpha-state"
          />
        </Field>
        <Field label={copy.login.username}>
          <input
            className={inputClass}
            value={username}
            onChange={(event) => {
              setUsername(event.currentTarget.value);
            }}
            autoComplete="username"
            autoCapitalize="none"
          />
        </Field>
        <Field label={copy.login.password} {...(error === undefined ? {} : { error })}>
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
              aria-label={showPassword ? copy.login.hidePassword : copy.login.showPassword}
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
        <PrimaryButton type="submit" disabled={busy || offline}>
          {busy ? copy.login.submitting : copy.login.submit}
        </PrimaryButton>
      </form>
    </main>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return copy.login.locked;
    if (error.status === 0 || error.status >= 500) return copy.login.offline;
  }
  // A failed fetch surfaces as a TypeError, not an ApiError.
  if (error instanceof TypeError) return copy.login.offline;
  return copy.login.failed;
}
