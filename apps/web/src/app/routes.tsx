import { Outlet, type RouteObject } from "react-router";
import { ToastProvider } from "../ui/index.ts";
import { HomePage, NotFoundPage, VaultPage } from "./pages.tsx";

function Root() {
  return (
    <ToastProvider>
      <Outlet />
    </ToastProvider>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/v/:vault/*", element: <VaultPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
