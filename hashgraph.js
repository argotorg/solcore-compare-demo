// The "hash graph" view: the containment tree of one function drawn from the integer record of the
// slot layout (`slot_layout` in the viewer module, sections 1.1 to 1.7 and 5 of FABLE-B5-LAYOUT.md),
// or, when a pair is selected, the two versions of a function drawn from the union record
// (`slot_union_layout`, section 1.9; the comparison lives in hashgraph-pair.js).
//
// Rows are hash heights (0 for a leaf), columns are exclusive slots, and `z` (slack) is the depth
// offset inside a plate. The page draws an orthographic projection of that object, computed here
// from three numbers: the yaw (a turn about the vertical axis), the tilt (camera elevation) and the
// spread (the depth pitch as a fraction of the row pitch). Nothing in this file decides a position;
// the record does.
//
// The first half is pure (no DOM), so Node can test it. `initHashView` at the end connects it to
// the page.
//
// The hash of a node (equal-hash colours, the counts, the hover text) is the one the page's facets choose:
// hashsel.js. `opts.hash` of the drawing and the `sel` of `summarise` are `{ mask, bindings }`; without
// them the hash is that of the default facets, `node.hash`.

import { DEFAULT_SEL, hashesOf, hashName, hashText } from './hashsel.js?v=aa62f03930';
import { HINT, singlePanel, pairPanel } from './preview.js?v=0ed0ee8f0b';

// Pixel sizes: one column is 12 pixels, so a half column is 6 (the record counts half columns).
export const GEOM = { halfColumn: 6, row: 50, boxHeight: 22 };
// `colour` is the switch for one function (on by default), `pairColour` the same switch in a comparison
// (off by default): the reader's choice is kept apart for the two views.
export const DEFAULTS = { tilt: 15, spread: 0.5, yaw: 0, colour: true, pairColour: false, arcs: false, uniform: false, paths: false };
export const LIMITS = { tilt: [0, 60], spread: [0, 2], yaw: [0, 90] };
// The isometric camera: yaw 45 degrees, elevation arctan(1 / sqrt 2) = 35.264 degrees, and one depth
// unit as long as one row (spread 1), so that the three axes are foreshortened equally.
export const ISO = { yaw: 45, tilt: (Math.atan(1 / Math.SQRT2) * 180) / Math.PI, spread: 1 };
// Eight outline colours, indexed by the first two bytes of the hash (`--hash0` to `--hash7` in
// hashgraph.css, a validated categorical palette for light and dark).
export const PALETTE_SIZE = 8;
const CHAR_PX = 6.6;
const PLATE_PAD = 8;
const LABEL_ROOM = 66;

/**
 * The camera: yaw about the vertical axis (applied first), then the elevation `tilt` in degrees; the
 * depth pitch `spread` (1 = as far as a row). With yaw 0 this is the camera of the front view.
 */
