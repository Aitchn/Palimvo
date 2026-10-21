/**
 * The expression language of Obsidian Bases filters and formulas, enough of it
 * for everyday databases: `file.hasTag("book")`, `status == "done"`,
 * `price * 2`, `tags.contains("x") && !file.inFolder("archive")`,
 * `if(done, "✓", "")`.
 */

export type Expr =
  | { t: "lit"; value: unknown }
  | { t: "id"; name: string }
  | { t: "get"; obj: Expr; name: string }
  | { t: "index"; obj: Expr; index: Expr }
  | { t: "call"; fn: Expr; args: Expr[] }
  | { t: "unary"; op: "!" | "-"; arg: Expr }
  | { t: "bin"; op: string; left: Expr; right: Expr }
  | { t: "list"; items: Expr[] };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

const OPS = [
  "==",
  "!=",
  ">=",
  "<=",
  "&&",
  "||",
  ">",
  "<",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  ",",
  ".",
  "[",
  "]",
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        s += src[i++];
      }
      if (i >= src.length) throw new ExprError("Unterminated string");
      i++;
      out.push({ k: "str", v: s });
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    // Property names may be any word, including CJK ones.
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected character "${c}"`);
    out.push({ k: "op", v: op });
    i += op.length;
  }
  return out;
}

const BINARY: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  "<": 4,
  ">=": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}" here`);
    pos++;
  };

  const primary = (): Expr => {
    const tok = tokens[pos++];
    if (!tok) throw new ExprError("Incomplete expression");
    if (tok.k === "num" || tok.k === "str") return { t: "lit", value: tok.v };
    if (tok.k === "id") {
      if (tok.v === "true" || tok.v === "false") return { t: "lit", value: tok.v === "true" };
      if (tok.v === "null") return { t: "lit", value: null };
      return { t: "id", name: tok.v };
    }
    if (tok.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (tok.v === "[") {
      const items: Expr[] = [];
      while (!isOp("]")) {
        items.push(expr(0));
        if (!isOp("]")) expect(",");
      }
      pos++;
      return { t: "list", items };
    }
    if (tok.v === "!" || tok.v === "-") return { t: "unary", op: tok.v, arg: postfix(primary()) };
    throw new ExprError(`Unexpected "${tok.v}"`);
  };

  const postfix = (e: Expr): Expr => {
    for (;;) {
      if (isOp(".")) {
        pos++;
        const name = tokens[pos++];
        if (name?.k !== "id") throw new ExprError('Expected a name after "."');
        e = { t: "get", obj: e, name: name.v };
      } else if (isOp("(")) {
        pos++;
        const args: Expr[] = [];
        while (!isOp(")")) {
          args.push(expr(0));
          if (!isOp(")")) expect(",");
        }
        pos++;
        e = { t: "call", fn: e, args };
      } else if (isOp("[")) {
        pos++;
        const index = expr(0);
        expect("]");
        e = { t: "index", obj: e, index };
      } else {
        return e;
      }
    }
  };

  const expr = (min: number): Expr => {
    let left = postfix(primary());
    for (;;) {
      const tok = peek();
      const prec = tok?.k === "op" ? BINARY[tok.v] : undefined;
      if (prec === undefined || prec < min) return left;
      pos++;
      left = { t: "bin", op: String(tok!.v), left, right: expr(prec + 1) };
    }
  };

  const result = expr(0);
  if (pos < tokens.length) throw new ExprError(`Unexpected extra "${String(tokens[pos]!.v)}"`);
  return result;
}

// --- values ---

/** A file as expressions see it (`file`, `this.file`). */
export interface FileValue {
  readonly kind: "file";
  path: string;
  mtime: number;
  ctime: number;
  size: number;
  tags: string[];
  /** Resolved paths this file links to. */
  links: string[];
  properties: Record<string, unknown>;
}

/** Where names resolve: `file`, `note`, `formula`, `this`, and bare note property names. */
export interface Scope {
  file: FileValue;
  formula: (name: string) => unknown;
  thisFile?: FileValue;
  now: number;
}

const isFile = (v: unknown): v is FileValue =>
  typeof v === "object" && v !== null && (v as FileValue).kind === "file";

/** Strips leading and trailing slashes (a loop rather than a regex, so long runs of "/" stay linear). */
export function trimSlashes(text: string, ends: "both" | "start" | "end" = "both"): string {
  let start = 0;
  let end = text.length;
  if (ends !== "end") while (start < end && text[start] === "/") start++;
  if (ends !== "start") while (end > start && text[end - 1] === "/") end--;
  return text.slice(start, end);
}

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const fileBasename = (path: string) => fileName(path).replace(/\.[^.]+$/, "");
export const fileFolder = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const fileExt = (path: string) => {
  const name = fileName(path);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
};

