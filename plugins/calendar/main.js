// Calendar: notes on a month or week grid. A note sits on the day in its date property (default
// "date"), or on the day its file name starts with (2026-03-14 Trip.md). Click "+" on a day to
// create a note, drag a note onto another day to change its date.

const MAX_NOTES = 300;
const READ_PARALLEL = 8;
const DEFAULT_FIELD = "date";
/** Notes drawn in one month cell before "+N more". */
const PER_DAY = 3;

const CSS = `
.cal { padding: 12px; }
.cal.embed { padding: 0; }
.cal-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.cal-bar h2 { margin: 0 8px; font-size: 16px; flex: 1; min-width: 120px; }
.cal-bar label { color: var(--fg-muted); font-size: 12px; display: inline-flex; gap: 6px; align-items: center; }
.cal-bar input { width: 110px; }
.cal-bar .cal-active { background: var(--accent-soft); color: var(--accent-text); }
.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: var(--radius-md, 8px); overflow: hidden; }
.cal-dow { background: var(--bg-side); color: var(--fg-muted); font-size: 11px; text-align: center; padding: 4px 0; }
.cal-day { background: var(--bg); min-height: 84px; padding: 4px; min-width: 0; position: relative; }
.cal.week .cal-day { min-height: 200px; }
.cal-day.other { background: var(--bg-side); color: var(--fg-subtle); }
.cal-day.drop { outline: 2px solid var(--accent); outline-offset: -2px; }
.cal-day.today .cal-num { background: var(--accent); color: var(--accent-fg); }
.cal-num { display: inline-block; min-width: 20px; text-align: center; border-radius: 10px; font-size: 12px; }
.cal-add { all: unset; position: absolute; top: 3px; right: 4px; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 5px; border-radius: 4px; color: var(--fg-muted); opacity: 0; }
.cal-day:hover .cal-add, .cal-add:focus-visible { opacity: 1; }
.cal-add:hover { background: var(--accent-soft); color: var(--accent-text); }
@media (hover: none) { .cal-add { opacity: 1; } }
.cal-note { display: block; user-select: none; box-sizing: border-box; width: 100%; cursor: pointer; font-size: 12px; padding: 1px 4px; margin-top: 2px; border-radius: 4px; background: var(--accent-soft); color: var(--accent-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-note:hover, .cal-note:focus-visible { outline: 1px solid var(--accent); }
.cal-note.dragging { opacity: 0.5; }
.cal-more { all: unset; cursor: pointer; display: block; color: var(--fg-muted); font-size: 11px; margin-top: 2px; }
.cal-more:hover { text-decoration: underline; }
.cal-msg { color: var(--fg-muted); font-size: 12px; padding-bottom: 6px; white-space: pre-wrap; }
.cal-msg.error { color: var(--danger); }
.cal-count { color: var(--fg-muted); font-size: 12px; }
@media (max-width: 560px) { .cal-day { min-height: 56px; } .cal.week .cal-day { min-height: 120px; } .cal-note { font-size: 11px; } }
`;

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const keyOfDate = (d) => dayKey(d.getFullYear(), d.getMonth(), d.getDate());
const dateOfKey = (key) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));

const DATE_AT_START = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;

