import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createBrowserRouter } from "react-router";
import { routes } from "./app/routes.tsx";
import { initI18n } from "./i18n/index.ts";
import { registerServiceWorker } from "./pwa/register.ts";
import { initTheme } from "./theme/theme.ts";
import "./styles/tokens.css";
import "./styles/motion.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/files.css";
import "./styles/history.css";
import "./styles/editor.css";
import "./styles/auth.css";
import "./pwa/standalone.css";

initTheme();
const i18n = await initI18n();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={createBrowserRouter(routes)} />
    </I18nextProvider>
  </StrictMode>,
);
registerServiceWorker();
