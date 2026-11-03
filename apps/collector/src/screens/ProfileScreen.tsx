import { useState, type ReactElement } from "react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { Banner, Card, Screen, SecondaryButton } from "../components/ui.js";
import { toBigInt } from "../lib/flow.js";
import { useTenantConfig, useWallet } from "../lib/data.js";
import { promptInstall, useInstallKind } from "../lib/install.js";
import { initialsFor, maskNationalId, roleLabel } from "../lib/profile.js";
import { useSession } from "../session.js";

/**
 * Who the collector is signed in as, and what this handset is holding.
 *
 * Everything here is read-only: the contact fields are managed by the dashboard
 * (ADR 0054), and cash lives on Home where it is in reach. The point of the
 * screen is the support call — "read me what your profile says" answers the
 * state, the username and the phone number without a guess.
 */
export function ProfileScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const user = useSession((state) => state.user);
  const config = useTenantConfig();
  const wallet = useWallet();
  const installKind = useInstallKind();
  const [showNationalId, setShowNationalId] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | undefined>(undefined);

  const currency = config?.locale.currency ?? "NGN";
  const numberFormat = config?.locale.numberFormat ?? "en-NG";
  const view = wallet.data?.wallet;
  const frozen = view?.status === "frozen";
  const role = user?.roles[0];

  const install = async (): Promise<void> => {
    const outcome = await promptInstall();
    if (outcome === "dismissed") {
      setInstallMessage("Install was dismissed. Use the browser menu if you change your mind.");
    } else if (outcome === "unavailable") {
      setInstallMessage("This browser did not offer an install prompt. Use its menu instead.");
    } else {
      setInstallMessage(undefined);
    }
  };

  return (
    <Screen title="Profile" onBack={props.onBack}>
      <Card>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-900 text-base font-semibold text-white"
          >
            {initialsFor(user?.displayName ?? "")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-slate-900">
              {user?.displayName ?? "Collector"}
            </p>
            {role === undefined ? null : (
              <p className="text-sm text-slate-500">{roleLabel(role)}</p>
            )}
          </div>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Username" value={user?.username ?? "—"} />
          <Row label="State" value={config?.identity.name ?? "—"} />
        </dl>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-slate-900">Your details</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Your supervisor manages these in the dashboard, so ask them to correct anything that is
          wrong.
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Phone" value={user?.phone ?? "Not recorded"} />
          <div className="flex items-start justify-between gap-3">
            <dt className="text-slate-500">National ID</dt>
            <dd className="text-right font-medium text-slate-900">
              {user?.nationalId === null || user?.nationalId === undefined ? (
                "Not recorded"
              ) : (
                <span className="font-mono">
                  {showNationalId ? user.nationalId : maskNationalId(user.nationalId)}
                </span>
              )}
              {user?.nationalId === null || user?.nationalId === undefined ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setShowNationalId((current) => !current);
                  }}
                  aria-label={showNationalId ? "Hide national ID" : "Show national ID"}
                  aria-pressed={showNationalId}
                  className="ml-2 text-xs font-medium text-slate-600 underline"
                >
                  {showNationalId ? "Hide" : "Show"}
                </button>
              )}
            </dd>
          </div>
          <Row label="Home address" value={user?.homeAddress ?? "Not recorded"} />
        </dl>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-slate-900">Cash in hand</h2>
        <p className="mt-1 text-2xl font-semibold text-slate-900">
          {formatMoneyMinor(toBigInt(view?.balanceMinor), currency, numberFormat)}
        </p>
        <p className="text-xs text-slate-500">
          {view?.floatCeilingMinor === null || view?.floatCeilingMinor === undefined
            ? "No float ceiling set for this state."
            : `of ${formatMoneyMinor(toBigInt(view.floatCeilingMinor), currency, numberFormat)} float ceiling`}
        </p>
        {frozen ? (
          <div className="mt-2">
            <Banner tone="danger">
              Wallet frozen{view.frozenReason === null ? "" : `: ${view.frozenReason}`}. Finance
              must unfreeze it before you take more cash.
            </Banner>
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-slate-900">This phone</h2>
        {installMessage === undefined ? null : (
          <p className="mt-1 text-sm text-slate-700" role="status">
            {installMessage}
          </p>
        )}
        {installKind === "installed" ? (
          <p className="mt-1 text-sm text-slate-600">
            Installed on this phone. Open it from the home screen like any other app.
          </p>
        ) : installKind === "prompt" ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              Add the collector app to the home screen so it opens full screen, without typing the
              address.
            </p>
            <div className="mt-2">
              <SecondaryButton
                onClick={() => {
                  void install();
                }}
              >
                Install on this phone
              </SecondaryButton>
            </div>
          </>
        ) : installKind === "ios" ? (
          <p className="mt-1 text-sm text-slate-600">
            On iPhone or iPad, tap Share in the browser bar, then Add to Home Screen.
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            Open this page in Chrome or Safari, then use the browser menu to add it to the home
            screen.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          The app opens without a network, but taking cash needs a connection: nothing is recorded
          on the phone.
        </p>
      </Card>

      <SecondaryButton
        onClick={() => {
          void useSession.getState().logout();
        }}
      >
        Sign out
      </SecondaryButton>
      <p className="text-center text-xs text-slate-500">
        To change your password, ask your supervisor to reset it.
      </p>
    </Screen>
  );
}

function Row(props: Readonly<{ label: string; value: string }>): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{props.label}</dt>
      <dd className="break-words text-right font-medium text-slate-900">{props.value}</dd>
    </div>
  );
}
