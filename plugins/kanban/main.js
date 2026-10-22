// Kanban board: notes are cards, grouped into columns by a frontmatter property (default
// "status"). Dragging a card to another column, or picking a column in its menu, rewrites that
// property in the note.
//
// Other plugins add badges to cards through the "card-badge" extension point (see README.md).
// A `kanban` code block takes the same options as the page, one `key: value` per line:
//   folder: tasks
//   field: status
//   columns: todo, doing, done

const DEFAULT_COLUMNS = ["todo", "doing", "done"];
const DEFAULT_FOLDER = "tasks";
/** Notes read per board; a bigger vault should narrow the board with `folder`. */
const MAX_NOTES = 300;
const READ_PARALLEL = 8;
const TONES = ["danger", "warning", "success", "accent", "muted"];

const CSS = `
.kb { display: flex; flex-direction: column; min-height: 100%; }
.kb-bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px 0; align-items: center; color: var(--fg-muted); font-size: 12px; }
.kb-bar label { display: inline-flex; gap: 6px; align-items: center; }
.kb-bar input { width: 120px; }
.kb-cols { display: flex; gap: 12px; padding: 12px; align-items: flex-start; overflow-x: auto; flex: 1; }
.kb-col { background: var(--bg-side); border: 1px solid var(--border); border-radius: var(--radius-md, 8px); width: 252px; flex: none; padding: 8px; }
.kb-col.drop { border-color: var(--accent); background: var(--accent-soft); }
.kb-col h3 { margin: 0 0 8px; font-size: 13px; color: var(--fg-muted); display: flex; justify-content: space-between; }
.kb-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); padding: 8px; margin-bottom: 6px; cursor: grab; }
.kb-card:hover, .kb-card:focus-within { border-color: var(--accent); }
.kb-card.moving { opacity: 0.5; }
.kb-title { all: unset; cursor: pointer; display: block; width: 100%; font-weight: 500; overflow-wrap: anywhere; }
.kb-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.kb-path { display: block; color: var(--fg-muted); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
.kb-move { margin-top: 6px; width: 100%; font-size: 12px; }
.kb-new { width: 100%; box-sizing: border-box; }
.kb-error { color: var(--danger); padding: 8px 12px 0; white-space: pre-wrap; }
.kb-empty { color: var(--fg-muted); padding: 12px; }
.kb-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.kb-badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border); color: var(--fg-muted); }
.kb-badge.tone-danger { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.kb-badge.tone-warning { color: var(--warning); border-color: var(--warning); background: var(--warning-soft); }
.kb-badge.tone-success { color: var(--success); border-color: var(--success); background: var(--success-soft); }
.kb-badge.tone-accent { color: var(--accent-text); border-color: var(--accent); background: var(--accent-soft); }
`;

export default function activate(palimvo) {
  palimvo.ui.registerView("board", (ctx) => mount(palimvo, ctx.el, { field: "status" }, true));
  palimvo.ui.registerCodeBlock("kanban", (ctx) =>
    mount(palimvo, ctx.el, { field: "status", ...parseOptions(ctx.source) }, false),
  );
}

export function parseOptions(source) {
  const options = {};
  for (const line of String(source).split("\n")) {
    const m = /^\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "columns") {
      options.columns = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (m[1] === "folder" || m[1] === "field") {
      options[m[1]] = m[2].trim();
    }
  }
  return options;
}

/** The scalar and list values of a note's leading `---` block; nested YAML is ignored. */
export function parseFrontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out = {};
  if (!block) return out;
  let key = null;
  for (const line of block[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(out[key])) {
      out[key].push(unquote(item[1]));
      continue;
    }
    const m = /^([A-Za-z0-9_][\w .-]*?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    key = m[1];
    const raw = m[2].trim();
    if (raw === "") out[key] = [];
    else if (raw.startsWith("[") && raw.endsWith("]"))
      out[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== "");
    else out[key] = unquote(raw);
  }
  return out;
}

