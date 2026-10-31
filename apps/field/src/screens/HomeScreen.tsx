import type { ReactElement } from "react";
import { formatBusinessDate } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";

/**
 * The officer's start screen: who they are, which tenant they are working for,
 * and the one action that matters. Sync state and the scan action arrive with
 * the sync and scan steps; until then the button says so instead of failing.
 */
export function HomeScreen(): ReactElement {
  const user = useSession((state) => state.user);
  const config = useSession((state) => state.config);
  const configError = useSession((state) => state.configError);

  const now = new Date();
  const today =
    config === undefined
      ? undefined
      : formatBusinessDate(now, config.locale.numberFormat, "yyyy-MM-dd");

  return (
    <Screen
      title={config?.branding.appName ?? copy.app.title}
      footer={
        <SecondaryButton
          onClick={() => {
            void useSession.getState().logout();
          }}
        >
          {copy.app.signOut}
        </SecondaryButton>
      }
    >
      {configError ? (
        <Banner tone="warning">
          The tenant settings could not be loaded. Branding and dispute reasons come from the last
          successful sign-in on this phone.
        </Banner>
      ) : null}

      <Card>
        <p className="text-base text-slate-600">{copy.home.greeting}</p>
        <p className="text-xl font-semibold text-slate-900">{user?.displayName ?? "Officer"}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-base">
          <dt className="text-slate-600">{copy.home.today}</dt>
          <dd className="text-right font-medium text-slate-900">{today ?? "—"}</dd>
          <dt className="text-slate-600">State</dt>
          <dd className="text-right font-medium text-slate-900">{config?.identity.name ?? "—"}</dd>
        </dl>
      </Card>

      <PrimaryButton disabled>{copy.home.scan}</PrimaryButton>
      <p className="-mt-1 text-center text-sm text-slate-600">{copy.home.scanComing}</p>
    </Screen>
  );
}
