import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACTIVITY_FILTERS, type ActivityFilter } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { getActivity, type Activity } from "../api/home.ts";
import type { CommitInfo } from "../api/history.ts";
import { useAsync } from "../app/useAsync.ts";
import { DiffDialog } from "../history/DiffDialog.tsx";
import { AuthorLine } from "../history/AuthorLine.tsx";
import { formatWhen } from "../history/HistoryList.tsx";
import { useRoster } from "../roles/RoleBadge.tsx";
import { Button, Skeleton } from "../ui/index.ts";

/** How many changes of one author are listed before "show all". */
const PER_AUTHOR = 3;
const DEFAULT_LIMIT = 30;

interface Props {
  vault: string;
  limit?: number | undefined;
  /** Changes when the vault's files changed, so the wall is fetched again. */
  revision: number;
  onOpenFile: (path: string) => void;
}

const authorKey = (c: CommitInfo): string => `${c.author.kind}:${c.author.id}`;

/** Recent changes, grouped by who made them. People and AIs can be told apart at a glance and filtered. */
export function ActivityWidget({ vault, limit = DEFAULT_LIMIT, revision, onOpenFile }: Props) {
  const { t, i18n } = useTranslation();
  const roster = useRoster(vault);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<CommitInfo | null>(null);
  const wall = useAsync(
    (signal) => getActivity(vault, { filter, limit, signal }),
    `activity:${vault}:${filter}:${limit}:${revision}`,
  );

  return (
    <>
      <div className="home-filter" role="group" aria-label={t("home.activity.filterLabel")}>
        {ACTIVITY_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            className="home-chip"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {t(`home.activity.filter.${id}`)}
            {wall.status === "ready" && <span className="muted"> {countFor(wall.data, id)}</span>}
          </button>
        ))}
      </div>
      {wall.status === "loading" && <Skeleton lines={4} />}
      {wall.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, wall.error)}</p>
          <Button onClick={wall.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {wall.status === "ready" && (
        <Groups
          data={wall.data}
          language={i18n.language}
          roster={roster}
          expanded={expanded}
          onToggle={(key) =>
            setExpanded((now) => {
              const next = new Set(now);
              if (!next.delete(key)) next.add(key);
              return next;
            })
          }
          onShow={setShown}
          onOpenFile={onOpenFile}
        />
      )}
      <DiffDialog vault={vault} commit={shown} onClose={() => setShown(null)} />
    </>
  );
}

function countFor(data: Activity, filter: ActivityFilter): number {
  return data.authors
    .filter(
      ({ author }) =>
        filter === "all" ||
        (filter === "human"
          ? author.kind === "human"
          : author.kind === "ai" || author.kind === "plugin"),
    )
    .reduce((n, a) => n + a.count, 0);
}

function Groups({
  data,
  language,
  roster,
  expanded,
  onToggle,
  onShow,
  onOpenFile,
}: {
  data: Activity;
  language: string;
  roster: ReturnType<typeof useRoster>;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onShow: (commit: CommitInfo) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  // Authors with the most recent change first; entries are already newest first.
  const groups = useMemo(() => {
    const byKey = new Map<string, CommitInfo[]>();
    for (const entry of data.entries) {
      const list = byKey.get(authorKey(entry)) ?? [];
      list.push(entry);
      byKey.set(authorKey(entry), list);
    }
    return [...byKey.values()];
  }, [data.entries]);

  if (groups.length === 0) return <p className="muted">{t("home.activity.empty")}</p>;
  return (
    <ul className="activity-groups">
      {groups.map((entries) => {
        const first = entries[0]!;
        const key = authorKey(first);
        const open = expanded.has(key);
        const visible = open ? entries : entries.slice(0, PER_AUTHOR);
        return (
          <li key={key} className="activity-group" data-author-kind={first.author.kind}>
            <div className="activity-author">
              <AuthorLine author={first.author} roster={roster} />
              <span className="muted">{t("home.activity.changes", { count: entries.length })}</span>
            </div>
            <ol
              className="activity-entries"
              aria-label={t("home.activity.entriesOf", { name: first.author.name })}
            >
              {visible.map((entry) => (
                <li key={entry.id} className="activity-entry">
                  <p className="activity-reason">
                    {entry.checkpoint && (
                      <span className="history-checkpoint">{t("history.checkpoint")}</span>
                    )}{" "}
                    {entry.reasons[0] ?? entry.subject}
                  </p>
                  {entry.approvedBy.length > 0 && (
                    <p className="muted activity-approved">
                      {t("history.approvedBy", {
                        names: entry.approvedBy.map((a) => a.name).join(", "),
                      })}
                    </p>
                  )}
                  <div className="activity-meta">
                    <time className="muted" dateTime={entry.date}>
                      {formatWhen(entry.date, language)}
                    </time>
                    {entry.files.slice(0, 2).map((file) => (
                      <button
                        key={file}
                        type="button"
                        className="link-item"
                        onClick={() => onOpenFile(file)}
                      >
                        {file}
                      </button>
                    ))}
                    {entry.files.length > 2 && (
                      <span className="muted">
                        {t("history.moreFiles", { count: entry.files.length - 2 })}
                      </span>
                    )}
                    <Button variant="ghost" icon="eye" onClick={() => onShow(entry)}>
                      {t("history.changes")}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            {entries.length > PER_AUTHOR && (
              <Button variant="ghost" aria-expanded={open} onClick={() => onToggle(key)}>
                {open
                  ? t("home.activity.showFewer")
                  : t("home.activity.showAll", { count: entries.length })}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
