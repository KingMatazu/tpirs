import { useState, type ReactElement } from "react";
import { ApiError } from "@tpirs/api-client";
import { useSession } from "../session.js";
import { Field, PrimaryButton, SecondaryButton, inputClass } from "../components/ui.js";

const MIN_PASSWORD_LENGTH = 6;

/**
 * First sign-in for a collector account an administrator created.
 *
 * The server refuses every other route while the temporary password is still in
 * place, so this screen stands between the collector and the cash flow. The
 * username stays as handed over; only the password changes.
 */
export function SetPasswordScreen(): ReactElement {
  const displayName = useSession((state) => state.user?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    void (async () => {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
        return;
      }
      if (password !== confirmation) {
        setError("The two passwords do not match.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await useSession.getState().changePassword(password);
        // The session clears the flag, so `App` renders the home screen next.
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "The password could not be changed. Check your connection and try again.",
        );
        setBusy(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          First sign-in
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Choose your password</h1>
        <p className="mt-1 text-sm text-slate-600">
          {displayName === "" ? "This account" : displayName} still has the temporary password you
          were given. Choose one only you know; the temporary one stops working.
        </p>
      </div>

      {error === undefined ? null : (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="New password" hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters`}>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
            autoComplete="new-password"
            autoCapitalize="none"
          />
        </Field>
        <Field label="Confirm password">
          <input
            className={inputClass}
            type="password"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.currentTarget.value);
            }}
            autoComplete="new-password"
            autoCapitalize="none"
          />
        </Field>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save and continue"}
        </PrimaryButton>
      </form>

      <SecondaryButton
        onClick={() => {
          void useSession.getState().logout();
        }}
      >
        Sign out
      </SecondaryButton>
    </main>
  );
}
