// Three component types for `component` blocks: radar (several aspects compared), treemap (parts
// of a whole as nested rectangles) and sparkline (one series as a small line). The host resolves
// the block's YAML (`config`) and any references into `data`; the plugin only draws, as SVG.
//
//   radar:     axes: [Speed, Cost]   series: [{ name: A, values: [3, 4] }]   max: 5
//   treemap:   items: [{ name: Rent, value: 900 }, { name: Food, value: 400 }]
//   sparkline: values: [3, 5, 4, 8]  label: Visits  unit: "/day"

const SVG_NS = "http://www.w3.org/2000/svg";
/** Series and rectangle colors; the first is also the accent of single-series charts. */
const PALETTE = [
  "#5b9cf5",
  "#45c088",
  "#e8b84a",
  "#f0616d",
  "#b08cf6",
  "#4cc9d6",
  "#f08a4b",
  "#9bb04a",
];
const MAX_SERIES = 8;
const MAX_ITEMS = 200;

export const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const CSS = `
.cp { font-size: 12px; color: var(--fg); }
.cp svg { display: block; margin: 0 auto; max-width: 100%; height: auto; overflow: visible; }
.cp .ttl { font-weight: 600; margin: 0 0 6px; text-align: center; }
.cp .axis, .cp .ring { stroke: var(--border-strong, var(--border)); fill: none; }
.cp .tick { fill: var(--fg-muted); font-size: 11px; }
.cp .axis-label { fill: var(--fg); font-size: 12px; }
.cp .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; justify-content: center; margin-top: 6px; color: var(--fg-muted); }
.cp .legend span { display: inline-flex; align-items: center; gap: 6px; }
.cp .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.cp .cell-label { fill: #fff; font-size: 12px; pointer-events: none; }
.cp .cell-value { fill: #fff; font-size: 11px; opacity: 0.85; pointer-events: none; }
.cp .spark { display: inline-flex; align-items: center; gap: 8px; }
.cp .spark b { font-size: 18px; font-variant-numeric: tabular-nums; }
.cp .spark small { color: var(--fg-muted); }
.cp .empty { color: var(--fg-muted); text-align: center; padding: 20px 0; }
.cp .warn { color: var(--warning); margin-top: 4px; text-align: center; }
`;

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  if (parent) parent.append(node);
  return node;
}

function html(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function frame(el, title) {
  const style = html("style");
  style.textContent = CSS;
  const box = html("div", "cp");
  if (title) box.append(html("p", "ttl", String(title)));
  el.replaceChildren(style, box);
  return box;
}

/** The block's own YAML, overridden by whatever the host resolved into `data`. */
const options = (ctx) => ({
  ...(isObject(ctx.config) ? ctx.config : {}),
  ...(isObject(ctx.data) ? ctx.data : {}),
});

const fmt = (locale) => {
  const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (v) => (v === null ? "—" : f.format(v));
};

/* ---------------------------------------------------------------- radar */

export function radarModel(opts) {
  const axes = (Array.isArray(opts.axes) ? opts.axes : []).map(String);
  const series = (Array.isArray(opts.series) ? opts.series : [])
    .filter(isObject)
    .slice(0, MAX_SERIES)
    .map((s) => ({
      name: s.name == null ? "" : String(s.name),
      values: axes.map((_, i) => num(Array.isArray(s.values) ? s.values[i] : null)),
    }));
  const largest = Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v !== null)));
  const max = num(opts.max) > 0 ? num(opts.max) : niceCeil(largest);
  return { axes, series, max };
}

/** 7 → 10, 42 → 50, 3.2 → 4: a round top for the outer ring. */
export function niceCeil(v) {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 4, 5, 10]) if (v <= step * pow) return step * pow;
  return 10 * pow;
}

