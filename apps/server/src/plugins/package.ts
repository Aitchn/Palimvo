import {
  MANIFEST_FILE,
  MANIFEST_LIMITS,
  computePluginHash,
  referencedFiles,
  validateManifest,
  type ManifestIssue,
  type PluginFile,
  type PluginManifest,
} from "@palimvo/plugin-sdk";
import { AppError } from "@palimvo/core";

/** A plugin package that passed every check, ready to be stored. */
export interface InspectedPackage {
  manifest: PluginManifest;
  files: PluginFile[];
  /** The content hash a person approves. */
  sha256: string;
  totalBytes: number;
  warnings: ManifestIssue[];
}

export interface InspectOptions {
  /** The running Palimvo version, to refuse a plugin that needs a newer one. */
  palimvoVersion?: string;
}

/** Each segment starts with a letter, digit or underscore: no hidden files, and safe as a `.palimvo/` name. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_PATH_LENGTH = 200;

function invalid(issues: ManifestIssue[]): AppError {
  const first = issues[0];
  return new AppError(
    "plugin_invalid",
    undefined,
    { issues },
    {
      message: `The plugin package is not valid: ${first ? `${first.path || "package"}: ${first.message}` : "unknown problem"}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`,
    },
  );
}

const problem = (path: string, code: string, message: string): ManifestIssue => ({
  path,
  code,
  message,
});

/** What is wrong with the shape of the file list, before any file is read. */
function listProblems(files: readonly PluginFile[]): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (files.length === 0) {
    issues.push(problem("", "empty_package", "The package has no files."));
    return issues;
  }
  if (files.length > MANIFEST_LIMITS.packageFiles) {
    issues.push(
      problem(
        "",
        "too_many_files",
        `A package may have at most ${MANIFEST_LIMITS.packageFiles} files (this one has ${files.length}).`,
      ),
    );
  }
  let total = 0;
  const seen = new Set<string>();
  const folders = new Set<string>();
  for (const f of files) {
    total += f.bytes.length;
    const segments = f.path.split("/");
    if (f.path.length > MAX_PATH_LENGTH || !segments.every((s) => SEGMENT.test(s))) {
      issues.push(
        problem(
          f.path,
          "invalid_file_path",
          "File paths use letters, digits, `_`, `-` and `.`, with `/` between folders; no segment may start with a dot.",
        ),
      );
      continue;
    }
    // Windows and macOS compare names without case; two files that differ only by case would collide.
    const key = f.path.toLowerCase();
    if (seen.has(key))
      issues.push(problem(f.path, "duplicate_file", "Two files have the same path."));
    seen.add(key);
    for (let i = 1; i < segments.length; i++)
      folders.add(segments.slice(0, i).join("/").toLowerCase());
  }
  for (const f of files) {
    if (folders.has(f.path.toLowerCase()))
      issues.push(problem(f.path, "file_is_folder", "A path is used as both a file and a folder."));
  }
  if (total > MANIFEST_LIMITS.packageBytes) {
    issues.push(
      problem(
        "",
        "package_too_large",
        `A package may be at most ${MANIFEST_LIMITS.packageBytes} bytes in total (this one has ${total}).`,
      ),
    );
  }
  return issues;
}

/**
 * Checks a plugin package before anything is stored: the file list (count, total size, safe
 * paths), the manifest (T30's validator), that every file the manifest points at is in the
 * package, and that locale files are JSON objects. Throws `plugin_invalid` with all the problems.
 */
export async function inspectPackage(
  files: readonly PluginFile[],
  options: InspectOptions = {},
): Promise<InspectedPackage> {
  const listIssues = listProblems(files);
  if (listIssues.length > 0) throw invalid(listIssues);

  const manifestFile = files.find((f) => f.path === MANIFEST_FILE);
  if (!manifestFile)
    throw invalid([
      problem(MANIFEST_FILE, "missing_manifest", `The package needs a ${MANIFEST_FILE}.`),
    ]);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes));
  } catch {
    throw invalid([
      problem(MANIFEST_FILE, "manifest_not_json", `${MANIFEST_FILE} is not valid JSON.`),
    ]);
  }
  const validated = validateManifest(json, {
    ...(options.palimvoVersion ? { palimvoVersion: options.palimvoVersion } : {}),
  });
  if (!validated.ok) throw invalid(validated.issues);
  const { manifest } = validated;

  const byPath = new Map(files.map((f) => [f.path, f]));
  const issues: ManifestIssue[] = [];
  for (const path of referencedFiles(manifest)) {
    if (!byPath.has(path))
      issues.push(
        problem(
          path,
          "missing_file",
          `${MANIFEST_FILE} points at "${path}", which is not in the package.`,
        ),
      );
  }
  for (const [locale, path] of Object.entries(manifest.locales ?? {})) {
    const file = byPath.get(path);
    if (!file) continue;
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      );
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        issues.push(
          problem(path, "locale_not_object", `Locale "${locale}" must be a JSON object.`),
        );
    } catch {
      issues.push(problem(path, "locale_not_json", `Locale "${locale}" is not valid JSON.`));
    }
  }
  if (issues.length > 0) throw invalid(issues);

  const sha256 = await computePluginHash(files);
  return {
    manifest,
    files: [...files],
    sha256,
    totalBytes: files.reduce((n, f) => n + f.bytes.length, 0),
    warnings: validated.warnings,
  };
}
