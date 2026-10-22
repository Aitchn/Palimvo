import { globProblem } from "./globs.ts";
import {
  DEFAULT_MAIN_FILE,
  EDITOR_EXTENSIONS,
  MANIFEST_LIMITS as L,
  MANIFEST_VERSION,
  PLUGIN_ID_PATTERN,
  RESERVED_BASE_VIEWS,
  RESERVED_CODE_BLOCKS,
  SLOT_NAMES,
  type LocalizedText,
  type PluginManifest,
} from "./manifest.ts";
import { compareVersions, isStrictVersion, isVersionRange } from "./version.ts";

export interface ManifestIssue {
  /** Where, e.g. `contributes.views[0].id`. */
  path: string;
  /** Stable code, for tests and translated messages. */
  code: string;
  /** English explanation for plugin authors. */
  message: string;
}

export type ValidationResult =
  | { ok: true; manifest: PluginManifest; warnings: ManifestIssue[] }
  | { ok: false; issues: ManifestIssue[] };

export interface ValidateOptions {
  /** The running Palimvo version; when given, `minPalimvo` above it is an `incompatible` issue. */
  palimvoVersion?: string;
}

type Obj = Record<string, unknown>;

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const FILE_PATH = /^(?![/.])[A-Za-z0-9._/-]+$/;
const HOST =
  /^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/;
const ICON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LANGUAGE = /^[a-z0-9][a-z0-9_+-]{0,31}$/;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_EXTENSION = /^[a-z0-9]{1,16}$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Checker {
  readonly issues: ManifestIssue[] = [];
  readonly warnings: ManifestIssue[] = [];

  issue(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  warn(path: string, code: string, message: string): void {
    this.warnings.push({ path, code, message });
  }

  /** Flags keys outside `allowed` (typos would otherwise silently do nothing). */
  keys(value: Obj, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.issue(path ? `${path}.${key}` : key, "unknown_key", `"${key}" is not a known field.`);
      }
    }
  }

  object(value: unknown, path: string): Obj | undefined {
    if (isObj(value)) return value;
    this.issue(path, "invalid_type", "must be an object.");
    return undefined;
  }

  string(
    value: unknown,
    path: string,
    max: number,
    pattern?: RegExp,
    what?: string,
  ): string | undefined {
    if (typeof value !== "string" || value.length === 0) {
      this.issue(path, "invalid_type", "must be a non-empty string.");
      return undefined;
    }
    if (value.length > max) {
      this.issue(path, "too_long", `must be at most ${max} characters.`);
      return undefined;
    }
    if (pattern && !pattern.test(value)) {
      this.issue(path, "invalid_format", `is not a valid ${what ?? "value"}.`);
      return undefined;
    }
    return value;
  }

  localized(value: unknown, path: string, max: number): LocalizedText | undefined {
    if (typeof value === "string") return this.string(value, path, max);
    if (!isObj(value)) {
      this.issue(path, "invalid_type", "must be a string or an object of locale -> string.");
      return undefined;
    }
    const out: Record<string, string> = {};
    let ok = true;
    for (const [locale, text] of Object.entries(value)) {
      if (!LOCALE.test(locale)) {
        this.issue(`${path}.${locale}`, "invalid_locale", "is not a locale code like en or zh-TW.");
        ok = false;
        continue;
      }
      const s = this.string(text, `${path}.${locale}`, max);
      if (s === undefined) ok = false;
      else out[locale] = s;
    }
    if (typeof out.en !== "string") {
      if (ok) this.issue(path, "missing_english", 'must include an "en" text.');
      return undefined;
    }
    return ok ? (out as { en: string } & Record<string, string>) : undefined;
  }

  stringList(value: unknown, path: string, max: number): string[] | undefined {
    if (!Array.isArray(value)) {
      this.issue(path, "invalid_type", "must be an array of strings.");
      return undefined;
    }
    if (value.length > max) {
      this.issue(path, "too_many", `can have at most ${max} entries.`);
      return undefined;
    }
    const out: string[] = [];
    value.forEach((item, i) => {
      if (typeof item === "string") out.push(item);
      else this.issue(`${path}[${i}]`, "invalid_type", "must be a string.");
    });
    return out.length === value.length ? out : undefined;
  }

  list(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.issue(path, "invalid_type", "must be an array.");
      return [];
    }
    if (value.length > max) {
      this.issue(path, "too_many", `can have at most ${max} entries.`);
      return [];
    }
    return value;
  }

  file(value: unknown, path: string, extensions: readonly string[]): string | undefined {
    const s = this.string(value, path, 200, FILE_PATH, "relative file path");
    if (s === undefined) return undefined;
    if (s.split("/").some((seg) => seg === "" || seg === "." || seg === "..") || s.includes("//")) {
      this.issue(path, "invalid_format", 'must not contain "..", "." or empty segments.');
      return undefined;
    }
    if (!extensions.some((ext) => s.endsWith(ext))) {
      this.issue(path, "invalid_format", `must end with ${extensions.join(" or ")}.`);
      return undefined;
    }
    return s;
  }
}

