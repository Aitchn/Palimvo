import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  GIT_APPROVER_TRAILER,
  GIT_AUTHOR_TRAILER,
  GIT_REASON_TRAILER,
  authorFromGit,
  gitEmail,
  isValidVaultId,
  makeAuthor,
  parseAuthor,
  sameAuthor,
  type Author,
} from "@palimvo/core";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";
import { KeyedMutex } from "../vault/mutex.ts";
import { git, GitError } from "./git.ts";

/** What someone said about a change, recorded next to the paths it touched. */
export interface ChangeNote {
  /** The author's own words ("why"); becomes the commit subject and a `Palimvo-Reason` trailer. */
  reason?: string | undefined;
  /** What the app did ("Move a to b"); only used for the subject when nobody gave a reason. */
  summary?: string | undefined;
  /** Who accepted this change when someone else proposed it; recorded in a `Palimvo-Approved-by` trailer. */
  approvedBy?: Author | undefined;
}

/** Receives "this path was changed by this author" notes from the file API and, later, the collab hub. */
export interface ChangeRecorder {
  record(vault: string, paths: readonly string[], author: Author, note?: ChangeNote): void;
}

export interface HistoryOptions {
  logger: Logger;
  /** Commit this long after the last recorded change... */
  commitDelayMs?: number;
  /** ...but at least this often while changes keep coming. */
  commitMaxDelayMs?: number;
  /**
   * Holds the vault's file writes while a commit snapshots it, so a write and its attribution
   * never land on different sides of a commit. Pass `VaultService.exclusive`.
   */
  writeLock?: <T>(vault: string, fn: () => Promise<T>) => Promise<T>;
  /** Files bigger than this stay out of the history (default `MAX_HISTORY_FILE_BYTES`). */
  maxFileBytes?: number;
}

export interface CommitInfo {
  id: string;
  date: string;
  author: Author;
  coAuthors: Author[];
  /** Who accepted the change, when it was proposed by someone else (`Palimvo-Approved-by`). */
  approvedBy: Author[];
  subject: string;
  /** Free text below the subject, without trailers. */
  body: string;
  /** The `Palimvo-Reason` trailers: why each part of the commit was made. */
  reasons: string[];
  /** True for a commit made by "save a checkpoint". */
  checkpoint: boolean;
  tags: string[];
  files: string[];
  /** When the log is for one file: its path in this commit (it may have been renamed since). */
  path?: string;
}

export interface Checkpoint {
  name: string;
  commit: string;
  date: string;
  message: string;
}

/** Who gets the blame for things the app does by itself (the first commit, the `.aivault` rename). */
export const SYSTEM_AUTHOR: Author = makeAuthor("external", "Palimvo", { id: "palimvo" });
/** Who gets the blame for changes nobody told the app about (an editor, git, a sync tool). */
export const EXTERNAL_AUTHOR: Author = makeAuthor("external", "External change", {
  id: "external",
});

/**
 * Files that must never be committed: app-internal state and crash leftovers. Lines are
 * written once to `.git/info/exclude`, so the vault's own files stay untouched.
 */
const EXCLUDES = [
  "/.palimvo/collab/",
  "/.palimvo/proposals/",
  "/.palimvo/cache/",
  "/.palimvo/uploads/",
  "/.palimvo/tmp/",
  "/.aivault/collab/",
  "/.aivault/mcp/",
  "/.aivault/transactions/",
  "/.aivault/uploads/",
  ".*.tmp-????????",
];
const EXCLUDE_HEADER = "# palimvo";
/** The folders in `EXCLUDES`, as vault-relative prefixes: git never sees them, so they need no size check. */
const UNVERSIONED_FOLDERS = EXCLUDES.filter((e) => e.startsWith("/") && e.endsWith("/")).map((e) =>
  e.slice(1),
);

/**
 * Files bigger than this stay out of the history and off-site backups: git copies every version
 * into the repository for good, and GitHub refuses files over 100 MB, which would stop every
 * backup push. They live only in the vault folder (and the server's own backups of it).
 */
