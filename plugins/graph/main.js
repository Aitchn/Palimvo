// Graph view, an official Palimvo plugin.
//
// The host loads only this one file, so the layout, the drawing and the screens live here. The
// pure parts (model, layout, picking) are exported for tests; the plugin itself is the default
// export. Drawing uses a 2D canvas with batched paths so a vault of 10,000 notes stays
// interactive: edges and nodes are drawn in a handful of strokes and fills, off-screen parts are
// skipped, and labels are limited to the best connected notes in view.

const NOTE = 0;
const CANVAS = 1;
const BASE = 2;
const TAG = 3;
const KIND_TYPE = { markdown: NOTE, canvas: CANVAS, base: BASE };
const KIND_KEY = ["kindMarkdown", "kindCanvas", "kindBase", "tag"];

const EDGE_LINK = 0;
const EDGE_EMBED = 1;
const EDGE_TAG = 2;

const MAX_GROUPS = 12;
/** From this many dots and links on, moving the view moves an image of the drawing. */
const BIG_PICTURE = 6000;
/** How far a held note's neighbors may stray in a big picture. */
const FOLLOW_DISTANCE = 45;
/** The most notes the side panel draws around the open note. */
export const LOCAL_LIMIT = 250;

/* ------------------------------------------------------------------------------------------ */
/* Model: the raw graph as arrays the layout and the drawing can run through quickly.          */

export function folderOf(path) {
  const slash = path.indexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The top-level folders of the notes, sorted. */
export function topFolders(raw) {
  const found = new Set();
  for (const node of raw.nodes) {
    const folder = folderOf(node.path);
    if (folder !== "") found.add(folder);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function groupName(node, colorBy) {
  if (colorBy === "tag") return node.tags && node.tags.length > 0 ? node.tags[0] : "";
  if (colorBy === "type") return node.kind;
  return folderOf(node.path);
}

/**
 * Builds the model of one picture.
 *
 * options: `tags` adds a node per tag used by two or more notes, `embeds` keeps embed links,
 * `orphans` keeps notes without links, `folder` keeps one top-level folder, `colorBy` is
 * "folder" | "tag" | "type", `previous` is a Map of key -> [x, y] to start from (so a changed
 * filter does not scramble the picture).
 */
export function buildModel(raw, options = {}) {
  const {
    tags = false,
    embeds = true,
    orphans = true,
    folder = "",
    colorBy = "folder",
    previous = null,
  } = options;

  const kept = new Map();
  for (const node of raw.nodes) {
    if (folder !== "" && folderOf(node.path) !== folder) continue;
    kept.set(node.path, node);
  }
  const edges = [];
  const linkDegree = new Map();
  for (const edge of raw.edges) {
    if (!kept.has(edge.from) || !kept.has(edge.to) || edge.from === edge.to) continue;
    if (edge.embed && !embeds) continue;
    edges.push(edge);
    linkDegree.set(edge.from, (linkDegree.get(edge.from) ?? 0) + 1);
    linkDegree.set(edge.to, (linkDegree.get(edge.to) ?? 0) + 1);
  }
  const tagUse = new Map();
  if (tags) {
    for (const node of kept.values())
      for (const tag of node.tags ?? []) tagUse.set(tag, (tagUse.get(tag) ?? 0) + 1);
  }
  const shownTag = (tag) => (tagUse.get(tag) ?? 0) >= 2;

  const items = [];
  for (const node of kept.values()) {
    const nodeTags = tags ? (node.tags ?? []).filter(shownTag) : [];
    if (!orphans && (linkDegree.get(node.path) ?? 0) === 0 && nodeTags.length === 0) continue;
    items.push({ node, nodeTags });
  }

  const nodes = [];
  const index = new Map();
  for (const { node } of items) {
    index.set(node.path, nodes.length);
    nodes.push({
      key: node.path,
      path: node.path,
      label: node.title,
      type: KIND_TYPE[node.kind] ?? NOTE,
      tag: null,
      groupName: groupName(node, colorBy),
      group: -1,
      deg: 0,
    });
  }
  const edgeA = [];
  const edgeB = [];
  const edgeKind = [];
  for (const edge of edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined) continue;
    edgeA.push(a);
    edgeB.push(b);
    edgeKind.push(edge.embed ? EDGE_EMBED : EDGE_LINK);
  }
  const tagIndex = new Map();
  for (const { node, nodeTags } of items) {
    for (const tag of nodeTags) {
      let t = tagIndex.get(tag);
      if (t === undefined) {
        t = nodes.length;
        tagIndex.set(tag, t);
        nodes.push({
          key: `#${tag}`,
          path: null,
          label: `#${tag}`,
          type: TAG,
          tag,
          groupName: colorBy === "tag" ? tag : "",
          group: -1,
          deg: 0,
        });
      }
      edgeA.push(index.get(node.path));
      edgeB.push(t);
      edgeKind.push(EDGE_TAG);
    }
  }

  const count = nodes.length;
  const degree = new Int32Array(count);
  for (let e = 0; e < edgeA.length; e++) {
    degree[edgeA[e]]++;
    degree[edgeB[e]]++;
  }
  nodes.forEach((node, i) => (node.deg = degree[i]));

  // Groups: the largest ones get a color each, the rest share one.
  const tally = new Map();
  for (const node of nodes) {
    if (node.groupName !== "") tally.set(node.groupName, (tally.get(node.groupName) ?? 0) + 1);
  }
  const ranked = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const groupId = new Map(ranked.slice(0, MAX_GROUPS).map(([name], i) => [name, i]));
  const groups = ranked.slice(0, MAX_GROUPS).map(([name, size], id) => ({ id, name, size }));
  const rest = ranked.slice(MAX_GROUPS).reduce((sum, [, size]) => sum + size, 0);
  for (const node of nodes) {
    node.group = node.groupName === "" ? -1 : (groupId.get(node.groupName) ?? MAX_GROUPS);
  }

  // Neighbors as a compressed adjacency list.
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const adjList = new Int32Array(adjStart[count]);
  const fill = adjStart.slice(0, count);
  for (let e = 0; e < edgeA.length; e++) {
    adjList[fill[edgeA[e]]++] = edgeB[e];
    adjList[fill[edgeB[e]]++] = edgeA[e];
  }

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const before = previous && previous.get(nodes[i].key);
    if (before) {
      x[i] = before[0];
      y[i] = before[1];
    } else {
      // A sunflower spiral in list order: notes of one folder start next to each other.
      const radius = 7 * Math.sqrt(i + 0.5);
      const angle = i * 2.399963229728653;
      x[i] = radius * Math.cos(angle);
      y[i] = radius * Math.sin(angle);
    }
  }

  const radius = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    radius[i] = Math.min(9, 2.4 + Math.sqrt(degree[i]) * 1.1) + (nodes[i].type === TAG ? 1 : 0);
  }
  const byDegree = Int32Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => degree[b] - degree[a] || a - b,
  );

  return {
    count,
    nodes,
    index,
    edgeCount: edgeA.length,
    edgeA: Int32Array.from(edgeA),
    edgeB: Int32Array.from(edgeB),
    edgeKind: Uint8Array.from(edgeKind),
    adjStart,
    adjList,
    degree,
    radius,
    byDegree,
    groups,
    otherSize: rest,
    tagCount: tagIndex.size,
    x,
    y,
  };
}

