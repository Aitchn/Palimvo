/**
 * Databases: Obsidian Bases (.base) files. A base is YAML describing which notes
 * to show (filters on tags, folders, properties), computed columns (formulas)
 * and views (table or cards, sorted and grouped). The rows are the vault's
 * notes; their columns are the notes' frontmatter properties, so editing a
 * cell edits the note.
 */
import { isMap, parse as parseYaml, parseDocument, stringify } from "yaml";
import {
  FrontmatterError,
  parseFrontmatter,
  propertyTags,
  removeProperty,
  setProperty,
} from "./frontmatter.ts";
import {
  compareValues,
  displayText,
  trimSlashes,
  evaluate,
  fileBasename,
  fileFolder,
  parseExpr,
  truthy,
  type Expr,
  type FileValue,
  type Scope,
} from "./base-expr.ts";
import { extractWikiLinks, LinkResolver, linkResolver } from "./links.ts";
import { extractInlineTags } from "./tags.ts";

export { displayText, ExprError, parseExpr, evaluate, type FileValue } from "./base-expr.ts";

export type BaseFilter =
  string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter[] };

export interface BaseSort {
  property: string;
  direction: "ASC" | "DESC";
}

/** Binds a native database view to a code block declared by an approved plugin. */
export interface BasePluginRenderer {
  id: string;
  codeBlock: string;
  /** Same source text as the plugin's fenced Markdown block. */
  source: string;
}

/** Host-provided selection, available as app.settings.baseContext in that sandbox. */
export interface BasePluginContext {
  path?: string;
  /** Paths after native filters, sorting and limit. This is not a permission boundary. */
  paths: string[];
}

export interface BaseView {
  type: "table" | "cards" | "plugin";
  /** Approved sandbox code block. Host supplies the filtered row paths via settings.baseContext. */
  plugin?: BasePluginRenderer;
  name: string;
  filters?: BaseFilter;
  /** Columns, in order (`file.name`, `status`, `formula.total`…). */
  order?: string[];
  sort?: BaseSort[];
  /** Notes with a list value (tags) appear under each of its entries. */
  groupBy?: BaseSort;
  limit?: number;
  /** Cards: the property holding a cover image. */
  image?: string;
}

export interface BaseFile {
  filters?: BaseFilter;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string }>;
  views: BaseView[];
}

export class BaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseError";
  }
}

export const BASE_EXTENSION = ".base";

/** Shape of a plugin id, as bound by a `plugin` view. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `[a, b]` stays as people (and Obsidian) write it, not `[ a, b ]`. */
const YAML_OPTIONS = { flowCollectionPadding: false, lineWidth: 0 };

/** The file a new database starts as. */
export const NEW_BASE = `views:
  - type: table
    name: Table
    order:
      - file.name
      - file.tags
      - file.mtime
`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkFilter(f: unknown, where: string): BaseFilter {
  if (typeof f === "string") return f;
  if (typeof f === "boolean" || typeof f === "number") return String(f);
  if (isRecord(f)) {
    const keys = Object.keys(f);
    const key = keys[0];
    if (keys.length === 1 && (key === "and" || key === "or" || key === "not")) {
      const list = f[key];
      if (!Array.isArray(list)) throw new BaseError(`${where}.${key} must be a list`);
      return { [key]: list.map((x, i) => checkFilter(x, `${where}.${key}[${i}]`)) } as BaseFilter;
    }
  }
  throw new BaseError(`${where} must be an expression string or an and / or / not list`);
}

function checkSort(s: unknown, where: string): BaseSort {
  if (typeof s === "string") return { property: s, direction: "ASC" };
  if (!isRecord(s) || typeof s.property !== "string")
    throw new BaseError(`${where} needs a property`);
  const dir = String(s.direction ?? "ASC").toUpperCase();
  return { property: s.property, direction: dir === "DESC" ? "DESC" : "ASC" };
}

