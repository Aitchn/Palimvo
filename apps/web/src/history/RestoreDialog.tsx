import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import type { CommitInfo } from "../api/history.ts";
import { Button, Dialog } from "../ui/index.ts";
import { formatWhen } from "./HistoryList.tsx";

interface Props {
  commit: CommitInfo | null;
  path: string;
  onClose: () => void;
  /** Throw to keep the dialog open and show the error. */
  onConfirm: (commit: CommitInfo) => Promise<void>;
}

/** "Put this version back?" The current text is not lost: it stays in the history. */
export function RestoreDialog({ commit, path, onClose, onConfirm }: Props) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setProblem(null);
  }, [commit?.id]);

  const confirm = async () => {
    if (!commit) return;
    setBusy(true);
    try {
      await onConfirm(commit);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={commit !== null}
      onClose={onClose}
      title={t("history.restoreTitle", { name: path })}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void confirm()}>
            {t("history.restoreConfirm")}
          </Button>
        </>
      }
    >
      {commit && (
        <p>
          {t("history.restoreBody", {
            author: commit.author.name,
            when: formatWhen(commit.date, i18n.language),
          })}
        </p>
      )}
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
