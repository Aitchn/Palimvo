import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RosterEntry } from "../api/admin.ts";
import { describeError } from "../api/errors.ts";
import {
  decideProposal,
  getProposal,
  type Proposal,
  type ProposalFile,
  type ProposalHunk,
} from "../api/proposals.ts";
import { useAsync } from "../app/useAsync.ts";
import { AuthorLine } from "../history/AuthorLine.tsx";
import { formatWhen } from "../history/HistoryList.tsx";
import { Button, Dialog, Skeleton, useToast } from "../ui/index.ts";
import { hunkDisplay } from "./lines.ts";

interface Props {
  vault: string;
  /** The proposal to show; `null` keeps the dialog closed. */
  proposalId: string | null;
  roster: ReadonlyMap<string, RosterEntry>;
  canReview: boolean;
  onClose: () => void;
  /** A decision was made. */
  onChanged: () => void;
  onOpenFile: (path: string) => void;
}

/** One proposal in full: its reasons, every change in place, and accept / reject for the ones chosen. */
export function ProposalDialog({
  vault,
  proposalId,
  roster,
  canReview,
  onClose,
  onChanged,
  onOpenFile,
}: Props) {
  const { t } = useTranslation();
  const loaded = useAsync(
    async (signal) => (proposalId ? getProposal(vault, proposalId, { signal }) : null),
    `proposal:${vault}:${proposalId ?? ""}`,
  );
  // A decision answers with the proposal as it now stands.
  const [latest, setLatest] = useState<Proposal | null>(null);
  useEffect(() => setLatest(null), [proposalId]);
  const proposal = latest ?? (loaded.status === "ready" ? loaded.data : null);

  return (
    <Dialog
      open={proposalId !== null}
      onClose={onClose}
      title={proposal?.title ?? t("proposals.title")}
      footer={
        proposal ? undefined : (
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        )
      }
    >
      {proposalId !== null && loaded.status === "loading" && !latest && <Skeleton lines={6} />}
      {proposalId !== null && loaded.status === "error" && !latest && (
        <div className="state" role="alert">
          <p>{describeError(t, loaded.error)}</p>
          <Button onClick={loaded.reload}>{t("common.retry")}</Button>
        </div>
      )}
      {proposal && (
        <ProposalBody
          key={`${proposal.id}:${proposal.version}`}
          vault={vault}
          proposal={proposal}
          roster={roster}
          canReview={canReview}
          onClose={onClose}
          onDecided={(next) => {
            setLatest(next);
            onChanged();
          }}
          onOpenFile={onOpenFile}
        />
      )}
    </Dialog>
  );
}

interface BodyProps {
  vault: string;
  proposal: Proposal;
  roster: ReadonlyMap<string, RosterEntry>;
  canReview: boolean;
  onClose: () => void;
  onDecided: (proposal: Proposal) => void;
  onOpenFile: (path: string) => void;
}

