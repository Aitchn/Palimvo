import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { createCheckpoint, listCheckpoints, listHistory, type CommitInfo } from "../api/history.ts";
import { useAsync } from "../app/useAsync.ts";
import { useRoster } from "../roles/RoleBadge.tsx";
import { Button, Dialog, Skeleton, useToast } from "../ui/index.ts";
import { DiffDialog } from "./DiffDialog.tsx";
import { formatWhen, HistoryList } from "./HistoryList.tsx";

const PAGE = 50;

interface Props {
  vault: string;
  revision: number;
  /** Whether the person may save a checkpoint. */
  canCheckpoint: boolean;
  onOpenFile: (path: string) => void;
}

/** The vault's change log and its checkpoints (the sidebar's History view). */
export function ChangeLog({ vault, revision, canCheckpoint, onOpenFile }: Props) {
  const { t, i18n } = useTranslation();
  const roster = useRoster(vault);
  const [limit, setLimit] = useState(PAGE);
  const [shown, setShown] = useState<CommitInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const history = useAsync(
    (signal) => listHistory(vault, { limit, signal }),
    `changes:${vault}:${limit}:${revision}`,
  );
  const checkpoints = useAsync((signal) => listCheckpoints(vault, { signal }), `cp:${vault}`);

  const refresh = () => {
    history.reload();
    checkpoints.reload();
  };

  return (
    <div className="sidebar-body change-log">
      {canCheckpoint && (
        <div className="sidebar-toolbar">
          <Button variant="secondary" icon="add" onClick={() => setSaving(true)}>
            {t("history.saveCheckpoint")}
          </Button>
          <span className="toolbar-spacer" />
          <Button
            variant="ghost"
            icon="history"
            aria-label={t("history.refresh")}
            title={t("history.refresh")}
            onClick={refresh}
          />
        </div>
      )}
      {checkpoints.status === "ready" && checkpoints.data.length > 0 && (
        <section className="link-panel" aria-label={t("history.checkpoints")}>
          <h2 className="link-heading">{t("history.checkpoints")}</h2>
          <ul className="history-files">
            {checkpoints.data.map((cp) => (
              <li key={cp.name}>
                <strong>{cp.name}</strong> <span className="muted">{cp.message}</span>
                <br />
                <time className="muted" dateTime={cp.date}>
                  {formatWhen(cp.date, i18n.language)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="link-panel" aria-label={t("history.vaultTitle")}>
        <h2 className="link-heading">{t("history.vaultTitle")}</h2>
        {history.status === "loading" && <Skeleton lines={5} />}
        {history.status === "error" && (
          <div className="state" role="alert">
            <p>{describeError(t, history.error)}</p>
            <Button onClick={history.reload}>{t("common.retry")}</Button>
          </div>
        )}
        {history.status === "ready" && (
          <>
            <HistoryList
              label={t("history.vaultLabel")}
              commits={history.data}
              roster={roster}
              showFiles
              onShowChanges={setShown}
              onOpenFile={onOpenFile}
            />
            {history.data.length >= limit && (
              <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>
                {t("search.more")}
              </Button>
            )}
          </>
        )}
      </section>
      <DiffDialog vault={vault} commit={shown} onClose={() => setShown(null)} />
      <CheckpointDialog
        open={saving}
        vault={vault}
        onClose={() => setSaving(false)}
        onSaved={() => {
          setSaving(false);
          refresh();
        }}
      />
    </div>
  );
}

function CheckpointDialog({
  open,
  vault,
  onClose,
  onSaved,
}: {
  open: boolean;
  vault: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setMessage("");
    setTag("");
    setBusy(false);
    setProblem(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) {
      setProblem(t("history.checkpointNameEmpty"));
      return;
    }
    setBusy(true);
    try {
      await createCheckpoint(vault, message.trim(), tag.trim() || undefined);
      toast.push({ message: t("history.checkpointSaved"), kind: "success" });
      onSaved();
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("history.saveCheckpoint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="checkpoint-form" loading={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="checkpoint-form" className="form" onSubmit={submit} noValidate>
        <p className="muted">{t("history.checkpointHint")}</p>
        <label className="field">
          {t("history.checkpointMessage")}
          <input
            ref={first}
            data-autofocus
            className="input"
            value={message}
            autoComplete="off"
            onChange={(event) => {
              setMessage(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        <label className="field">
          {t("history.checkpointTag")}
          <input
            className="input"
            value={tag}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setTag(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
}