/** Which nodes match a search (every word in the label, path or tag), as 1s and 0s. */
export function queryMask(model, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const mask = new Uint8Array(model.count);
  model.nodes.forEach((node, i) => {
    const text = `${node.label} ${node.path ?? ""} ${node.tag ?? ""}`.toLowerCase();
    if (words.every((word) => text.includes(word))) mask[i] = 1;
  });
  return mask;
}

/**
 * The part of a graph shown beside the open note: the files nearest to `center` first, then the
 * best connected, at most `limit` of them. `total` is how many the whole neighborhood had.
 */
export function localSubset(raw, center, limit = LOCAL_LIMIT) {
  const next = new Map();
  const link = (a, b) => {
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  for (const edge of raw.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const distance = new Map([[center, 0]]);
  let frontier = [center];
  while (frontier.length > 0) {
    const found = [];
    for (const path of frontier) {
      for (const other of next.get(path) ?? []) {
        if (distance.has(other)) continue;
        distance.set(other, distance.get(path) + 1);
        found.push(other);
      }
    }
    frontier = found;
  }
  const present = new Set(raw.nodes.map((node) => node.path));
  const all = [...distance.keys()].filter((path) => present.has(path));
  const total = all.length;
  const degree = (path) => (next.get(path) ?? []).length;
  const chosen = new Set(
    all
      .sort(
        (a, b) => distance.get(a) - distance.get(b) || degree(b) - degree(a) || a.localeCompare(b),
      )
      .slice(0, limit),
  );
  chosen.add(center);
  return {
    nodes: raw.nodes.filter((node) => chosen.has(node.path)),
    edges: raw.edges.filter((edge) => chosen.has(edge.from) && chosen.has(edge.to)),
    total,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Layout: a force simulation with a Barnes-Hut quadtree, so one step costs O(n log n).        */

const THETA2 = 2;
const CHARGE = 30;
const LINK_DISTANCE = 30;
const GRAVITY = 0.04;
const VELOCITY_DECAY = 0.6;
const ALPHA_MIN = 0.004;
const SETTLE_STEPS = 300;
/** Big vaults settle in fewer steps so the picture is still before the person loses patience. */
const SETTLE_STEPS_LARGE = 170;
const MAX_DEPTH = 40;

export function createSimulation(model) {
  const n = model.count;
  const { x, y, edgeA, edgeB, edgeCount, degree } = model;
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const pinned = new Uint8Array(n);
  let held = 0;
  const decay = 1 - Math.pow(ALPHA_MIN, 1 / (n > 4000 ? SETTLE_STEPS_LARGE : SETTLE_STEPS));
  let alpha = 1;
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };

  // Spring strength and the share of a spring's push each end takes.
  const strength = new Float64Array(edgeCount);
  const bias = new Float64Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const a = degree[edgeA[e]];
    const b = degree[edgeB[e]];
    strength[e] = 1 / Math.max(1, Math.min(a, b));
    bias[e] = a / Math.max(1, a + b);
  }

  // The quadtree lives in flat arrays that grow when a tick needs more cells.
  let cap = Math.max(64, n * 3);
  let cx0 = new Float64Array(cap);
  let cy0 = new Float64Array(cap);
  let csize = new Float64Array(cap);
  let cmass = new Float64Array(cap);
  let csx = new Float64Array(cap);
  let csy = new Float64Array(cap);
  let cleaf = new Int32Array(cap);
  let cchild = new Int32Array(cap * 4);
  let cells = 0;
  const stack = new Int32Array(MAX_DEPTH * 4 + 16);

  function grow() {
    const next = cap * 2;
    const widen = (old, Type, factor = 1) => {
      const made = new Type(next * factor);
      made.set(old);
      return made;
    };
    cx0 = widen(cx0, Float64Array);
    cy0 = widen(cy0, Float64Array);
    csize = widen(csize, Float64Array);
    cmass = widen(cmass, Float64Array);
    csx = widen(csx, Float64Array);
    csy = widen(csy, Float64Array);
    cleaf = widen(cleaf, Int32Array);
    cchild = widen(cchild, Int32Array, 4);
    cap = next;
  }

  function newCell(x0, y0, size) {
    if (cells >= cap) grow();
    const c = cells++;
    cx0[c] = x0;
    cy0[c] = y0;
    csize[c] = size;
    cmass[c] = 0;
    csx[c] = 0;
    csy[c] = 0;
    cleaf[c] = -1;
    cchild.fill(-1, c * 4, c * 4 + 4);
    return c;
  }

  function childOf(c, px, py) {
    const half = csize[c] / 2;
    const right = px >= cx0[c] + half ? 1 : 0;
    const down = py >= cy0[c] + half ? 1 : 0;
    const slot = c * 4 + down * 2 + right;
    let child = cchild[slot];
    if (child < 0) {
      child = newCell(cx0[c] + right * half, cy0[c] + down * half, half);
      cchild[slot] = child;
    }
    return child;
  }

  function insert(i) {
    let c = 0;
    for (let depth = 0; ; depth++) {
      if (cmass[c] === 0) {
        cleaf[c] = i;
        cmass[c] = 1;
        csx[c] = x[i];
        csy[c] = y[i];
        return;
      }
      if (cleaf[c] >= 0) {
        // A cell that holds one node: push it down so both get a cell of their own.
        if (depth >= MAX_DEPTH) {
          cmass[c] += 1;
          csx[c] += x[i];
          csy[c] += y[i];
          return;
        }
        const j = cleaf[c];
        if (x[j] === x[i] && y[j] === y[i]) x[i] += random() * 1e-3;
        cleaf[c] = -1;
        const moved = childOf(c, x[j], y[j]);
        cleaf[moved] = j;
        cmass[moved] = 1;
        csx[moved] = x[j];
        csy[moved] = y[j];
      }
      cmass[c] += 1;
      csx[c] += x[i];
      csy[c] += y[i];
      c = childOf(c, x[i], y[i]);
    }
  }

  function buildTree() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    cells = 0;
    const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
    newCell(minX - 0.5, minY - 0.5, size);
    for (let i = 0; i < n; i++) insert(i);
  }

  function repel(i) {
    const px = x[i];
    const py = y[i];
    let fx = 0;
    let fy = 0;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const c = stack[--top];
      const mass = cmass[c];
      if (mass === 0) continue;
      const comX = csx[c] / mass;
      const comY = csy[c] / mass;
      let dx = comX - px;
      let dy = comY - py;
      const leaf = cleaf[c] >= 0;
      if (leaf && cleaf[c] === i) continue;
      const size = csize[c];
      const inside = px >= cx0[c] && px < cx0[c] + size && py >= cy0[c] && py < cy0[c] + size;
      let d2 = dx * dx + dy * dy;
      if (leaf || (!inside && size * size < THETA2 * d2)) {
        if (d2 === 0) {
          dx = random() * 1e-3;
          dy = random() * 1e-3;
          d2 = dx * dx + dy * dy;
        }
        if (d2 < 1) d2 = 1;
        const w = (CHARGE * mass) / d2;
        fx -= dx * w;
        fy -= dy * w;
      } else {
        const base = c * 4;
        for (let q = 0; q < 4; q++) {
          const child = cchild[base + q];
          if (child >= 0) stack[top++] = child;
        }
      }
    }
    vx[i] += fx * alpha;
    vy[i] += fy * alpha;
  }

  function tick() {
    alpha -= alpha * decay;
    if (n === 0) return;
    for (let e = 0; e < edgeCount; e++) {
      const a = edgeA[e];
      const b = edgeB[e];
      let dx = x[b] + vx[b] - x[a] - vx[a];
      let dy = y[b] + vy[b] - y[a] - vy[a];
      if (dx === 0) dx = random() * 1e-3;
      if (dy === 0) dy = random() * 1e-3;
      const length = Math.sqrt(dx * dx + dy * dy);
      const pull = ((length - LINK_DISTANCE) / length) * alpha * strength[e];
      dx *= pull;
      dy *= pull;
      vx[b] -= dx * bias[e];
      vy[b] -= dy * bias[e];
      vx[a] += dx * (1 - bias[e]);
      vy[a] += dy * (1 - bias[e]);
    }
    buildTree();
    for (let i = 0; i < n; i++) repel(i);
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < n; i++) {
      vx[i] -= x[i] * GRAVITY * alpha;
      vy[i] -= y[i] * GRAVITY * alpha;
      if (pinned[i]) {
        vx[i] = 0;
        vy[i] = 0;
      } else {
        vx[i] *= VELOCITY_DECAY;
        vy[i] *= VELOCITY_DECAY;
        x[i] += vx[i];
        y[i] += vy[i];
      }
      meanX += x[i];
      meanY += y[i];
    }
    // Keep the picture centered on the origin so it does not drift away (not under a held node).
    if (held === 0) {
      meanX /= n;
      meanY /= n;
      for (let i = 0; i < n; i++) {
        x[i] -= meanX;
        y[i] -= meanY;
      }
    }
  }

  return {
    get alpha() {
      return alpha;
    },
    get settled() {
      return alpha < ALPHA_MIN;
    },
    tick,
    /** Runs steps until the time is up or the layout is settled; returns how many ran. */
    run(budgetMs, maxTicks = Infinity) {
      const end = performance.now() + budgetMs;
      let ran = 0;
      while (alpha >= ALPHA_MIN && ran < maxTicks) {
        tick();
        ran++;
        if (performance.now() >= end) break;
      }
      return ran;
    },
    /** Wakes the layout after a change (a dragged node, a new filter). */
    reheat(level = 0.3) {
      alpha = Math.max(alpha, level);
    },
    pin(i, on) {
      if (pinned[i] === (on ? 1 : 0)) return;
      pinned[i] = on ? 1 : 0;
      held += on ? 1 : -1;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* View: transform, picking and the colors.                                                     */

/** The screen position of a point in graph space. */
export function toScreen(view, px, py) {
  return [px * view.k + view.x, py * view.k + view.y];
}

/** The graph-space position under a screen point. */
export function toGraph(view, sx, sy) {
  return [(sx - view.x) / view.k, (sy - view.y) / view.k];
}

/** A transform that fits the middle 98% of the nodes into a box. */
export function fitView(model, width, height, padding = 28) {
  const n = model.count;
  if (n === 0 || width <= 0 || height <= 0) return { k: 1, x: width / 2, y: height / 2 };
  const xs = Float64Array.from(model.x).sort();
  const ys = Float64Array.from(model.y).sort();
  const low = n > 50 ? Math.floor(n * 0.01) : 0;
  const high = n > 50 ? n - 1 - low : n - 1;
  const minX = xs[low];
  const maxX = xs[high];
  const minY = ys[low];
  const maxY = ys[high];
  const spanX = Math.max(maxX - minX, 40);
  const spanY = Math.max(maxY - minY, 40);
  const k = Math.min(
    4,
    Math.max(0.02, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
  );
  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/** The node under a screen point, the nearest one inside its dot (plus a little slack), or -1. */
export function pickNode(model, view, sx, sy, slack = 3) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < model.count; i++) {
    const [px, py] = toScreen(view, model.x[i], model.y[i]);
    const dx = px - sx;
    const dy = py - sy;
    const reach = screenRadius(model.radius[i], view.k) + slack;
    const d2 = dx * dx + dy * dy;
    if (d2 <= reach * reach && d2 < bestDistance) {
      best = i;
      bestDistance = d2;
    }
  }
  return best;
}

export function screenRadius(radius, k) {
  return radius * (0.45 + 0.55 * Math.min(k, 3));
}

/** A color per group; stable for a group's rank, with lightness fitted to the theme. */
export function groupColor(id, dark) {
  if (id < 0) return dark ? "hsl(220 8% 58%)" : "hsl(220 8% 52%)";
  if (id >= MAX_GROUPS) return dark ? "hsl(220 12% 42%)" : "hsl(220 12% 66%)";
  const hue = Math.round((id * 137.508 + 200) % 360);
  return dark ? `hsl(${hue} 65% 64%)` : `hsl(${hue} 62% 44%)`;
}

/* ------------------------------------------------------------------------------------------ */
/* The canvas: drawing and pointer handling for one picture.                                    */

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readColors() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    dark: document.documentElement.dataset.theme !== "light",
    fg: pick("--fg", "#ddd"),
    muted: pick("--fg-muted", "#999"),
    border: pick("--border", "#444"),
    accent: pick("--accent", "#6c8cff"),
    bg: pick("--bg", "#111"),
    font: pick("--font-sans", "system-ui, sans-serif"),
  };
}