export const MAX_HISTORY_FILE_BYTES = 100 * 1024 * 1024;
const LARGE_BEGIN = "# palimvo: files too large for the history (rewritten by the app)";
const LARGE_END = "# palimvo: end of large files";

const COMMITTER = [
  "-c",
  "user.name=Palimvo",
  "-c",
  `user.email=${gitEmail(SYSTEM_AUTHOR)}`,
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];
const COMMIT_ID = /^[0-9a-f]{7,40}$/;
const COMMIT_MESSAGE_FILE = "PALIMVO_COMMIT_MSG";
const CHECKPOINT_TRAILER = "Palimvo-Checkpoint";
const FIELD = "\x1f";
const RECORD = "\x1e";
const END = "\x1d";

interface Pending {
  /** path -> everyone who changed it since the last commit, most recent last */
  authors: Map<string, Author[]>;
  reasons: Map<string, string[]>;
  summaries: Map<string, string[]>;
  /** path -> who accepted the proposed change to it */
  approvers: Map<string, Author[]>;
  timer?: ReturnType<typeof setTimeout>;
  firstAt?: number;
}

/** A commit that is made on request instead of from recorded changes. */
export interface CommitRequest {
  message: string;
  author: Author;
  /** Make the commit even when nothing changed. */
  allowEmpty?: boolean;
  /** Marks the commit as a checkpoint. */
  checkpoint?: boolean;
}

/**
 * Each vault is a git repository. Changes are batched into commits a few seconds after they
 * settle, one commit per author and stated reason, so the history says who (which person or
 * AI) changed what and why.
 */
export class VaultHistory implements ChangeRecorder {
  private readonly git = new KeyedMutex();
  private readonly pending = new Map<string, Pending>();
  private readonly ready = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private readonly commitDelayMs: number;
  private readonly commitMaxDelayMs: number;
  private readonly maxFileBytes: number;
  private readonly writeLock: <T>(vault: string, fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly root: string,
    options: HistoryOptions,
  ) {
    this.log = options.logger;
    this.commitDelayMs = options.commitDelayMs ?? 10_000;
    this.commitMaxDelayMs = options.commitMaxDelayMs ?? 60_000;
    this.maxFileBytes = options.maxFileBytes ?? MAX_HISTORY_FILE_BYTES;
    this.writeLock = options.writeLock ?? ((_vault, fn) => fn());
  }

  record(vault: string, paths: readonly string[], author: Author, note: ChangeNote = {}): void {
    const p = this.pendingFor(vault);
    const reason = note.reason ? cleanReason(note.reason) : "";
    const summary = note.summary ? cleanReason(note.summary) : "";
    for (const file of paths) {
      const list = p.authors.get(file) ?? [];
      p.authors.set(file, [...list.filter((a) => !sameAuthor(a, author)), author]);
      if (reason) addTo(p.reasons, file, reason);
      if (summary) addTo(p.summaries, file, summary);
      if (note.approvedBy) {
        const approvers = p.approvers.get(file) ?? [];
        p.approvers.set(file, [
          ...approvers.filter((a) => !sameAuthor(a, note.approvedBy!)),
          note.approvedBy,
        ]);
      }
    }
    this.schedule(vault);
  }

  /** Something changed that nobody recorded (an external edit): commit it soon as an external change. */
  noteUnrecorded(vault: string): void {
    this.schedule(vault);
  }

  private schedule(vault: string): void {
    const p = this.pendingFor(vault);
    p.firstAt ??= Date.now();
    clearTimeout(p.timer);
    const wait = Math.min(this.commitDelayMs, p.firstAt + this.commitMaxDelayMs - Date.now());
    p.timer = setTimeout(() => void this.commit(vault).catch(() => undefined), Math.max(0, wait));
    p.timer.unref();
  }

  /** Makes sure the vault is a git repository with the app's ignore rules. Safe to call repeatedly. */
  ensureRepo(vault: string): Promise<void> {
    let ready = this.ready.get(vault);
    if (!ready) {
      ready = this.git.run(vault, () => this.init(vault));
      ready.catch(() => this.ready.delete(vault));
      this.ready.set(vault, ready);
    }
    return ready;
  }

