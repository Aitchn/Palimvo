import { Navigate, Outlet, useLocation, type RouteObject } from "react-router";
import { InvitePage } from "../auth/InvitePage.tsx";
import { LoginPage } from "../auth/LoginPage.tsx";
import { SessionBoundary, SessionProvider, useSession } from "../auth/session.tsx";
import { SetupPage } from "../auth/SetupPage.tsx";
import { AccountSection } from "../settings/AccountSection.tsx";
import { SettingsPage } from "../settings/SettingsPage.tsx";
import { UsersSection } from "../settings/UsersSection.tsx";
import { VaultSettings } from "../settings/VaultSettings.tsx";
import { VaultsSection } from "../settings/VaultsSection.tsx";
import { ToastProvider } from "../ui/index.ts";
import { VaultPage } from "../workspace/Workspace.tsx";
import { HomePage, NotFoundPage } from "./pages.tsx";

function Root() {
  return (
    <SessionProvider>
      <ToastProvider>
        <SessionBoundary>
          <Outlet />
        </SessionBoundary>
      </ToastProvider>
    </SessionProvider>
  );
}

/** Everything but the sign-in pages: a server that is not set up yet sends people to the wizard. */
function NeedsSetup() {
  const { session } = useSession();
  const location = useLocation();
  if (session.status === "setup" && location.pathname !== "/setup")
    return <Navigate to="/setup" replace />;
  return <Outlet />;
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: "/setup", element: <SetupPage /> },
      { path: "/login", element: <LoginPage /> },
      { path: "/invite/:token", element: <InvitePage /> },
      {
        element: <NeedsSetup />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/v/:vault/*", element: <VaultPage /> },
          {
            path: "/settings",
            element: <SettingsPage />,
            children: [
              { index: true, element: <Navigate to="account" replace /> },
              { path: "account", element: <AccountSection /> },
              { path: "users", element: <UsersSection /> },
              { path: "vaults", element: <VaultsSection /> },
              { path: "vaults/:vault", element: <VaultSettings /> },
            ],
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