/**
 * Draws a model on a canvas and handles the mouse, touch and keyboard.
 *
 * options: `mode` "full" | "local", `center` (the key of the node to ring), `onOpen(node)`,
 * `onTag(node)`, `describe(node)` (text for the hover card), `labelLimit`.
 */
function createCanvasView(host, options) {
  const { mode } = options;
  const canvas = document.createElement("canvas");
  canvas.className = "pg-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  host.append(canvas);
  const ctx = canvas.getContext("2d");
  const card = document.createElement("div");
  card.className = "pg-card";
  card.hidden = true;
  host.append(card);

  let model = null;
  let sim = null;
  let colors = readColors();
  let view = { k: 1, x: 0, y: 0 };
  // While the view moves in a big picture, the last full drawing is moved instead of redrawn.
  let snap = null;
  let snapTimer = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let dirty = true;
  let autoFit = true;
  let hover = -1;
  let current = -1;
  let pulse = -1;
  let mask = null;
  let state = null;
  let disposed = false;
  let frames = 0;
  const pointers = new Map();
  let gesture = null;
  let pinch = null;

  function resize() {
    const box = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const h = Math.max(1, Math.floor(box.height));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (w === width && h === height && ratio === dpr) return;
    const before = { width, height };
    snap = null;
    width = w;
    height = h;
    dpr = ratio;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (autoFit || before.width === 0) view = model ? fitView(model, width, height) : view;
    else {
      view = { ...view, x: view.x + (w - before.width) / 2, y: view.y + (h - before.height) / 2 };
    }
    dirty = true;
    schedule();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  function beginMove() {
    if (!model || model.count + model.edgeCount < BIG_PICTURE || (sim && !sim.settled)) return;
    if (!snap) {
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d").drawImage(canvas, 0, 0);
      snap = { canvas: copy, k: view.k, x: view.x, y: view.y };
    }
    clearTimeout(snapTimer);
    snapTimer = setTimeout(endMove, 140);
  }

  function endMove() {
    if (!snap) return;
    snap = null;
    dirty = true;
    schedule();
  }

  /** Changes the view; a big picture is moved as an image until the movement stops. */
  function setView(next) {
    beginMove();
    view = next;
  }

  function drawSnapshot() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const scale = view.k / snap.k;
    ctx.drawImage(
      snap.canvas,
      0,
      0,
      snap.canvas.width,
      snap.canvas.height,
      view.x - snap.x * scale,
      view.y - snap.y * scale,
      width * scale,
      height * scale,
    );
  }

  /** Big pictures: the neighbors of a held node follow it without waking the whole layout. */
  function followDrag(i) {
    const { adjStart, adjList, x, y } = model;
    for (let a = adjStart[i]; a < adjStart[i + 1] && a < adjStart[i] + 300; a++) {
      const j = adjList[a];
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const d = Math.hypot(dx, dy);
      if (d <= FOLLOW_DISTANCE) continue;
      const pull = ((d - FOLLOW_DISTANCE) * 0.35) / d;
      x[j] += dx * pull;
      y[j] += dy * pull;
    }
  }

  function schedule() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }

  function recomputeState() {
    if (!model) {
      state = null;
      return;
    }
    const n = model.count;
    state = new Uint8Array(n);
    if (hover >= 0) {
      state.fill(1);
      state[hover] = 3;
      for (let a = model.adjStart[hover]; a < model.adjStart[hover + 1]; a++)
        state[model.adjList[a]] = 2;
    } else if (mask) {
      for (let i = 0; i < n; i++) state[i] = mask[i] ? 2 : 1;
    }
  }

  function frame() {
    raf = 0;
    if (disposed) return;
    if (sim && !sim.settled) {
      const budget = model.count > 3000 ? 9 : 14;
      sim.run(budget);
      // While it moves, follow it (every few frames: fitting sorts the positions).
      if (autoFit && (sim.settled || (mode === "full" && frames % 6 === 0)))
        view = fitView(model, width, height);
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      draw();
    }
    if (sim && !sim.settled) schedule();
  }

  function draw() {
    if (!model || width === 0) return;
    frames++;
    host.dataset.frames = String(frames);
    if (snap) {
      drawSnapshot();
      return;
    }
    const { dark, accent, fg, bg } = colors;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { k } = view;
    const n = model.count;
    const { x, y, edgeA, edgeB, edgeKind, radius, nodes } = model;
    const focused = state !== null;
    const margin = 12;
    const sx = (i) => x[i] * k + view.x;
    const sy = (i) => y[i] * k + view.y;
    const visible = (px, py) =>
      px > -margin && px < width + margin && py > -margin && py < height + margin;

    // Links, in one stroke per class.
    const dim = new Path2D();
    const link = new Path2D();
    const embed = new Path2D();
    const tagLink = new Path2D();
    const lit = new Path2D();
    for (let e = 0; e < model.edgeCount; e++) {
      const a = edgeA[e];
      const b = edgeB[e];
      const ax = sx(a);
      const ay = sy(a);
      const bx = sx(b);
      const by = sy(b);
      if (
        (ax < -margin && bx < -margin) ||
        (ax > width + margin && bx > width + margin) ||
        (ay < -margin && by < -margin) ||
        (ay > height + margin && by > height + margin)
      )
        continue;
      let target;
      if (!focused)
        target = edgeKind[e] === EDGE_EMBED ? embed : edgeKind[e] === EDGE_TAG ? tagLink : link;
      else if (hover >= 0) target = a === hover || b === hover ? lit : dim;
      else target = state[a] === 2 && state[b] === 2 ? link : dim;
      target.moveTo(ax, ay);
      target.lineTo(bx, by);
    }
    ctx.lineWidth = 1;
    const base = dark ? "255,255,255" : "20,30,60";
    ctx.strokeStyle = `rgba(${base},${focused ? 0.05 : 0.14})`;
    ctx.stroke(dim);
    ctx.strokeStyle = `rgba(${base},${n > 4000 ? 0.16 : n > 400 ? 0.3 : 0.6})`;
    ctx.stroke(link);
    ctx.setLineDash([4, 3]);
    ctx.stroke(embed);
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${base},0.12)`;
    ctx.stroke(tagLink);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = accent;
    ctx.stroke(lit);

    // Dots, one fill per color and emphasis.
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const px = sx(i);
      const py = sy(i);
      if (!visible(px, py)) continue;
      const s = state ? state[i] : 2;
      const emphasis = s === 1 ? 0 : 1;
      const group = nodes[i].type === TAG ? 100 : nodes[i].group;
      const key = group * 2 + emphasis;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { path: new Path2D(), group, emphasis };
        buckets.set(key, bucket);
      }
      const r = screenRadius(radius[i], k);
      if (nodes[i].type === TAG) bucket.path.rect(px - r, py - r, r * 2, r * 2);
      else if (r < 2.4) bucket.path.rect(px - r, py - r, r * 2, r * 2);
      else {
        bucket.path.moveTo(px + r, py);
        bucket.path.arc(px, py, r, 0, Math.PI * 2);
      }
    }
    for (const bucket of [...buckets.values()].sort((a, b) => a.emphasis - b.emphasis)) {
      ctx.globalAlpha = bucket.emphasis ? 1 : 0.16;
      ctx.fillStyle = bucket.group === 100 ? accent : groupColor(bucket.group, dark);
      ctx.fill(bucket.path);
    }
    ctx.globalAlpha = 1;

    // Rings: the open note, the hovered or just-found node.
    const ring = (i, color, width2) => {
      if (i < 0 || i >= n) return;
      const px = sx(i);
      const py = sy(i);
      ctx.beginPath();
      ctx.arc(px, py, screenRadius(radius[i], k) + 3, 0, Math.PI * 2);
      ctx.lineWidth = width2;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    ring(current, accent, 2);
    ring(pulse, accent, 2);
    ring(hover, fg, 1.5);

    // Labels: the hovered node and its neighbors, then the best connected nodes in view.
    ctx.font = `11px ${colors.font}`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const taken = new Set();
    const cell = (px, py) => `${Math.floor(px / 70)},${Math.floor(py / 14)}`;
    let drawn = 0;
    const limit = options.labelLimit ?? (k < 0.5 ? 0 : k < 1.1 ? 24 : 90);
    const label = (i, force) => {
      const px = sx(i);
      const py = sy(i);
      if (!visible(px, py)) return;
      const spot = cell(px, py);
      if (!force && taken.has(spot)) return;
      taken.add(spot);
      const text = nodes[i].label.length > 28 ? `${nodes[i].label.slice(0, 27)}…` : nodes[i].label;
      const dx = screenRadius(radius[i], k) + 5;
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.strokeText(text, px + dx, py);
      ctx.fillStyle = fg;
      ctx.fillText(text, px + dx, py);
      drawn++;
    };
    if (hover >= 0) {
      label(hover, true);
      for (let a = model.adjStart[hover]; a < model.adjStart[hover + 1]; a++)
        label(model.adjList[a], true);
    }
    if (current >= 0) label(current, true);
    if (pulse >= 0) label(pulse, true);
    if (mask && hover < 0) {
      let shown = 0;
      for (const i of model.byDegree) {
        if (shown >= 40) break;
        if (mask[i]) {
          label(i, false);
          shown++;
        }
      }
    }
    if (hover < 0 && !mask) {
      for (const i of model.byDegree) {
        if (drawn >= limit) break;
        label(i, false);
      }
    }
  }

  /* ----- input ----- */

  function point(event) {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  function setHover(i, px, py) {
    if (i === hover) {
      if (i >= 0) moveCard(px, py);
      return;
    }
    hover = i;
    recomputeState();
    dirty = true;
    schedule();
    if (i < 0) {
      card.hidden = true;
      canvas.style.cursor = "";
    } else {
      card.textContent = options.describe ? options.describe(model.nodes[i]) : model.nodes[i].label;
      card.hidden = false;
      canvas.style.cursor = "pointer";
      moveCard(px, py);
    }
  }

  function moveCard(px, py) {
    const w = card.offsetWidth;
    card.style.left = `${Math.max(4, Math.min(width - w - 4, px + 14))}px`;
    card.style.top = `${Math.max(4, Math.min(height - 30, py + 14))}px`;
  }

  function zoomAt(factor, px, py) {
    const k = Math.min(8, Math.max(0.02, view.k * factor));
    const real = k / view.k;
    setView({ k, x: px - (px - view.x) * real, y: py - (py - view.y) * real });
    autoFit = false;
    dirty = true;
    schedule();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!model || event.button > 0) return;
    canvas.setPointerCapture(event.pointerId);
    const [px, py] = point(event);
    pointers.set(event.pointerId, [px, py]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), k: view.k };
      gesture = null;
      return;
    }
    const hit = pickNode(model, view, px, py, event.pointerType === "touch" ? 10 : 3);
    gesture = {
      node: hit,
      startX: px,
      startY: py,
      lastX: px,
      lastY: py,
      moved: false,
    };
    if (hit >= 0 && sim) sim.pin(hit, true);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!model) return;
    const [px, py] = point(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, [px, py]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(
        (pinch.k * (distance / pinch.distance)) / view.k,
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
      );
      return;
    }
    if (!gesture) {
      setHover(pickNode(model, view, px, py), px, py);
      return;
    }
    if (!gesture.moved && Math.hypot(px - gesture.startX, py - gesture.startY) > 4) {
      gesture.moved = true;
      autoFit = false;
    }
    if (!gesture.moved) return;
    if (gesture.node >= 0) {
      const [gx, gy] = toGraph(view, px, py);
      model.x[gesture.node] = gx;
      model.y[gesture.node] = gy;
      if (model.count > 3000) followDrag(gesture.node);
      else if (sim) sim.reheat(0.25);
      setHover(gesture.node, px, py);
    } else {
      setView({ ...view, x: view.x + px - gesture.lastX, y: view.y + py - gesture.lastY });
      card.hidden = true;
    }
    gesture.lastX = px;
    gesture.lastY = py;
    dirty = true;
    schedule();
  });

  function release(event) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      gesture = null;
      return;
    }
    const g = gesture;
    gesture = null;
    if (!g || !model) return;
    if (g.node >= 0) {
      if (sim) sim.pin(g.node, false);
      if (!g.moved && event.type === "pointerup") {
        const node = model.nodes[g.node];
        if (node.type === TAG) options.onTag?.(node);
        else options.onOpen?.(node);
      }
    }
    if (event.pointerType === "touch") setHover(-1, 0, 0);
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", (event) => {
    if (!gesture && event.pointerType !== "touch") setHover(-1, 0, 0);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!model) return;
      if (mode === "local" && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const [px, py] = point(event);
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), px, py);
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", (event) => {
    if (!model) return;
    const [px, py] = point(event);
    if (pickNode(model, view, px, py) < 0) api.fit();
  });

  canvas.addEventListener("keydown", (event) => {
    const step = 40;
    const keys = {
      ArrowLeft: () => setView({ ...view, x: view.x + step }),
      ArrowRight: () => setView({ ...view, x: view.x - step }),
      ArrowUp: () => setView({ ...view, y: view.y + step }),
      ArrowDown: () => setView({ ...view, y: view.y - step }),
    };
    if (keys[event.key]) {
      keys[event.key]();
      autoFit = false;
    } else if (event.key === "+" || event.key === "=") zoomAt(1.25, width / 2, height / 2);
    else if (event.key === "-" || event.key === "_") zoomAt(0.8, width / 2, height / 2);
    else if (event.key === "0") api.fit();
    else return;
    event.preventDefault();
    dirty = true;
    schedule();
  });

  const api = {
    canvas,
    get model() {
      return model;
    },
    get view() {
      return view;
    },
    get settled() {
      return !sim || sim.settled;
    },
    get frames() {
      return frames;
    },
    /** Shows a model; the layout starts from where its nodes are and runs on. */
    setModel(next, settleMs) {
      model = next;
      snap = null;
      sim = model.count > 0 ? createSimulation(model) : null;
      hover = -1;
      pulse = -1;
      current = -1;
      card.hidden = true;
      autoFit = true;
      if (sim) {
        // Settle a good part before the first picture; the rest animates.
        const quick = reducedMotion();
        sim.run(quick ? 4000 : (settleMs ?? 450));
        if (quick) while (!sim.settled) sim.run(1000);
      }
      view = fitView(model, width, height);
      mask = null;
      recomputeState();
      dirty = true;
      canvas.setAttribute("aria-label", options.ariaLabel ? options.ariaLabel(model) : "");
      schedule();
    },
    setMask(next, silent) {
      mask = next;
      recomputeState();
      if (!silent) {
        dirty = true;
        schedule();
      }
    },
    setCurrent(key) {
      current = model && key ? (model.index.get(key) ?? -1) : -1;
      dirty = true;
      schedule();
    },
    setColors() {
      colors = readColors();
      dirty = true;
      schedule();
    },
    /** Moves the view to a node and rings it for a moment. */
    focusNode(i) {
      if (!model || i < 0) return;
      autoFit = false;
      const k = Math.max(view.k, 1);
      setView({ k, x: width / 2 - model.x[i] * k, y: height / 2 - model.y[i] * k });
      pulse = i;
      dirty = true;
      schedule();
      setTimeout(() => {
        if (pulse === i) {
          pulse = -1;
          dirty = true;
          schedule();
        }
      }, 1800);
    },
    fit() {
      if (!model) return;
      autoFit = true;
      setView(fitView(model, width, height));
      dirty = true;
      schedule();
    },
    zoom(factor) {
      zoomAt(factor, width / 2, height / 2);
    },
    /** A node's position on screen, for tests and for keyboard focus. */
    screenOf(key) {
      const i = model ? model.index.get(key) : undefined;
      return i === undefined ? null : toScreen(view, model.x[i], model.y[i]);
    },
    dispose() {
      disposed = true;
      clearTimeout(snapTimer);
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.remove();
      card.remove();
    },
  };
  resize();
  return api;
}

/* ------------------------------------------------------------------------------------------ */
/* Screens.                                                                                     */

const STYLE = `
.pg-root{display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:10px;}
.pg-root.pg-local{padding:0;gap:6px;}
.pg-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.pg-bar label{display:inline-flex;align-items:center;gap:4px;color:var(--fg-muted);font-size:12px;}
.pg-bar label.pg-check{color:var(--fg);}
.pg-bar select,.pg-bar input[type=search],.pg-bar button{padding:4px 8px;font-size:13px;}
.pg-bar input[type=search]{min-width:170px;flex:1 1 170px;max-width:280px;}
.pg-bar input[type=checkbox]{margin:0;accent-color:var(--accent);}
.pg-search{position:relative;display:flex;flex:1 1 170px;max-width:280px;}
.pg-search input{width:100%;}
.pg-results{position:absolute;top:100%;left:0;right:0;z-index:5;margin-top:2px;padding:4px;
  background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;max-height:260px;overflow:auto;
  box-shadow:0 6px 20px rgba(0,0,0,.25);}
