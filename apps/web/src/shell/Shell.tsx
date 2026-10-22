import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { registerCommands } from "../commands/registry.ts";
import { Button, Icon, Sheet } from "../ui/index.ts";
import { useLayout, useOnline } from "./layout.ts";
import { Rail } from "./Rail.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

interface Props {
  /** Content of the left panel (file tree). */
  sidebar: ReactNode;
  /** Content of the right panel (details of the open file). */
  inspector: ReactNode;
  /** The tab strip shown in the top bar; leave out for the page title only. */
  tabs?: ReactNode;
  /** Extra buttons in the top bar, before the details toggle (plugin toolbar entries). */
  toolbar?: ReactNode;
  /** A bar under the main area; leave out for none (plugin status-bar entries). */
  statusBar?: ReactNode;
  /** Increase to make sure the sidebar is showing (e.g. when search was asked for). */
  sidebarRequest?: number;
  children: ReactNode;
}

/**
 * Layout v2: icon rail, collapsible sidebar, top bar with tabs, main area, details panel.
 * Up to 900px the sidebar and details panel become drawers and the top bar gets menu buttons.
 */
export function Shell({
  sidebar,
  inspector,
  tabs,
  toolbar,
  statusBar,
  sidebarRequest = 0,
  children,
}: Props) {
  const { t } = useTranslation();
  const layout = useLayout();
  const online = useOnline();
  const [settings, setSettings] = useState(false);
  const location = useLocation();
  const { closeDrawer, isMobile } = layout;

  // The toggles change every render; commands reach them through a ref so they register once.
  const latest = useRef(layout);
  latest.current = layout;
  useEffect(
    () =>
      registerCommands([
        {
          id: "view.toggleSidebar",
          title: t("nav.toggleSidebar"),
          icon: "sidebar",
          run: () => latest.current.toggleSidebar(),
        },
        {
          id: "view.toggleInspector",
          title: t("nav.toggleInspector"),
          icon: "inspector",
          run: () => latest.current.toggleInspector(),
        },
        {
          id: "view.settings",
          title: t("nav.settings"),
          icon: "settings",
          run: () => setSettings(true),
        },
      ]),
    [t],
  );

  useEffect(() => {
    if (sidebarRequest > 0 && !latest.current.sidebarOpen) latest.current.toggleSidebar();
  }, [sidebarRequest]);

  useEffect(() => {
    if (isMobile) closeDrawer();
  }, [location.pathname, isMobile, closeDrawer]);

  const rail = (
    <Rail
      sidebarOpen={layout.sidebarOpen}
      onToggleSidebar={layout.toggleSidebar}
      onOpenSettings={() => {
        closeDrawer();
        setSettings(true);
      }}
    />
  );

  return (
    <div
      className="shell"
      data-mobile={layout.isMobile || undefined}
      data-sidebar={(!layout.isMobile && layout.sidebarOpen) || undefined}
      data-inspector={(!layout.isMobile && layout.inspectorOpen) || undefined}
    >
      <a className="skip-link" href="#main">
        {t("nav.skipToContent")}
      </a>
      {!layout.isMobile && rail}
      {!layout.isMobile && layout.sidebarOpen && (
        <aside className="sidebar" aria-label={t("shell.sidebarTitle")}>
          {sidebar}
        </aside>
      )}
      <div className="stage">
        {!online && (
          <div className="offline-bar" role="status">
            <Icon name="offline" />
            {t("pwa.offline")}
          </div>
        )}
        <header className="topbar">
          <Button
            variant="ghost"
            icon={layout.isMobile ? "menu" : "sidebar"}
            aria-label={
              layout.isMobile
                ? t("nav.openMenu")
                : layout.sidebarOpen
                  ? t("nav.collapseSidebar")
                  : t("nav.expandSidebar")
            }
            aria-expanded={layout.sidebarOpen}
            onClick={layout.toggleSidebar}
          />
          <div className="topbar-tabs">{tabs}</div>
          {toolbar}
          <Button
            variant="ghost"
            icon="inspector"
            aria-label={layout.inspectorOpen ? t("nav.hideInspector") : t("nav.showInspector")}
            aria-expanded={layout.inspectorOpen}
            onClick={layout.toggleInspector}
          />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
        {statusBar}
      </div>
      {!layout.isMobile && layout.inspectorOpen && (
        <aside className="inspector" aria-label={t("shell.inspectorTitle")}>
          {inspector}
        </aside>
      )}
      {layout.isMobile && (
        <>
          <Sheet
            open={layout.sidebarOpen}
            onClose={layout.closeDrawer}
            side="left"
            title={t("shell.sidebarTitle")}
            hideTitle
            className="drawer"
          >
            <div className="drawer-layout">
              {rail}
              <div className="sidebar">{sidebar}</div>
            </div>
          </Sheet>
          <Sheet
            open={layout.inspectorOpen}
            onClose={layout.closeDrawer}
            side="right"
            title={t("shell.inspectorTitle")}
            className="drawer"
          >
            {inspector}
          </Sheet>
        </>
      )}
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
