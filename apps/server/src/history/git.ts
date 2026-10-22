import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "@palimvo/core";

const run = promisify(execFile);

/** `git` 2.31 added `GIT_CONFIG_COUNT`, which we use to hand credentials to git without putting them on a command line. */
const MIN_GIT: readonly [number, number] = [2, 31];

/** A git command failed. `message` is git's own stderr, which may name paths but never credentials. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitRun {
  cwd: string;
  args: readonly string[];
  /** Written to git's stdin. */
  input?: string | undefined;
  /** Extra environment (e.g. `GIT_CONFIG_*` for credentials). */
  env?: Record<string, string> | undefined;
  /** Return bytes instead of a UTF-8 string. */
  binary?: boolean;
}

/** Options every command gets: no prompts, no optional locks, literal paths, the same output on every OS. */
const BASE_ARGS = [
  "-c",
  "core.quotepath=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "safe.directory=*",
  "--literal-pathspecs",
];

export async function git(options: GitRun & { binary?: false }): Promise<string>;
export async function git(options: GitRun & { binary: true }): Promise<Buffer>;
export async function git(options: GitRun): Promise<string | Buffer> {
  try {
    const running = run("git", [...BASE_ARGS, ...options.args], {
      cwd: options.cwd,
      maxBuffer: 256 * 1024 * 1024,
      encoding: options.binary ? "buffer" : "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        ...options.env,
      },
    });
    if (options.input !== undefined) {
      // git may exit before reading everything; its exit code tells the story.
      running.child.stdin?.on("error", () => {});
      running.child.stdin?.end(options.input);
    }
    const { stdout } = await running;
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === "ENOENT") throw gitMissing(err);
    const stderr = String(e.stderr ?? "").trim();
    throw new GitError(stderr || e.message, stderr);
  }
}

function gitMissing(cause: unknown): AppError {
  return new AppError("git_unavailable", undefined, undefined, {
    message:
      "Palimvo needs git to keep version history, but the git command was not found. Install git and make sure it is on PATH.",
    cause,
  });
}

/** Throws a clear `git_unavailable` error unless a recent enough `git` is installed. Returns its version. */
export async function assertGit(): Promise<string> {
  let out: string;
  try {
    out = (await run("git", ["--version"])).stdout.trim();
  } catch (err) {
    throw gitMissing(err);
  }
  const match = /(\d+)\.(\d+)/.exec(out);
  if (!match) return out;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new AppError(
      "git_unavailable",
      undefined,
      { found: out },
      {
        message: `Palimvo needs git ${MIN_GIT.join(".")} or newer, found "${out}".`,
      },
    );
  }
  return out;
}