  /**
   * Gives a vault its first commit ("Create version history") if it has none yet. Call it when a
   * vault is created, so edits made right after do not end up inside that first commit.
   */
  async ensureBaseline(vault: string): Promise<void> {
    await this.ensureRepo(vault);
    await this.git.run(vault, () => this.writeLock(vault, () => this.baseline(vault, new Set())));
  }

  /**
   * Commits everything that changed since the last commit. Recorded changes are committed per
   * author; anything else (edits made outside the app) as an external change. With `request` the
   * whole change is one commit by that author. Returns the commits made.
   */
  async commit(vault: string, request?: CommitRequest): Promise<CommitInfo[]> {
    await this.ensureRepo(vault);
    return this.git.run(vault, async () => {
      const p = this.pendingFor(vault);
      clearTimeout(p.timer);
      let taken: Pick<Pending, "authors" | "reasons" | "summaries" | "approvers"> | undefined;
      try {
        return await this.writeLock(vault, () => {
          // Take the notes only once no write is running: a write that finished before this point
          // has recorded its author, and one that starts later is not in this snapshot.
          taken = {
            authors: p.authors,
            reasons: p.reasons,
            summaries: p.summaries,
            approvers: p.approvers,
          };
          p.authors = new Map();
          p.reasons = new Map();
          p.summaries = new Map();
          p.approvers = new Map();
          p.firstAt = undefined;
          return this.commitLocked(vault, taken, request);
        });
      } catch (err) {
        // Keep the notes so the next commit still attributes these changes, and try again later
        // (e.g. another git process briefly held the index lock).
        if (taken) {
          restore(p.authors, taken.authors);
          restore(p.reasons, taken.reasons);
          restore(p.summaries, taken.summaries);
          restore(p.approvers, taken.approvers);
        }
        if (!(err instanceof AppError)) {
          this.log.error("commit failed", { vault, ...errorFields(err) });
          this.schedule(vault);
        }
        throw err;
      }
    });
  }

  /**
   * Forgets a removed vault (after its folder moved away), so a new vault with the same
   * name starts its own history.
   */
  forget(vault: string): void {
    clearTimeout(this.pending.get(vault)?.timer);
    this.pending.delete(vault);
    this.ready.delete(vault);
  }

  /** Commits every vault with pending changes (shutdown) and stops the timers. */
  async flushAll(): Promise<void> {
    const vaults = [...this.pending.keys()];
    await Promise.all(
      vaults.map((v) =>
        this.commit(v).catch((err) =>
          this.log.error("final commit failed", { vault: v, ...errorFields(err) }),
        ),
      ),
    );
  }

  /** Commits touching `file` (following renames), or the whole vault, newest first. */
  async list(
    vault: string,
    options: { path?: string; limit?: number } = {},
  ): Promise<CommitInfo[]> {
    await this.ensureRepo(vault);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const args = [
      "log",
      `-n${limit}`,
      "--name-only",
      `--format=${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%D${FIELD}%s${FIELD}%b${END}`,
    ];
    // For one file, follow it across renames. Otherwise list both sides of a move.
    if (options.path) args.push("--follow", "--", options.path);
    else args.push("--no-renames");
    let out: string;
    try {
      out = await this.gitIn(vault, args);
    } catch (err) {
      if (err instanceof GitError && /does not have any commits/.test(err.message)) return [];
      throw err;
    }
    return out
      .split(RECORD)
      .filter((r) => r.trim())
      .map((record) => {
        const [meta = "", names = ""] = record.split(END);
        const [id = "", name = "", email = "", date = "", refs = "", subject = "", body = ""] =
          meta.split(FIELD);
        const parsed = parseMessage(body);
        const commit: CommitInfo = {
          id,
          date,
          author: parsed.author ?? authorFromGit(name, email),
          coAuthors: parsed.coAuthors,
          approvedBy: parsed.approvedBy,
          subject,
          body: parsed.text,
          reasons: parsed.reasons,
          checkpoint: parsed.checkpoint,
          tags: refs
            .split(", ")
            .filter((r) => r.startsWith("tag: "))
            .map((r) => r.slice(5)),
          files: names.split("\n").filter(Boolean),
        };
        return commit;
      })
      .map((c) => (options.path ? { ...c, path: c.files[0] ?? options.path } : c));
  }