/** `#a/b` is also a hit for "a"; matching ignores case and a leading "#". */
export function tagMatches(tag: string, wanted: string): boolean {
  const t = tag.replace(/^#/, "").toLowerCase();
  const w = wanted.replace(/^#/, "").toLowerCase();
  return t === w || t.startsWith(`${w}/`);
}

function fileField(f: FileValue, name: string): unknown {
  switch (name) {
    case "path":
      return f.path;
    case "name":
      return fileName(f.path);
    case "basename":
      return fileBasename(f.path);
    case "folder":
      return fileFolder(f.path);
    case "ext":
      return fileExt(f.path);
    case "size":
      return f.size;
    case "mtime":
      return new Date(f.mtime);
    case "ctime":
      return new Date(f.ctime);
    case "tags":
      return f.tags;
    case "links":
      return f.links;
    case "properties":
      return f.properties;
    case "file":
      return f;
    default:
      return undefined;
  }
}

/** Link targets as strings, files or [[wikilinks]] all name a path (or a note name). */
function linkTarget(v: unknown): string {
  if (isFile(v)) return v.path;
  return String(v ?? "")
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]!
    .split("#")[0]!
    .trim();
}

function samePath(path: string, target: string): boolean {
  const p = path.toLowerCase();
  const t = trimSlashes(target.toLowerCase(), "start");
  return p === t || p === `${t}.md` || p.endsWith(`/${t}`) || p.endsWith(`/${t}.md`);
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return Boolean(v);
}

export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && !(v instanceof Date) && !isFile(v))
    return Object.keys(v).length === 0;
  return false;
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Orders values for sorting and `<`/`>`: numbers, dates, then text; empty values last. */
export function compareValues(a: unknown, b: unknown): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const da = toDate(a);
  const db = toDate(b);
  if (da && db) return da.getTime() - db.getTime();
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b)))
    return a - Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && !Number.isNaN(Number(a)))
    return Number(a) - b;
  return displayText(a).localeCompare(displayText(b), undefined, { numeric: true });
}

export function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
  if (isFile(a) || isFile(b))
    return (
      linkTarget(a) !== "" &&
      samePath(isFile(a) ? a.path : linkTarget(b), linkTarget(isFile(a) ? b : a))
    );
  const da = toDate(a);
  const db = toDate(b);
  if (da && db && (a instanceof Date || b instanceof Date)) return da.getTime() === db.getTime();
  if (typeof a === "number" && typeof b === "string") return b.trim() !== "" && Number(b) === a;
  if (typeof b === "number" && typeof a === "string") return a.trim() !== "" && Number(a) === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

/** How a value reads in a table cell or a group heading. */
export function displayText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(displayText).join(", ");
  if (v instanceof Date)
    return formatDate(v, v.getHours() || v.getMinutes() ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD");
  if (isFile(v)) return fileBasename(v.path);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const pad = (n: number) => String(n).padStart(2, "0");
function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

const MAX_DEPTH = 64;

export function evaluate(e: Expr, scope: Scope, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new ExprError("Expression is nested too deeply");
  const ev = (x: Expr) => evaluate(x, scope, depth + 1);
  switch (e.t) {
    case "lit":
      return e.value;
    case "list":
      return e.items.map(ev);
    case "id":
      if (e.name === "file") return scope.file;
      if (e.name === "note") return scope.file.properties;
      if (e.name === "formula") return { kind: "formulas" };
      if (e.name === "this")
        return scope.thisFile ? { ...scope.thisFile.properties, file: scope.thisFile } : {};
      return scope.file.properties[e.name];
    case "get": {
      const obj = ev(e.obj);
      if (obj && typeof obj === "object" && (obj as { kind?: string }).kind === "formulas")
        return scope.formula(e.name);
      return getField(obj, e.name);
    }
    case "index": {
      const obj = ev(e.obj);
      const index = ev(e.index);
      if (Array.isArray(obj))
        return obj[Number(index) < 0 ? obj.length + Number(index) : Number(index)];
      if (obj && typeof obj === "object" && (obj as { kind?: string }).kind === "formulas")
        return scope.formula(String(index));
      return getField(obj, String(index));
    }
    case "unary": {
      const v = ev(e.arg);
      return e.op === "!" ? !truthy(v) : -Number(v);
    }
    case "bin":
      return binary(e.op, e.left, e.right, ev);
    case "call":
      return call(e, scope, ev);
  }
}

function getField(obj: unknown, name: string): unknown {
  if (isFile(obj)) return fileField(obj, name);
  if (name === "length" && (typeof obj === "string" || Array.isArray(obj))) return obj.length;
  if (obj instanceof Date) {
    if (name === "year") return obj.getFullYear();
    if (name === "month") return obj.getMonth() + 1;
    if (name === "day") return obj.getDate();
    if (name === "hour") return obj.getHours();
    if (name === "minute") return obj.getMinutes();
    return undefined;
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj))
    return (obj as Record<string, unknown>)[name];
  return undefined;
}

