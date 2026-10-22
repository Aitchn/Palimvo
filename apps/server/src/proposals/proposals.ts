import { randomUUID } from "node:crypto";
import {
  AppError,
  createMigrator,
  fileKind,
  normalizeVaultPath,
  parseBase,
  parseCanvas,
  type Author,
} from "@palimvo/core";
import { z } from "zod";
import type { ChangeRecorder } from "../history/history.ts";
import { contentVersion } from "../vault/fsutil.ts";
import { KeyedMutex } from "../vault/mutex.ts";
import type { BatchWrite, VaultService } from "../vault/service.ts";

/** Where a vault keeps its proposals: one JSON file each, outside the version history. */
const FOLDER = "proposals";
const MAX_PROPOSAL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_HUNKS = 200;
const MAX_LISTED = 1000;
/** How much of the base text around a hunk is kept so a reviewer sees it in place. */
const CONTEXT_CHARS = 240;

const sourceSchema = z.object({
  path: z.string().min(1).max(500),
  label: z.string().max(200).optional(),
});

const hunkSchema = z.object({
  /** Character offsets (UTF-16) in the base text. Leave both out to locate `before` instead. */
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  before: z.string().max(1_000_000),
  after: z.string().max(1_000_000),
  rationale: z.string().max(10_000).default(""),
});

export const proposalInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  rationale: z.string().max(10_000).default(""),
  sources: z.array(sourceSchema).max(100).default([]),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        /** The version of the file the change was written against; `null`: the file does not exist yet. */
        baseRevision: z
          .string()
          .regex(/^[a-f0-9]{16}$/)
          .nullable(),
        hunks: z.array(hunkSchema).min(1).max(MAX_HUNKS),
      }),
    )
    .min(1)
    .max(MAX_FILES),
});
export type ProposalInput = z.output<typeof proposalInputSchema>;

export const proposalReviewSchema = z.object({
  /** The proposal version the reviewer saw; a changed proposal must be looked at again. */
  version: z.number().int().min(1),
  /** The hunks to decide on; leave out for every hunk still waiting. */
  hunkIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
});
export type ProposalReview = z.infer<typeof proposalReviewSchema>;

export type HunkState = "pending" | "accepted" | "rejected";
export type ProposalState = "pending" | "partial" | "accepted" | "rejected" | "resolved";

export interface ProposalHunk {
  id: string;
  start: number;
  end: number;
  before: string;
  after: string;
  rationale: string;
  /** Some of the text just before and after, as it was when the change was proposed. */
  contextBefore: string;
  contextAfter: string;
  state: HunkState;
  reviewedBy?: Author;
  reviewedAt?: string;
}

export interface ProposalFile {
  path: string;
  baseRevision: string | null;
  hunks: ProposalHunk[];
}

/** An accept that was started: kept until the files are known to be written, so a crash can be sorted out. */
interface Applying {
  reviewer: Author;
  files: { path: string; hunkIds: string[]; resultVersion: string }[];
}

export interface Proposal {
  schemaVersion: 1;
  id: string;
  /** Goes up with every review, so two reviewers cannot decide on a stale view. */
  version: number;
  title: string;
  rationale: string;
  sources: z.infer<typeof sourceSchema>[];
  files: ProposalFile[];
  proposedBy: Author;
  createdAt: string;
  updatedAt: string;
  state: ProposalState;
  applying?: Applying;
}

export type FileStatus = "current" | "stale" | "missing";

/** A proposal as clients see it: with whether each file still matches what it was written against. */
export interface ProposalView extends Omit<Proposal, "applying" | "files"> {
  /** True when a file with changes still waiting has changed since. */
  stale: boolean;
  files: (ProposalFile & { status: FileStatus })[];
}

export interface ProposalSummary {
  id: string;
  version: number;
  title: string;
  rationale: string;
  state: ProposalState;
  stale: boolean;
  proposedBy: Author;
  createdAt: string;
  updatedAt: string;
  files: {
    path: string;
    status: FileStatus;
    pending: number;
    accepted: number;
    rejected: number;
  }[];
}

const migrate = createMigrator({ current: 1, migrations: [] });

const safeId = (id: string): string => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError("not_found");
  return id;
};
const recordName = (id: string): string => `${FOLDER}/${safeId(id)}.json`;

/** Notes, canvases and bases only: they are the files whose text can be proposed and re-checked. */
function proposable(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (fileKind(normalized) === "other") {
    throw new AppError("unsupported_type", undefined, { path: normalized });
  }
  return normalized;
}