.pg-results button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:5px 8px;border-radius:6px;font-size:13px;}
.pg-results button:hover,.pg-results button:focus{background:var(--bg-hover);outline:none;}
.pg-results small{color:var(--fg-muted);margin-left:6px;}
.pg-results p{margin:0;padding:6px 8px;color:var(--fg-muted);font-size:13px;}
.pg-status{color:var(--fg-muted);font-size:12px;margin-left:auto;}
.pg-stage{position:relative;flex:1 1 auto;min-height:120px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg);}
.pg-local .pg-stage{flex:none;height:240px;border-radius:8px;}
.pg-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;}
.pg-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--accent);}
.pg-card{position:absolute;pointer-events:none;max-width:260px;padding:4px 8px;border-radius:6px;font-size:12px;
  background:var(--bg-elev-2,var(--bg-elev));border:1px solid var(--border);color:var(--fg);white-space:pre-line;z-index:3;}
.pg-legend{position:absolute;left:8px;bottom:8px;display:flex;flex-wrap:wrap;gap:2px 10px;max-width:70%;font-size:11px;
  color:var(--fg-muted);pointer-events:none;}
.pg-legend span{display:inline-flex;align-items:center;gap:4px;}
.pg-legend i{width:8px;height:8px;border-radius:50%;display:inline-block;}
.pg-zoom{position:absolute;right:8px;bottom:8px;display:flex;flex-direction:column;gap:4px;}
.pg-zoom button{width:28px;height:28px;padding:0;font-size:16px;line-height:1;}
.pg-stage .pg-note{position:relative;z-index:2;}
.pg-note{margin:0;padding:12px;color:var(--fg-muted);font-size:13px;}
.pg-note.pg-bad{color:var(--danger);}
.pg-depth{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--fg-muted);}
.pg-depth button{padding:2px 8px;font-size:12px;}
.pg-depth button[aria-pressed=true]{background:var(--accent);color:var(--accent-fg,#fff);border-color:var(--accent);}
`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return node;
}

function addStyle(root, fill) {
  const style = document.createElement("style");
  // A page fills its frame; the side panel's frame grows with its content instead.
  style.textContent = fill ? `html,body,#root{height:100%;margin:0;}${STYLE}` : STYLE;
  root.append(style);
}

function errorText(error) {
  return String((error && error.message) || error);
}

/** The whole-vault page. */
function mountFull(palimvo, context) {
  const t = (key, params) => palimvo.i18n.t(key, params);
  const root = context.el;
  root.replaceChildren();
  addStyle(root, true);
  const page = el("div", { class: "pg-root" });
  root.append(page);

  const settings = { tags: false, embeds: true, orphans: true, folder: "", colorBy: "folder" };
  let raw = null;
  let rawHasTags = false;
  let query = "";
  let disposed = false;
  let canvasView = null;
  let loadId = 0;
  let refreshTimer = 0;
  let currentPath = null;

  const searchInput = el("input", {
    type: "search",
    placeholder: t("searchPlaceholder"),
    "aria-label": t("search"),
    autocomplete: "off",
  });
  const results = el("div", { class: "pg-results", hidden: true, role: "listbox" });
  const status = el("span", { class: "pg-status", role: "status", "aria-live": "polite" });
  const folderSelect = el("select", { "aria-label": t("folder") });
  const colorSelect = el(
    "select",
    { "aria-label": t("colorBy") },
    el("option", { value: "folder" }, t("colorFolder")),
    el("option", { value: "tag" }, t("colorTag")),
    el("option", { value: "type" }, t("colorType")),
  );
  const check = (name, label) => {
    const input = el("input", { type: "checkbox" });
    input.checked = settings[name];
    input.addEventListener("change", () => {
      settings[name] = input.checked;
      void rebuild();
    });
    return el("label", { class: "pg-check" }, input, label);
  };
  const bar = el(
    "div",
    { class: "pg-bar" },
    el("div", { class: "pg-search" }, searchInput, results),
    folderSelect,
    el("label", {}, t("colorBy"), colorSelect),
    check("tags", t("showTags")),
    check("embeds", t("showEmbeds")),
    check("orphans", t("showOrphans")),
    status,
  );
  const stage = el("div", { class: "pg-stage" });
  const legend = el("div", { class: "pg-legend" });
  const zoom = el(
    "div",
    { class: "pg-zoom" },
    el(
      "button",
      {
        type: "button",
        "aria-label": t("zoomIn"),
        title: t("zoomIn"),
        onclick: () => canvasView?.zoom(1.3),
      },
      "+",
    ),
    el(
      "button",
      {
        type: "button",
        "aria-label": t("zoomOut"),
        title: t("zoomOut"),
        onclick: () => canvasView?.zoom(1 / 1.3),
      },
      "−",
    ),
    el(
      "button",
      { type: "button", "aria-label": t("fit"), title: t("fit"), onclick: () => canvasView?.fit() },
      "⤢",
    ),
  );
  const note = el("p", { class: "pg-note", role: "status" }, t("loading"));
  page.append(bar, stage);
  stage.append(note);

  folderSelect.append(el("option", { value: "" }, t("allFolders")));

  const kindLabel = (node) => t(KIND_KEY[node.type]);

  function describe(node) {
    if (node.type === TAG) return `${node.label}\n${t("links", { count: node.deg })}`;
    return `${node.label}\n${node.path}\n${kindLabel(node)} · ${t("links", { count: node.deg })}`;
  }

  function showLegend() {
    legend.replaceChildren();
    const model = canvasView?.model;
    if (!model) return;
    const dark = readColors().dark;
    const names = {
      folder: (name) => name,
      tag: (name) => `#${name}`,
      type: (name) =>
        t(
          { markdown: "kindMarkdown", canvas: "kindCanvas", base: "kindBase" }[name] ??
            "kindMarkdown",
        ),
    }[settings.colorBy];
    for (const group of model.groups.slice(0, 8)) {
      legend.append(
        el(
          "span",
          {},
          el("i", { style: `background:${groupColor(group.id, dark)}` }),
          names(group.name),
        ),
      );
    }
    if (model.groups.length > 8 || model.otherSize > 0)
      legend.append(
        el(
          "span",
          {},
          el("i", { style: `background:${groupColor(MAX_GROUPS, dark)}` }),
          t("otherGroups"),
        ),
      );
  }

  async function load() {
    const id = ++loadId;
    const wantTags = settings.tags || settings.colorBy === "tag";
    try {
      const next = await palimvo.vault.graph(wantTags ? { tags: true } : {});
      if (disposed || id !== loadId) return;
      raw = next;
      rawHasTags = wantTags;
      const folders = topFolders(raw);
      const chosen = folders.includes(settings.folder) ? settings.folder : "";
      settings.folder = chosen;
      folderSelect.replaceChildren(
        el("option", { value: "" }, t("allFolders")),
        ...folders.map((folder) => el("option", { value: folder }, folder)),
      );
      folderSelect.value = chosen;
    } catch (error) {
      if (disposed || id !== loadId) return;
      note.textContent = t("failed", { detail: errorText(error) });
      note.className = "pg-note pg-bad";
      note.hidden = false;
      return;
    }
    await rebuild();
  }

  async function rebuild() {
    if (disposed || !raw) return;
    if ((settings.tags || settings.colorBy === "tag") && !rawHasTags) {
      await load();
      return;
    }
    const previous = new Map();
    const old = canvasView?.model;
    if (old) old.nodes.forEach((node, i) => previous.set(node.key, [old.x[i], old.y[i]]));
    const model = buildModel(raw, { ...settings, previous });
    if (!canvasView) {
      stage.replaceChildren();
      canvasView = createCanvasView(stage, {
        mode: "full",
        describe,
        ariaLabel: (m) => t("canvasLabel", { notes: m.count }),
        onOpen: (node) => palimvo.ui.openFile(node.path),
        onTag: (node) => {
          searchInput.value = node.label;
          applyQuery();
        },
      });
      stage.append(legend, zoom);
      window.__graph = canvasView;
    }
    note.hidden = true;
    canvasView.setModel(model, old ? 120 : 450);
    canvasView.setMask(queryMask(model, query));
    canvasView.setCurrent(currentPath);
    if (model.count === 0) {
      stage.append(note);
      note.textContent = t("empty");
      note.className = "pg-note";
      note.hidden = false;
    }
    const noteCount = model.count - model.tagCount;
    status.textContent = settings.tags
      ? t("summaryTags", {
          notes: noteCount,
          links: model.edgeCount - tagEdges(model),
          tags: model.tagCount,
        })
      : t("summary", { notes: noteCount, links: model.edgeCount });
    showLegend();
    root.dataset.ready = "1";
    document.body.dataset.ready = "1";
  }

  function tagEdges(model) {
    let count = 0;
    for (let e = 0; e < model.edgeCount; e++) if (model.edgeKind[e] === EDGE_TAG) count++;
    return count;
  }

  /* search box */
  let matches = [];
  function applyQuery() {
    query = searchInput.value;
    const model = canvasView?.model;
    if (!model) return;
    const mask = queryMask(model, query);
    canvasView.setMask(mask);
    matches = [];
    if (mask) {
      for (const i of model.byDegree) {
        if (mask[i]) matches.push(i);
        if (matches.length >= 8) break;
      }
    }
    results.replaceChildren();
    if (!mask) {
      results.hidden = true;
      return;
    }
    if (matches.length === 0) results.append(el("p", {}, t("noMatch")));
    for (const i of matches) {
      const node = model.nodes[i];
      results.append(
        el(
          "button",
          { type: "button", role: "option", onclick: () => choose(i) },
          node.label,
          el("small", {}, node.type === TAG ? t("tag") : (node.path ?? "")),
        ),
      );
    }
    results.hidden = false;
  }

  function choose(i) {
    const model = canvasView?.model;
    if (!model) return;
    results.hidden = true;
    const node = model.nodes[i];
    canvasView.focusNode(i);
    if (node.type !== TAG) palimvo.ui.openFile(node.path);
  }

  searchInput.addEventListener("input", applyQuery);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && matches.length > 0) {
      event.preventDefault();
      choose(matches[0]);
    } else if (event.key === "ArrowDown" && !results.hidden) {
      event.preventDefault();
      results.querySelector("button")?.focus();
    } else if (event.key === "Escape") {
      searchInput.value = "";
      results.hidden = true;
      applyQuery();
    }
  });
  results.addEventListener("keydown", (event) => {
    const buttons = [...results.querySelectorAll("button")];
    const at = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") buttons[Math.min(buttons.length - 1, at + 1)]?.focus();
    else if (event.key === "ArrowUp") (at <= 0 ? searchInput : buttons[at - 1]).focus();
    else if (event.key === "Escape") searchInput.focus();
    else return;
    event.preventDefault();
  });
  folderSelect.addEventListener("change", () => {
    settings.folder = folderSelect.value;
    void rebuild();
  });
  colorSelect.addEventListener("change", () => {
    settings.colorBy = colorSelect.value;
    void rebuild();
  });

  const offs = [
    palimvo.events.on("theme:changed", () => {
      canvasView?.setColors();
      showLegend();
    }),
    palimvo.events.on("file:opened", ({ path }) => {
      currentPath = path;
      canvasView?.setCurrent(path);
    }),
    palimvo.events.on("file:changed", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(), 2000);
    }),
  ];

  void load();
  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    for (const off of offs) off();
    canvasView?.dispose();
    if (window.__graph === canvasView) delete window.__graph;
    root.replaceChildren();
  };
}