function binary(op: string, l: Expr, r: Expr, ev: (x: Expr) => unknown): unknown {
  if (op === "&&") return truthy(ev(l)) && truthy(ev(r));
  if (op === "||") {
    const a = ev(l);
    return truthy(a) ? a : ev(r);
  }
  const a = ev(l);
  const b = ev(r);
  switch (op) {
    case "==":
      return equalValues(a, b);
    case "!=":
      return !equalValues(a, b);
    case ">":
      return !isEmpty(a) && !isEmpty(b) && compareValues(a, b) > 0;
    case "<":
      return !isEmpty(a) && !isEmpty(b) && compareValues(a, b) < 0;
    case ">=":
      return !isEmpty(a) && !isEmpty(b) && compareValues(a, b) >= 0;
    case "<=":
      return !isEmpty(a) && !isEmpty(b) && compareValues(a, b) <= 0;
    case "+": {
      if (typeof a === "number" && typeof b === "number") return a + b;
      const date = toDate(a);
      if (date && typeof b === "string" && DURATION.test(b)) return addDuration(date, b, 1);
      if (Array.isArray(a)) return a.concat(b);
      return displayText(a) + displayText(b);
    }
    case "-": {
      const da = toDate(a);
      if (da && typeof b === "string" && DURATION.test(b)) return addDuration(da, b, -1);
      const db = toDate(b);
      if (da && db) return da.getTime() - db.getTime();
      return Number(a) - Number(b);
    }
    case "*":
      return Number(a) * Number(b);
    case "/":
      return Number(a) / Number(b);
    case "%":
      return Number(a) % Number(b);
  }
  throw new ExprError(`Unsupported operator ${op}`);
}

const DURATION =
  /^\s*(-?\d+)\s*(y|year|years|M|month|months|w|week|weeks|d|day|days|h|hour|hours|m|minute|minutes|s|second|seconds)\s*$/;

function addDuration(date: Date, text: string, sign: 1 | -1): Date {
  const [, n, unit] = DURATION.exec(text)!;
  const amount = Number(n) * sign;
  const d = new Date(date.getTime());
  const u = unit!;
  if (u.startsWith("y")) d.setFullYear(d.getFullYear() + amount);
  else if (u === "M" || u.startsWith("mo")) d.setMonth(d.getMonth() + amount);
  else if (u.startsWith("w")) d.setDate(d.getDate() + amount * 7);
  else if (u.startsWith("d")) d.setDate(d.getDate() + amount);
  else if (u.startsWith("h")) d.setHours(d.getHours() + amount);
  else if (u === "m" || u.startsWith("mi")) d.setMinutes(d.getMinutes() + amount);
  else d.setSeconds(d.getSeconds() + amount);
  return d;
}

function call(e: Extract<Expr, { t: "call" }>, scope: Scope, ev: (x: Expr) => unknown): unknown {
  const args = () => e.args.map(ev);
  if (e.fn.t === "id") return globalFunction(e.fn.name, e.args, scope, ev);
  if (e.fn.t !== "get") throw new ExprError("Only functions and methods can be called");
  const target = ev(e.fn.obj);
  return method(target, e.fn.name, args());
}