function unquote(raw) {
  const m = /^(["'])(.*)\1$/.exec(raw);
  return m ? m[2] : raw;
}

/** Returns `content` with the property set, creating the frontmatter block when there is none. */
export function setProperty(content, field, value) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return `---\n${field}: ${value}\n---\n${content}`;
  // Replace the whole value: the `key:` line and, for a block list, the indented lines under it.
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${field}:`));
  let kept;
  if (at < 0) kept = [...lines, `${field}: ${value}`];
  else {
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    kept = [...lines.slice(0, at), `${field}: ${value}`, ...lines.slice(end)];
  }
  const body = kept.join("\n");
  return `---\n${body}\n---${content.slice(fm[0].length)}`;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function mount(palimvo, container, initial, withBar) {
  const t = (key, params, fallback) => {
    const text = palimvo.i18n.t(key, params);
    return text === key && fallback !== undefined ? fallback : text;
  };
  const options = { ...initial };
  const style = h("style");
  style.textContent = CSS;
  const root = h("div", "kb");
  const error = h("div", "kb-error");
  error.setAttribute("role", "alert");
  const cols = h("div", "kb-cols");
  container.replaceChildren(style, root);
  const fail = (err) => {
    error.textContent = String((err && err.message) || err);
  };

  const state = { notes: [], busy: new Set() };

  // One input for new cards that survives every redraw, so a refresh never eats what is being typed.
  let newColumn = DEFAULT_COLUMNS[0];
  const newInput = h("input", "kb-new");
  newInput.placeholder = t("newCard");
  newInput.setAttribute("aria-label", t("newCard"));
  newInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !newInput.value.trim()) return;
    const text = newInput.value.trim().replace(/[\\/:*?"<>|]/g, "-");
    newInput.value = "";
    createCard(text, newColumn).then(load, fail);
  });

  if (withBar) {
    const bar = h("div", "kb-bar");
    const field = h("input");
    field.value = options.field;
    field.setAttribute("aria-label", t("field"));
    const folder = h("input");
    folder.value = options.folder || "";
    folder.placeholder = t("allFolders");
    folder.setAttribute("aria-label", t("folder"));
    const apply = () => {
      options.field = field.value.trim() || "status";
      options.folder = folder.value.trim();
      load().catch(fail);
    };
    for (const input of [field, folder])
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
    for (const input of [field, folder]) input.addEventListener("change", apply);
    const l1 = h("label", "", t("field"));
    l1.append(field);
    const l2 = h("label", "", t("folder"));
    l2.append(folder);
    bar.append(l1, l2);
    root.append(bar);
  }
  root.append(error, cols);

  const folderPath = () => (options.folder || "").replace(/^\/+|\/+$/g, "");

  async function load() {
    error.textContent = "";
    const folder = folderPath();
    const entries = await palimvo.vault.list(folder, { recursive: true });
    const paths = entries
      .filter((e) => e.kind === "file" && /\.md$/i.test(e.path))
      .map((e) => e.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_NOTES);
    const notes = await mapLimit(paths, READ_PARALLEL, async (path) => {
      try {
        const text = await palimvo.vault.read(path);
        return {
          path,
          title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
          frontmatter: parseFrontmatter(text),
        };
      } catch {
        return null;
      }
    });
    state.notes = notes.filter(Boolean);
    await render();
  }

  const valueOf = (note) => {
    const v = note.frontmatter[options.field];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };

  async function render() {
    // Without a folder only notes that carry the property are cards.
    const notes = folderPath()
      ? state.notes
      : state.notes.filter((n) => n.frontmatter[options.field] !== undefined);
    const columns = [
      ...(options.columns && options.columns.length ? options.columns : DEFAULT_COLUMNS),
    ];
    const columnOf = (n) => String(valueOf(n) || columns[0]);
    for (const n of notes) if (!columns.includes(columnOf(n))) columns.push(columnOf(n));
    const badges = await cardBadges(notes);
    if (notes.length === 0 && !folderPath()) {
      cols.replaceChildren(h("p", "kb-empty", t("empty", { field: options.field })));
      return;
    }
    const typing = document.activeElement === newInput;
    cols.replaceChildren(
      ...columns.map((name, i) =>
        column(
          name,
          notes.filter((n) => columnOf(n) === name),
          i === 0,
          badges,
          columns,
        ),
      ),
    );
    if (typing) newInput.focus();
  }

  /**
   * Extension point "card-badge": each contributor gets { cards: [{ path, title, properties }],
   * field } and answers [{ path, text, tone?, title? }]. One that fails only loses its badges.
   */
  async function cardBadges(notes) {
    const byPath = new Map();
    if (notes.length === 0) return byPath;
    const cards = notes.map((n) => ({ path: n.path, title: n.title, properties: n.frontmatter }));
    let answers;
    try {
      answers = await palimvo.extensions.invoke("card-badge", { cards, field: options.field });
    } catch {
      return byPath;
    }
    for (const answer of answers) {
      for (const badge of Array.isArray(answer) ? answer : []) {
        if (!badge || typeof badge.path !== "string" || typeof badge.text !== "string") continue;
        if (!byPath.has(badge.path)) byPath.set(badge.path, []);
        byPath.get(badge.path).push(badge);
      }
    }
    return byPath;
  }

  function column(name, notes, first, badges, allColumns) {
    const col = h("div", "kb-col");
    col.dataset.column = name;
    const title = h("h3");
    title.append(
      h("span", "", t(`column.${name}`, undefined, name)),
      h("span", "", String(notes.length)),
    );
    col.append(title);
    for (const note of notes) col.append(card(note, badges.get(note.path), allColumns, name));
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop");
      const path = e.dataTransfer.getData("text/plain");
      if (path) move(path, name).catch(fail);
    });
    if (first) {
      newColumn = name;
      col.append(newInput);
    }
    return col;
  }

  /** Writes a new note under a name nobody uses yet ("Plan trip 2" when "Plan trip" exists). */
  async function createCard(text, columnName) {
    const dir = folderPath() || DEFAULT_FOLDER;
    let title = text;
    for (let n = 2; n < 1000; n++) {
      const taken = await palimvo.vault.read(`${dir}/${title}.md`).then(
        () => true,
        (err) => {
          if (err && err.code === "not_found") return false;
          throw err;
        },
      );
      if (!taken) break;
      title = `${text} ${n}`;
    }
    await palimvo.vault.write(
      `${dir}/${title}.md`,
      `---\n${options.field}: ${columnName}\n---\n# ${title}\n`,
      { reason: `Kanban: new card ${title}` },
    );
  }

  function card(note, extra, allColumns, current) {
    const node = h("div", "kb-card");
    node.draggable = true;
    node.dataset.path = note.path;
    if (state.busy.has(note.path)) node.classList.add("moving");
    const open = h("button", "kb-title", note.title);
    open.type = "button";
    open.addEventListener("click", () => palimvo.ui.openFile(note.path));
    node.append(open);
    if (!folderPath()) node.append(h("span", "kb-path", note.path));
    if (extra && extra.length) {
      const row = h("div", "kb-badges");
      for (const badge of extra.slice(0, 6)) {
        const tone = TONES.includes(badge.tone) ? badge.tone : "muted";
        const chip = h("span", `kb-badge tone-${tone}`, badge.text.slice(0, 40));
        if (typeof badge.title === "string") chip.title = badge.title;
        row.append(chip);
      }
      node.append(row);
    }
    // Touch screens cannot drag, and a keyboard cannot either: the menu does the same move.
    const select = h("select", "kb-move");
    select.setAttribute("aria-label", t("moveTo"));
    for (const name of allColumns) {
      const option = h("option", "", t(`column.${name}`, undefined, name));
      option.value = name;
      option.selected = name === current;
      select.append(option);
    }
    select.addEventListener("change", () => move(note.path, select.value).catch(fail));
    node.append(select);
    node.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", note.path));
    return node;
  }

  async function move(path, to) {
    state.busy.add(path);
    try {
      // Read again right before writing, so a change made meanwhile by a person or an AI is kept.
      const content = await palimvo.vault.read(path);
      await palimvo.vault.write(path, setProperty(content, options.field, to), {
        reason: `Kanban: ${options.field} → ${to}`,
      });
      const note = state.notes.find((n) => n.path === path);
      if (note) note.frontmatter = parseFrontmatter(setProperty(content, options.field, to));
    } finally {
      state.busy.delete(path);
    }
    await render();
  }

  let timer;
  const off = palimvo.events.on("file:changed", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load().catch(fail), 300);
  });
  load().catch(fail);
  return () => {
    clearTimeout(timer);
    off();
  };
}
