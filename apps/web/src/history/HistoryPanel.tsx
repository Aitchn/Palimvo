import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { listHistory, restoreVersion, type CommitInfo } from "../api/history.ts";
import { useAsync } from "../app/useAsync.ts";
import { useRoster } from "../roles/RoleBadge.tsx";
import { Button, Skeleton, useToast } from "../ui/index.ts";
import { DiffDialog } from "./DiffDialog.tsx";
import { HistoryList } from "./HistoryList.tsx";
import { RestoreDialog } from "./RestoreDialog.tsx";

interface Props {
  vault: string;
  path: string;
  /** Changes when the vault's files changed, so the list is fetched again. */
  revision: number;
  /** Whether the person may put an earlier version back. */
  canRestore: boolean;
}

/** Every version of the open file: who changed it, why, what changed, and a way back. */
export function HistoryPanel({ vault, path, revision, canRestore }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const roster = useRoster(vault);
  const [shown, setShown] = useState<CommitInfo | null>(null);
  const [restoring, setRestoring] = useState<CommitInfo | null>(null);
  const history = useAsync(
    (signal) => listHistory(vault, { path, signal }),
    `history:${vault}:${path}:${revision}`,
  );

  const restore = async (commit: CommitInfo) => {
    await restoreVersion(vault, path, commit.id, commit.path);
    setRestoring(null);
    toast.push({ message: t("history.restored"), kind: "success" });
    history.reload();
  };

  return (
    <section className="link-panel history-panel" aria-label={t("history.title")}>
      <h2 className="link-heading">{t("history.title")}</h2>
      {history.status === "loading" && <Skeleton lines={4} />}
      {history.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, history.error)}</p>
          <Button onClick={history.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {history.status === "ready" &&
        (history.data.length === 0 ? (
          <p className="muted">{t("history.none")}</p>
        ) : (
          <>
            <HistoryList
              label={t("history.fileLabel", { name: path })}
              commits={history.data}
              roster={roster}
              onShowChanges={setShown}
              {...(canRestore ? { onRestore: setRestoring } : {})}
            />
            <Button variant="ghost" icon="history" onClick={history.reload}>
              {t("history.refresh")}
            </Button>
          </>
        ))}
      <DiffDialog
        vault={vault}
        commit={shown}
        path={path}
        versions={history.status === "ready" ? history.data : []}
        onClose={() => setShown(null)}
      />
      <RestoreDialog
        commit={restoring}
        path={path}
        onClose={() => setRestoring(null)}
        onConfirm={restore}
      />
    </section>
  );
}