/** "2026-03-14", "2026-3-4T10:00" → "2026-03-14", or null when it is no real date. */
export function normalizeDate(value) {
  const m = DATE_AT_START.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return dayKey(y, mo - 1, d);
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;
const KEY_LINE = /^([^:#\s][^:]*?)\s*:\s*(.*)$/;

/** The scalar value of `field` in a note's leading `---` block. */
export function readProperty(text, field) {
  const block = FRONT.exec(text);
  if (!block) return undefined;
  for (const line of block[1].split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    if (m && m[1] === field) return m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/** The day of a note: its property when valid, else the date its file name starts with. */
export function dayOf(path, text, field) {
  const prop = readProperty(text, field);
  if (prop !== undefined && prop !== "") return normalizeDate(prop);
  return normalizeDate(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The note text with `field` set to the day `day`. A time after the old date ("2026-03-14T10:00")
 * is kept, quotes are kept, other lines stay byte for byte.
 */
export function setDay(text, field, day) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = FRONT.exec(text);
  if (!block) return `---${eol}${field}: ${day}${eol}---${eol}${eol}${text}`;
  const lines = block[1].split(/\r?\n/);
  const at = lines.findIndex((line) => KEY_LINE.exec(line)?.[1] === field);
  if (at < 0) lines.push(`${field}: ${day}`);
  else {
    const value = KEY_LINE.exec(lines[at])[2].trim();
    const quote = /^(["'])/.exec(value)?.[1] ?? "";
    const inner = quote ? value.slice(1, value.endsWith(quote) ? -1 : undefined) : value;
    const rest = DATE_AT_START.test(inner) ? inner.replace(DATE_AT_START, "") : "";
    lines[at] = `${field}: ${quote}${day}${rest}${quote}`;
    // A block value ("due:" followed by "  - 2026-03-14") would otherwise stay behind.
    let end = at + 1;
    while (value === "" && end < lines.length && /^(\s+|-\s)/.test(lines[end])) end++;
    lines.splice(at + 1, end - at - 1);
  }
  return `---${eol}${lines.join(eol)}${eol}---${text.slice(block[0].length)}`;
}

/** Fills the template (or a default) for a new note on `day`. */
export function newNoteText(template, field, day) {
  if (template == null) return `---\n${field}: ${day}\n---\n\n# ${day}\n`;
  const filled = template.replaceAll("{{date}}", day).replaceAll("{{title}}", day);
  return readProperty(filled, field) ? filled : setDay(filled, field, day);
}

export function newNotePath(folder, day) {
  const dir = folder.trim().replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${day}.md` : `${day}.md`;
}

/** `weekStart`: 0 = Sunday, 1 = Monday. Mainland China starts the week on Monday. */
export function weekStartOf(locale) {
  return locale === "zh-CN" ? 1 : 0;
}

/** 6 weeks of days starting on `weekStart` around the month. */
export function monthGrid(year, month, weekStart) {
  const lead = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(year, month, 1 - lead + i);
    return { key: keyOfDate(d), day: d.getDate(), other: d.getMonth() !== month };
  });
}

/** The 7 days of the week that holds `anchor`. */
export function weekGrid(anchor, weekStart) {
  const lead = (anchor.getDay() - weekStart + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - lead + i);
    return { key: keyOfDate(d), day: d.getDate(), other: false };
  });
}

/** Options of a ```calendar block: `field: due`, `view: week`, `folder: Daily` (one per line). */
export function parseBlock(source) {
  const options = {};
  for (const line of String(source).split(/\r?\n/)) {
    const m = KEY_LINE.exec(line.trim());
    if (m) options[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return {
    field: options.field || DEFAULT_FIELD,
    view: options.view === "week" ? "week" : "month",
    folder: options.folder || "",
    template: options.template || "",
  };
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

export default function activate(palimvo) {
  palimvo.ui.registerView("calendar", (ctx) => mount(palimvo, ctx.el, { controls: "full" }));
  palimvo.ui.registerCodeBlock("calendar", (ctx) =>
    mount(palimvo, ctx.el, { ...parseBlock(ctx.source), controls: "nav", embed: true }),
  );
  palimvo.ui.registerHomeWidget("week", (ctx) =>
    mount(palimvo, ctx.el, { view: "week", controls: "nav", embed: true }),
  );
}

/**
 * Draws the calendar into `container`. `options`: field, view ("month" | "week"), folder and
 * template for new notes, controls ("full" shows the property, folder and template boxes; "nav"
 * only the buttons), embed (no page padding).
 */
export function mount(palimvo, container, options = {}, now = new Date()) {
  const t = palimvo.i18n.t;
  const locale = palimvo.i18n.locale;
  const weekStart = weekStartOf(locale);
  const todayKey = keyOfDate(now);
  const state = {
    view: options.view === "week" ? "week" : "month",
    anchor: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    field: options.field || DEFAULT_FIELD,
    folder: options.folder || "",
    template: options.template || "",
  };
  let byDay = new Map();
  let total = 0;
  let truncated = false;
  let disposed = false;

  const style = h("style");
  style.textContent = CSS;
  const root = h("div", `cal ${state.view}${options.embed ? " embed" : ""}`);
  container.replaceChildren(style, root);

  const message = h("div", "cal-msg");
  message.setAttribute("role", "status");
  const title = h("h2");
  title.setAttribute("aria-live", "polite");
  const count = h("span", "cal-count");
  const grid = h("div", "cal-grid");
  const bar = h("div", "cal-bar");

  const say = (text, error = false) => {
    message.className = `cal-msg${error ? " error" : ""}`;
    message.textContent = text;
  };
  const fail = (err) => say(String((err && err.message) || err), true);

  const button = (label, onClick, name) => {
    const b = h("button", "", label);
    b.type = "button";
    if (name) b.setAttribute("aria-label", name);
    b.addEventListener("click", onClick);
    return b;
  };
  const field = (labelText, value, onChange) => {
    const input = h("input");
    input.value = value;
    input.setAttribute("aria-label", labelText);
    input.addEventListener("change", () => onChange(input.value.trim()));
    const label = h("label", "", labelText);
    label.append(input);
    return label;
  };

  const shift = (by) => {
    if (state.view === "week") state.anchor.setDate(state.anchor.getDate() + 7 * by);
    else state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + by, 1);
    draw();
  };
  const setView = (view) => {
    state.view = view;
    draw();
  };
  const viewButtons = {
    month: button(t("month"), () => setView("month")),
    week: button(t("week"), () => setView("week")),
  };
  bar.append(
    button("‹", () => shift(-1), t("prev")),
    title,
    button(t("today"), () => {
      state.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      draw();
    }),
    button("›", () => shift(1), t("next")),
    viewButtons.month,
    viewButtons.week,
    count,
  );
  if (options.controls === "full")
    bar.append(
      field(t("field"), state.field, (value) => {
        state.field = value || DEFAULT_FIELD;
        load().catch(fail);
      }),
      field(t("folder"), state.folder, (value) => {
        state.folder = value;
      }),
      field(t("template"), state.template, (value) => {
        state.template = value;
      }),
    );
  root.append(message, bar, grid);

  async function createNote(day) {
    say("");
    try {
      const path = newNotePath(state.folder, day);
      let exists = true;
      try {
        await palimvo.vault.read(path);
      } catch (err) {
        if (err && err.code !== "not_found") throw err;
        exists = false;
      }
      if (!exists) {
        let template = null;
        if (state.template) {
          try {
            template = await palimvo.vault.read(state.template);
          } catch (err) {
            if (err && err.code !== "not_found") throw err;
            say(t("templateMissing", { path: state.template }), true);
            return;
          }
        }
        await palimvo.vault.write(path, newNoteText(template, state.field, day), {
          reason: `Calendar: new note for ${day}`,
        });
        palimvo.ui.showNotice(t("created", { path }), { kind: "success" });
      }
      palimvo.ui.openFile(path);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function moveNote(path, day) {
    say("");
    try {
      // Read again right before writing, so edits made since the last load are not lost.
      const text = await palimvo.vault.read(path);
      if (dayOf(path, text, state.field) === day) return;
      await palimvo.vault.write(path, setDay(text, state.field, day), {
        reason: `Calendar: moved to ${day}`,
      });
      palimvo.ui.showNotice(t("moved", { path, date: day }), { kind: "success" });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  function dayCell({ key, day, other }) {
    const cell = h("div", `cal-day${other ? " other" : ""}${key === todayKey ? " today" : ""}`);
    cell.dataset.day = key;
    cell.append(h("span", "cal-num", String(day)));
    const add = h("button", "cal-add", "+");
    add.type = "button";
    add.setAttribute("aria-label", t("add", { date: key }));
    add.addEventListener("click", () => createNote(key));
    cell.append(add);

    const notes = byDay.get(key) || [];
    const shown = state.view === "week" ? notes : notes.slice(0, PER_DAY);
    for (const note of shown) {
      // A div, not a button: browsers do not reliably start a drag from a button.
      const open = h("div", "cal-note", note.title);
      open.setAttribute("role", "button");
      open.tabIndex = 0;
      open.title = note.path;
      open.draggable = true;
      open.addEventListener("click", () => palimvo.ui.openFile(note.path));
      open.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          palimvo.ui.openFile(note.path);
        }
      });
      open.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", note.path);
        event.dataTransfer.effectAllowed = "move";
        open.classList.add("dragging");
      });
      open.addEventListener("dragend", () => open.classList.remove("dragging"));
      cell.append(open);
    }
    if (shown.length < notes.length) {
      const more = h("button", "cal-more", t("more", { count: notes.length - shown.length }));
      more.type = "button";
      more.addEventListener("click", () => {
        state.anchor = dateOfKey(key);
        setView("week");
      });
      cell.append(more);
    }
    cell.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      cell.classList.add("drop");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop"));
    cell.addEventListener("drop", (event) => {
      event.preventDefault();
      cell.classList.remove("drop");
      const path = event.dataTransfer.getData("text/plain");
      if (path) moveNote(path, key);
    });
    return cell;
  }

  function draw() {
    root.className = `cal ${state.view}${options.embed ? " embed" : ""}`;
    for (const [view, b] of Object.entries(viewButtons))
      b.className = view === state.view ? "cal-active" : "";
    const days =
      state.view === "week"
        ? weekGrid(state.anchor, weekStart)
        : monthGrid(state.anchor.getFullYear(), state.anchor.getMonth(), weekStart);
    title.textContent =
      state.view === "week"
        ? `${dateOfKey(days[0].key).toLocaleDateString(locale, { month: "short", day: "numeric" })} – ${dateOfKey(days[6].key).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}`
        : state.anchor.toLocaleDateString(locale, { year: "numeric", month: "long" });
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const name = new Date(2024, 0, 7 + weekStart + i).toLocaleDateString(locale, {
        weekday: "short",
      });
      cells.push(h("div", "cal-dow", name));
    }
    for (const d of days) cells.push(dayCell(d));
    grid.replaceChildren(...cells);
    count.textContent =
      t("count", { count: total }) +
      (truncated ? ` · ${t("truncated", { count: MAX_NOTES })}` : "");
  }

  async function load() {
    if (disposed) return;
    const entries = await palimvo.vault.list("", { recursive: true });
    const all = entries
      .filter((e) => e.kind === "file" && /\.md$/i.test(e.path))
      .map((e) => e.path)
      .sort((a, b) => a.localeCompare(b));
    truncated = all.length > MAX_NOTES;
    const dated = await mapLimit(all.slice(0, MAX_NOTES), READ_PARALLEL, async (path) => {
      try {
        const day = dayOf(path, await palimvo.vault.read(path), state.field);
        return day
          ? { day, path, title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "") }
          : null;
      } catch {
        return null;
      }
    });
    if (disposed) return;
    byDay = new Map();
    total = 0;
    for (const note of dated) {
      if (!note) continue;
      byDay.set(note.day, [...(byDay.get(note.day) || []), note]);
      total++;
    }
    draw();
  }

  let timer;
  const off = palimvo.events.on("file:changed", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load().catch(fail), 300);
  });
  draw();
  load().catch(fail);
  return () => {
    disposed = true;
    clearTimeout(timer);
    off();
  };
}