/** Reads a .base file. Throws BaseError with a message people can act on. */
export function parseBase(source: string): BaseFile {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new BaseError(
      `Invalid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isRecord(raw))
    throw new BaseError("The top level of a base file must be a map (filters, formulas, views)");
  const base: BaseFile = { views: [] };
  if (raw.filters !== undefined && raw.filters !== null)
    base.filters = checkFilter(raw.filters, "filters");
  if (raw.formulas !== undefined && raw.formulas !== null) {
    if (!isRecord(raw.formulas)) throw new BaseError("formulas must map names to expressions");
    base.formulas = Object.fromEntries(
      Object.entries(raw.formulas).map(([k, v]) => [k, String(v ?? "")]),
    );
  }
  if (isRecord(raw.properties)) {
    base.properties = {};
    for (const [k, v] of Object.entries(raw.properties)) {
      if (isRecord(v))
        base.properties[k] = {
          displayName: typeof v.displayName === "string" ? v.displayName : undefined,
        };
    }
  }
  const views = raw.views ?? [];
  if (!Array.isArray(views)) throw new BaseError("views must be a list");
  views.forEach((v, i) => {
    if (!isRecord(v)) throw new BaseError(`views[${i}] must be a map`);
    const view: BaseView = {
      type: v.type === "plugin" ? "plugin" : v.type === "cards" ? "cards" : "table",
      name: typeof v.name === "string" && v.name.trim() ? v.name : `View ${i + 1}`,
    };
    if (view.type === "plugin") {
      const p = v.plugin;
      if (
        !isRecord(p) ||
        typeof p.id !== "string" ||
        !PLUGIN_ID.test(p.id) ||
        typeof p.codeBlock !== "string" ||
        !p.codeBlock.trim() ||
        typeof p.source !== "string" ||
        new TextEncoder().encode(p.source).length > 1048576
      ) {
        throw new BaseError(`views[${i}].plugin needs id, codeBlock and source (at most 1 MiB)`);
      }
      view.plugin = { id: p.id, codeBlock: p.codeBlock, source: p.source };
    }
    if (v.filters !== undefined && v.filters !== null)
      view.filters = checkFilter(v.filters, `views[${i}].filters`);
    if (Array.isArray(v.order)) view.order = v.order.map(String);
    if (Array.isArray(v.sort))
      view.sort = v.sort.map((s, j) => checkSort(s, `views[${i}].sort[${j}]`));
    if (v.groupBy !== undefined && v.groupBy !== null)
      view.groupBy = checkSort(v.groupBy, `views[${i}].groupBy`);
    if (typeof v.limit === "number" && v.limit > 0) view.limit = Math.floor(v.limit);
    if (typeof v.image === "string") view.image = v.image;
    base.views.push(view);
  });
  if (base.views.length === 0) base.views.push({ type: "table", name: "Table" });
  return base;
}

const MODELED = new Set(["filters", "formulas", "properties", "views"]);
const VIEW_KEYS = new Set([
  "type",
  "name",
  "filters",
  "order",
  "sort",
  "groupBy",
  "limit",
  "image",
  "plugin",
]);

/**
 * Writes `next` back into the YAML text, replacing only the top-level sections
 * that changed, so comments and formatting elsewhere survive.
 */
export function updateBaseSource(source: string, next: BaseFile): string {
  const doc = parseDocument(source.trim() ? source : "{}");
  if (doc.errors.length || !isMap(doc.contents)) return stringify(clean(next));
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const after = clean(next) as Record<string, unknown>;
  // Fields this module does not model (summaries, groupOrder, ...) stay as they are in the file.
  for (const key of Object.keys(before)) if (MODELED.has(key) && !(key in after)) doc.delete(key);
  if (isRecord(after.properties) && isRecord(before.properties)) {
    for (const [key, value] of Object.entries(after.properties)) {
      const old = before.properties[key];
      if (isRecord(old) && isRecord(value)) after.properties[key] = { ...old, ...value };
    }
  }
  if (Array.isArray(after.views) && Array.isArray(before.views)) {
    const old = before.views.filter(isRecord);
    after.views = after.views.map((view: Record<string, unknown>, i) => {
      const prev = old.find((o) => o.name === view.name) ?? old[i];
      if (!prev) return view;
      const extra = Object.fromEntries(Object.entries(prev).filter(([k]) => !VIEW_KEYS.has(k)));
      return { ...view, ...extra };
    });
  }
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) doc.set(key, doc.createNode(value));
  }
  const text = doc.toString(YAML_OPTIONS);
  return text.trim() === "{}" ? "" : text;
}

/** Drops empty and undefined fields so the YAML stays tidy. */
function clean(base: BaseFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (
    base.filters !== undefined &&
    !(isRecord(base.filters) && Object.values(base.filters)[0]?.length === 0)
  )
    out.filters = base.filters;
  if (base.formulas && Object.keys(base.formulas).length) out.formulas = base.formulas;
  if (base.properties && Object.keys(base.properties).length) out.properties = base.properties;
  out.views = base.views.map((v) => {
    const view: Record<string, unknown> = { type: v.type, name: v.name };
    if (
      v.filters !== undefined &&
      !(isRecord(v.filters) && Object.values(v.filters)[0]?.length === 0)
    )
      view.filters = v.filters;
    if (v.order?.length) view.order = v.order;
    if (v.sort?.length) view.sort = v.sort;
    if (v.groupBy) view.groupBy = v.groupBy;
    if (v.limit) view.limit = v.limit;
    if (v.image) view.image = v.image;
    if (v.type === "plugin" && v.plugin) view.plugin = v.plugin;
    return view;
  });
  return out;
}

// --- notes as rows ---

/** A note's frontmatter properties (any YAML), or {} when it has none or it is broken. */
export function noteProperties(content: string): Record<string, unknown> {
  return parseFrontmatter(content).properties;
}

/** Tags of a note: `tags:` in its properties plus #tags in the text (not in code), without "#". */
export function noteTags(content: string, properties = noteProperties(content)): string[] {
  const tags = new Set(propertyTags(properties));
  for (const tag of extractInlineTags(parseFrontmatter(content).body))
    tags.add(trimSlashes(tag, "end"));
  return [...tags];
}

export interface BaseNoteInput {
  path: string;
  content: string;
  mtime: number;
  ctime?: number;
}

/** What filters and columns see of one note. `paths`: every file in the vault (or a shared `LinkResolver` over them), to resolve links. */
export function baseFile(input: BaseNoteInput, paths: readonly string[] | LinkResolver): FileValue {
  const properties = noteProperties(input.content);
  const links = new Set<string>();
  // Pass one shared LinkResolver when indexing a whole vault, so the path tables are built once.
  const resolver = paths instanceof LinkResolver ? paths : linkResolver(paths);
  for (const link of extractWikiLinks(input.content)) {
    links.add(resolver.resolve(link.target, input.path) ?? link.target);
  }
  return {
    kind: "file",
    path: input.path,
    mtime: input.mtime,
    ctime: input.ctime ?? input.mtime,
    size: new TextEncoder().encode(input.content).length,
    tags: noteTags(input.content, properties),
    links: [...links],
    properties,
  };
}

// --- queries ---

export type CellValue = string | number | boolean | null | CellValue[];

export interface BaseColumn {
  id: string;
  label: string;
  /** Where the value comes from: a file field, a note property (editable) or a formula. */
  source: "file" | "note" | "formula";
  /** The property / field / formula name. */
  key: string;
}

export interface BaseRow {
  path: string;
  cells: Record<string, CellValue>;
}

export interface BaseGroup {
  label: string;
  rows: number[];
}

export interface BaseResult {
  views: { name: string; type: BaseView["type"] }[];
  viewIndex: number;
  view: BaseView;
  columns: BaseColumn[];
  rows: BaseRow[];
  groups: BaseGroup[] | null;
  /** Matching notes before `limit`. */
  total: number;
  /** Filters or formulas that could not run (they count as "no match"). */
  errors: string[];
  /** For building filters and columns: what the vault's notes have. */
  available: { properties: string[]; tags: string[]; folders: string[]; formulas: string[] };
}

const FILE_LABELS: Record<string, string> = {
  name: "Name",
  basename: "Name",
  path: "Path",
  folder: "Folder",
  ext: "Extension",
  size: "Size",
  mtime: "Modified",
  ctime: "Created",
  tags: "Tags",
  links: "Links",
};

/** The file fields offered as columns. */
export const FILE_COLUMNS = [
  "file.name",
  "file.folder",
  "file.tags",
  "file.mtime",
  "file.ctime",
  "file.links",
  "file.size",
];

export function baseColumn(id: string, base?: BaseFile): BaseColumn {
  const display = base?.properties?.[id]?.displayName;
  if (id.startsWith("file.")) {
    const key = id.slice(5);
    return { id, key, source: "file", label: display ?? FILE_LABELS[key] ?? key };
  }
  if (id.startsWith("formula.")) {
    const key = id.slice(8);
    return { id, key, source: "formula", label: display ?? key };
  }
  const key = id.startsWith("note.") ? id.slice(5) : id;
  return { id, key, source: "note", label: display ?? base?.properties?.[key]?.displayName ?? key };
}

function toCell(v: unknown): CellValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(toCell);
  if (v instanceof Date || (isRecord(v) && v.kind === "file")) return displayText(v);
  return displayText(v);
}

export interface QueryOptions {
  /** View name or index; the first view by default. */
  view?: string | number;
  /** The file the base is shown in (`this` in expressions). */
  thisFile?: FileValue;
  now?: number;
  /** Columns to return instead of the view's own (components pick the ones they draw). */
  columns?: string[];
}

/** Runs one view of a base over the vault's notes. */
export function queryBase(
  base: BaseFile,
  files: readonly FileValue[],
  options: QueryOptions = {},
): BaseResult {
  const viewIndex =
    typeof options.view === "number"
      ? Math.min(Math.max(0, options.view), base.views.length - 1)
      : Math.max(
          0,
          base.views.findIndex((v) => v.name === options.view),
        );
  const view = base.views[viewIndex]!;
  const errors = new Set<string>();
  const now = options.now ?? Date.now();

  const compiled = new Map<string, Expr | null>();
  const compile = (src: string): Expr | null => {
    if (!compiled.has(src)) {
      try {
        compiled.set(src, parseExpr(src));
      } catch (err) {
        errors.add(`"${src}": ${err instanceof Error ? err.message : String(err)}`);
        compiled.set(src, null);
      }
    }
    return compiled.get(src)!;
  };

  const scopeFor = (file: FileValue): Scope => {
    const cache = new Map<string, unknown>();
    const busy = new Set<string>();
    const scope: Scope = {
      file,
      thisFile: options.thisFile,
      now,
      formula: (name) => {
        if (cache.has(name)) return cache.get(name);
        const src = base.formulas?.[name];
        if (src === undefined) return null;
        if (busy.has(name)) {
          errors.add(`Formula ${name} refers to itself`);
          return null;
        }
        busy.add(name);
        const value = run(src, scope);
        busy.delete(name);
        cache.set(name, value);
        return value;
      },
    };
    return scope;
  };

  const run = (src: string, scope: Scope): unknown => {
    const expr = compile(src);
    if (!expr) return null;
    try {
      return evaluate(expr, scope);
    } catch (err) {
      errors.add(`"${src}": ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const matches = (filter: BaseFilter | undefined, scope: Scope): boolean => {
    if (filter === undefined) return true;
    if (typeof filter === "string") return filter.trim() === "" || truthy(run(filter, scope));
    if ("and" in filter) return filter.and.every((f) => matches(f, scope));
    if ("or" in filter) return filter.or.length === 0 || filter.or.some((f) => matches(f, scope));
    return !filter.not.some((f) => matches(f, scope));
  };

  const value = (column: BaseColumn, scope: Scope): unknown => {
    if (column.source === "formula") return scope.formula(column.key);
    if (column.source === "note") return scope.file.properties[column.key];
    if (column.key === "name") return fileBasename(scope.file.path);
    return run(column.id, scope);
  };

  // Rows: matching notes with their scopes, sorted.
  let rows = files
    .map((file) => ({ file, scope: scopeFor(file) }))
    .filter(({ scope }) => matches(base.filters, scope) && matches(view.filters, scope));
  const sort = view.sort ?? [];
  if (sort.length) {
    const sortColumns = sort.map((s) => ({
      column: baseColumn(s.property, base),
      dir: s.direction === "DESC" ? -1 : 1,
    }));
    const keyed = rows.map((r) => ({ r, keys: sortColumns.map((s) => value(s.column, r.scope)) }));
    keyed.sort((a, b) => {
      for (let i = 0; i < sortColumns.length; i++) {
        const av = a.keys[i];
        const bv = b.keys[i];
        const c = compareValues(av, bv);
        // Empty values stay last whichever way the column is sorted.
        if (c !== 0) return isBlank(av) || isBlank(bv) ? c : c * sortColumns[i]!.dir;
      }
      return a.r.file.path.localeCompare(b.r.file.path);
    });
    rows = keyed.map((k) => k.r);
  } else {
    rows.sort((a, b) => a.file.path.localeCompare(b.file.path));
  }
  const total = rows.length;
  if (view.limit) rows = rows.slice(0, view.limit);

  const order = options.columns?.length
    ? options.columns
    : view.order?.length
      ? view.order
      : defaultOrder(files);
  const columns = order.map((id) => baseColumn(id, base));
  const extra = [view.image, view.groupBy?.property].filter(
    (id): id is string => !!id && !order.includes(id),
  );
  const cellColumns = [...columns, ...extra.map((id) => baseColumn(id, base))];

  const out: BaseRow[] = rows.map(({ file, scope }) => ({
    path: file.path,
    cells: Object.fromEntries(cellColumns.map((c) => [c.id, toCell(value(c, scope))])),
  }));

  let groups: BaseGroup[] | null = null;
  if (view.groupBy) {
    const id = view.groupBy.property;
    const byLabel = new Map<string, { sortKey: unknown; rows: number[] }>();
    out.forEach((row, i) => {
      const v = row.cells[id] ?? null;
      const entries = Array.isArray(v) ? (v.length ? v : [null]) : [v];
      for (const entry of new Set(entries.map((e) => (isBlank(e) ? "" : displayText(e))))) {
        const g = byLabel.get(entry) ?? {
          sortKey: entries.find((e) => displayText(e) === entry) ?? entry,
          rows: [],
        };
        g.rows.push(i);
        byLabel.set(entry, g);
      }
    });
    const dir = view.groupBy.direction === "DESC" ? -1 : 1;
    groups = [...byLabel.entries()]
      .sort(([la, a], [lb, b]) =>
        la === "" ? 1 : lb === "" ? -1 : compareValues(a.sortKey, b.sortKey) * dir,
      )
      .map(([label, g]) => ({ label, rows: g.rows }));
  }

  return {
    views: base.views.map((v) => ({ name: v.name, type: v.type })),
    viewIndex,
    view,
    columns,
    rows: out,
    groups,
    total,
    errors: [...errors],
    available: available(files, base),
  };
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Without `order`: the name, then the properties most notes have. */
function defaultOrder(files: readonly FileValue[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files)
    for (const k of Object.keys(f.properties)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const props = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([k]) => k);
  return ["file.name", ...props];
}

function available(files: readonly FileValue[], base: BaseFile): BaseResult["available"] {
  const properties = new Set<string>();
  const tags = new Set<string>();
  const folders = new Set<string>();
  for (const f of files) {
    for (const k of Object.keys(f.properties)) properties.add(k);
    for (const t of f.tags) tags.add(t);
    let folder = fileFolder(f.path);
    while (folder) {
      folders.add(folder);
      folder = fileFolder(folder);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    properties: sorted(properties),
    tags: sorted(tags),
    folders: sorted(folders),
    formulas: Object.keys(base.formulas ?? {}),
  };
}

// --- editing notes ---

/**
 * Sets (or with null / "" / [] removes) one frontmatter property of a note,
 * keeping the rest of its properties, their comments and the note's text as they are.
 */
export function setNoteProperty(content: string, key: string, value: unknown): string {
  if (!key.trim()) throw new BaseError("A property name cannot be empty");
  const remove =
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  try {
    return remove ? removeProperty(content, key) : setProperty(content, key, value);
  } catch (err) {
    if (err instanceof FrontmatterError)
      throw new BaseError(
        `This note's properties are not valid YAML properties (${err.message}); fix them in the note first`,
      );
    throw err;
  }
}

/** Filters that read like "has tag X" / "in folder Y" / "status is Z", collected so a new row starts out matching them. */
export function newRowTemplate(
  base: BaseFile,
  viewIndex = 0,
): { folder?: string; properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  const tags: string[] = [];
  let folder: string | undefined;
  const visit = (f: BaseFilter | undefined) => {
    if (f === undefined) return;
    if (typeof f === "string") {
      const s = f.trim();
      let m = /^file\.hasTag\(\s*["']([^"']+)["']\s*\)$/.exec(s);
      if (m) tags.push(m[1]!.replace(/^#/, ""));
      m = /^file\.inFolder\(\s*["']([^"']+)["']\s*\)$/.exec(s);
      if (m) folder ??= trimSlashes(m[1]!);
      m =
        /^(?:note\.)?([\p{L}_][\p{L}\p{N}_]*)\s*==\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false))$/u.exec(
          s,
        );
      if (m && m[1] !== "file")
        properties[m[1]!] = m[2] ?? m[3] ?? (m[4] !== undefined ? Number(m[4]) : m[5] === "true");
      return;
    }
    if ("and" in f) f.and.forEach(visit);
  };
  visit(base.filters);
  visit(base.views[viewIndex]?.filters);
  if (tags.length)
    properties.tags = [
      ...new Set([
        ...(Array.isArray(properties.tags) ? (properties.tags as string[]) : []),
        ...tags,
      ]),
    ];
  return { folder, properties };
}