function ProposalBody({
  vault,
  proposal,
  roster,
  canReview,
  onClose,
  onDecided,
  onOpenFile,
}: BodyProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pending = useMemo(
    () => proposal.files.flatMap((f) => f.hunks.filter((h) => h.state === "pending")),
    [proposal],
  );
  const fileOf = useMemo(() => {
    const map = new Map<string, ProposalFile>();
    for (const f of proposal.files) for (const h of f.hunks) map.set(h.id, f);
    return map;
  }, [proposal]);
  // A change can only be accepted while its file is as it was when the change was written.
  const blocked = [...picked].some((id) => fileOf.get(id)?.status !== "current");

  const toggle = (ids: readonly string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  };

  const decide = async (action: "accept" | "reject", ids: readonly string[]) => {
    setBusy(action);
    setProblem(null);
    try {
      const next = await decideProposal(vault, proposal, action, ids);
      toast.push({
        message: t(action === "accept" ? "proposals.accepted" : "proposals.rejected", {
          count: ids.length,
        }),
        kind: "success",
      });
      onDecided(next);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(null);
    }
  };

  const chosen = [...picked].filter((id) => pending.some((h) => h.id === id));

  return (
    <div className="proposal-detail">
      <div className="proposal-byline">
        <AuthorLine author={proposal.proposedBy} roster={roster} />
        <time className="muted" dateTime={proposal.createdAt}>
          {formatWhen(proposal.createdAt, i18n.language)}
        </time>
        <span className={`proposal-state proposal-state-${proposal.state}`}>
          {t(`proposals.state.${proposal.state}`)}
        </span>
      </div>
      {proposal.rationale && <p className="proposal-rationale">{proposal.rationale}</p>}
      {proposal.sources.length > 0 && (
        <p className="muted">
          {t("proposals.sources")}:{" "}
          {proposal.sources.map((s, i) => (
            <span key={`${s.path}:${i}`}>
              {i > 0 && ", "}
              <button type="button" className="link-item" onClick={() => onOpenFile(s.path)}>
                {s.label ?? s.path}
              </button>
            </span>
          ))}
        </p>
      )}
      {proposal.stale && (
        <p className="proposal-warning" role="status">
          {t("proposals.staleHelp")}
        </p>
      )}
      {!canReview && pending.length > 0 && <p className="muted">{t("proposals.viewOnly")}</p>}

      {proposal.files.map((file) => (
        <section key={file.path} className="proposal-file" aria-label={file.path}>
          <header className="proposal-file-head">
            <button type="button" className="link-item" onClick={() => onOpenFile(file.path)}>
              {file.path}
            </button>
            {file.status !== "current" && (
              <span className="proposal-state proposal-state-stale">
                {t(file.status === "missing" ? "proposals.fileMissing" : "proposals.fileChanged")}
              </span>
            )}
            {canReview && file.hunks.filter((h) => h.state === "pending").length > 1 && (
              <label className="proposal-all">
                <input
                  type="checkbox"
                  checked={file.hunks
                    .filter((h) => h.state === "pending")
                    .every((h) => picked.has(h.id))}
                  onChange={(event) =>
                    toggle(
                      file.hunks.filter((h) => h.state === "pending").map((h) => h.id),
                      event.target.checked,
                    )
                  }
                />
                {t("proposals.selectFile")}
              </label>
            )}
          </header>
          {file.hunks.map((hunk, index) => (
            <HunkView
              key={hunk.id}
              hunk={hunk}
              label={t("proposals.hunkLabel", { path: file.path, n: index + 1 })}
              selectable={canReview && hunk.state === "pending"}
              picked={picked.has(hunk.id)}
              onPick={(on) => toggle([hunk.id], on)}
            />
          ))}
        </section>
      ))}

      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <div className="proposal-actions">
        <Button variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
        <span className="toolbar-spacer" />
        {canReview && pending.length > 0 && (
          <>
            <Button
              variant="secondary"
              disabled={busy !== null || chosen.length === 0}
              loading={busy === "reject"}
              onClick={() => void decide("reject", chosen)}
            >
              {t("proposals.rejectSelected", { count: chosen.length })}
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={busy !== null || chosen.length === 0 || blocked}
              loading={busy === "accept"}
              onClick={() => void decide("accept", chosen)}
            >
              {t("proposals.acceptSelected", { count: chosen.length })}
            </Button>
          </>
        )}
      </div>
      {canReview && pending.length > 0 && (
        <div className="proposal-bulk">
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              setPicked(
                new Set(
                  pending.filter((h) => fileOf.get(h.id)?.status === "current").map((h) => h.id),
                ),
              )
            }
          >
            {t("proposals.selectAll")}
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setPicked(new Set())}>
            {t("proposals.selectNone")}
          </Button>
          {blocked && <span className="muted">{t("proposals.blockedHelp")}</span>}
        </div>
      )}
    </div>
  );
}

function HunkView({
  hunk,
  label,
  selectable,
  picked,
  onPick,
}: {
  hunk: ProposalHunk;
  label: string;
  selectable: boolean;
  picked: boolean;
  onPick: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const shown = hunkDisplay(hunk);
  return (
    <div className={`proposal-hunk proposal-hunk-${hunk.state}`}>
      <div className="proposal-hunk-head">
        {selectable ? (
          <label className="proposal-pick">
            <input
              type="checkbox"
              checked={picked}
              aria-label={label}
              onChange={(event) => onPick(event.target.checked)}
            />
            <span>{hunk.rationale || t("proposals.change")}</span>
          </label>
        ) : (
          <span className="proposal-pick">{hunk.rationale || t("proposals.change")}</span>
        )}
        {hunk.state !== "pending" && (
          <span className={`proposal-state proposal-state-${hunk.state}`}>
            {t(`proposals.hunk.${hunk.state}`)}
            {hunk.reviewedBy && ` · ${hunk.reviewedBy.name}`}
          </span>
        )}
      </div>
      <pre className="diff-view proposal-diff" tabIndex={0} aria-label={label}>
        {shown.map((line, i) => (
          <span key={i} className={`diff-line diff-${line.kind}`}>
            <span className="diff-mark" aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            {line.kind === "add" && <span className="sr-only">{t("history.added")} </span>}
            {line.kind === "del" && <span className="sr-only">{t("history.removed")} </span>}
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
