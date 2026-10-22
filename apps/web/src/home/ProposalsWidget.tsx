import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { listProposals } from "../api/proposals.ts";
import { useAsync } from "../app/useAsync.ts";
import { AuthorLine } from "../history/AuthorLine.tsx";
import { formatWhen } from "../history/HistoryList.tsx";
import { ProposalDialog } from "../proposals/ProposalDialog.tsx";
import { useRoster } from "../roles/RoleBadge.tsx";
import { Button, Skeleton } from "../ui/index.ts";

const SHOWN = 5;

interface Props {
  vault: string;
  canReview: boolean;
  revision: number;
  /** Called after an accepted proposal changed notes. */
  onChanged: () => void;
  onOpenFile: (path: string) => void;
  /** Opens the sidebar's full list. */
  onShowAll: () => void;
}

/** Edit proposals that still wait for a decision, newest first. */
export function ProposalsWidget({
  vault,
  canReview,
  revision,
  onChanged,
  onOpenFile,
  onShowAll,
}: Props) {
  const { t, i18n } = useTranslation();
  const roster = useRoster(vault);
  const [openId, setOpenId] = useState<string | null>(null);
  const proposals = useAsync(
    (signal) => listProposals(vault, { signal }),
    `home-proposals:${vault}:${revision}`,
  );
  const waiting =
    proposals.status === "ready"
      ? proposals.data.filter((p) => p.state === "pending" || p.state === "partial")
      : [];

  return (
    <>
      {proposals.status === "loading" && <Skeleton lines={3} />}
      {proposals.status === "error" && (
        <div className="state" role="alert">
          <p>{describeError(t, proposals.error)}</p>
          <Button onClick={proposals.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {proposals.status === "ready" &&
        (waiting.length === 0 ? (
          <p className="muted">{t("proposals.none")}</p>
        ) : (
          <>
            <ul className="proposal-list home-proposals" aria-label={t("proposals.listLabel")}>
              {waiting.slice(0, SHOWN).map((p) => {
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
                      <span className="muted">
                        {t("proposals.changesWaiting", { count: pending })}
                      </span>
                      {p.stale && (
                        <span className="proposal-state proposal-state-stale">
                          {t("proposals.stale")}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {waiting.length > SHOWN && (
              <Button variant="ghost" onClick={onShowAll}>
                {t("home.proposals.more", { count: waiting.length - SHOWN })}
              </Button>
            )}
          </>
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
    </>
  );
}
