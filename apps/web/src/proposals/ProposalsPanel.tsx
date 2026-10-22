import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import type { ProposalSummary } from "../api/proposals.ts";
import type { AsyncState } from "../app/useAsync.ts";
import { AuthorLine } from "../history/AuthorLine.tsx";
import { formatWhen } from "../history/HistoryList.tsx";
import { useRoster } from "../roles/RoleBadge.tsx";
import { Button, Skeleton } from "../ui/index.ts";
import { ProposalDialog } from "./ProposalDialog.tsx";

interface Props {
  vault: string;
  proposals: AsyncState<ProposalSummary[]> & { reload: () => void };
  /** Whether finished proposals are listed too. */
  showAll: boolean;
  onShowAll: (all: boolean) => void;
  /** Whether the person may accept and reject. */
  canReview: boolean;
  /** Called after notes were changed by an accepted proposal. */
  onChanged: () => void;
  onOpenFile: (path: string) => void;
}

/** The sidebar's Proposals view: changes that AIs (or people who may not write) suggested, waiting for a decision. */
export function ProposalsPanel({
  vault,
  proposals,
  showAll,
  onShowAll,
  canReview,
  onChanged,
  onOpenFile,
}: Props) {
  const { t, i18n } = useTranslation();
  const roster = useRoster(vault);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="sidebar-body proposals-panel">
      <div className="sidebar-toolbar">
        <label className="proposal-filter">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => onShowAll(event.target.checked)}
          />
          {t("proposals.showAll")}
        </label>
        <span className="toolbar-spacer" />
        <Button
          variant="ghost"
          icon="history"
          aria-label={t("proposals.refresh")}
          title={t("proposals.refresh")}
          onClick={proposals.reload}
        />
      </div>
      {proposals.status === "loading" && <Skeleton lines={4} />}
      {proposals.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, proposals.error)}</p>
          <Button onClick={proposals.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {proposals.status === "ready" &&
        (proposals.data.length === 0 ? (
          <p className="muted proposals-empty">
            {showAll ? t("proposals.noneAtAll") : t("proposals.none")}
          </p>
        ) : (
          <ul className="proposal-list" aria-label={t("proposals.listLabel")}>
            {proposals.data.map((p) => {
              const pending = p.files.reduce((n, f) => n + f.pending, 0);
              return (
                <li key={p.id} className="proposal-card" data-state={p.state}>
                  <button
                    type="button"
                    className="proposal-open"
                    onClick={() => setOpenId(p.id)}
                    aria-label={t("proposals.open", { title: p.title })}
                  >
                    <span className="proposal-title">{p.title}</span>
                  </button>
                  <div className="proposal-meta">
                    <AuthorLine author={p.proposedBy} roster={roster} />
                    <time className="muted" dateTime={p.updatedAt}>
                      {formatWhen(p.updatedAt, i18n.language)}
                    </time>
                  </div>
                  <div className="proposal-badges">
                    <span className={`proposal-state proposal-state-${p.state}`}>
                      {t(`proposals.state.${p.state}`)}
                    </span>
                    {pending > 0 && (
                      <span className="muted">
                        {t("proposals.changesWaiting", { count: pending })}
                      </span>
                    )}
                    {p.stale && (
                      <span className="proposal-state proposal-state-stale">
                        {t("proposals.stale")}
                      </span>
                    )}
                  </div>
                  <p className="muted proposal-files">
                    {p.files
                      .slice(0, 3)
                      .map((f) => f.path)
                      .join(", ")}
                    {p.files.length > 3 &&
                      ` ${t("history.moreFiles", { count: p.files.length - 3 })}`}
                  </p>
                </li>
              );
            })}
          </ul>
        ))}
      <ProposalDialog
        vault={vault}
        proposalId={openId}
        roster={roster}
        canReview={canReview}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          proposals.reload();
          onChanged();
        }}
        onOpenFile={(path) => {
          setOpenId(null);
          onOpenFile(path);
        }}
      />
    </div>
  );
}
