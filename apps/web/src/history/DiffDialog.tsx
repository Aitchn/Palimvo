import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { compareVersions, getDiff, type CommitInfo } from "../api/history.ts";
import { useAsync } from "../app/useAsync.ts";
import { Button, Dialog, Skeleton } from "../ui/index.ts";
import { parseDiff } from "./diff.ts";
import { formatWhen } from "./HistoryList.tsx";

interface Props {
  vault: string;
  /** The change to show; `null` keeps the dialog closed. */
  commit: CommitInfo | null;
  /** Limits the diff to this file (and lets the person compare with any other version of it). */
  path?: string;
  /** Other versions of the file, newest first, to compare against. */
  versions?: readonly CommitInfo[];
  onClose: () => void;
}

const PREVIOUS = "previous";

/** What one change did, or what changed between it and any other version of the file. */
export function DiffDialog({ vault, commit, path, versions = [], onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [base, setBase] = useState(PREVIOUS);
  const id = commit?.id ?? "";
  const file = path ? (commit?.path ?? path) : undefined;
  const diff = useAsync(
    async (signal) => {
      if (!id) return "";
      const options = { signal, ...(file ? { path: file } : {}) };
      return base === PREVIOUS
        ? getDiff(vault, id, options)
        : compareVersions(vault, base, id, options);
    },
    `diff:${vault}:${id}:${base}:${file ?? ""}`,
  );
  const others = versions.filter((v) => v.id !== id);
  const lines = diff.status === "ready" ? parseDiff(diff.data) : [];
  const close = () => {
    setBase(PREVIOUS);
    onClose();
  };

  return (
    <Dialog
      open={commit !== null}
      onClose={close}
      title={t("history.diffTitle", { name: file ?? commit?.subject ?? "" })}
      footer={
        <Button variant="primary" onClick={close}>
          {t("common.close")}
        </Button>
      }
    >
      {commit && (
        <div className="diff-dialog">
          <p className="muted">
            {commit.author.name} · {formatWhen(commit.date, i18n.language)}
          </p>
          {others.length > 0 && (
            <label className="field">
              {t("history.compareWith")}
              <select
                className="select"
                value={base}
                onChange={(event) => setBase(event.target.value)}
              >
                <option value={PREVIOUS}>{t("history.previousVersion")}</option>
                {others.map((v) => (
                  <option key={v.id} value={v.id}>
                    {formatWhen(v.date, i18n.language)} · {v.author.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {diff.status === "loading" && <Skeleton lines={5} />}
          {diff.status === "error" && (
            <div className="state" role="alert">
              <p>{describeError(t, diff.error)}</p>
              <Button onClick={diff.reload}>{t("common.retry")}</Button>
            </div>
          )}
          {diff.status === "ready" &&
            (lines.length === 0 ? (
              <p className="muted">{t("history.noChanges")}</p>
            ) : (
              <pre className="diff-view" tabIndex={0} aria-label={t("history.diffLabel")}>
                {lines.map((line, i) => (
                  <span key={i} className={`diff-line diff-${line.kind}`}>
                    <span className="diff-mark" aria-hidden="true">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </span>
                    {line.kind === "add" && <span className="sr-only">{t("history.added")} </span>}
                    {line.kind === "del" && (
                      <span className="sr-only">{t("history.removed")} </span>
                    )}
                    {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            ))}
        </div>
      )}
    </Dialog>
  );
}
