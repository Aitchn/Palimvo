import { useTranslation } from "react-i18next";
import type { RosterEntry } from "../api/admin.ts";
import type { CommitInfo } from "../api/history.ts";
import { Button } from "../ui/index.ts";
import { AuthorLine } from "./AuthorLine.tsx";

export function formatWhen(date: string, language: string): string {
  const when = new Date(date);
  if (Number.isNaN(when.getTime())) return date;
  return when.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
}

interface Props {
  commits: readonly CommitInfo[];
  roster: ReadonlyMap<string, RosterEntry>;
  /** Show which files each change touched (for the whole-vault list). */
  showFiles?: boolean;
  onShowChanges: (commit: CommitInfo) => void;
  /** Offered per entry when given; not offered for the newest entry of a file. */
  onRestore?: (commit: CommitInfo) => void;
  onOpenFile?: (path: string) => void;
  label: string;
}

const SHOWN_FILES = 3;

/** A timeline of changes, newest first: who, when, why, and what they touched. */
export function HistoryList({
  commits,
  roster,
  showFiles = false,
  onShowChanges,
  onRestore,
  onOpenFile,
  label,
}: Props) {
  const { t, i18n } = useTranslation();
  return (
    <ol className="history-list" aria-label={label}>
      {commits.map((commit, index) => {
        const why = commit.reasons.length > 0 ? commit.reasons : [commit.subject];
        return (
          <li key={commit.id} className="history-item" data-author-kind={commit.author.kind}>
            <div className="history-head">
              <AuthorLine author={commit.author} roster={roster} />
              <time className="muted history-time" dateTime={commit.date}>
                {formatWhen(commit.date, i18n.language)}
              </time>
            </div>
            {commit.checkpoint && (
              <span className="history-checkpoint">
                {t("history.checkpoint")}
                {commit.tags.length > 0 && `: ${commit.tags.join(", ")}`}
              </span>
            )}
            {why.map((line, i) => (
              <p key={i} className="history-reason">
                {line}
              </p>
            ))}
            {showFiles && commit.files.length > 0 && (
              <ul className="history-files" aria-label={t("history.files")}>
                {commit.files.slice(0, SHOWN_FILES).map((file) => (
                  <li key={file}>
                    {onOpenFile ? (
                      <button type="button" className="link-item" onClick={() => onOpenFile(file)}>
                        {file}
                      </button>
                    ) : (
                      file
                    )}
                  </li>
                ))}
                {commit.files.length > SHOWN_FILES && (
                  <li className="muted">
                    {t("history.moreFiles", { count: commit.files.length - SHOWN_FILES })}
                  </li>
                )}
              </ul>
            )}
            <div className="history-actions">
              <Button variant="ghost" icon="eye" onClick={() => onShowChanges(commit)}>
                {t("history.changes")}
              </Button>
              {onRestore && index > 0 && (
                <Button variant="ghost" icon="history" onClick={() => onRestore(commit)}>
                  {t("history.restore")}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