  /** The file as it was in `commit`, as raw bytes. */
  async blob(vault: string, commit: string, file: string): Promise<Buffer> {
    checkCommit(commit);
    await this.ensureRepo(vault);
    try {
      return await git({
        cwd: this.dir(vault),
        args: ["cat-file", "blob", `${commit}:${file}`],
        binary: true,
      });
    } catch (err) {
      if (err instanceof GitError) {
        throw new AppError(
          "not_found",
          undefined,
          { commit, path: file },
          {
            message: `"${file}" does not exist in ${commit.slice(0, 7)}.`,
          },
        );
      }
      throw err;
    }
  }

  /** Unified diff of what `commit` changed (optionally limited to one file). */
  async diff(vault: string, commit: string, file?: string): Promise<string> {
    checkCommit(commit);
    await this.ensureRepo(vault);
    const args = ["show", "--format=", "--patch", "--find-renames", commit];
    if (file) args.push("--", file);
    try {
      return await this.gitIn(vault, args);
    } catch (err) {
      if (err instanceof GitError) {
        throw new AppError(
          "not_found",
          undefined,
          { commit },
          {
            message: `Commit ${commit.slice(0, 7)} was not found.`,
          },
        );
      }
      throw err;
    }
  }

  /** Unified diff from commit `from` to commit `to` (optionally limited to one file). */
  async compare(vault: string, from: string, to: string, file?: string): Promise<string> {
    checkCommit(from);
    checkCommit(to);
    await this.ensureRepo(vault);
    const args = ["diff", "--find-renames", from, to];
    if (file) args.push("--", file);
    try {
      return await this.gitIn(vault, args);
    } catch (err) {
      if (err instanceof GitError) {
        throw new AppError(
          "not_found",
          undefined,
          { from, to },
          { message: `Commit ${from.slice(0, 7)} or ${to.slice(0, 7)} was not found.` },
        );
      }
      throw err;
    }
  }