export function camera(tilt, spread, geom = GEOM, yaw = 0) {
  const t = (tilt * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  return { tilt, spread, yaw, cos: Math.cos(t), sin: Math.sin(t), cosY: Math.cos(y), sinY: Math.sin(y), geom };
}

/**
 * Orthographic projection of a world point `(X, Y, Z)` in pixels: X along the columns (to the right),
 * Y up the rows, Z along the depth offset (the slack axis, away from the viewer at yaw 0). The yaw
 * turns X and Z about the vertical axis, X' = X cos y + Z sin y and Z' = Z cos y - X sin y; the camera
 * is then raised by `tilt` about the X axis, so the upward screen coordinate is Y cos t + Z' sin t and
 * the distance from the viewer is Z' cos t - Y sin t (larger = farther). With yaw 0, X' = X and Z' = Z
 * exactly, which is the projection of the front and depth views.
 */
export function projectWorld(X0, Y, Z0, cam, height) {
  const g = cam.geom;
  const X = X0 * cam.cosY + Z0 * cam.sinY, Z = Z0 * cam.cosY - X0 * cam.sinY;
  return { x: X, y: height * g.row - (Y * cam.cos + Z * cam.sin), depth: Z * cam.cos - Y * cam.sin };
}

/**
 * Projection of a record point `[x, row, z]` (half columns, rows, rows of slack): the world point is
 * X = x * halfColumn, Y = row * rowPitch, Z = spread * z * rowPitch. The result is in SVG pixels,
 * y down, with the root row at y = 0 when the tilt is 0.
 */
export function project(point, cam, height) {
  const [x, row, z] = point;
  const g = cam.geom;
  return projectWorld(x * g.halfColumn, row * g.row, cam.spread * z * g.row, cam, height);
}

/** The tilt in degrees at which rows are source depths (report, 1.6; yaw 0): tan t = 1 / spread. */
export function depthTilt(spread) {
  return spread > 0 ? (Math.atan(1 / spread) * 180) / Math.PI : 90;
}

// The convex hull of points (Andrew's monotone chain): counter-clockwise, no repeated point.
function hull(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const out = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return build(p).concat(build(p.slice().reverse()));
}

/**
 * Everything the drawing needs, in pixels, from a record: boxes, edges, plates, drawing order. A
 * record from the union layout (`slot_union_layout`, one side) also holds `ghosts` (boxes of the other
 * side's nodes) and `ghost_edges`; they are projected too, and the plates and bounds cover them.
 */
export function scene(record, cam) {
  const g = cam.geom, H = record.height;
  const ghosts = record.ghosts || [];
  const boxOf = (s, v) => {
    const p = project([s.x, s.row, s.z], cam, H);
    return { v, row: s.row, x: p.x, y: p.y, w: s.w * g.halfColumn, h: g.boxHeight, depth: p.depth };
  };
  const boxes = record.slots.map((s, v) => boxOf(s, v));
  const ghostBoxes = ghosts.map((s, i) => ({ ...boxOf(s, i), of: s.of }));
  const edges = record.edges.map((e) => ({ parent: e.parent, child: e.child, points: e.points.map((p) => project(p, cam, H)) }));
  const ghostEdges = (record.ghost_edges || []).map((points) => ({ points: points.map((p) => project(p, cam, H)) }));
  // One plate per row that has nodes (real or ghost); it spans the drawing's width and the row's depth range.
  const zmax = new Array(H + 1).fill(-1);
  for (const s of record.slots) zmax[s.row] = Math.max(zmax[s.row], s.z);
  for (const s of ghosts) zmax[s.row] = Math.max(zmax[s.row], s.z);
  const plates = [];
  const turned = cam.yaw !== 0;
  const v = g.boxHeight / 2 + PLATE_PAD / 2;
  for (let row = 0; row <= H; row++) {
    if (zmax[row] < 0) continue;
    if (!turned) {
      const front = project([0, row, 0], cam, H), back = project([0, row, zmax[row]], cam, H);
      plates.push({
        row,
        x0: -PLATE_PAD, x1: record.width * g.halfColumn + PLATE_PAD,
        y0: back.y - g.boxHeight / 2 - PLATE_PAD / 2, y1: front.y + g.boxHeight / 2 + PLATE_PAD / 2,
        depth: (front.depth + back.depth) / 2,
        label: { x: -PLATE_PAD - 6, y: front.y + 4 },
      });
      continue;
    }
    // Turned camera: the plate is the rectangle of the row in the plane of X and Z (padded), as
    // projected, with the boxes' half height added above and below, so that a box centred on the
    // plate stays on it. The label sits at the leftmost corner.
    const Y = row * g.row, W = record.width * g.halfColumn, D = cam.spread * zmax[row] * g.row;
    const corners = [[-PLATE_PAD, -PLATE_PAD], [W + PLATE_PAD, -PLATE_PAD], [W + PLATE_PAD, D + PLATE_PAD], [-PLATE_PAD, D + PLATE_PAD]]
      .map(([X, Z]) => projectWorld(X, Y, Z, cam, H));
    let left = corners[0];
    for (const c of corners) if (c.x < left.x) left = c;
    const points = hull(corners.flatMap((c) => [[c.x, c.y - v], [c.x, c.y + v]]));
    plates.push({
      row, points,
      depth: corners.reduce((s, c) => s + c.depth, 0) / corners.length,
      label: { x: left.x - 6, y: left.y + 4 },
    });
  }
  // Far first; ties by node number (rows for plates), so the order never depends on the engine.
  const order = boxes.map((b) => b.v).sort((a, b) => boxes[b].depth - boxes[a].depth || a - b);
  plates.sort((a, b) => b.depth - a.depth || a.row - b.row);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes.concat(ghostBoxes)) {
    x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2);
    y0 = Math.min(y0, b.y - b.h / 2); y1 = Math.max(y1, b.y + b.h / 2);
  }
  for (const p of plates) {
    const xs = p.points ? p.points.map((q) => q[0]) : [p.x0, p.x1], ys = p.points ? p.points.map((q) => q[1]) : [p.y0, p.y1];
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs); y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  if (!isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 100, 40];
  return { cam, height: H, boxes, ghostBoxes, edges, ghostEdges, plates, order, bounds: { x0, y0, x1, y1 } };
}

/** Index into the palette of a hash: its first two bytes (four hex digits) modulo the palette size. */
export function hashColourIndex(hash) {
  const n = parseInt(String(hash || '').slice(0, 4), 16);
  return Number.isNaN(n) ? 0 : n % PALETTE_SIZE;
}

/** How often each hash occurs in a list of hashes, one per node (a node without a hash, null, is not counted). */
export function hashCounts(hashes) {
  const counts = new Map();
  for (const h of hashes) if (h) counts.set(h, (counts.get(h) || 0) + 1);
  return counts;
}

/** The numbers of the line under the header, for the hash `sel` chooses ({ mask, bindings }). */
export function summarise(record, graph, sel = DEFAULT_SEL) {
  const hashes = hashesOf(graph, sel.mask, sel.bindings);
  const counts = hashCounts(hashes);
  const perRow = new Array(record.height + 1).fill(0);
  for (const s of record.slots) perRow[s.row]++;
  let widest = { count: 0, row: 0 };
  perRow.forEach((count, row) => { if (count > widest.count) widest = { count, row }; });
  return {
    nodes: record.slots.length,
    rows: record.slots.length === 0 ? 0 : record.height + 1,
    distinct: counts.size,
    withoutHash: hashes.filter((h) => !h).length,
    repeated: [...counts.values()].filter((c) => c > 1).length,
    widest,
    columns: record.width / 2,
  };
}

