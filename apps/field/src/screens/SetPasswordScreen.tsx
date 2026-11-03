import { useState, type ReactElement } from "react";
import { ApiError } from "@tpirs/api-client";
import { useSession } from "../session.js";
import { Banner, Field, PrimaryButton, SecondaryButton, inputClass } from "../components/ui.js";

const MIN_PASSWORD_LENGTH = 6;

/**
 * First sign-in for an account an administrator created.
 *
 * The server refuses every other route while the account still holds the
 * temporary password, so this screen is not a suggestion: it is the only place
 * the officer can go until it is done. The username is not asked for — the
 * administrator chose it and wrote it on the handover card, and asking for a
 * second one is how a card becomes wrong.
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
            : "The password could not be changed. Try again when you have signal.",
        );
        setBusy(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 bg-slate-100 p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          First sign-in
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Choose your password</h1>
        <p className="mt-1 text-base text-slate-600">
          {displayName === "" ? "This account" : displayName} still has the temporary password you
          were given. Choose one only you know; the temporary one stops working.
        </p>
      </div>

      {error === undefined ? null : <Banner tone="danger">{error}</Banner>}

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