function checkPermissions(c: Checker, raw: unknown): PluginManifest["permissions"] {
  const out: PluginManifest["permissions"] = { read: [], write: [], network: false };
  if (raw === undefined) return out;
  const o = c.object(raw, "permissions");
  if (!o) return out;
  c.keys(o, ["read", "write", "network"], "permissions");
  for (const key of ["read", "write"] as const) {
    if (o[key] === undefined) continue;
    const globs = c.stringList(o[key], `permissions.${key}`, L.globsPerList);
    if (!globs) continue;
    globs.forEach((g, i) => {
      const problem = globProblem(g);
      if (problem) c.issue(`permissions.${key}[${i}]`, "invalid_glob", `"${g}" ${problem}.`);
    });
    out[key] = [...new Set(globs)];
    if (key === "write" && out.write.includes("**")) {
      c.warn("permissions.write", "write_whole_vault", "Can change any file in the vault.");
    }
  }
  const net = o.network;
  if (net === undefined || net === false) return out;
  const hosts = c.stringList(net, "permissions.network", L.networkHosts);
  if (!hosts) {
    if (!Array.isArray(net))
      c.issue("permissions.network", "invalid_type", "must be false or an array of host names.");
    return out;
  }
  hosts.forEach((h, i) => {
    if (!HOST.test(h))
      c.issue(`permissions.network[${i}]`, "invalid_host", `"${h}" is not a host name pattern.`);
  });
  if (hosts.length === 0) return out;
  out.network = [...new Set(hosts)];
  if (hosts.includes("*")) {
    c.warn("permissions.network", "network_unrestricted", "Can reach any host on the internet.");
  }
  return out;
}

function checkJsonSchema(
  c: Checker,
  schema: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (!isObj(schema) || schema.type !== "object") {
    c.issue(path, "invalid_schema", 'must be a JSON Schema object with type "object".');
    return undefined;
  }
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    c.issue(path, "invalid_schema", "must be plain JSON.");
    return undefined;
  }
  if (text.length > L.inputSchemaBytes) {
    c.issue(path, "too_long", `must be at most ${L.inputSchemaBytes} bytes.`);
    return undefined;
  }
  // Only same-document references: a `$ref` to a URL would make the server fetch or trust it.
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (isObj(node)) {
      if ("$ref" in node && !(typeof node.$ref === "string" && node.$ref.startsWith("#"))) {
        c.issue(path, "invalid_schema", '"$ref" may only point inside the same schema ("#/...").');
        return undefined;
      }
      stack.push(...Object.values(node));
    }
  }
  return schema;
}

