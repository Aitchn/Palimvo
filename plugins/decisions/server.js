// Decisions: MCP tools for decision records.
//
// A record is a note named `NNNN-title.md` inside a `decisions/` folder (any depth). Its
// frontmatter holds status, date, deciders, related, supersedes, requires, tree and branch.
// A tree is the part of the path around `decisions/` ("decisions/Prism/0001-x.md" and
// "Prism/decisions/0001-x.md" are both tree "Prism"), unless `tree:` says otherwise. Numbers count
// per folder. This file runs in the QuickJS sandbox: no imports, only `vault` and `console`.

const DECISIONS_DIR = "decisions";
/** A call may make 200 host calls; keep some for the list, the write and the read-back. */
const MAX_READS = 150;
const MAX_NUMBER_ATTEMPTS = 5;

const HEADINGS = {
  en: {
    context: "Context",
    options: "Options",
    decision: "Decision",
    consequences: "Consequences",
  },
  "zh-TW": { context: "背景", options: "選項", decision: "決定", consequences: "後果" },
  "zh-CN": { context: "背景", options: "选项", decision: "决定", consequences: "后果" },
};

// ---- parsing ---------------------------------------------------------------------------------

function unquote(s) {
  if (/^".*"$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      // Not valid JSON escapes: fall through to plain unquoting.
    }
  }
  return s.replace(/^(["'])(.*)\1$/, "$2");
}

/** Splits the inside of `[a, "b, c"]` at commas that are not inside double quotes. */
function splitFlowList(inner) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && quoted) {
      current += ch + (inner[++i] || "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((x) => unquote(x.trim())).filter(Boolean);
}
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const asText = (v) => (Array.isArray(v) ? v.join(", ") : v);

/** Reads the simple frontmatter of decision records: `key: value`, `key: [a, b]` and block lists. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2];
    listKey = null;
    if (raw === "") {
      data[key] = [];
      listKey = key;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = splitFlowList(raw.slice(1, -1));
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

/** Replaces (or adds) one scalar frontmatter field and leaves the rest of the file as it was. */
function setFrontmatterField(text, key, value) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return `---\n${key}: ${value}\n---\n\n${text}`;
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at >= 0) lines[at] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---${text.slice(match[0].length)}`;
}

/** A tree name the way it would be a folder: no empty, "." or ".." parts, no characters files cannot have. */
function cleanTreeName(tree) {
  return (
    String(tree)
      .split("/")
      // eslint-disable-next-line no-control-regex
      .map((part) => part.replace(/[\\:*?"<>|#^[\]{}%\u0000-\u001f]/g, "").trim())
      .filter((part) => part && part !== "." && part !== "..")
      .join("/")
      .slice(0, 200)
  );
}

function inDecisionsFolder(path) {
  return path.toLowerCase().endsWith(".md") && path.split("/").slice(0, -1).includes(DECISIONS_DIR);
}

/** The tree a file belongs to by where it is, ignoring any `tree:` field. */
function treeOfPath(path) {
  const dirs = path.split("/").slice(0, -1);
  const at = dirs.indexOf(DECISIONS_DIR);
  if (at < 0) return "";
  return [...dirs.slice(0, at), ...dirs.slice(at + 1)].join("/");
}

const folderOf = (path) => path.split("/").slice(0, -1).join("/");

/** A record known only by its path: enough to number, place and look up references. */
function fromPath(path) {
  const file = path.split("/").pop();
  const num = /^(\d{1,6})[-_ ]/.exec(file);
  if (!num || !file.toLowerCase().endsWith(".md")) return null;
  return {
    path,
    number: Number(num[1]),
    title: file.slice(num[0].length, -3),
    status: "proposed",
    deciders: [],
    related: [],
    requires: [],
    branch: "",
    requiresPaths: [],
    requiredBy: [],
    relatedPaths: [],
    tree: treeOfPath(path),
    folder: folderOf(path),
  };
}

/** Reads a decision file; null for files that are not numbered decision records. */
function parseDecision(path, text) {
  const base = fromPath(path);
  if (!base) return null;
  const { data, body } = parseFrontmatter(text);
  const named = asText(data.tree);
  const heading = /^#\s+(.+)$/m.exec(body);
  const title = (heading ? heading[1].trim() : base.title).replace(/^\d+\s*[-.:：]?\s*/, "");
  return {
    ...base,
    title,
    status: asText(data.status) || "proposed",
    date: asText(data.date),
    deciders: asList(data.deciders),
    related: asList(data.related),
    supersedes: asText(data.supersedes),
    requires: [...asList(data.requires), ...asList(data.depends_on)],
    branch: (asText(data.branch) || "")
      .replace(/[\r\n]/g, " ")
      .trim()
      .slice(0, 80),
    tree: named !== undefined && cleanTreeName(named) ? cleanTreeName(named) : base.tree,
  };
}

/**
 * Finds the record a reference names: a path or [[link]] (with or without .md, or just the file
 * name), `Tree#0003` / `Tree#0003-name`, or a bare number. Ambiguous names prefer `from`'s folder,
 * then its tree.
 */
function resolveRef(raw, from, list) {
  const ref = String(raw)
    .trim()
    .replace(/^\[+|\]+$/g, "")
    .replace(/\|.*$/, "")
    .replace(/#\^.*$/, "")
    .trim();
  if (!ref) return undefined;
  const withMd = ref.toLowerCase().endsWith(".md") ? ref : `${ref}.md`;
  const exact = list.find((d) => d.path === ref || d.path === withMd);
  if (exact) return exact;
  const pick = (matches) =>
    matches.find((d) => d.folder === from.folder) ||
    matches.find((d) => d.tree === from.tree) ||
    (matches.length === 1 ? matches[0] : undefined);
  const inTree = /^(.+?)\s*[#:]\s*0*(\d{1,6})(?:[-_ ].*)?$/.exec(ref);
  if (inTree) {
    const tree = cleanTreeName(inTree[1]).toLowerCase();
    const hit = pick(
      list.filter((d) => d.tree.toLowerCase() === tree && d.number === Number(inTree[2])),
    );
    if (hit) return hit;
  }
  const num = /^0*(\d{1,6})$/.exec(ref);
  if (num) return pick(list.filter((d) => d.number === Number(num[1])));
  const name = withMd.split("/").pop();
  return pick(
    list.filter((d) => d.path.split("/").pop() === name || d.path.endsWith(`/${withMd}`)),
  );
}

/** Resolves `supersedes`, `requires` and `related` to the records they name; fills `requiredBy`. */
function linkDecisions(list) {
  const resolveAll = (refs, d) => [
    ...new Set(
      refs
        .map((r) => {
          const hit = resolveRef(r, d, list);
          return hit && hit.path;
        })
        .filter((p) => p !== undefined && p !== d.path),
    ),
  ];
  const linked = list.map((d) => {
    const replaced = d.supersedes ? resolveRef(d.supersedes, d, list) : undefined;
    return {
      ...d,
      supersedesPath: replaced && replaced.path !== d.path ? replaced.path : undefined,
      requiresPaths: resolveAll(d.requires, d),
      relatedPaths: resolveAll(d.related, d),
      requiredBy: [],
    };
  });
  const byPath = new Map(linked.map((d) => [d.path, d]));
  for (const d of linked) for (const p of d.requiresPaths) byPath.get(p).requiredBy.push(d.path);
  return linked;
}

/** Orders records by tree (no tree first), then number, then path. */
function sortDecisions(list) {
  return [...list].sort(
    (a, b) =>
      (a.tree === b.tree
        ? 0
        : a.tree === ""
          ? -1
          : b.tree === ""
            ? 1
            : a.tree.localeCompare(b.tree)) ||
      a.number - b.number ||
      a.path.localeCompare(b.path),
  );
}

// ---- writing ---------------------------------------------------------------------------------

/**
 * Where a new record for `tree` goes: the folder the tree's records already use (the busiest one),
 * else `decisions/<tree>/`. (A plugin that may only read decision folders cannot tell whether a
 * `<tree>/` folder exists, so `<tree>/decisions/` is only reached by records already there.)
 */
function decisionFolderFor(tree, existing) {
  const clean = cleanTreeName(tree);
  if (!clean) return DECISIONS_DIR;
  const counts = new Map();
  for (const d of existing)
    if (d.tree === clean) counts.set(d.folder, (counts.get(d.folder) || 0) + 1);
  const busiest = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (busiest) return busiest[0];
  return `${DECISIONS_DIR}/${clean}`;
}

/** A file-name-safe version of a title; keeps CJK and other letters. */
function slugify(title) {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|#^[\]{}%]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return slug || "decision";
}

/** The next free number and file name in `folder`; numbers count per folder. */
function nextDecisionPath(existing, title, folder, skip = 0) {
  const number =
    existing.reduce((max, d) => (d.folder === folder ? Math.max(max, d.number) : max), 0) +
    1 +
    skip;
  return { number, path: `${folder}/${String(number).padStart(4, "0")}-${slugify(title)}.md` };
}

/** A flow list; an item with anything YAML could misread is double-quoted (JSON escapes are YAML's too). */
const yamlItem = (i) => {
  const text = String(i).trim();
  return /^[^\s"'#[\]{},:&*!|>%@`-][^\n"#[\]{},]*$/.test(text) && !/\s$/.test(text)
    ? text
    : JSON.stringify(text);
};
const yamlList = (items) => `[${items.map(yamlItem).join(", ")}]`;
const oneLine = (s) =>
  String(s)
    .replace(/[\r\n"]/g, " ")
    .trim();

function decisionMarkdown(number, input) {
  const lines = [
    "---",
    `status: ${input.status || "proposed"}`,
    `date: ${input.date || new Date().toISOString().slice(0, 10)}`,
    `deciders: ${yamlList(input.deciders || [])}`,
    `related: ${yamlList(input.related || [])}`,
  ];
  if (input.supersedes) lines.push(`supersedes: ${oneLine(input.supersedes)}`);
  const requires = (input.requires || []).map(oneLine).filter(Boolean);
  // A block list of quoted entries, so [[links]] survive and Obsidian shows them as links.
  if (requires.length) lines.push("requires:", ...requires.map((r) => `  - "${r}"`));
  if (input.tree && cleanTreeName(input.tree)) lines.push(`tree: ${cleanTreeName(input.tree)}`);
  const branch = input.branch ? oneLine(input.branch).slice(0, 80) : "";
  if (branch) lines.push(`branch: "${branch}"`);
  lines.push("---", "");
  const h = HEADINGS[input.language] || HEADINGS.en;
  const section = (name, text) => [`## ${name}`, (text || "").trim(), ""];
  return [
    ...lines,
    `# ${String(number).padStart(4, "0")} ${input.title.trim()}`,
    "",
    ...section(h.context, input.context),
    ...section(h.options, input.options),
    ...section(h.decision, input.decision),
    ...section(h.consequences, input.consequences),
  ].join("\n");
}

// ---- reading the vault -----------------------------------------------------------------------

/** Paths of the files that could be decision records (and every readable file, for placing a tree). */
async function decisionPaths() {
  const files = await vault.list({});
  return { files, paths: files.filter((p) => inDecisionsFolder(p) && fromPath(p)) };
}

/** Records with their frontmatter read, trees first-come up to the read budget. */
async function readDecisions(paths, preferTree) {
  const order =
    preferTree === undefined
      ? paths
      : [
          ...paths.filter((p) => treeOfPath(p) === preferTree),
          ...paths.filter((p) => treeOfPath(p) !== preferTree),
        ];
  const chosen = order.slice(0, MAX_READS);
  const found = [];
  for (const path of chosen) {
    let text;
    try {
      text = await vault.read({ path });
    } catch (e) {
      // Removed since the listing, or not readable for this caller: not a record we can show.
      console.log("skipped", path, String(e && e.message));
      continue;
    }
    const d = parseDecision(path, text);
    if (d) found.push(d);
  }
  return {
    list: sortDecisions(linkDecisions(found)),
    total: paths.length,
    truncated: paths.length > chosen.length,
  };
}

const treeFilter = (list, tree) =>
  tree === undefined ? list : list.filter((d) => d.tree === cleanTreeName(tree));

// ---- tools -----------------------------------------------------------------------------------

async function listDecisions({ status, tree }) {
  const { paths } = await decisionPaths();
  const wanted = tree === undefined ? undefined : cleanTreeName(tree);
  const { list, total, truncated } = await readDecisions(paths, wanted);
  const decisions = treeFilter(list, tree).filter(
    (d) => status === undefined || d.status === status,
  );
  return { decisions, total, truncated };
}

async function listDecisionTrees() {
  const { paths } = await decisionPaths();
  const { list, total, truncated } = await readDecisions(paths);
  const treeOf = new Map(list.map((d) => [d.path, d.tree]));
  const trees = new Map();
  for (const d of list) {
    const t = trees.get(d.tree) || {
      tree: d.tree,
      folders: new Set(),
      count: 0,
      statuses: {},
      needs: new Set(),
    };
    t.folders.add(d.folder);
    t.count++;
    t.statuses[d.status] = (t.statuses[d.status] || 0) + 1;
    for (const p of d.requiresPaths) if (treeOf.get(p) !== d.tree) t.needs.add(treeOf.get(p));
    trees.set(d.tree, t);
  }
  return {
    trees: [...trees.values()].map((t) => ({ ...t, folders: [...t.folders], needs: [...t.needs] })),
    total,
    truncated,
  };
}

async function recordDecision(input) {
  const title = input.title.trim();
  if (title === "") throw new Error("invalid_argument: title must not be blank");
  const tree = cleanTreeName(input.tree || "");
  const { paths } = await decisionPaths();
  // Numbers and references only need the file names, so recording stays cheap in a big vault.
  const existing = paths.map(fromPath);
  const folder = decisionFolderFor(tree, existing);
  const scope = { folder, tree };
  // References that name a record become [[links]], so they stay clickable in any Obsidian.
  const requires = (input.requires || []).map((r) => {
    const hit = resolveRef(r, scope, existing);
    return hit ? `[[${hit.path.slice(0, -3)}]]` : r;
  });
  // A record that replaces one on a branch stays on that branch unless told otherwise.
  let branch = input.branch;
  if (branch === undefined && input.supersedes) {
    const replaced = resolveRef(input.supersedes, scope, existing);
    if (replaced && replaced.tree === tree) {
      const old = parseDecision(replaced.path, await vault.read({ path: replaced.path }));
      branch = old && old.branch;
    }
  }
  const record = {
    ...input,
    title,
    requires,
    branch,
    // The folder already says which tree it is in; only a record filed elsewhere needs a tree: field.
    tree: treeOfPath(`${folder}/x.md`) === tree ? undefined : tree,
  };
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const { number, path } = nextDecisionPath(existing, title, folder, attempt);
    // Never overwrite: another call may have taken this number since the listing.
    let taken = true;
    try {
      await vault.read({ path });
    } catch (e) {
      if (!String(e && e.message).startsWith("not_found")) throw e;
      taken = false;
    }
    if (taken) continue;
    const written = await vault.write({ path, content: decisionMarkdown(number, record) });
    const decision = parseDecision(path, await vault.read({ path }));
    const duplicate = (await vault.list({ dir: folder })).some(
      (p) => p !== path && fromPath(p) && fromPath(p).number === number,
    );
    return {
      path: written.path,
      number,
      decision,
      ...(duplicate ? { warning: `another record in ${folder} also has number ${number}` } : {}),
    };
  }
  throw new Error("version_conflict: could not find a free decision number, try again");
}

async function updateDecisionStatus({ id, status }) {
  const { paths } = await decisionPaths();
  const from = { folder: DECISIONS_DIR, tree: "" };
  // File names first (cheap); a record whose `tree:` field differs from its folder needs a read.
  let hit = resolveRef(id, from, paths.map(fromPath));
  if (!hit) hit = resolveRef(id, from, (await readDecisions(paths)).list);
  if (!hit) {
    const alike = paths.map(fromPath).filter((d) => d.number === Number(id));
    throw new Error(
      alike.length > 1
        ? `invalid_argument: "${id}" matches ${alike.length} records (${alike.map((d) => d.path).join(", ")}); use a path or Tree#number`
        : `not_found: no decision record matches "${id}"`,
    );
  }
  // The host's write takes whatever version is current, so re-read right before writing and start
  // over when the note changed meanwhile; the window that is left is a few milliseconds.
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const text = await vault.read({ path: hit.path });
    const before = parseDecision(hit.path, text);
    if (!before) throw new Error(`not_found: "${hit.path}" is not a decision record`);
    if (before.status === status)
      return { path: hit.path, status, changed: false, decision: before };
    const next = setFrontmatterField(text, "status", status);
    if ((await vault.read({ path: hit.path })) !== text) continue;
    const written = await vault.write({ path: hit.path, content: next });
    return {
      path: written.path,
      status,
      changed: true,
      previous: before.status,
      decision: parseDecision(hit.path, await vault.read({ path: hit.path })),
    };
  }
  throw new Error("version_conflict: the note keeps changing, try again");
}

globalThis.__plugin = {
  tools: {
    record_decision: recordDecision,
    list_decisions: listDecisions,
    update_decision_status: updateDecisionStatus,
    list_decision_trees: listDecisionTrees,
  },
};