function drawRadar(ctx) {
  const opts = options(ctx);
  const { axes, series, max } = radarModel(opts);
  const box = frame(ctx.el, opts.title);
  if (axes.length < 3 || series.length === 0) {
    box.append(html("div", "empty", ctx.t("radar.empty")));
    return;
  }
  const show = fmt(ctx.locale);
  const size = 320;
  const c = size / 2;
  const r = 105;
  const root = svg(
    "svg",
    { viewBox: `-40 -10 ${size + 80} ${size + 20}`, role: "img", width: size + 80 },
    box,
  );
  root.setAttribute("aria-label", opts.title ? String(opts.title) : ctx.t("radar.name"));
  const angle = (i) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;
  const point = (i, f) => [c + Math.cos(angle(i)) * r * f, c + Math.sin(angle(i)) * r * f];
  for (const f of [0.25, 0.5, 0.75, 1]) {
    svg(
      "polygon",
      { class: "ring", points: axes.map((_, i) => point(i, f).join(",")).join(" ") },
      root,
    );
    const [x, y] = point(0, f);
    const tick = svg("text", { class: "tick", x: x + 3, y: y + 1 }, root);
    tick.textContent = show(max * f);
  }
  axes.forEach((name, i) => {
    const [x, y] = point(i, 1);
    svg("line", { class: "axis", x1: c, y1: c, x2: x, y2: y }, root);
    const [lx, ly] = point(i, 1.16);
    const anchor = Math.abs(lx - c) < 4 ? "middle" : lx > c ? "start" : "end";
    const label = svg(
      "text",
      { class: "axis-label", x: lx, y: ly + 4, "text-anchor": anchor },
      root,
    );
    label.textContent = name;
  });
  series.forEach((s, k) => {
    const color = PALETTE[k % PALETTE.length];
    const pts = s.values.map((v, i) => point(i, Math.min(1, Math.max(0, (v ?? 0) / max))));
    const poly = svg(
      "polygon",
      {
        points: pts.map((p) => p.join(",")).join(" "),
        fill: color,
        "fill-opacity": 0.18,
        stroke: color,
        "stroke-width": 2,
      },
      root,
    );
    svg("title", {}, poly).textContent = `${s.name}: ${s.values.map(show).join(" / ")}`;
    pts.forEach(([x, y], i) => {
      const dot = svg("circle", { cx: x, cy: y, r: 3, fill: color }, root);
      svg("title", {}, dot).textContent = `${s.name} · ${axes[i]}: ${show(s.values[i])}`;
    });
  });
  const legend = html("div", "legend");
  series.forEach((s, k) => {
    const item = html("span");
    const swatch = html("i");
    swatch.style.background = PALETTE[k % PALETTE.length];
    item.append(swatch, document.createTextNode(s.name));
    legend.append(item);
  });
  box.append(legend);
}

/* -------------------------------------------------------------- treemap */

/** Flat leaves of `items`, each remembering the top-level item it belongs to (for its color). */
export function treemapLeaves(items) {
  const leaves = [];
  const walk = (list, group, path) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!isObject(item) || leaves.length >= MAX_ITEMS) continue;
      const name = item.name == null ? "" : String(item.name);
      const g = group ?? name;
      if (Array.isArray(item.children)) walk(item.children, g, [...path, name]);
      else {
        const value = num(item.value);
        if (value !== null && value > 0)
          leaves.push({ name, path: [...path, name], value, group: g, color: item.color });
      }
    }
  };
  walk(items, null, []);
  return leaves;
}

/** Squarified treemap (Bruls et al.): rectangles close to square, largest first. */
export function squarify(leaves, width, height) {
  const total = leaves.reduce((a, l) => a + l.value, 0);
  const sorted = [...leaves].sort((a, b) => b.value - a.value);
  const rects = [];
  let x = 0;
  let y = 0;
  let w = width;
  let hgt = height;
  const scale = (w * hgt) / total;
  const worst = (row, side) => {
    const area = row.reduce((a, l) => a + l.value * scale, 0);
    const big = Math.max(...row.map((l) => l.value * scale));
    const small = Math.min(...row.map((l) => l.value * scale));
    return Math.max((side * side * big) / (area * area), (area * area) / (side * side * small));
  };
  let i = 0;
  while (i < sorted.length) {
    const side = Math.min(w, hgt);
    const row = [sorted[i]];
    i++;
    while (i < sorted.length && worst([...row, sorted[i]], side) <= worst(row, side)) {
      row.push(sorted[i]);
      i++;
    }
    const area = row.reduce((a, l) => a + l.value * scale, 0);
    const thick = area / side;
    let offset = 0;
    for (const leaf of row) {
      const length = (leaf.value * scale) / thick;
      if (w >= hgt) rects.push({ leaf, x, y: y + offset, w: thick, h: length });
      else rects.push({ leaf, x: x + offset, y, w: length, h: thick });
      offset += length;
    }
    if (w >= hgt) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      hgt -= thick;
    }
  }
  return rects;
}