/** The side panel: the open note and what is within a few links of it. */
function mountLocal(palimvo, context) {
  const t = (key, params) => palimvo.i18n.t(key, params);
  const root = context.el;
  root.replaceChildren();
  addStyle(root);
  const page = el("div", { class: "pg-root pg-local" });
  root.append(page);
  const path = context.path;
  if (!path) {
    page.append(el("p", { class: "pg-note" }, t("localHint")));
    return () => root.replaceChildren();
  }

  let disposed = false;
  let depth = 1;
  let canvasView = null;
  const status = el("span", { class: "pg-status", role: "status", "aria-live": "polite" });
  const buttons = [1, 2, 3].map((value) =>
    el(
      "button",
      {
        type: "button",
        "aria-pressed": value === depth ? "true" : "false",
        title: `${t("depth")}: ${value}`,
        onclick: () => {
          depth = value;
          for (const [i, button] of buttons.entries())
            button.setAttribute("aria-pressed", i + 1 === depth ? "true" : "false");
          void load();
        },
      },
      t("depthN", { count: value }),
    ),
  );
  const bar = el(
    "div",
    { class: "pg-bar" },
    el("span", { class: "pg-depth" }, t("depth"), ...buttons),
    status,
  );
  const stage = el("div", { class: "pg-stage" });
  const note = el("p", { class: "pg-note", role: "status" }, t("loading"));
  page.append(bar, stage);
  stage.append(note);
  let loadId = 0;

  async function load() {
    const id = ++loadId;
    try {
      const raw = await palimvo.vault.graph({ around: path, depth });
      if (disposed || id !== loadId) return;
      const subset = localSubset(raw, path);
      const model = buildModel(
        { nodes: subset.nodes, edges: subset.edges },
        { colorBy: "folder", previous: canvasView ? previousOf(canvasView.model) : null },
      );
      if (!canvasView) {
        stage.replaceChildren();
        canvasView = createCanvasView(stage, {
          mode: "local",
          labelLimit: 40,
          describe: (node) => `${node.label}\n${t("links", { count: node.deg })}`,
          ariaLabel: (m) => t("canvasLabel", { notes: m.count }),
          onOpen: (node) => {
            if (node.path !== path) palimvo.ui.openFile(node.path);
          },
        });
        window.__graph = canvasView;
      }
      canvasView.setModel(model, 200);
      canvasView.setCurrent(path);
      if (model.count <= 1) {
        stage.append(note);
        note.textContent = t("localAlone");
        note.className = "pg-note";
        note.hidden = false;
      } else note.hidden = true;
      status.textContent =
        subset.total > model.count
          ? t("truncated", { shown: model.count, total: subset.total })
          : t("summary", { notes: model.count, links: model.edgeCount });
      document.body.dataset.ready = "1";
    } catch (error) {
      if (disposed || id !== loadId) return;
      note.textContent = t("failed", { detail: errorText(error) });
      note.className = "pg-note pg-bad";
      note.hidden = false;
    }
  }

  function previousOf(model) {
    const map = new Map();
    model.nodes.forEach((node, i) => map.set(node.key, [model.x[i], model.y[i]]));
    return map;
  }

  // Files appearing or going away change the neighborhood (edits of the open note are not reported yet).
  let refreshTimer = 0;
  const offs = [
    palimvo.events.on("theme:changed", () => canvasView?.setColors()),
    palimvo.events.on("file:changed", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(), 1500);
    }),
  ];
  void load();
  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    for (const off of offs) off();
    canvasView?.dispose();
    if (window.__graph === canvasView) delete window.__graph;
    root.replaceChildren();
  };
}

export default (palimvo) => {
  let last = null;
  // A language change draws the screen again with the new strings.
  const redraw = () => {
    if (last) last.restart();
  };
  palimvo.events.on("locale:changed", redraw);

  const register = (draw) => (context) => {
    const state = { stop: draw(palimvo, context) };
    state.restart = () => {
      state.stop();
      state.stop = draw(palimvo, context);
    };
    last = state;
    return () => {
      state.stop();
      if (last === state) last = null;
    };
  };

  palimvo.ui.registerView("links", register(mountFull));
  palimvo.ui.registerSlot("inspector", "local", {
    render: register(mountLocal),
  });
};