/** Canvases and bases must still parse after a change, or the file would be broken for everyone. */
function checkText(path: string, content: string): void {
  try {
    const kind = fileKind(path);
    if (kind === "canvas") parseCanvas(content);
    else if (kind === "base") parseBase(content);
  } catch (cause) {
    throw new AppError("invalid_request", undefined, {
      path,
      reason: "the change would leave the file unreadable",
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function applyHunks(content: string, hunks: readonly ProposalHunk[]): string {
  let result = content;
  for (const h of [...hunks].sort((a, b) => b.start - a.start)) {
    if (result.slice(h.start, h.end) !== h.before) throw new AppError("proposal_stale");
    result = result.slice(0, h.start) + h.after + result.slice(h.end);
  }
  return result;
}

function stateOf(files: readonly ProposalFile[]): ProposalState {
  const states = new Set(files.flatMap((f) => f.hunks.map((h) => h.state)));
  if (states.has("pending")) return states.size > 1 ? "partial" : "pending";
  if (states.size > 1) return "resolved";
  return states.has("accepted") ? "accepted" : "rejected";
}

/** Fills in where each hunk sits in `content` and checks that they fit and do not overlap. */
function resolveHunks(
  path: string,
  content: string,
  inputs: z.infer<typeof hunkSchema>[],
): ProposalHunk[] {
  const bad = (reason: string): AppError =>
    new AppError("invalid_request", undefined, { path, reason });
  const hunks = inputs.map((h): ProposalHunk => {
    let { start, end } = h;
    if (start === undefined && end === undefined) {
      if (h.before === "") {
        // Only an empty file can be filled without saying where.
        if (content !== "")
          throw bad("say where to insert: give start and end, or text to replace");
        start = end = 0;
      } else {
        const at = content.indexOf(h.before);
        if (at < 0) throw bad("the text to replace is not in the file");
        if (content.indexOf(h.before, at + 1) >= 0) {
          throw bad("the text to replace appears more than once; include more of it");
        }
        start = at;
        end = at + h.before.length;
      }
    } else if (start === undefined || end === undefined) {
      throw bad("give both start and end, or neither");
    }
    if (end < start || end > content.length || content.slice(start, end) !== h.before) {
      throw bad("the text to replace is not where the offsets say");
    }
    if (h.before === h.after) throw bad("a change must differ from the text it replaces");
    return {
      id: randomUUID(),
      start,
      end,
      before: h.before,
      after: h.after,
      rationale: h.rationale,
      contextBefore: content.slice(Math.max(0, start - CONTEXT_CHARS), start),
      contextAfter: content.slice(end, end + CONTEXT_CHARS),
      state: "pending",
    };
  });
  hunks.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < hunks.length; i++) {
    // Two changes at the same offset (insertions, or an insertion and a replacement) would apply
    // in a different order depending on which is accepted first.
    if (hunks[i]!.start < hunks[i - 1]!.end || hunks[i]!.start === hunks[i - 1]!.start) {
      throw bad("changes must not overlap");
    }
  }
  return hunks;
}

export interface ProposalServiceOptions {
  vaults: Pick<VaultService, "readFile" | "writeBatch" | "readMeta" | "writeMeta" | "listMeta">;
  history: ChangeRecorder;
}

/**
 * Edit proposals: an AI that may only propose (or anyone without the right to write) describes
 * changes to notes, and a reviewer accepts or rejects them hunk by hunk. Accepting writes every
 * chosen hunk of every file as one batch that is checked against the versions the proposal was
 * written for; the history credits whoever proposed and records who accepted.
 */
export class ProposalService {
  private readonly locks = new KeyedMutex();
  private readonly vaults: ProposalServiceOptions["vaults"];
  private readonly history: ChangeRecorder;

  constructor(options: ProposalServiceOptions) {
    this.vaults = options.vaults;
    this.history = options.history;
  }

  /** Newest first. `open` leaves out proposals with nothing left to decide. */
  async list(vault: string, options: { open?: boolean } = {}): Promise<ProposalSummary[]> {
    const names = (await this.vaults.listMeta(vault, FOLDER))
      .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n));
    const out: ProposalSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const proposal = await this.settled(vault, id).catch((err: unknown) => {
        // A record from a newer version, or a damaged one, must not hide the others.
        if (
          err instanceof AppError &&
          ["not_found", "schema_too_new", "schema_invalid"].includes(err.code)
        )
          return null;
        throw err;
      });
      if (!proposal) continue;
      if (options.open && !["pending", "partial"].includes(proposal.state)) continue;
      out.push(await this.summary(vault, proposal));
    }
    // Newest first, then cut: file names are random, so the cut must come after the ordering.
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_LISTED);
  }

  async get(vault: string, id: string): Promise<ProposalView> {
    return this.view(vault, await this.settled(vault, id));
  }

  /** Stores a proposal. The author is whoever the server authenticated, never something in the body. */
  async create(vault: string, input: ProposalInput, author: Author): Promise<ProposalView> {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_PROPOSAL_BYTES) {
      throw new AppError("payload_too_large", undefined, { limit: MAX_PROPOSAL_BYTES });
    }
    const seen = new Set<string>();
    const files: ProposalFile[] = [];
    for (const file of input.files) {
      const path = proposable(file.path);
      const key = path.normalize("NFC").toLowerCase();
      if (seen.has(key)) {
        throw new AppError("invalid_request", undefined, {
          path,
          reason: "the file is listed twice",
        });
      }
      seen.add(key);
      const current = await this.read(vault, path);
      if ((current?.version ?? null) !== file.baseRevision) {
        throw new AppError("version_conflict", undefined, { path });
      }
      const hunks = resolveHunks(path, current?.content ?? "", file.hunks);
      checkText(path, applyHunks(current?.content ?? "", hunks));
      files.push({ path, baseRevision: file.baseRevision, hunks });
    }
    const now = new Date().toISOString();
    const proposal: Proposal = {
      schemaVersion: 1,
      id: randomUUID(),
      version: 1,
      title: input.title,
      rationale: input.rationale,
      sources: input.sources.map((s) => ({ ...s, path: normalizeVaultPath(s.path) })),
      files,
      proposedBy: author,
      createdAt: now,
      updatedAt: now,
      state: "pending",
    };
    await this.save(vault, proposal);
    return this.view(vault, proposal);
  }

  /**
   * Accepts or rejects hunks. Accepting changes the notes; nothing is written when any chosen
   * file no longer matches what the proposal was written against. Rejecting never touches notes.
   */
  review(
    vault: string,
    id: string,
    input: ProposalReview,
    action: "accept" | "reject",
    reviewer: Author,
  ): Promise<ProposalView> {
    return this.locks.run(`${vault}\0${safeId(id)}`, async () => {
      const proposal = await this.settledLocked(vault, id);
      if (input.version !== proposal.version) throw new AppError("proposal_changed");
      const pending = proposal.files.flatMap((f) => f.hunks).filter((h) => h.state === "pending");
      const chosen = new Set(input.hunkIds ?? pending.map((h) => h.id));
      if (chosen.size === 0) throw new AppError("proposal_changed");
      for (const hunkId of chosen) {
        if (!pending.some((h) => h.id === hunkId)) throw new AppError("proposal_changed");
      }
      const now = new Date().toISOString();

      if (action === "reject") {
        for (const file of proposal.files) {
          for (const h of file.hunks) if (chosen.has(h.id)) this.mark(h, "rejected", reviewer, now);
        }
        return this.view(vault, await this.finish(vault, proposal, now));
      }

      const writes: BatchWrite[] = [];
      const applying: Applying = { reviewer, files: [] };
      for (const file of proposal.files) {
        const hunks = file.hunks.filter((h) => chosen.has(h.id));
        if (hunks.length === 0) continue;
        const current = await this.read(vault, file.path);
        if ((current?.version ?? null) !== file.baseRevision) {
          throw new AppError("proposal_stale", undefined, { path: file.path });
        }
        const next = applyHunks(current?.content ?? "", hunks);
        checkText(file.path, next);
        writes.push({ path: file.path, baseVersion: file.baseRevision, content: next });
        applying.files.push({
          path: file.path,
          hunkIds: hunks.map((h) => h.id),
          resultVersion: contentVersion(next),
        });
      }
      // Written down first: if the server stops while the files are being written, the next look
      // at this proposal sees which files made it and finishes the bookkeeping.
      proposal.applying = applying;
      await this.save(vault, proposal);
      try {
        await this.vaults.writeBatch(vault, writes, {
          onWritten: (results) =>
            this.history.record(
              vault,
              results.map((r) => r.path),
              proposal.proposedBy,
              { reason: proposal.title, approvedBy: reviewer },
            ),
        });
      } catch (err) {
        delete proposal.applying;
        await this.save(vault, proposal).catch(() => undefined);
        throw err;
      }
      this.settleApplied(proposal, now);
      return this.view(vault, await this.finish(vault, proposal, now));
    });
  }

  // ---- internals ----------------------------------------------------------------------------

  private mark(h: ProposalHunk, state: HunkState, by: Author, at: string): void {
    h.state = state;
    h.reviewedBy = by;
    h.reviewedAt = at;
  }

  /** Records a finished review: new version, new state, saved. */
  private async finish(vault: string, proposal: Proposal, now: string): Promise<Proposal> {
    proposal.version++;
    proposal.updatedAt = now;
    proposal.state = stateOf(proposal.files);
    await this.save(vault, proposal);
    return proposal;
  }

  /**
   * Marks the hunks of an `applying` accept as accepted (their files are written), moves each
   * file's base to what was written and shifts the hunks still waiting, then saves.
   */
  private settleApplied(proposal: Proposal, now: string, written?: ReadonlySet<string>): void {
    const applying = proposal.applying;
    if (!applying) return;
    for (const entry of applying.files) {
      if (written && !written.has(entry.path)) continue;
      const file = proposal.files.find((f) => f.path === entry.path);
      if (!file) continue;
      const done = file.hunks.filter((h) => entry.hunkIds.includes(h.id));
      for (const h of file.hunks) {
        if (h.state !== "pending" || entry.hunkIds.includes(h.id)) continue;
        const shift = done
          .filter((d) => d.end <= h.start)
          .reduce((n, d) => n + d.after.length - (d.end - d.start), 0);
        h.start += shift;
        h.end += shift;
      }
      for (const h of done) this.mark(h, "accepted", applying.reviewer, now);
      file.baseRevision = entry.resultVersion;
    }
    delete proposal.applying;
  }

  private async read(vault: string, path: string) {
    try {
      return await this.vaults.readFile(vault, path);
    } catch (err) {
      if (err instanceof AppError && err.code === "not_found") return null;
      throw err;
    }
  }

  private async load(vault: string, id: string): Promise<Proposal> {
    const raw = await this.vaults.readMeta(vault, recordName(id));
    if (raw === null) throw new AppError("not_found");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("schema_invalid", undefined, { reason: "not JSON" });
    }
    return migrate(parsed).data as unknown as Proposal;
  }

  private async save(vault: string, proposal: Proposal): Promise<void> {
    await this.vaults.writeMeta(vault, recordName(proposal.id), JSON.stringify(proposal, null, 2));
  }

  /** A proposal after sorting out an accept that was interrupted. */
  private settled(vault: string, id: string): Promise<Proposal> {
    return this.locks.run(`${vault}\0${safeId(id)}`, () => this.settledLocked(vault, id));
  }

  private async settledLocked(vault: string, id: string): Promise<Proposal> {
    const proposal = await this.load(vault, id);
    if (!proposal.applying) return proposal;
    // A file counts as written when it now has exactly the content the accept computed.
    const written = new Set<string>();
    for (const entry of proposal.applying.files) {
      if ((await this.read(vault, entry.path))?.version === entry.resultVersion) {
        written.add(entry.path);
      }
    }
    // The attribution kept in memory died with the process; give the recovered files theirs again.
    if (written.size > 0) {
      this.history.record(vault, [...written], proposal.proposedBy, {
        reason: proposal.title,
        approvedBy: proposal.applying.reviewer,
      });
    }
    this.settleApplied(proposal, new Date().toISOString(), written);
    delete proposal.applying;
    proposal.version++;
    proposal.state = stateOf(proposal.files);
    await this.save(vault, proposal);
    return proposal;
  }

  private async statuses(vault: string, proposal: Proposal): Promise<FileStatus[]> {
    const out: FileStatus[] = [];
    for (const file of proposal.files) {
      if (!file.hunks.some((h) => h.state === "pending")) {
        out.push("current");
        continue;
      }
      const current = await this.read(vault, file.path);
      if (current === null) out.push(file.baseRevision === null ? "current" : "missing");
      else out.push(current.version === file.baseRevision ? "current" : "stale");
    }
    return out;
  }

  private async view(vault: string, proposal: Proposal): Promise<ProposalView> {
    const status = await this.statuses(vault, proposal);
    const { applying, ...rest } = proposal;
    void applying; // never shown to clients
    return {
      ...rest,
      stale: status.some((s) => s !== "current"),
      files: proposal.files.map((f, i) => ({ ...f, status: status[i]! })),
    };
  }

  private async summary(vault: string, proposal: Proposal): Promise<ProposalSummary> {
    const status = await this.statuses(vault, proposal);
    const count = (f: ProposalFile, s: HunkState) => f.hunks.filter((h) => h.state === s).length;
    return {
      id: proposal.id,
      version: proposal.version,
      title: proposal.title,
      rationale: proposal.rationale,
      state: proposal.state,
      stale: status.some((s) => s !== "current"),
      proposedBy: proposal.proposedBy,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      files: proposal.files.map((f, i) => ({
        path: f.path,
        status: status[i]!,
        pending: count(f, "pending"),
        accepted: count(f, "accepted"),
        rejected: count(f, "rejected"),
      })),
    };
  }
}