// The title row of a pane (the <h2> of index.html: its label `#lname`, the function's name `#lt` and the row itself `#lhead`; `#r...` for the
// right pane). The row shows the name only (the page's CSS cuts a long one with an ellipsis); the full name and the developer's figures
// (`detail`: node count, timings) are the tooltip of the row. An empty name clears both.
export function setPaneName($, side, name, detail) {
  const k = side === 'left' ? 'l' : 'r';
  $(`#${k}t`).textContent = name || '';
  $(`#${k}head`).title = name ? (detail ? `${name} · ${detail}` : name) : '';
}
export const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

export function kindClass(kind) {
  if (kind.startsWith('yul.')) return 'yul';
  if (kind === 'hull.ty') return 'ty';
  if (kind === 'hull.fn' || kind === 'hull.local-fn') return 'fn';
  if (kind === 'collapsed') return 'collapsed';
  return 'code';
}

// The tree edge as SVG path data: a straight riser up the child's column (absent when the edge
// skips no row, and of length zero in the depth view), then one cubic with vertical tangents.
export function edgePath(points, boxH) {
  const half = boxH / 2;
  const first = points[0], last = points[points.length - 1];
  const a = { x: first.x, y: first.y - half }, b = { x: last.x, y: last.y + half };
  let d = `M${f1(a.x)} ${f1(a.y)}`;
  let from = a;
  if (points.length === 3) {
    const r = { x: points[1].x, y: points[1].y - half };
    if (Math.abs(r.y - a.y) > 0.05 || Math.abs(r.x - a.x) > 0.05) d += `L${f1(r.x)} ${f1(r.y)}`;
    from = r;
  }
  const mid = (from.y + b.y) / 2;
  return `${d}C${f1(from.x)} ${f1(mid)} ${f1(b.x)} ${f1(mid)} ${f1(b.x)} ${f1(b.y)}`;
}

// A reference arc as SVG path data: leaves the top of the use box, arches over the layout and
// lands on the top of the definition box. Arcs are an overlay and never move a node.
export function arcPath(a, b) {
  const lift = Math.min(160, 24 + 0.25 * Math.abs(b.x - a.x) + 0.1 * Math.abs(b.y - a.y));
  const ay = a.y - a.h / 2, by = b.y - b.h / 2;
  return { d: `M${f1(a.x)} ${f1(ay)}C${f1(a.x)} ${f1(ay - lift)} ${f1(b.x)} ${f1(by - lift)} ${f1(b.x)} ${f1(by)}`, top: Math.min(ay, by) - 0.75 * lift };
}

/** The SVG of one plate: a rounded rectangle for the front and depth views, a polygon when the camera is turned. */
export function plateSvg(p) {
  if (p.points) return `<polygon class="plate" points="${p.points.map((q) => `${f1(q[0])},${f1(q[1])}`).join(' ')}"/>`;
  return `<rect class="plate" x="${f1(p.x0)}" y="${f1(p.y0)}" width="${f1(p.x1 - p.x0)}" height="${f1(p.y1 - p.y0)}" rx="4"/>` ;
}

/** The label of a plate, at its left corner. */
export function plateLabelSvg(p) {
  return `<text class="plate-label" x="${f1(p.label.x)}" y="${f1(p.label.y)}">height ${p.row}</text>`;
}

/**
 * The drawing as one SVG element, and its box (`[x, y, w, h]`, padded, as `data-box`). `opts`:
 * `yaw`, `tilt`, `spread`, `colour` (outline colours for equal hashes), `arcs` (reference arcs),
 * `uniform` (labels are cut to the box), `hash` (`{ mask, bindings }`: which hash of a node counts, see
 * hashsel.js), `fit` (per node: the text length to squeeze a label to, 0 for none; measured by the page).
 */