  /**
   * Saves a checkpoint: commits everything now (including recorded changes still waiting for
   * their timer), optionally tags it, and returns the commit. A bad or taken tag name is
   * rejected before anything is committed.
   */
  async checkpoint(
    vault: string,
    options: { message: string; tag?: string | undefined; author: Author },
  ): Promise<CommitInfo> {
    const message = options.message.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!message) throw new AppError("invalid_request", undefined, { field: "message" });
    if (options.tag !== undefined) await this.checkTag(vault, options.tag);
    const [made] = await this.commit(vault, {
      message,
      author: options.author,
      allowEmpty: true,
      checkpoint: true,
    });
    if (!made) throw new AppError("internal");
    if (options.tag === undefined) return made;
    const tag = options.tag;
    await this.git.run(vault, () =>
      this.gitIn(vault, [...COMMITTER, "tag", "-a", tag, "-m", message, made.id]),
    );
    return { ...made, tags: [...made.tags, tag] };
  }

  /** Throws an `invalid_tag` / `already_exists` error unless `name` is a usable new tag name. */
  async checkTag(vault: string, name: string): Promise<void> {
    const valid =
      name.length > 0 &&
      name.length <= 100 &&
      !name.startsWith("-") &&
      (await git({ cwd: this.dir(vault), args: ["check-ref-format", `refs/tags/${name}`] }).then(
        () => true,
        () => false,
      ));
    if (!valid) throw new AppError("invalid_tag", undefined, { tag: name });
    await this.ensureRepo(vault);
    const taken = await this.gitIn(vault, [
      "rev-parse",
      "-q",
      "--verify",
      `refs/tags/${name}`,
    ]).then(
      () => true,
      () => false,
    );
    if (taken) throw new AppError("already_exists", undefined, { tag: name });
  }

  /** Tags with their commit, newest first. */
  async checkpoints(vault: string): Promise<Checkpoint[]> {
    await this.ensureRepo(vault);
    const out = await this.gitIn(vault, [
      "for-each-ref",
      "--sort=-creatordate",
      `--format=%(refname:short)${FIELD}%(*objectname)${FIELD}%(objectname)${FIELD}%(creatordate:iso-strict)${FIELD}%(contents:subject)${END}`,
      "refs/tags",
    ]);
    return out
      .split(END)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((record) => {
        const [name = "", peeled = "", object = "", date = "", message = ""] = record.split(FIELD);
        return { name, commit: peeled || object, date, message };
      });
  }

  /**
   * Runs git in the vault, serialized with commits. Used by the backup service. Pass `env` for
   * credentials (never put them in `args`).
   */
  exclusive<T>(
    vault: string,
    fn: (run: (args: string[], env?: Record<string, string>) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    return this.ensureRepo(vault).then(() =>
      this.git.run(vault, () => fn((args, env) => this.gitIn(vault, args, undefined, env))),
    );
  }

  private pendingFor(vault: string): Pending {
    let p = this.pending.get(vault);
    if (!p) {
      p = {
        authors: new Map(),
        reasons: new Map(),
        summaries: new Map(),
        approvers: new Map(),
      };
      this.pending.set(vault, p);
    }
    return p;
  }

  private dir(vault: string): string {
    if (!isValidVaultId(vault)) throw notFound(vault);
    return path.join(this.root, vault);
  }

  private gitIn(
    vault: string,
    args: string[],
    input?: string,
    env?: Record<string, string>,
  ): Promise<string> {
    return git({ cwd: this.dir(vault), args, input, env });
  }

  private async init(vault: string): Promise<void> {
    const dir = this.dir(vault);
    if (!existsSync(dir)) throw notFound(vault);
    // An imported vault may already be a git repository; use it as it is.
    if (!existsSync(path.join(dir, ".git"))) {
      await this.gitIn(vault, ["init", "-q", "-b", "main"]);
      this.log.info("initialized vault history", { vault });
    }
    // Lets `git add -A` / `git status` skip folders that did not change (large vaults).
    await this.gitIn(vault, ["config", "core.untrackedCache", "true"]).catch(() => undefined);
    const exclude = path.join(dir, ".git", "info", "exclude");
    await mkdir(path.dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    const missing = EXCLUDES.filter((line) => !current.split("\n").includes(line));
    if (missing.length) {
      const lead = current && !current.endsWith("\n") ? "\n" : "";
      await appendFile(exclude, `${lead}${EXCLUDE_HEADER}\n${missing.join("\n")}\n`);
    }
  }

  /** The first commit, made from everything except `recorded` files (which a later commit credits to their authors). */
  private async baseline(vault: string, recorded: ReadonlySet<string>): Promise<void> {
    const hasCommits = await this.gitIn(vault, ["rev-parse", "--verify", "-q", "HEAD"]).then(
      () => true,
      () => false,
    );
    if (hasCommits) return;
    await this.excludeLargeFiles(vault);
    await this.gitIn(vault, ["add", "-A"]);
    const held = [...recorded];
    for (let i = 0; i < held.length; i += 100) {
      const batch = held.slice(i, i + 100);
      const staged = (await this.gitIn(vault, ["ls-files", "-z", "--", ...batch]))
        .split("\0")
        .filter(Boolean);
      if (staged.length) await this.gitIn(vault, ["rm", "--cached", "-q", "--", ...staged]);
    }
    await this.commitFiles(vault, {
      author: SYSTEM_AUTHOR,
      subject: "Create version history",
      files: [],
      co: [],
      reasons: [],
      allowEmpty: true,
      checkpoint: false,
    });
  }

  /**
   * Keeps files over `maxFileBytes` out of git: lists them in `.git/info/exclude` (so
   * `git add` never even reads them) and stops tracking any that grew past the limit.
   */
  private async excludeLargeFiles(vault: string): Promise<void> {
    const dir = this.dir(vault);
    const exclude = path.join(dir, ".git", "info", "exclude");
    const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    const lines = current.split("\n");
    const begin = lines.indexOf(LARGE_BEGIN);
    // Only files git sees as new or changed can have grown past the limit since the last commit
    // (plus the ones already listed, which may have shrunk); checking just those keeps a commit
    // in a vault of many thousands of notes from stat-ing every file while writes wait.
    const listed =
      begin >= 0
        ? lines
            .slice(begin + 1, lines.indexOf(LARGE_END, begin))
            .filter(Boolean)
            .map(unignorePattern)
        : [];
    const changed = (
      await this.gitIn(vault, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ])
    )
      .split("\0")
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3));
    const large = (
      await largeAmong(dir, [...new Set([...listed, ...changed])], this.maxFileBytes)
    ).sort();
    if (!large.length && begin < 0) return;
    const end = lines.indexOf(LARGE_END, begin);
    const kept =
      begin >= 0 && end > begin ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;
    const base = kept.join("\n").replace(/\n*$/, "\n");
    const next = large.length
      ? `${base}${LARGE_BEGIN}\n${large.map(ignorePattern).join("\n")}\n${LARGE_END}\n`
      : base;
    if (next !== current) {
      await mkdir(path.dirname(exclude), { recursive: true });
      await writeFile(exclude, next);
    }
    // A file that was versioned before it grew leaves the history in a commit of its own (a commit
    // naming the path would take it back from the working tree).
    const tracked: string[] = [];
    for (let i = 0; i < large.length; i += 100) {
      tracked.push(
        ...(await this.gitIn(vault, ["ls-files", "-z", "--", ...large.slice(i, i + 100)]))
          .split("\0")
          .filter(Boolean),
      );
    }
    if (!tracked.length) return;
    for (let i = 0; i < tracked.length; i += 100) {
      await this.gitIn(vault, ["rm", "--cached", "-q", "--", ...tracked.slice(i, i + 100)]);
    }
    const names =
      tracked.slice(0, 3).join(", ") +
      (tracked.length > 3 ? ` and ${tracked.length - 3} more` : "");
    const mib = Math.round(this.maxFileBytes / 1024 / 1024);
    await this.commitFiles(vault, {
      author: SYSTEM_AUTHOR,
      subject: `Stop versioning ${names}: over ${mib} MiB (the file itself is kept)`,
      files: [],
      co: [],
      reasons: [],
      allowEmpty: false,
      checkpoint: false,
    });
  }

  private async commitLocked(
    vault: string,
    notes: Pick<Pending, "authors" | "reasons" | "summaries" | "approvers">,
    request?: CommitRequest,
  ): Promise<CommitInfo[]> {
    const { authors, reasons, summaries, approvers } = notes;
    await this.baseline(vault, new Set(authors.keys()));
    await this.excludeLargeFiles(vault);
    await this.gitIn(vault, ["add", "-A"]);
    const changed = await this.stagedFiles(vault);
    const made: CommitInfo[] = [];

    if (request) {
      const co: Author[] = [];
      for (const file of changed) {
        for (const a of authors.get(file) ?? []) {
          if (!sameAuthor(a, request.author) && !co.some((c) => sameAuthor(c, a))) co.push(a);
        }
      }
      if (!changed.length && !request.allowEmpty) return made;
      made.push(
        await this.commitFiles(vault, {
          author: request.author,
          subject: request.message,
          files: changed,
          co,
          reasons: distinct(changed.flatMap((f) => reasons.get(f) ?? [])),
          approvedBy: distinctAuthors(changed.flatMap((f) => approvers.get(f) ?? [])),
          allowEmpty: request.allowEmpty ?? false,
          checkpoint: request.checkpoint ?? false,
        }),
      );
      return made;
    }

    // Group files by their latest author and stated reasons (one commit per change they
    // described); everyone else who touched them is a co-author.
    const groups = new Map<string, { author: Author; files: string[]; co: Author[] }>();
    for (const file of changed) {
      const list = authors.get(file);
      const author = list?.at(-1) ?? EXTERNAL_AUTHOR;
      const why = reasons.get(file) ?? [];
      const what = why.length ? [] : (summaries.get(file) ?? []);
      const approvedBy = approvers.get(file) ?? [];
      const key = [
        `${author.kind}:${author.id}`,
        ...why,
        "\0",
        ...what,
        "\0",
        ...approvedBy.map((a) => `${a.kind}:${a.id}`),
      ].join("\0");
      const group = groups.get(key) ?? { author, files: [], co: [] };
      group.files.push(file);
      for (const a of list ?? []) {
        if (!sameAuthor(a, author) && !group.co.some((c) => sameAuthor(c, a))) group.co.push(a);
      }
      groups.set(key, group);
    }
    // External edits last, so the people's commits stay together at the top of the log.
    const ordered = [...groups.values()].sort(
      (a, b) => Number(a.author === EXTERNAL_AUTHOR) - Number(b.author === EXTERNAL_AUTHOR),
    );
    for (const group of ordered) {
      const why = distinct(group.files.flatMap((f) => reasons.get(f) ?? []));
      const what = distinct(group.files.flatMap((f) => summaries.get(f) ?? []));
      made.push(
        await this.commitFiles(vault, {
          author: group.author,
          subject: subjectFor(group.files, why, what),
          files: group.files,
          co: group.co,
          reasons: why,
          approvedBy: distinctAuthors(group.files.flatMap((f) => approvers.get(f) ?? [])),
          allowEmpty: false,
          checkpoint: false,
        }),
      );
    }
    return made;
  }

  private async stagedFiles(vault: string): Promise<string[]> {
    const out = await this.gitIn(vault, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
    return out.split("\0").filter(Boolean);
  }

  private async commitFiles(
    vault: string,
    c: {
      author: Author;
      subject: string;
      files: string[];
      co: Author[];
      reasons: string[];
      approvedBy?: Author[];
      allowEmpty: boolean;
      checkpoint: boolean;
    },
  ): Promise<CommitInfo> {
    const trailers = [
      `${GIT_AUTHOR_TRAILER}: ${c.author.kind}:${c.author.name}${c.author.client ? `/${c.author.client}` : ""}`,
      ...c.reasons.map((r) => `${GIT_REASON_TRAILER}: ${r}`),
      ...(c.approvedBy ?? []).map((a) => `${GIT_APPROVER_TRAILER}: ${a.kind}:${a.name} <${a.id}>`),
      ...(c.checkpoint ? [`${CHECKPOINT_TRAILER}: true`] : []),
      ...c.co.map((a) => `Co-authored-by: ${a.name} <${gitEmail(a)}>`),
    ];
    const message = `${c.subject}\n\n${trailers.join("\n")}\n`;
    // The message and the paths go through a file and stdin: thousands of paths on the command line
    // overflow Windows' 32K-character limit (spawn ENAMETOOLONG) and fail every later commit.
    const messageFile = path.join(this.dir(vault), ".git", COMMIT_MESSAGE_FILE);
    await writeFile(messageFile, message);
    const args = [
      ...COMMITTER,
      "commit",
      "-q",
      "--no-verify",
      `--author=${c.author.name} <${gitEmail(c.author)}>`,
      "-F",
      messageFile,
    ];
    if (c.allowEmpty) args.push("--allow-empty");
    // No files named: commit the whole index.
    const named = c.files.length > 0;
    if (named) args.push("--only", "--pathspec-from-file=-", "--pathspec-file-nul");
    try {
      await this.gitIn(vault, args, named ? c.files.join("\0") + "\0" : undefined);
    } finally {
      await rm(messageFile, { force: true });
    }
    const [info] = await this.list(vault, { limit: 1 });
    return info!;
  }
}

function addTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

/** Puts notes from a failed commit back, under whatever was recorded since. */
function restore<T>(into: Map<string, T[]>, from: Map<string, T[]>): void {
  for (const [file, list] of from) if (!into.has(file)) into.set(file, list);
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

function distinctAuthors(authors: Author[]): Author[] {
  const out: Author[] = [];
  for (const a of authors) if (!out.some((o) => sameAuthor(o, a))) out.push(a);
  return out;
}

function subjectFor(files: string[], reasons: string[], summaries: string[]): string {
  const said = reasons.length ? reasons : summaries;
  if (said.length === 1) return said[0]!;
  if (said.length > 1) {
    const joined = said.join("; ");
    return joined.length <= 100 ? joined : `${said[0]} and ${said.length - 1} more changes`;
  }
  const names = files.slice(0, 3).join(", ");
  return files.length > 3
    ? `Update ${names} and ${files.length - 3} more files`
    : `Update ${names}`;
}

function cleanReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 200);
}

function checkCommit(commit: string): void {
  if (!COMMIT_ID.test(commit)) {
    throw new AppError(
      "not_found",
      undefined,
      { commit },
      { message: `Invalid commit id "${commit}".` },
    );
  }
}

function notFound(vault: string): AppError {
  return new AppError("vault_not_found", undefined, { vault });
}