function drawTreemap(ctx) {
  const opts = options(ctx);
  const leaves = treemapLeaves(opts.items);
  const box = frame(ctx.el, opts.title);
  if (leaves.length === 0) {
    box.append(html("div", "empty", ctx.t("treemap.empty")));
    return;
  }
  const show = fmt(ctx.locale);
  const total = leaves.reduce((a, l) => a + l.value, 0);
  const W = 600;
  const H = 320;
  const groups = [...new Set(leaves.map((l) => l.group))];
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", width: W }, box);
  root.setAttribute("aria-label", opts.title ? String(opts.title) : ctx.t("treemap.name"));
  for (const { leaf, x, y, w, h: hgt } of squarify(leaves, W, H)) {
    const color =
      typeof leaf.color === "string" && /^#[0-9a-f]{3,8}$/i.test(leaf.color)
        ? leaf.color
        : PALETTE[groups.indexOf(leaf.group) % PALETTE.length];
    const g = svg("g", {}, root);
    svg(
      "rect",
      { x, y, width: w, height: hgt, fill: color, stroke: "var(--bg)", "stroke-width": 2, rx: 3 },
      g,
    );
    svg("title", {}, g).textContent =
      `${leaf.path.join(" › ")}: ${show(leaf.value)} (${show((leaf.value / total) * 100)}%)`;
    if (w > 52 && hgt > 34) {
      svg("text", { class: "cell-label", x: x + 7, y: y + 18 }, g).textContent = clip(
        leaf.name,
        Math.floor((w - 12) / 7),
      );
      svg("text", { class: "cell-value", x: x + 7, y: y + 33 }, g).textContent = show(leaf.value);
    }
  }
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

/* ------------------------------------------------------------ sparkline */

export function sparkModel(opts) {
  const values = (Array.isArray(opts.values) ? opts.values : [])
    .map(num)
    .filter((v) => v !== null)
    .slice(-MAX_ITEMS);
  return {
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    last: values[values.length - 1],
  };
}

function drawSparkline(ctx) {
  const opts = options(ctx);
  const { values, min, max, last } = sparkModel(opts);
  const box = frame(ctx.el, null);
  if (values.length === 0) {
    box.append(html("div", "empty", ctx.t("sparkline.empty")));
    return;
  }
  const show = fmt(ctx.locale);
  const W = 120;
  const H = 32;
  const pad = 3;
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    values.length === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (values.length - 1),
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);
  const wrap = html("div", "spark");
  if (opts.label) wrap.append(html("small", "", String(opts.label)));
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  root.setAttribute(
    "aria-label",
    `${opts.label ?? ctx.t("sparkline.name")}: ${values.map(show).join(", ")}`,
  );
  svg(
    "polyline",
    {
      points: pts.map((p) => p.join(",")).join(" "),
      fill: "none",
      stroke: PALETTE[0],
      "stroke-width": 1.75,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    },
    root,
  );
  const [lx, ly] = pts[pts.length - 1];
  svg("circle", { cx: lx, cy: ly, r: 2.5, fill: PALETTE[0] }, root);
  svg("title", {}, root).textContent = `${show(min)} – ${show(max)}`;
  wrap.append(root, html("b", "", `${show(last)}${opts.unit ? String(opts.unit) : ""}`));
  box.append(wrap);
}

/* ------------------------------------------------------------- activate */

export default function activate(palimvo) {
  const draw = (type, fn) =>
    palimvo.ui.registerComponent(type, (ctx) =>
      fn({ ...ctx, t: (key) => palimvo.i18n.t(key), locale: palimvo.i18n.locale }),
    );
  draw("radar", drawRadar);
  draw("treemap", drawTreemap);
  draw("sparkline", drawSparkline);
}