function checkFileType(c: Checker, t: Obj, path: string): void {
  c.keys(t, ["extension", "mime", "maxBytes", "description"], path);
  const ext = c.string(
    t.extension,
    `${path}.extension`,
    16,
    FILE_EXTENSION,
    "extension (lowercase letters and digits, no dot)",
  );
  if (ext && EDITOR_EXTENSIONS.has(ext)) {
    c.issue(`${path}.extension`, "reserved", `.${ext} is a note type the core handles itself.`);
  }
  if (t.mime !== undefined) {
    const mime = c.string(t.mime, `${path}.mime`, 100, MIME, "media type");
    if (mime && /html|xml|svg|script|xsl|wasm|flash|^multipart\//.test(mime)) {
      c.issue(
        `${path}.mime`,
        "unsafe_mime",
        `${mime} could run as a page or program and is not allowed.`,
      );
    }
  }
  if (t.maxBytes !== undefined) {
    const n = t.maxBytes;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > L.fileTypeMaxBytes) {
      c.issue(
        `${path}.maxBytes`,
        "out_of_range",
        `must be an integer from 1 to ${L.fileTypeMaxBytes}.`,
      );
    }
  }
  if (t.description !== undefined)
    c.string(t.description, `${path}.description`, L.descriptionLength);
}

function eachItem(
  c: Checker,
  value: unknown,
  path: string,
  max: number,
  fn: (item: Obj, itemPath: string) => string | undefined,
  uniqueLabel: string,
): unknown[] {
  const items = c.list(value, path, max);
  const seen = new Set<string>();
  items.forEach((raw, i) => {
    const itemPath = `${path}[${i}]`;
    const item = c.object(raw, itemPath);
    if (!item) return;
    const key = fn(item, itemPath);
    if (key === undefined) return;
    if (seen.has(key)) c.issue(itemPath, "duplicate", `${uniqueLabel} "${key}" is declared twice.`);
    seen.add(key);
  });
  return items;
}