export function buildSvg(record, graph, opts) {
  const cam = camera(opts.tilt, opts.spread, GEOM, opts.yaw || 0);
  const sc = scene(record, cam);
  const sel = opts.hash || DEFAULT_SEL;
  const hashes = hashesOf(graph, sel.mask, sel.bindings);
  const counts = hashCounts(hashes);
  const { x0, y0, x1, y1 } = sc.bounds;
  let top = y0;
  const parts = [];

  parts.push('<g class="plates">');
  for (const p of sc.plates) {
    parts.push(plateSvg(p));
    // the label sits on the left, level with the plate's front edge (at its left corner when turned)
    parts.push(plateLabelSvg(p));
  }
  parts.push('</g><g class="edges">');
  for (const e of sc.edges) parts.push(`<path class="e t" d="${edgePath(e.points, GEOM.boxHeight)}"/>`);
  parts.push('</g><g class="nodes">');

  // A slight fade with depth helps read the tilted view; it fades in with the tilt, so the flat
  // view is drawn at full strength.
  let dmin = Infinity, dmax = -Infinity;
  for (const b of sc.boxes) { dmin = Math.min(dmin, b.depth); dmax = Math.max(dmax, b.depth); }
  const fadeStrength = Math.min(1, opts.tilt / 20) * 0.3;
  for (const v of sc.order) {
    const b = sc.boxes[v], node = graph.nodes[v];
    const hash = hashes[v];
    const times = hash ? counts.get(hash) : 0;
    const equal = times >= 2;
    const fade = fadeStrength > 0 && dmax > dmin ? 1 - (fadeStrength * (b.depth - dmin)) / (dmax - dmin) : 1;
    let label = node.label;
    if (opts.uniform) {
      const room = Math.max(1, Math.floor((b.w - 8) / CHAR_PX));
      const chars = Array.from(label);
      if (chars.length > room) label = chars.slice(0, Math.max(1, room - 1)).join('') + '…';
    }
    const squeeze = opts.fit && opts.fit[v] ? ` textLength="${f1(opts.fit[v])}" lengthAdjust="spacingAndGlyphs"` : '';
    const title = [node.kind, node.label, hashText(graph, v, sel.mask), `height ${b.row}`, hash ? `this hash occurs ${times} time${times === 1 ? '' : 's'}` : ''].filter(Boolean).join('\n');
    parts.push(
      `<g class="n plain ${kindClass(node.kind)}${equal ? ' eq' : ''}" data-v="${v}"${hash ? ` data-hash="${escapeText(hash)}"` : ''}` +
      `${equal ? ` style="--hc:var(--hash${hashColourIndex(hash)})"` : ''}${fade < 0.995 ? ` opacity="${fade.toFixed(2)}"` : ''}>` +
      `<title>${escapeText(title)}</title>` +
      `<rect class="box" x="${f1(b.x - b.w / 2)}" y="${f1(b.y - b.h / 2)}" width="${f1(b.w)}" height="${f1(b.h)}" rx="3"/>` +
      `<rect class="halo" x="${f1(b.x - b.w / 2 - 3)}" y="${f1(b.y - b.h / 2 - 3)}" width="${f1(b.w + 6)}" height="${f1(b.h + 6)}" rx="5"/>` +
      `<text x="${f1(b.x)}" y="${f1(b.y + 4)}"${squeeze}>${escapeText(label)}</text></g>`,
    );
  }
  parts.push('</g>');

  if (opts.arcs) {
    parts.push('<g class="arcs">');
    for (const [use, def] of graph.refs) {
      const a = sc.boxes[use], b = sc.boxes[def];
      if (!a || !b || use === def) continue;
      const arc = arcPath(a, b);
      top = Math.min(top, arc.top);
      parts.push(`<path class="e hr" d="${arc.d}"/>`);
    }
    parts.push('</g>');
  }

  const pad = 16, left = x0 - LABEL_ROOM - PLATE_PAD;
  const box = [left - pad, top - pad, x1 - left + 2 * pad, y1 - top + 2 * pad];
  const b = box.map(f1).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="hg${opts.colour ? ' hc' : ''}" data-box="${b}" viewBox="${b}">${parts.join('')}</svg>`;
  return { svg, box };
}

// ---------------------------------------------------------------------------------------------
// The page part. `env`: `$` (querySelector), `panes` (the page's pan and zoom objects), `slot_layout`
// and `slot_union_layout` (the wasm exports), `pair` (the module hashgraph-pair.js, for the comparison),
// `reshow` (draws the selected function again), `hashSel` (the hash the page's facets choose, `{ mask, bindings }`),
// `sides` (a function: how the texts of a comparison call the two versions, `[left, right]`; "left" and "right" without it).

export function initHashView(env) {
  const { $, panes, slot_layout, reshow } = env;
  const refreshUrl = env.refreshUrl || (() => {});
  const sel = () => (env.hashSel ? env.hashSel() : DEFAULT_SEL);
  const pane = panes.left;
  const st = { active: false, pair: false, graph: null, record: null, fit: null, layoutMs: 0, drawMs: 0, o: { ...DEFAULTS }, sel: DEFAULT_SEL, hashes: [], counts: new Map(),
    // the pinned node: { side, i } (side 'L' or 'R' in a comparison, null for one function); `pinReq` is a pin
    // asked for by the address, taken when the next function is drawn (undefined: nothing asked)
    pin: null, pinReq: undefined, down: null };

  const bar = document.createElement('div');
  bar.id = 'hg-bar';
  bar.className = 'hg-only';
  bar.innerHTML =
    '<label title="Turn the stack about the vertical axis. 0 is the front view; 45 with the isometric tilt is the isometric view.">yaw ' +
    `<input type="range" id="hg-yaw" min="${LIMITS.yaw[0]}" max="${LIMITS.yaw[1]}" step="1"> <output id="hg-yaw-v"></output></label>` +
    '<label title="Camera elevation. 0 is the front view: rows by hash height (a pyramid). At 45 degrees with spread 1 and yaw 0, rows are source depths (a tree).">tilt ' +
    `<input type="range" id="hg-tilt" min="${LIMITS.tilt[0]}" max="${LIMITS.tilt[1]}" step="1"> <output id="hg-tilt-v"></output></label>` +
    '<label title="Depth pitch as a fraction of the row pitch. 0 shows the plates edge-on; larger values spread them in depth.">spread ' +
    `<input type="range" id="hg-spread" min="${LIMITS.spread[0]}" max="${LIMITS.spread[1]}" step="0.05"> <output id="hg-spread-v"></output></label>` +
    '<button id="hg-front" title="Yaw 0, tilt 0: rows by hash height">front view</button>' +
    '<button id="hg-depth" title="Yaw 0, tilt 45 and spread 1: rows by source depth">depth view</button>' +
    '<button id="hg-iso" title="Yaw 45, tilt 35.26 and spread 1: the three axes are foreshortened equally">isometric</button>' +
    '<span id="hg-hint"></span>' +
    '<label><input type="checkbox" id="hg-colour"> colour equal hashes</label>' +
    '<label class="hg-pair-only" title="Fade every node whose hash is equal on both sides and that has no changed node below it, so that only the paths from the changes up to the root stay clear"><input type="checkbox" id="hg-paths"> show only changed hashes\' paths</label>' +
    '<label><input type="checkbox" id="hg-arcs"> reference arcs</label>' +
    '<label title="Every box has the same width; long labels are cut and shown in full on hover"><input type="checkbox" id="hg-uniform"> uniform box widths</label>';
  const info = document.createElement('div');
  info.id = 'hg-info';
  info.className = 'hg-only';
  info.innerHTML = '<span id="hg-numbers"></span><span id="hg-hover"></span>';
  const legend = document.createElement('div');
  legend.id = 'hg-legend';
  legend.className = 'hg-only';
  legend.innerHTML =
    '<span class="hg-single-only">Each plate is one hash height (0 = a leaf; a node is one higher than its tallest child). ' +
    'Nodes whose subtree hash occurs more than once in this function have a coloured outline: ' +
    Array.from({ length: PALETTE_SIZE }, (_, i) => `<i class="sw" style="border-color:var(--hash${i})"></i>`).join('') +
    ' the colour comes from the hash, so the same hash has the same colour in every function; two different hashes can share a colour, so hover a node to outline all nodes with its hash. ' +
    'A plain outline means the hash occurs once. Red arcs (when on) are variable uses.</span>' +
    '<span class="hg-pair-only">Comparison: both versions are drawn from one union tree, so a node that both sides share has one place in both panes. ' +
    'Each plate is one height of the union (a node is one higher than its tallest child in the union). <i class="gh"></i>A dotted box marks where the other version has a node and this one has none. ' +
    'Node colours are the status colours in the next line. Hover a node to outline its partner in the other pane. With "colour equal hashes" a node whose hash occurs more than once in its own version has a stripe along its lower edge, ' +
    'in a colour taken from the hash. Red arcs (when on) are variable uses.</span>';
  // The bar stands in the controls (<aside id="side">, after #groups), the numbers and the legend in the graphs column, above #summary.
  $('#groups').after(bar);
  $('#summary').before(info, legend);

  // The panel "What this hash is made of" (preview.js), after the graphs: a hint until a node is pinned, then the
  // record of the pinned node. Plain elements; hashgraph.css only decides where it is shown and how far it grows.
  const hint = document.createElement('p');
  hint.id = 'hg-record-hint';
  hint.className = 'hg-only';
  hint.textContent = HINT;
  const record = document.createElement('details');
  record.id = 'hg-record';
  record.className = 'hg-only';
  record.open = true;
  record.hidden = true;
  record.innerHTML = '<summary>What this hash is made of</summary><div id="hg-record-body"></div>';
  $('#main').after(hint, record);

  const colourOn = () => (st.pair ? st.o.pairColour : st.o.colour);

  // The comparison (hashgraph-pair.js): created only when the page passes the module.
  const pairCtl = env.pair && env.slot_union_layout
    ? env.pair.createPairController({ $, panes, slot_union_layout: env.slot_union_layout, options: () => ({ ...st.o, colour: colourOn(), hash: sel() }), refreshUrl, sides: env.sides })
    : null;

  const tiltText = (t) => (Number.isInteger(t) ? `${t}` : t.toFixed(1));

  const controls = () => {
    $('#hg-yaw').value = st.o.yaw; $('#hg-tilt').value = st.o.tilt; $('#hg-spread').value = st.o.spread;
    $('#hg-colour').checked = colourOn(); $('#hg-paths').checked = st.o.paths;
    $('#hg-arcs').checked = st.o.arcs; $('#hg-uniform').checked = st.o.uniform;
    $('#hg-yaw-v').textContent = `${st.o.yaw}°`;
    $('#hg-tilt-v').textContent = `${tiltText(st.o.tilt)}°`;
    $('#hg-spread-v').textContent = st.o.spread.toFixed(2);
    const d = depthTilt(st.o.spread);
    const isIso = Math.abs(st.o.yaw - ISO.yaw) < 1e-9 && Math.abs(st.o.tilt - ISO.tilt) < 1e-9 && st.o.spread === ISO.spread;
    $('#hg-hint').textContent = st.o.yaw !== 0
      ? (isIso ? 'isometric: yaw 45°, tilt 35.3°, spread 1' : `yaw ${st.o.yaw}°: rows are source depths only at yaw 0`)
      : (d <= LIMITS.tilt[1] ? `rows are source depths at tilt ${d.toFixed(0)}°` : 'rows are source depths at a tilt beyond 60°');
  };
  controls();

  const clamp = (x, [lo, hi], fallback) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);

  function setActive(on) {
    st.active = on;
    document.body.classList.toggle('hashmode', on);
    if (!on) { document.body.classList.remove('hashpair'); st.pair = false; st.pin = null; if (pairCtl) pairCtl.deactivate(); updatePanel(); }
    $('#view').value = on ? 'hash' : 'layered';
    if (on) {
      panes.right.svg = null;
      $('#right').innerHTML = '';
      setPaneName($, 'right', '');
    }
  }

  // ---- the pinned node ----------------------------------------------------------------------------------------
  // The graph and the partner of the pinned node, as [pane, node] pairs: the node in its own pane, and in a
  // comparison its partner in the other (the hover marks the partner too).
  const pinnedNodes = () => {
    const pin = st.active ? st.pin : null;
    if (!pin) return [];
    if (!st.pair) return [['left', pin.i]];
    const s = pairCtl && pairCtl.state;
    if (!s || !s.info) return [];
    const mine = pin.side === 'L' ? 'left' : 'right', theirs = pin.side === 'L' ? 'right' : 'left';
    const partner = (pin.side === 'L' ? s.info.pl : s.info.pr)[pin.i];
    return partner >= 0 ? [[mine, pin.i], [theirs, partner]] : [[mine, pin.i]];
  };
  const markPins = () => {
    for (const [key, v] of pinnedNodes()) $(key === 'left' ? '#left' : '#right').querySelectorAll(`.n[data-v="${v}"]`).forEach((n) => n.classList.add('hh'));
  };
  if (pairCtl && pairCtl.setPinned) pairCtl.setPinned(pinnedNodes);

  const pinText = () => (st.active && st.pin ? (st.pair ? st.pin.side : '') + st.pin.i : null);

  // Fill the panel for the pinned node, or show the hint (and nothing else) when none is pinned.
  function updatePanel() {
    let html = null;
    const pin = st.active ? st.pin : null;
    const choice = sel();   // the facets and the switch as they are now
    if (pin) {
      const s = pairCtl && pairCtl.state;
      const graphs = st.pair ? (s && s.left && s.right ? [s.left, s.right] : null) : (st.graph ? [st.graph, null] : null);
      const mine = graphs && (pin.side === 'R' ? graphs[1] : graphs[0]);
      if (!mine || pin.i >= mine.nodes.length) {
        st.pin = null;
      } else if (!st.pair) {
        html = singlePanel(mine, pin.i, choice.mask, choice.bindings);
      } else {
        const partner = (pin.side === 'L' ? s.info.pl : s.info.pr)[pin.i];
        html = pin.side === 'L'
          ? pairPanel(graphs[0], graphs[1], pin.i, partner, choice.mask, choice.bindings)
          : pairPanel(graphs[0], graphs[1], partner, pin.i, choice.mask, choice.bindings);
      }
    }
    $('#hg-record-body').innerHTML = html === null ? '' : html;
    $('#hg-record').hidden = html === null;
    $('#hg-record-hint').hidden = html !== null;
  }

  // The pin the address asked for becomes the pin when the function is drawn (only a node that exists is pinned).
  function takePinRequest() {
    const req = st.pinReq;
    st.pinReq = undefined;
    if (req === undefined) return;
    const m = req === null ? null : /^([LR]?)(\d+)$/.exec(req);
    st.pin = m ? { side: st.pair ? (m[1] || 'L') : null, i: Number(m[2]) } : null;
  }

  function layout() {
    const t0 = performance.now();
    st.record = JSON.parse(slot_layout(JSON.stringify(st.graph), st.o.uniform));
    st.layoutMs = performance.now() - t0;
    st.fit = null;
  }

  // Squeeze a label that is wider than its box. Measured once per layout, because a label's width
  // does not depend on the camera.
  function measureFit() {
    const nodes = [...$('#left').querySelectorAll('.n')];
    const fit = new Array(st.record.slots.length).fill(0);
    const reads = nodes.map((g) => [g, g.querySelector('text').getComputedTextLength(), Number(g.querySelector('rect').getAttribute('width')) - 8]);
    for (const [g, length, room] of reads) if (length > room) fit[Number(g.dataset.v)] = room;
    for (const [g] of reads) {
      const room = fit[Number(g.dataset.v)];
      if (room) { const t = g.querySelector('text'); t.setAttribute('textLength', room); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    }
    st.fit = fit;
  }

  function render(keepView) {
    if (st.pair) { if (pairCtl) pairCtl.render(keepView); return; }
    if (!st.record) return;
    const t0 = performance.now();
    st.sel = sel();
    st.hashes = hashesOf(st.graph, st.sel.mask, st.sel.bindings);
    st.counts = hashCounts(st.hashes);
    const { svg, box } = buildSvg(st.record, st.graph, { ...st.o, colour: colourOn(), hash: st.sel, fit: st.fit });
    const view = $('#left');
    view.innerHTML = svg;
    const el = view.firstElementChild;
    if (keepView && pane.svg && pane.vb) {
      pane.svg = el;
      pane.box = box;
      el.setAttribute('viewBox', pane.vb.join(' '));
    } else {
      pane.set(el);
    }
    if (st.fit === null) measureFit();
    st.drawMs = performance.now() - t0;
    markPins();
    const s = summarise(st.record, st.graph, st.sel);
    $('#hg-numbers').textContent =
      `${hashName(st.sel)}: ${s.nodes} nodes · ${s.rows} rows · ${s.distinct} distinct hashes (${s.repeated} occur more than once` +
      `${s.withoutHash ? `; ${s.withoutHash} nodes have no hash` : ''}) · widest row ${s.widest.count} nodes (height ${s.widest.row}) · ` +
      `${s.columns} columns wide · layout ${st.layoutMs.toFixed(1)} ms, drawing ${st.drawMs.toFixed(1)} ms`;
  }

  function leavePair() {
    if (!st.pair) return;
    st.pair = false;
    st.pin = null;
    document.body.classList.remove('hashpair');
    if (pairCtl) pairCtl.deactivate();
    panes.right.svg = null;
    $('#right').innerHTML = '';
    setPaneName($, 'right', '');
    controls();
  }

  function show(graph, sideName) {
    const view = $('#left');
    leavePair();
    st.graph = graph;
    $('#hg-hover').textContent = '';
    if (!graph) {
      st.record = null;
      st.pin = null;
      st.pinReq = undefined;
      pane.svg = null;
      view.innerHTML = '<div class="empty">No function to show.</div>';
      $('#hg-numbers').textContent = '';
      setPaneName($, 'left', '');
      updatePanel();
      return;
    }
    takePinRequest();
    if (sideName) $('#lname').textContent = sideName;
    setPaneName($, 'left', graph.name, `${graph.nodes.length} nodes · hash graph`);
    try {
      layout();
    } catch (error) {
      st.record = null;
      pane.svg = null;
      view.innerHTML = `<div class="empty error">The hash graph cannot be drawn: ${escapeText(error && error.message ? error.message : error)}</div>`;
      $('#hg-numbers').textContent = '';
      st.pin = null;
      updatePanel();
      return;
    }
    render(false);
    updatePanel();
  }

  /** Draw the comparison of two versions of a function (both graphs carry the pairing numbers `m`). */
  function showPair(left, right, leftName, rightName) {
    if (!pairCtl) { show(left, leftName); return; }
    st.pair = true;
    st.graph = null;
    st.record = null;
    document.body.classList.add('hashpair');
    controls();
    $('#hg-hover').textContent = '';
    if (leftName) $('#lname').textContent = leftName;
    if (rightName) $('#rname').textContent = rightName;
    takePinRequest();
    pairCtl.show(left, right);
    markPins();
    updatePanel();
  }

  const onSlider = (which) => () => {
    if (which === 'tilt') st.o.tilt = clamp(Number($('#hg-tilt').value), LIMITS.tilt, DEFAULTS.tilt);
    if (which === 'spread') st.o.spread = clamp(Number($('#hg-spread').value), LIMITS.spread, DEFAULTS.spread);
    if (which === 'yaw') st.o.yaw = clamp(Number($('#hg-yaw').value), LIMITS.yaw, DEFAULTS.yaw);
    controls();
    render(true);
    refreshUrl();
  };
  $('#hg-tilt').addEventListener('input', onSlider('tilt'));
  $('#hg-spread').addEventListener('input', onSlider('spread'));
  $('#hg-yaw').addEventListener('input', onSlider('yaw'));
  const preset = (yaw, tilt, spread) => () => {
    st.o.yaw = yaw; st.o.tilt = tilt;
    if (spread !== undefined) st.o.spread = spread;
    controls(); render(false); refreshUrl();
  };
  $('#hg-front').addEventListener('click', preset(0, 0));
  $('#hg-depth').addEventListener('click', preset(0, 45, 1));
  $('#hg-iso').addEventListener('click', preset(ISO.yaw, ISO.tilt, ISO.spread));
  $('#hg-colour').addEventListener('change', () => { st.o[st.pair ? 'pairColour' : 'colour'] = $('#hg-colour').checked; render(true); refreshUrl(); });
  $('#hg-paths').addEventListener('change', () => { st.o.paths = $('#hg-paths').checked; render(true); refreshUrl(); });
  $('#hg-arcs').addEventListener('change', () => { st.o.arcs = $('#hg-arcs').checked; render(true); refreshUrl(); });
  $('#hg-uniform').addEventListener('change', () => {
    st.o.uniform = $('#hg-uniform').checked;
    refreshUrl();
    if (st.pair) { if (pairCtl) pairCtl.relayout(); return; }
    if (!st.graph) return;
    layout();
    render(false);
  });
  $('#view').addEventListener('change', () => {
    setActive($('#view').value === 'hash');
    refreshUrl();
    reshow();
  });

  // Hovering a node outlines every node with the same hash and describes the node.
  const left = $('#left');
  left.addEventListener('mouseover', (e) => {
    if (st.pair) return;
    left.querySelectorAll('.n.hh').forEach((n) => n.classList.remove('hh'));
    markPins();
    const g = e.target.closest ? e.target.closest('.n[data-v]') : null;
    if (!g || !st.graph) { $('#hg-hover').textContent = ''; return; }
    const v = Number(g.dataset.v), node = st.graph.nodes[v], slot = st.record.slots[v];
    const hash = st.hashes[v];
    if (hash) left.querySelectorAll(`.n[data-hash="${hash}"]`).forEach((n) => n.classList.add('hh'));
    const times = hash ? st.counts.get(hash) : 0;
    $('#hg-hover').textContent = `${node.kind} · ${node.label} · ${hashText(st.graph, v, st.sel.mask)} · height ${slot.row}${hash ? ` · occurs ${times} time${times === 1 ? '' : 's'}` : ''}`;
  });
  left.addEventListener('mouseleave', () => {
    if (st.pair) return;
    left.querySelectorAll('.n.hh').forEach((n) => n.classList.remove('hh'));
    markPins();
    $('#hg-hover').textContent = '';
  });

  // Clicking a node pins it, clicking it again or clicking empty space unpins it. A click that ends a drag (the
  // pan) is not a click, and the node is found by the point, because the pane captures the pointer.
  for (const [side, el] of [['L', $('#left')], ['R', $('#right')]]) {
    el.addEventListener('pointerdown', (e) => { st.down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('click', (e) => {
      if (!st.active) return;
      if (st.down && Math.hypot(e.clientX - st.down.x, e.clientY - st.down.y) > 4) return;
      const at = typeof document.elementFromPoint === 'function' && Number.isFinite(e.clientX) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      const target = at || e.target;
      const g = target && target.closest ? target.closest('.n[data-v]') : null;
      const next = g ? { side: st.pair ? side : null, i: Number(g.dataset.v) } : null;
      const same = st.pin && next && st.pin.i === next.i && st.pin.side === next.side;
      st.pin = same ? null : next;
      for (const pane of [$('#left'), $('#right')]) pane.querySelectorAll('.n.hh').forEach((n) => n.classList.remove('hh'));
      markPins();
      updatePanel();
      refreshUrl();
    });
  }

  return {
    get active() { return st.active; },
    get paired() { return st.pair; },
    /** The pinned node as the address writes it (`12`, in a comparison `L12` or `R7`), or null. */
    pinText,
    /** Ask for a pin (the text of `pinText`, or null for none) to be made when the next function is drawn; undefined withdraws the request. */
    requestPin(text) { st.pinReq = text === undefined ? undefined : text; },
    /** Forget the pinned node (another function is shown). */
    unpin() { st.pin = null; },
    show,
    showPair,
    /** Add this view's settings to the address, so a link reopens the same drawing. */
    addParams(p) {
      if (!st.active) return;
      p.set('view', 'hash');
      if (st.o.yaw !== DEFAULTS.yaw) p.set('yaw', String(st.o.yaw));
      if (st.o.tilt !== DEFAULTS.tilt) p.set('tilt', String(st.o.tilt));
      if (st.o.spread !== DEFAULTS.spread) p.set('spread', String(st.o.spread));
      if (st.o.arcs) p.set('arcs', '1');
      if (st.o.uniform) p.set('uniform', '1');
      if (st.o.paths) p.set('paths', '1');
      // the default of the colour switch depends on the view: on for one function, off in a comparison
      if (colourOn() !== (st.pair ? DEFAULTS.pairColour : DEFAULTS.colour)) p.set('colour', colourOn() ? '1' : '0');
    },
    /**
     * Read the settings from the address
     * (`view=hash&yaw=45&tilt=35.264&spread=1&arcs=1&uniform=1&colour=0&paths=1`).
     */
    readParams(p) {
      st.o = {
        yaw: clamp(p.has('yaw') ? Number(p.get('yaw')) : NaN, LIMITS.yaw, DEFAULTS.yaw),
        tilt: clamp(p.has('tilt') ? Number(p.get('tilt')) : NaN, LIMITS.tilt, DEFAULTS.tilt),
        spread: clamp(p.has('spread') ? Number(p.get('spread')) : NaN, LIMITS.spread, DEFAULTS.spread),
        arcs: p.get('arcs') === '1',
        uniform: p.get('uniform') === '1',
        paths: p.get('paths') === '1',
        colour: p.has('colour') ? p.get('colour') !== '0' : DEFAULTS.colour,
        pairColour: p.has('colour') ? p.get('colour') === '1' : DEFAULTS.pairColour,
      };
      controls();
      setActive(p.get('view') === 'hash');
    },
  };
}