const TRAILER =
  /^(Palimvo-Author|Palimvo-Reason|Palimvo-Approved-by|Palimvo-Checkpoint|Co-authored-by): (.*)$/;

/** Splits a commit body into free text and the trailers the app writes. */
function parseMessage(body: string): {
  text: string;
  author: Author | null;
  coAuthors: Author[];
  approvedBy: Author[];
  reasons: string[];
  checkpoint: boolean;
} {
  const text: string[] = [];
  const out = {
    author: null as Author | null,
    coAuthors: [] as Author[],
    approvedBy: [] as Author[],
    reasons: [] as string[],
    checkpoint: false,
  };
  for (const line of body.split("\n")) {
    const m = TRAILER.exec(line);
    if (!m) {
      text.push(line);
      continue;
    }
    const value = m[2]!;
    switch (m[1]) {
      case GIT_AUTHOR_TRAILER:
        out.author = parseAuthor(encodeURIComponent(value));
        break;
      case GIT_REASON_TRAILER:
        out.reasons.push(value);
        break;
      case GIT_APPROVER_TRAILER: {
        // `kind:name <id>`; older commits have no id, which is then made from the name.
        const at = value.lastIndexOf(" <");
        const withId = at > 0 && value.endsWith(">");
        const approver = parseAuthor(encodeURIComponent(withId ? value.slice(0, at) : value));
        if (approver) {
          out.approvedBy.push(withId ? { ...approver, id: value.slice(at + 2, -1) } : approver);
        }
        break;
      }
      case CHECKPOINT_TRAILER:
        out.checkpoint = true;
        break;
      default: {
        const mail = /^(.*) <([^>]*)>$/.exec(value);
        if (mail) out.coAuthors.push(authorFromGit(mail[1]!, mail[2]!));
      }
    }
  }
  return { ...out, text: text.join("\n").trim() };
}

