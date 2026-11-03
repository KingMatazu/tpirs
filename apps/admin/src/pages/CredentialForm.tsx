import { Eye, EyeOff } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api } from "../api/client.js";
import { errorFrom, type ApiResult } from "../api/unwrap.js";
import { Button, Field, TextInput } from "../components/ui.js";
import { navigate } from "../lib/router.js";
import { firstPermittedRoute } from "./Layout.js";
import { useSession } from "../session.js";

/**
 * The last step of onboarding: replace the provisioning account's temporary
 * credentials with the administrator's own.
 *
 * Rendered two ways. After the wizard creates the tenant it signs in with the
 * temporary account, and `App` sends that session straight here. A browser that
 * reloads mid-onboarding lands here too, because the refresh route reports the
 * same `mustChangeCredentials` flag. Either way the server refuses every other
 * route until this one succeeds, so this is the only place the account can go.
 *
 * The credential rules are enforced here for immediate feedback and again on the
 * server, which is authoritative: username must not be the provisioning one and
 * must be a plain `lowercase-dotted` name, the password must be six characters
 * and must be neither `password` nor the username.
 */

const TEMPORARY_USERNAME = "admin";
const TEMPORARY_PASSWORD = "password";
const MIN_PASSWORD_LENGTH = 6;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

interface CredentialSession {
  readonly token?: string;
}

function issues(
  username: string,
  password: string,
): {
  username?: string;
  password?: string;
} {
  const result: { username?: string; password?: string } = {};
  const name = username.trim();
  if (name.toLowerCase() === TEMPORARY_USERNAME) {
    result.username = `"${TEMPORARY_USERNAME}" is the provisioning account; choose your own username`;
  } else if (!USERNAME_PATTERN.test(name)) {
    result.username = "Use 3-40 characters: lowercase letters, digits, dot, underscore or hyphen";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    result.password = `Use at least ${String(MIN_PASSWORD_LENGTH)} characters`;
  } else if (password.toLowerCase() === TEMPORARY_PASSWORD) {
    result.password = `"${TEMPORARY_PASSWORD}" is the temporary password; choose your own`;
  } else if (name !== "" && password.toLowerCase() === name.toLowerCase()) {
    result.password = "The password must not be the username";
  }
  return result;
}

export function CredentialForm(): ReactElement {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    void (async () => {
      setErrors({});
      setFormError(undefined);
      const local = issues(username, password);
      if (local.username !== undefined || local.password !== undefined) {
        setErrors(local);
        return;
      }

      setSubmitting(true);
      const result = (await api.POST("/v1/auth/complete-onboarding", {
        body: { username: username.trim(), password },
      })) as ApiResult<CredentialSession>;

      if (result.error !== undefined && result.error !== null) {
        const envelope = (result.error as { error?: { issues?: unknown } }).error;
        const raw = envelope?.issues;
        const serverIssues = Array.isArray(raw) ? raw : [];
        const next: { username?: string; password?: string } = {};
        let general: string | undefined;
        for (const item of serverIssues) {
          if (typeof item !== "object" || item === null) continue;
          const record = item as Record<string, unknown>;
          const path = typeof record.path === "string" ? record.path : "";
          const message = typeof record.message === "string" ? record.message : "";
          if (path === "username") next.username = message;
          else if (path === "password") next.password = message;
          else general = message;
        }
        if (general === undefined && next.username === undefined && next.password === undefined) {
          general = errorFrom(result).message;
        }
        setErrors(next);
        setFormError(general);
        setSubmitting(false);
        return;
      }

      const token = result.data?.token;
      if (typeof token !== "string" || token === "") {
        setFormError("The sign-in was not completed");
        setSubmitting(false);
        return;
      }
      await useSession.getState().acceptSession(token);
      setSubmitting(false);
      navigate(firstPermittedRoute(useSession.getState().user?.permissions ?? []) ?? "/");
    })();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tpirs-color-accent)]">
          First sign-in
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Choose your credentials</h1>
        <p className="mt-2 text-sm text-slate-600">
          This account is still using a temporary password. Pick a username and password no one else
          can guess; the temporary one stops working.
        </p>
      </div>
      <form
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Username"
          {...(errors.username === undefined ? {} : { error: errors.username })}
        >
          <TextInput
            value={username}
            onValueChange={setUsername}
            autoComplete="username"
            placeholder="admin.officer"
          />
        </Field>
        <Field
          label="Password"
          {...(errors.password === undefined ? {} : { error: errors.password })}
        >
          <div className="relative">
            <TextInput
              value={password}
              onValueChange={setPassword}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="At least 6 characters"
            />
            <button
              type="button"
              onClick={() => {
                setShowPassword((current) => !current);
              }}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-500 hover:text-slate-900"
            >
              {showPassword ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>
        {formError !== undefined ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Setting sign-in…" : "Finish setup"}
        </Button>
      </form>
    </main>
  );
}