function globalFunction(
  name: string,
  rawArgs: Expr[],
  scope: Scope,
  ev: (x: Expr) => unknown,
): unknown {
  if (name === "if") {
    const [cond, then, otherwise] = rawArgs;
    if (!cond) throw new ExprError("if() needs a condition");
    return truthy(ev(cond)) ? (then ? ev(then) : null) : otherwise ? ev(otherwise) : null;
  }
  const args = rawArgs.map(ev);
  switch (name) {
    case "now":
      return new Date(scope.now);
    case "today": {
      const d = new Date(scope.now);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "date":
      return toDate(args[0]) ?? null;
    case "number": {
      const n = Number(args[0]);
      return Number.isNaN(n) ? null : n;
    }
    case "string":
      return displayText(args[0]);
    case "list":
      return Array.isArray(args[0]) ? args[0] : isEmpty(args[0]) ? [] : [args[0]];
    case "link":
      return `[[${linkTarget(args[0])}]]`;
    case "min":
      return (
        args
          .flat()
          .reduce<unknown>(
            (m, v) => (m === undefined || compareValues(v, m) < 0 ? v : m),
            undefined,
          ) ?? null
      );
    case "max":
      return (
        args
          .flat()
          .reduce<unknown>(
            (m, v) => (m === undefined || compareValues(v, m) > 0 ? v : m),
            undefined,
          ) ?? null
      );
  }
  throw new ExprError(`Unknown function ${name}()`);
}

function method(target: unknown, name: string, args: unknown[]): unknown {
  if (isFile(target)) {
    switch (name) {
      case "hasTag":
        return args.some((t) => target.tags.some((tag) => tagMatches(tag, String(t))));
      case "inFolder": {
        const folder = trimSlashes(String(args[0] ?? "")).toLowerCase();
        return folder === "" || target.path.toLowerCase().startsWith(`${folder}/`);
      }
      case "hasLink": {
        const want = linkTarget(args[0]);
        return want !== "" && target.links.some((l) => samePath(l, want));
      }
      case "hasProperty":
        return Object.prototype.hasOwnProperty.call(target.properties, String(args[0]));
      case "asLink":
        return `[[${fileBasename(target.path)}]]`;
    }
  }
  switch (name) {
    case "isEmpty":
      return isEmpty(target);
    case "isTruthy":
      return truthy(target);
    case "toString":
      return displayText(target);
    case "isType":
      return typeName(target) === String(args[0]);
  }
  if (Array.isArray(target)) {
    switch (name) {
      case "contains":
        return target.some((x) => equalValues(x, args[0]));
      case "containsAny":
        return args.some((a) => target.some((x) => equalValues(x, a)));
      case "containsAll":
        return args.every((a) => target.some((x) => equalValues(x, a)));
      case "join":
        return target.map(displayText).join(args[0] === undefined ? ", " : String(args[0]));
      case "unique":
        return target.filter((x, i) => target.findIndex((y) => equalValues(x, y)) === i);
      case "sort":
        return [...target].sort(compareValues);
      case "reverse":
        return [...target].reverse();
      case "slice":
        return target.slice(args[0] as number, args[1] as number | undefined);
      case "flat":
        return target.flat();
    }
  }
  if (typeof target === "string") {
    switch (name) {
      case "contains":
        return target.toLowerCase().includes(String(args[0] ?? "").toLowerCase());
      case "containsAny":
        return args.some((a) => target.toLowerCase().includes(String(a).toLowerCase()));
      case "containsAll":
        return args.every((a) => target.toLowerCase().includes(String(a).toLowerCase()));
      case "startsWith":
        return target.startsWith(String(args[0] ?? ""));
      case "endsWith":
        return target.endsWith(String(args[0] ?? ""));
      case "lower":
        return target.toLowerCase();
      case "upper":
        return target.toUpperCase();
      case "title":
        return target.replace(/\b\w/g, (c) => c.toUpperCase());
      case "trim":
        return target.trim();
      case "replace":
        return target.split(String(args[0] ?? "")).join(String(args[1] ?? ""));
      case "split":
        return target.split(String(args[0] ?? ","));
      case "slice":
        return target.slice(args[0] as number, args[1] as number | undefined);
    }
  }
  if (typeof target === "number") {
    switch (name) {
      case "toFixed":
        return target.toFixed(Number(args[0] ?? 0));
      case "round": {
        const f = 10 ** Number(args[0] ?? 0);
        return Math.round(target * f) / f;
      }
      case "floor":
        return Math.floor(target);
      case "ceil":
        return Math.ceil(target);
      case "abs":
        return Math.abs(target);
    }
  }
  const date = toDate(target);
  if (date) {
    switch (name) {
      case "format":
        return formatDate(date, String(args[0] ?? "YYYY-MM-DD"));
      case "date": {
        const d = new Date(date.getTime());
        d.setHours(0, 0, 0, 0);
        return d;
      }
      case "time":
        return formatDate(date, "HH:mm:ss");
    }
  }
  if (target === null || target === undefined) {
    if (
      name === "contains" ||
      name === "containsAny" ||
      name === "containsAll" ||
      name === "startsWith" ||
      name === "endsWith"
    )
      return false;
    return null;
  }
  throw new ExprError(`${typeName(target)} has no method ${name}()`);
}

function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "list";
  if (v instanceof Date) return "date";
  if (isFile(v)) return "file";
  return typeof v === "object" ? "object" : typeof v;
}