/** Which of these vault-relative paths are files over `limit` bytes (outside git's and the app's own folders). */
async function largeAmong(
  root: string,
  paths: readonly string[],
  limit: number,
): Promise<string[]> {
  const found: string[] = [];
  const candidates = paths.filter(
    (p) =>
      !p.startsWith(".git/") &&
      !UNVERSIONED_FOLDERS.some((folder) => p.startsWith(folder)) &&
      !/[\r\n]/.test(p),
  );
  for (let i = 0; i < candidates.length; i += 64) {
    await Promise.all(
      candidates.slice(i, i + 64).map(async (rel) => {
        const info = await stat(path.join(root, ...rel.split("/"))).catch(() => null);
        if (info?.isFile() && info.size > limit) found.push(rel);
      }),
    );
  }
  return found;
}

/** The path an `ignorePattern` line matches. */
function unignorePattern(line: string): string {
  return line.replace(/^\//, "").replace(/\\(.)/g, "$1");
}

/** An ignore rule matching exactly this one path. */
function ignorePattern(rel: string): string {
  const escaped = rel.replace(/[\\*?[\]]/g, "\\$&");
  // Trailing spaces would be dropped by git unless each one is escaped.
  const body = escaped.replace(/ +$/, "");
  return `/${body}${"\\ ".repeat(escaped.length - body.length)}`;
}
