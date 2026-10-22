import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { TreeNode } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { fileTree } from "../api/files.ts";
import { listVaults } from "../api/vaults.ts";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { Shell } from "../shell/Shell.tsx";
import { ThemeMenu } from "../theme/ThemeMenu.tsx";
import { Button, Icon, Skeleton } from "../ui/index.ts";
import { useAsync } from "./useAsync.ts";

function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="state" role="alert">
      <p>{describeError(t, error)}</p>
      <Button onClick={onRetry}>{t("common.retry")}</Button>
    </div>
  );
}

/** `/`: the vaults this server holds. */
export function HomePage() {
  const { t } = useTranslation();
  const vaults = useAsync((signal) => listVaults({ signal }), "vaults");
  return (
    <div className="page">
      <header className="page-bar">
        <span className="brand">
          <img src="/icons/palimvo.svg" alt="" width="28" height="28" />
          {t("common.appName")}
        </span>
        <ThemeMenu placement="below" />
      </header>
      <main className="page-main">
        <h1>{t("shell.vaultsTitle")}</h1>
        {vaults.status === "loading" && <Skeleton lines={3} />}
        {vaults.status === "error" && <Problem error={vaults.error} onRetry={vaults.reload} />}
        {vaults.status === "ready" &&
          (vaults.data.length === 0 ? (
            <p className="muted">{t("shell.vaultsEmpty")}</p>
          ) : (
            <ul className="vault-list">
              {vaults.data.map((vault) => (
                <li key={vault.id}>
                  <Link
                    to={`/v/${encodeURIComponent(vault.id)}`}
                    aria-label={t("shell.openVault", { name: vault.name })}
                  >
                    <Icon name="files" />
                    <span>{vault.name}</span>
                    <Icon name="chevron" />
                  </Link>
                </li>
              ))}
            </ul>
          ))}
        <div className="page-language">
          <LanguageSelect />
        </div>
      </main>
    </div>
  );
}

function TreeList({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.path}>
          <span className="tree-row">
            <Icon
              name={
                node.type === "folder"
                  ? "files"
                  : node.kind === "canvas"
                    ? "canvas"
                    : node.kind === "base"
                      ? "base"
                      : "note"
              }
            />
            <span className="tree-name">{node.name}</span>
          </span>
          {node.children && node.children.length > 0 && <TreeList nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

/** `/v/:vault`: the workspace. The tree is read-only here; editing and file operations come with the files and editor tasks. */
export function VaultPage() {
  const { t } = useTranslation();
  const { vault = "" } = useParams();
  const tree = useAsync((signal) => fileTree(vault, { signal }), `tree:${vault}`);
  return (
    <Shell
      sidebar={
        <>
          <div className="sidebar-header">
            <Link to="/" className="sidebar-vault" title={t("nav.vaults")}>
              {vault}
            </Link>
          </div>
          <div className="sidebar-body">
            {tree.status === "loading" && <Skeleton lines={5} />}
            {tree.status === "error" && <Problem error={tree.error} onRetry={tree.reload} />}
            {tree.status === "ready" && <TreeList nodes={tree.data} />}
          </div>
        </>
      }
      inspector={
        <div className="state">
          <p className="muted">{t("shell.inspectorEmpty")}</p>
        </div>
      }
    >
      <div className="state">
        <Icon name="note" />
        <h1>{t("shell.noFileTitle")}</h1>
        <p className="muted">{t("shell.noFileBody")}</p>
      </div>
    </Shell>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="page">
      <main className="page-main state">
        <h1>{t("shell.notFoundTitle")}</h1>
        <p className="muted">{t("shell.notFoundBody")}</p>
        <Link className="btn btn-primary" to="/">
          {t("shell.backHome")}
        </Link>
      </main>
    </div>
  );
}
