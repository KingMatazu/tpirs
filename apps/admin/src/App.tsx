import { useEffect, type ReactElement } from "react";
import { useRoute } from "./lib/router.js";
import { useSession } from "./session.js";
import { appDestinations, destinationsForRoles } from "./lib/appLinks.js";
import { Layout, firstPermittedRoute, permissionForRoute } from "./pages/Layout.js";
import { Card, EmptyState } from "./components/ui.js";
import { LoginPage } from "./pages/LoginPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { CredentialForm } from "./pages/CredentialForm.js";
import { ConfigViewerPage } from "./pages/ConfigViewerPage.js";
import { ZonesPage } from "./pages/ZonesPage.js";
import { UsersPage } from "./pages/UsersPage.js";
import { ChannelsPage } from "./pages/ChannelsPage.js";
import { UssdSimulatorPage } from "./pages/UssdSimulatorPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { CollectorsPage } from "./pages/CollectorsPage.js";
import { ReconciliationPage } from "./pages/ReconciliationPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { RegistryPage } from "./pages/RegistryPage.js";
import { PaymentsPage } from "./pages/PaymentsPage.js";
import { DisputesPage } from "./pages/DisputesPage.js";
import { ReversalsPage } from "./pages/ReversalsPage.js";

const NO_PERMISSIONS: readonly string[] = [];
const NO_ROLES: readonly string[] = [];

export function App(): ReactElement {
  const sessionStatus = useSession((state) => state.status);
  const needsSetup = useSession((state) => state.needsSetup);
  const user = useSession((state) => state.user);
  const permissions = useSession((state) => state.user?.permissions ?? NO_PERMISSIONS);
  const route = useRoute();

  // Reach the store method directly: selecting a closure would return a new
  // function on every render and send useSyncExternalStore into a loop.
  useEffect(() => {
    void useSession.getState().initialize();
  }, []);

  if (
    sessionStatus === "unknown" ||
    (sessionStatus === "anonymous" && needsSetup === undefined) ||
    (sessionStatus === "authenticated" && user === undefined)
  ) {
    return <p className="min-h-screen p-8 text-sm text-slate-500">Checking session…</p>;
  }
  if (sessionStatus === "anonymous") {
    // First-run detection wins over the sign-in screen: an empty deployment has
    // no account to sign in with, so showing the form would be a dead end.
    return needsSetup === true ? <SetupPage /> : <LoginPage />;
  }
  // A session issued to the provisioning account is confined server-side to the
  // completion route; the client sends it straight to the credential step
  // rather than to a dashboard every request would refuse.
  if (user?.mustChangeCredentials === true) {
    return <CredentialForm />;
  }

  // Landing: the first page this role may actually open, not a hardcoded one.
  const target = route === "/" ? firstPermittedRoute(permissions) : route;
  if (target === undefined) {
    // An officer or a collector has a role, just not one the dashboard serves.
    // "Ask for a role" would be wrong advice: the account works, on another app.
    const elsewhere = destinationsForRoles(user?.roles ?? NO_ROLES, appDestinations()).filter(
      (destination) => destination.key !== "admin",
    );
    if (elsewhere.length > 0) {
      return (
        <Layout>
          <Card>
            <div className="space-y-2 text-sm text-slate-700">
              <p className="font-medium text-slate-900">
                This account works on another app, not the dashboard.
              </p>
              {elsewhere.map((destination) => (
                <p key={destination.key}>
                  {destination.label}:{" "}
                  {destination.url === undefined ? (
                    <span className="text-slate-500">
                      ask an administrator for the address (set the app URL on this deployment)
                    </span>
                  ) : (
                    <a className="font-medium text-sky-700 underline" href={destination.url}>
                      {destination.url}
                    </a>
                  )}
                </p>
              ))}
              <p className="text-slate-500">
                Sign out here and sign in there with the same account.
              </p>
            </div>
          </Card>
        </Layout>
      );
    }
    return (
      <Layout>
        <Card>
          <EmptyState message="This account has no pages yet. Ask an administrator to give it a role." />
        </Card>
      </Layout>
    );
  }

  const required = permissionForRoute(target);
  if (required !== undefined && !permissions.includes(required)) {
    // The sidebar hides it, so the URL must not reach it either.
    return (
      <Layout>
        <Card>
          <EmptyState message="You do not have permission to view this page." />
        </Card>
      </Layout>
    );
  }

  return <Layout>{pageFor(target)}</Layout>;
}

function pageFor(route: string): ReactElement {
  switch (route) {
    case "/registry":
      return <RegistryPage />;
    case "/payments":
      return <PaymentsPage />;
    case "/disputes":
      return <DisputesPage />;
    case "/reversals":
      return <ReversalsPage />;
    case "/collectors":
      return <CollectorsPage />;
    case "/reconciliation":
      return <ReconciliationPage />;
    case "/reports":
      return <ReportsPage />;
    case "/channels":
      return <ChannelsPage />;
    case "/ussd":
      return <UssdSimulatorPage />;
    case "/config":
      return <ConfigViewerPage />;
    case "/zones":
      return <ZonesPage />;
    case "/users":
      return <UsersPage />;
    case "/audit":
      return <AuditPage />;
    default:
      return <PlaceholderPage title="Asset registry" step="7" />;
  }
}
