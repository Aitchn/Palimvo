import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dirname, type HomeConfig, type HomeWidget } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { getHome } from "../api/home.ts";
import { useAsync } from "../app/useAsync.ts";
import { tabTitle } from "../files/model.ts";
import type { VaultCan } from "../workspace/useVaultPermissions.ts";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { PluginFrame } from "../plugins/PluginFrame.tsx";
import { usePluginRuntime } from "../plugins/PluginsProvider.tsx";
import { Button, Icon, Skeleton } from "../ui/index.ts";
import { ActivityWidget } from "./ActivityWidget.tsx";
import { HomeSettingsDialog } from "./HomeSettingsDialog.tsx";
import { ProposalsWidget } from "./ProposalsWidget.tsx";

interface Props {
  vault: string;
  /** Every file of the vault, to tell pinned notes that no longer exist. */
  files: readonly string[];
  /** Changes when the vault's files changed. */
  revision: number;
  can: VaultCan;
  onOpen: (path: string) => void;
  /** Accepted proposals changed notes. */
  onTreeChanged: () => void;
  onShowProposals: () => void;
}

/** A vault's front page: what changed and who changed it, what waits for review, and pinned notes. */
export function VaultHome({
  vault,
  files,
  revision,
  can,
  onOpen,
  onTreeChanged,
  onShowProposals,
}: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(0);
  const home = useAsync((signal) => getHome(vault, { signal }), `home:${vault}:${saved}`);

  return (
    <div className="home" data-testid="vault-home">
      <header className="home-head">
        <div>
          <h1>{t("home.title")}</h1>
          <p className="muted">{vault}</p>
        </div>
        {can.settings && home.status === "ready" && (
          <Button variant="secondary" icon="settings" onClick={() => setEditing(true)}>
            {t("home.customize")}
          </Button>
        )}
      </header>
      {home.status === "loading" && <Skeleton lines={6} />}
      {home.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, home.error)}</p>
          <Button onClick={home.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {home.status === "ready" && (
        <>
          {home.data.config.publicNote && (
            <button
              type="button"
              className="home-start"
              onClick={() => onOpen(home.data.config.publicNote!)}
            >
              <Icon name="note" />
              <span>
                <strong>{t("home.startHere")}</strong>
                <br />
                <span className="muted">{tabTitle(home.data.config.publicNote)}</span>
              </span>
              <Icon name="chevron" />
            </button>
          )}
          <div className="home-grid">
            {home.data.config.widgets.map((widget) => (
              <WidgetCard
                key={widget.id}
                widget={widget}
                config={home.data.config}
                vault={vault}
                files={files}
                revision={revision}
                can={can}
                onOpen={onOpen}
                onTreeChanged={onTreeChanged}
                onShowProposals={onShowProposals}
              />
            ))}
          </div>
          {home.data.config.widgets.length === 0 && <p className="muted">{t("home.emptyPage")}</p>}
          <HomeSettingsDialog
            open={editing}
            vault={vault}
            state={home.data}
            files={files}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setSaved((n) => n + 1);
            }}
          />
        </>
      )}
    </div>
  );
}

interface CardProps {
  widget: HomeWidget;
  config: HomeConfig;
  vault: string;
  files: readonly string[];
  revision: number;
  can: VaultCan;
  onOpen: (path: string) => void;
  onTreeChanged: () => void;
  onShowProposals: () => void;
}

function Card({
  id,
  title,
  wide,
  children,
}: {
  id: string;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="home-card" data-wide={wide || undefined} aria-labelledby={`home-${id}`}>
      <h2 id={`home-${id}`} className="home-card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function WidgetCard({
  widget,
  config,
  vault,
  files,
  revision,
  can,
  onOpen,
  onTreeChanged,
  onShowProposals,
}: CardProps) {
  const { t } = useTranslation();
  switch (widget.type) {
    case "activity":
      // The change log is only for people who may see history; others do not get an empty box.
      if (!can.viewHistory) return null;
      return (
        <Card id={widget.id} title={t("home.activity.title")} wide>
          <ActivityWidget
            vault={vault}
            limit={widget.limit}
            revision={revision}
            onOpenFile={onOpen}
          />
        </Card>
      );
    case "proposals":
      if (!can.propose) return null;
      return (
        <Card id={widget.id} title={t("home.proposals.title")}>
          <ProposalsWidget
            vault={vault}
            canReview={can.review}
            revision={revision}
            onChanged={onTreeChanged}
            onOpenFile={onOpen}
            onShowAll={onShowProposals}
          />
        </Card>
      );
    case "pinned": {
      if (config.pinned.length === 0 && !can.settings) return null;
      const known = new Set(files);
      return (
        <Card id={widget.id} title={t("home.pinned.title")}>
          {config.pinned.length === 0 ? (
            <p className="muted">{t("home.pinned.empty")}</p>
          ) : (
            <ul className="home-links">
              {config.pinned.map((path) => (
                <li key={path}>
                  {known.has(path) || files.length === 0 ? (
                    <button type="button" className="home-link" onClick={() => onOpen(path)}>
                      <Icon name="note" />
                      <span>
                        {tabTitle(path)}
                        {dirname(path) && <span className="muted"> {dirname(path)}</span>}
                      </span>
                    </button>
                  ) : (
                    <span className="home-link muted">
                      <Icon name="warning" />
                      <span>{t("home.pinned.missing", { path })}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }
    case "base":
      return (
        <Card id={widget.id} title={t("home.base.title", { name: tabTitle(widget.path) })}>
          <button type="button" className="home-link" onClick={() => onOpen(widget.path)}>
            <Icon name="base" />
            <span>
              {widget.path}
              {widget.view && <span className="muted"> {widget.view}</span>}
            </span>
          </button>
        </Card>
      );
    case "plugin":
      return <PluginWidgetCard id={widget.id} plugin={widget.plugin} widget={widget.view} />;
  }
}

/** A plugin's home widget: drawn in its sandboxed frame while the plugin runs, else a short note. */
function PluginWidgetCard({ id, plugin, widget }: { id: string; plugin: string; widget: string }) {
  const { t, i18n } = useTranslation();
  const runtime = usePluginRuntime();
  const entry = runtime?.registry.homeWidget(plugin, widget);
  return (
    <Card
      id={id}
      title={entry ? resolveLocalized(entry.name, i18n.language) : plugin}
      wide={entry?.size === "large"}
    >
      {entry ? (
        <PluginFrame pluginId={plugin} mode="homeWidget" target={widget} autoHeight />
      ) : (
        <p className="muted" role="status">
          {runtime?.loaded === false
            ? t("plugins.loading")
            : t("home.plugin.unavailable", { plugin, view: widget })}
        </p>
      )}
    </Card>
  );
}