function checkContributes(
  c: Checker,
  raw: unknown,
  perms: PluginManifest["permissions"],
): PluginManifest["contributes"] {
  const out: PluginManifest["contributes"] = {
    views: [],
    codeBlocks: [],
    components: [],
    fileTypes: [],
    viewers: [],
    baseViews: [],
    homeWidgets: [],
    extensionPoints: [],
    extensions: [],
    slots: [],
    tools: [],
  };
  if (raw === undefined) return out;
  const o = c.object(raw, "contributes");
  if (!o) return out;
  c.keys(o, [...Object.keys(out), "theme", "app"], "contributes");
  const name = (item: Obj, p: string) => c.localized(item.name, `${p}.name`, L.nameLength);
  const icon = (item: Obj, p: string) => {
    if (item.icon !== undefined) c.string(item.icon, `${p}.icon`, 40, ICON, "icon name");
  };

  out.views = eachItem(
    c,
    o.views,
    "contributes.views",
    L.views,
    (v, p) => {
      c.keys(v, ["id", "name", "icon"], p);
      name(v, p);
      icon(v, p);
      return c.string(v.id, `${p}.id`, 64, ITEM_ID, "id");
    },
    "view",
  ) as typeof out.views;

  out.codeBlocks = eachItem(
    c,
    o.codeBlocks,
    "contributes.codeBlocks",
    L.codeBlocks,
    (v, p) => {
      c.keys(v, ["language", "name"], p);
      if (v.name !== undefined) name(v, p);
      const lang = c.string(v.language, `${p}.language`, 32, LANGUAGE, "language name");
      if (lang && RESERVED_CODE_BLOCKS.has(lang))
        c.issue(`${p}.language`, "reserved", `"${lang}" is used by the core.`);
      return lang;
    },
    "code block language",
  ) as typeof out.codeBlocks;

  out.components = eachItem(
    c,
    o.components,
    "contributes.components",
    L.components,
    (v, p) => {
      c.keys(v, ["type", "name", "description"], p);
      name(v, p);
      if (v.description !== undefined)
        c.localized(v.description, `${p}.description`, L.descriptionLength);
      return c.string(v.type, `${p}.type`, 32, TYPE_NAME, "component type");
    },
    "component type",
  ) as typeof out.components;

  out.fileTypes = eachItem(
    c,
    o.fileTypes,
    "contributes.fileTypes",
    L.fileTypes,
    (v, p) => {
      checkFileType(c, v, p);
      return typeof v.extension === "string" ? v.extension : undefined;
    },
    "file type",
  ) as typeof out.fileTypes;

  out.viewers = eachItem(
    c,
    o.viewers,
    "contributes.viewers",
    L.viewers,
    (v, p) => {
      c.keys(v, ["id", "name", "extensions"], p);
      name(v, p);
      const exts = c.stringList(v.extensions, `${p}.extensions`, 20);
      if (exts && exts.length === 0)
        c.issue(`${p}.extensions`, "empty", "must list at least one extension.");
      exts?.forEach((e, i) => {
        if (!FILE_EXTENSION.test(e))
          c.issue(
            `${p}.extensions[${i}]`,
            "invalid_format",
            `"${e}" is not an extension (lowercase, no dot).`,
          );
        else if (EDITOR_EXTENSIONS.has(e))
          c.issue(`${p}.extensions[${i}]`, "reserved", `.${e} has its own editor.`);
      });
      if (perms.read.length === 0)
        c.issue(p, "needs_read", "A viewer reads files, so permissions.read must not be empty.");
      return c.string(v.id, `${p}.id`, 64, ITEM_ID, "id");
    },
    "viewer",
  ) as typeof out.viewers;

  out.baseViews = eachItem(
    c,
    o.baseViews,
    "contributes.baseViews",
    L.baseViews,
    (v, p) => {
      c.keys(v, ["type", "name"], p);
      name(v, p);
      const type = c.string(v.type, `${p}.type`, 32, TYPE_NAME, "view type");
      if (type && RESERVED_BASE_VIEWS.has(type))
        c.issue(`${p}.type`, "reserved", `"${type}" is a built-in view.`);
      return type;
    },
    "base view",
  ) as typeof out.baseViews;

  out.homeWidgets = eachItem(
    c,
    o.homeWidgets,
    "contributes.homeWidgets",
    L.homeWidgets,
    (v, p) => {
      c.keys(v, ["id", "name", "size"], p);
      name(v, p);
      if (v.size !== undefined && !["small", "medium", "large"].includes(v.size as string)) {
        c.issue(`${p}.size`, "invalid_value", "must be small, medium or large.");
      }
      return c.string(v.id, `${p}.id`, 64, ITEM_ID, "id");
    },
    "home widget",
  ) as typeof out.homeWidgets;

  out.extensionPoints = eachItem(
    c,
    o.extensionPoints,
    "contributes.extensionPoints",
    L.extensionPoints,
    (v, p) => {
      c.keys(v, ["id", "name", "description"], p);
      if (v.name !== undefined) name(v, p);
      if (v.description !== undefined)
        c.localized(v.description, `${p}.description`, L.descriptionLength);
      return c.string(v.id, `${p}.id`, 64, ITEM_ID, "id");
    },
    "extension point",
  ) as typeof out.extensionPoints;

  out.extensions = eachItem(
    c,
    o.extensions,
    "contributes.extensions",
    L.extensions,
    (v, p) => {
      c.keys(v, ["plugin", "point"], p);
      const plugin = c.string(v.plugin, `${p}.plugin`, 64, PLUGIN_ID_PATTERN, "plugin id");
      const point = c.string(v.point, `${p}.point`, 64, ITEM_ID, "point id");
      return plugin && point ? `${plugin}/${point}` : undefined;
    },
    "extension",
  ) as typeof out.extensions;

  out.slots = eachItem(
    c,
    o.slots,
    "contributes.slots",
    L.slots,
    (v, p) => {
      c.keys(v, ["slot", "id", "title", "icon"], p);
      c.localized(v.title, `${p}.title`, L.nameLength);
      icon(v, p);
      if (!SLOT_NAMES.includes(v.slot as never)) {
        c.issue(`${p}.slot`, "invalid_value", `must be one of ${SLOT_NAMES.join(", ")}.`);
      }
      const id = c.string(v.id, `${p}.id`, 64, ITEM_ID, "id");
      return id && typeof v.slot === "string" ? `${v.slot}/${id}` : undefined;
    },
    "slot entry",
  ) as typeof out.slots;

  out.tools = eachItem(
    c,
    o.tools,
    "contributes.tools",
    L.tools,
    (v, p) => {
      c.keys(v, ["name", "description", "inputSchema", "readOnly"], p);
      c.string(v.description, `${p}.description`, L.toolDescriptionLength);
      checkJsonSchema(c, v.inputSchema, `${p}.inputSchema`);
      if (v.readOnly !== undefined && typeof v.readOnly !== "boolean") {
        c.issue(`${p}.readOnly`, "invalid_type", "must be true or false.");
      }
      return c.string(
        v.name,
        `${p}.name`,
        48,
        TOOL_NAME,
        "tool name (lowercase letters, digits, underscores)",
      );
    },
    "tool",
  ) as typeof out.tools;

  if (o.theme !== undefined) {
    const t = c.object(o.theme, "contributes.theme");
    if (t) {
      c.keys(t, ["name", "css"], "contributes.theme");
      name(t, "contributes.theme");
      c.file(t.css, "contributes.theme.css", [".css"]);
      out.theme = t as unknown as typeof out.theme;
    }
  }
  if (o.app !== undefined) {
    const a = c.object(o.app, "contributes.app");
    if (a) {
      c.keys(a, ["name", "icon"], "contributes.app");
      name(a, "contributes.app");
      icon(a, "contributes.app");
      out.app = a as unknown as typeof out.app;
    }
  }
  return out;
}

