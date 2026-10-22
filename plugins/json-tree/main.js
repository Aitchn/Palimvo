// JSON tree: a viewer for .json files. Objects and arrays fold open and closed; the search box
// keeps only the branches whose keys or values match.

const CSS = `
.jt { padding: 10px 16px; font: 13px/1.6 var(--font-mono, ui-monospace, Consolas, monospace); }
.jt-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-family: var(--font-sans, system-ui, sans-serif); }
.jt-bar input { flex: 1; max-width: 320px; }
.jt-bar small { color: var(--fg-muted); }
.jt details { margin-left: 16px; }
.jt > div > details { margin-left: 0; }
.jt summary { cursor: pointer; list-style: none; }
.jt summary::before { content: "▸ "; color: var(--fg-muted); }
.jt details[open] > summary::before { content: "▾ "; }
.jt .leaf { margin-left: 30px; white-space: pre-wrap; overflow-wrap: anywhere; }
.jt .key { color: var(--info); }
.jt .str { color: var(--warning); }
.jt .num { color: var(--success); }
.jt .lit { color: var(--accent-text); }
.jt .meta { color: var(--fg-muted); }
.jt-error { color: var(--danger); padding: 12px 16px; white-space: pre-wrap; }
`;

/** Branches start open down to this depth; deeper ones start folded. */
const OPEN_DEPTH = 2;
/** Arrays and objects with more entries show the first ones and a count. */
const MAX_CHILDREN = 500;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scalar(value) {
  if (typeof value === "string") return h("span", "str", JSON.stringify(value));
  if (typeof value === "number") return h("span", "num", String(value));
  return h("span", "lit", String(value));
}

/** Whether a key or anything below it contains `query` (already lowercased). */
export function matches(key, value, query) {
  if (!query) return true;
  if (String(key).toLowerCase().includes(query)) return true;
  if (value && typeof value === "object")
    return Object.entries(value).some(([k, v]) => matches(k, v, query));
  return String(value).toLowerCase().includes(query);
}

function render(t, key, value, depth, query) {
  const label = () => h("span", "key", key === undefined ? "" : `${key}: `);
  if (value === null || typeof value !== "object") {
    const leaf = h("div", "leaf");
    leaf.append(label(), scalar(value));
    return leaf;
  }
  // Without a search only the first MAX_CHILDREN entries are ever looked at, so a huge array is
  // not copied just to be cut down.
  const all = query ? Object.entries(value).filter(([k, v]) => matches(k, v, query)) : null;
  const total = all ? all.length : Array.isArray(value) ? value.length : Object.keys(value).length;
  const entries =
    all ??
    (Array.isArray(value)
      ? value.slice(0, MAX_CHILDREN).map((v, i) => [String(i), v])
      : Object.entries(value).slice(0, MAX_CHILDREN));
  const details = h("details");
  details.open = depth < OPEN_DEPTH || Boolean(query);
  const summary = h("summary");
  const size = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
  summary.append(label(), h("span", "meta", size));
  details.append(summary);
  for (const [k, v] of entries.slice(0, MAX_CHILDREN))
    details.append(render(t, Array.isArray(value) ? Number(k) : k, v, depth + 1, query));
  if (total > MAX_CHILDREN)
    details.append(h("div", "leaf meta", t("more", { count: total - MAX_CHILDREN })));
  return details;
}

export default function activate(palimvo) {
  palimvo.ui.registerViewer("tree", async (ctx) => {
    const t = palimvo.i18n.t;
    const style = h("style");
    style.textContent = CSS;
    const box = h("div", "jt");
    const bar = h("div", "jt-bar");
    const search = h("input");
    search.placeholder = t("search");
    search.setAttribute("aria-label", t("search"));
    const count = h("small");
    bar.append(search, count);
    const tree = h("div");
    box.append(bar, tree);
    ctx.el.replaceChildren(style, box);

    let data;
    let query = "";
    const draw = () => tree.replaceChildren(render(t, undefined, data, 0, query));
    const load = async () => {
      try {
        data = JSON.parse(await ctx.readText());
        count.textContent = ctx.path.slice(ctx.path.lastIndexOf("/") + 1);
        draw();
      } catch (err) {
        data = undefined;
        tree.replaceChildren(
          h("div", "jt-error", t("invalid", { message: String((err && err.message) || err) })),
        );
      }
    };
    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase();
      if (data !== undefined) draw();
    });
    const off = palimvo.events.on("file:changed", (change) => {
      if (change.path === ctx.path) void load();
    });
    await load();
    return off;
  });
}