/**
 * Checks a parsed `manifest.json`. On success the returned manifest is a normalized copy with all
 * defaults filled in; `warnings` list powerful-but-legal requests the approval screen should
 * highlight. Never throws.
 */
export function validateManifest(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const c = new Checker();
  const m = c.object(input, "");
  if (!m) return { ok: false, issues: c.issues };

  if (m.manifestVersion !== MANIFEST_VERSION) {
    c.issue(
      "manifestVersion",
      "unsupported_version",
      m.manifestVersion === undefined || m.manifestVersion === 1
        ? `This looks like a version 1 manifest; set "manifestVersion": ${MANIFEST_VERSION} or convert it with convertLegacyManifest().`
        : `manifestVersion must be ${MANIFEST_VERSION}.`,
    );
    return { ok: false, issues: c.issues };
  }
  c.keys(
    m,
    [
      "manifestVersion",
      "id",
      "version",
      "name",
      "description",
      "author",
      "license",
      "homepage",
      "minPalimvo",
      "permissions",
      "dependencies",
      "contributes",
      "main",
      "server",
      "locales",
    ],
    "",
  );

  const id = c.string(
    m.id,
    "id",
    64,
    PLUGIN_ID_PATTERN,
    "plugin id (lowercase letters, digits, hyphens)",
  );
  const version = c.string(m.version, "version", 64);
  if (version && !isStrictVersion(version))
    c.issue("version", "invalid_format", "must look like 1.2.3 or 1.2.3-beta.1.");
  const pluginName = c.localized(m.name, "name", L.nameLength);
  const description =
    m.description === undefined
      ? undefined
      : c.localized(m.description, "description", L.descriptionLength);
  const author = m.author === undefined ? undefined : c.string(m.author, "author", L.shortText);
  const license = m.license === undefined ? undefined : c.string(m.license, "license", L.shortText);
  const homepage =
    m.homepage === undefined
      ? undefined
      : c.string(m.homepage, "homepage", 300, /^https:\/\/[^\s]+$/, "https URL");

  let minPalimvo: string | undefined;
  if (m.minPalimvo !== undefined) {
    minPalimvo = c.string(m.minPalimvo, "minPalimvo", 64);
    if (minPalimvo && !isStrictVersion(minPalimvo)) {
      c.issue("minPalimvo", "invalid_format", "must look like 0.1.0.");
      minPalimvo = undefined;
    } else if (
      minPalimvo &&
      options.palimvoVersion &&
      compareVersions(options.palimvoVersion, minPalimvo) < 0
    ) {
      c.issue(
        "minPalimvo",
        "incompatible",
        `Needs Palimvo ${minPalimvo} or newer (this is ${options.palimvoVersion}).`,
      );
    }
  }

  const permissions = checkPermissions(c, m.permissions);

  const dependencies: Record<string, string> = {};
  if (m.dependencies !== undefined) {
    const d = c.object(m.dependencies, "dependencies");
    if (d) {
      if (Object.keys(d).length > L.dependencies)
        c.issue("dependencies", "too_many", `can have at most ${L.dependencies} entries.`);
      for (const [dep, range] of Object.entries(d)) {
        const p = `dependencies.${dep}`;
        if (!PLUGIN_ID_PATTERN.test(dep)) c.issue(p, "invalid_format", "key is not a plugin id.");
        else if (dep === id) c.issue(p, "self_dependency", "A plugin cannot depend on itself.");
        const r = c.string(range, p, 100);
        if (r === undefined) continue;
        if (!isVersionRange(r))
          c.issue(p, "invalid_range", `"${r}" is not a version range like ^1.0.0.`);
        else dependencies[dep] = r;
      }
    }
  }

  const contributes = checkContributes(c, m.contributes, permissions);
  for (const [i, use] of contributes.extensions.entries()) {
    if (!(use.plugin in dependencies)) {
      c.issue(
        `contributes.extensions[${i}].plugin`,
        "missing_dependency",
        `"${use.plugin}" must be listed in dependencies.`,
      );
    }
  }

  const main = m.main === undefined ? DEFAULT_MAIN_FILE : c.file(m.main, "main", [".js", ".mjs"]);
  let server: string | undefined;
  if (m.server !== undefined) server = c.file(m.server, "server", [".js"]);
  else if (contributes.tools.length > 0) {
    c.issue("server", "required", "A plugin with contributes.tools needs a server entry file.");
  }

  let locales: Record<string, string> | undefined;
  if (m.locales !== undefined) {
    const l = c.object(m.locales, "locales");
    if (l) {
      if (Object.keys(l).length > L.locales)
        c.issue("locales", "too_many", `can have at most ${L.locales} entries.`);
      locales = {};
      for (const [locale, file] of Object.entries(l)) {
        if (!LOCALE.test(locale))
          c.issue(`locales.${locale}`, "invalid_locale", "is not a locale code like en or zh-TW.");
        const f = c.file(file, `locales.${locale}`, [".json"]);
        if (f) locales[locale] = f;
      }
    }
  }

  if (c.issues.length > 0 || !id || !version || !pluginName || !main)
    return { ok: false, issues: c.issues };

  const manifest: PluginManifest = {
    manifestVersion: MANIFEST_VERSION,
    id,
    version,
    name: pluginName,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(minPalimvo !== undefined ? { minPalimvo } : {}),
    permissions,
    dependencies,
    contributes,
    main,
    ...(server !== undefined ? { server } : {}),
    ...(locales !== undefined ? { locales } : {}),
  };
  return { ok: true, manifest, warnings: c.warnings };
}

/** Like `validateManifest` but throws an Error listing every issue; for scripts and tests. */
export function parseManifest(input: unknown, options?: ValidateOptions): PluginManifest {
  const result = validateManifest(input, options);
  if (!result.ok) {
    throw new Error(result.issues.map((i) => `${i.path || "(manifest)"}: ${i.message}`).join("\n"));
  }
  return result.manifest;
}
