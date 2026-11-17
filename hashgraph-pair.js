// The comparison form of the hash graph view: two versions of one function drawn from the union
// record of `slot_union_layout` (section 1.9 of FABLE-B5-LAYOUT.md, version 1).
//
// The union tree is laid out once, so a node that both versions share has one row, column, depth
// offset and width in both panes; nodes that only the other version has appear as dotted ghost boxes.
// Both panes are drawn with the same camera (yaw, tilt, spread), the same plates and the same
// bounds, so that the page can give them one pan and zoom.
//
// The first half is pure (no DOM), so Node can test it. `createPairController` at the end connects
// it to the page; hashgraph.js creates it when the page passes this module.
//
// "The hash of a node" is the one the page's facets choose (hashsel.js): `sel` is `{ mask, bindings }`,
// the facet mask and whether the binding-aware hash is used; without it, the hash of the default facets.

import {
  GEOM, camera, scene, hashCounts, hashColourIndex, arcPath, edgePath, escapeText, f1, kindClass, plateSvg, plateLabelSvg, setPaneName,
} from './hashgraph.js?v=9159ac74de';
import { DEFAULT_SEL, hashesOf, hashName, hashText } from './hashsel.js?v=aa62f03930';

const CHAR_PX = 6.6;
const PLATE_PAD = 8;
const LABEL_ROOM = 66;
const STRIPE = 4;

/**
 * The partner of every node by the matcher's pairing number `m`: the first node with a given `m` on
 * each side owns it, and the two nodes are partners if both sides have one (the rule of
 * `slot_union`). Returns [for each left node the right node or -1, for each right node the left node or -1].
 */
export function partnersByM(left, right) {
  const first = (g) => {
    const out = new Map();
    g.nodes.forEach((n, i) => { if (n.m !== undefined && n.m !== null && !out.has(n.m)) out.set(n.m, i); });
    return out;
  };
  const lm = first(left), rm = first(right);
  const pl = new Array(left.nodes.length).fill(-1), pr = new Array(right.nodes.length).fill(-1);
  for (const [m, l] of lm) {
    const r = rm.get(m);
    if (r !== undefined) { pl[l] = r; pr[r] = l; }
  }
  return [pl, pr];
}

/**
 * What the comparison says about each node and the numbers for the line under the header.
 *
 * A node is *changed* if it has no partner, or its partner has another hash (or one of them has none), or
 * its status is not `same` (own, below, only, moved), or the union shows it twice (matched, but not
 * merged). A node is *faded* by "show only changed hashes' paths" if it is not changed and no node below
 * it (in its own version) is changed. A hash that differs on the two sides is a *path* node if some node
 * below it is changed: the change reaches the root through it.
 *
 * The numbers keep the hash classes apart: a matched pair is counted as hash equal, as hash differs, or,
 * when either node has no hash (with the bindings switch: no binding-aware hash), in neither; those nodes
 * are counted in `withoutHash`. `rebound`, `moved` and `duplicated` are not classes of their own: they count
 * pairs that are also in one of the hash classes.
 */
export function analyse(left, right, rec, sel = DEFAULT_SEL) {
  const [pl, pr] = partnersByM(left, right);
  const hashes = [hashesOf(left, sel.mask, sel.bindings), hashesOf(right, sel.mask, sel.bindings)];
  const side = (g, mine, theirs, partner, merged) => {
    const n = g.nodes.length;
    const kids = Array.from({ length: n }, () => []);
    const hasParent = new Array(n).fill(false);
    for (const [p, c] of g.tree) { kids[p].push(c); hasParent[c] = true; }
    const equal = g.nodes.map((node, v) => {
      const o = partner[v];
      return o >= 0 && !!mine[v] && mine[v] === theirs[o];
    });
    const changed = g.nodes.map((node, v) => !(equal[v] && node.status === 'same' && merged[v] >= 0));
    // preorder from the roots, then children before parents
    const pre = [];
    const stack = [];
    for (let v = n - 1; v >= 0; v--) if (!hasParent[v]) stack.push(v);
    while (stack.length) {
      const v = stack.pop();
      pre.push(v);
      for (let i = kids[v].length - 1; i >= 0; i--) stack.push(kids[v][i]);
    }
    const below = new Array(n).fill(false);
    for (let i = pre.length - 1; i >= 0; i--) {
      const v = pre[i];
      below[v] = kids[v].some((c) => changed[c] || below[c]);
    }
    const fade = changed.map((c, v) => !c && !below[v]);
    return { equal, changed, below, fade };
  };
  const L = side(left, hashes[0], hashes[1], pl, rec.left.pair), R = side(right, hashes[1], hashes[0], pr, rec.right.pair);
  let matched = 0, equalHash = 0, differs = 0, ancestors = 0;
  pl.forEach((r, l) => {
    if (r < 0) return;
    matched++;
    if (L.equal[l]) equalHash++;
    else if (hashes[0][l] && hashes[1][r]) {
      differs++;
      if (L.below[l] || R.below[r]) ancestors++;
    }
  });
  const merged = rec.left.pair.filter((p) => p >= 0).length;
  // With the "bindings" switch on (bindings.js) the nodes carry `rebound`, true or false; with it off, nothing.
  const bindings = left.nodes.some((n) => n.rebound !== undefined);
  const numbers = {
    matched,
    equal: equalHash,
    differs,
    ancestors,
    onlyLeft: pl.filter((p) => p < 0).length,
    onlyRight: pr.filter((p) => p < 0).length,
    moved: left.nodes.filter((n) => n.status === 'moved').length,
    merged,
    duplicated: matched - merged,
    withoutHash: hashes[0].filter((h) => !h).length + hashes[1].filter((h) => !h).length,
    columns: rec.left.width / 2,
    rows: rec.left.slots.length + rec.left.ghosts.length === 0 ? 0 : rec.left.height + 1,
    ...(bindings ? { rebound: left.nodes.filter((n) => n.rebound).length } : {}),
  };
  return { pl, pr, left: L, right: R, numbers, sel, hashes };
}

/** What the two versions are called in the texts of a comparison, unless the page says otherwise (`sides`). */
const SIDES = ['left', 'right'];

/**
 * The line under the header for a comparison; it starts by naming the hash it counts (`sel`, hashsel.js).
 * `sides` are the names of the two versions, as the page calls them (the labels of the program).
 */
export function numbersText(n, layoutMs, drawMs, sel = DEFAULT_SEL, sides = SIDES) {
  return `${hashName(sel)}: ${n.matched} matched nodes · hash equal on both sides ${n.equal} · hash differs ${n.differs} (${n.ancestors} of them above a changed node) · ` +
    `only in the ${sides[0]} graph ${n.onlyLeft} · only in the ${sides[1]} graph ${n.onlyRight} · moved ${n.moved} · shown twice by the union ${n.duplicated}` +
    `${n.rebound === undefined ? '' : ` · bindings differ ${n.rebound} (among the matched nodes)`}` +
    `${n.withoutHash ? ` · ${n.withoutHash} nodes have no hash` : ''} · union ${n.columns} columns wide, ${n.rows} rows · layout ${layoutMs.toFixed(1)} ms, drawing ${drawMs.toFixed(1)} ms`;
}

const STATUS_WORDS = { same: 'same', own: 'own facts or links differ', below: 'something below differs', only: 'only on this side', moved: 'moved', plain: 'not compared' };

/**
 * The text under the numbers when a node is hovered: both of its hashes for the current facets (with and
 * without the binding), its row, and whether the hash the page uses is equal on the two sides. `sides` are the
 * names of the two versions.
 */
export function describeNode(isLeft, v, left, right, rec, info, sides = SIDES) {
  const g = isLeft ? left : right, o = g.nodes[v];
  const partner = (isLeft ? info.pl : info.pr)[v];
  const mine = isLeft ? rec.left : rec.right;
  const row = mine.slots[v].row;
  const head = `${o.kind} · ${o.label}`;
  const mask = info.sel.mask;
  if (partner < 0) return `${head} · only in the ${sides[isLeft ? 0 : 1]} graph · ${hashText(g, v, mask)} · row ${row}`;
  const [lv, rv] = isLeft ? [v, partner] : [partner, v];
  const eq = !!info.hashes[0][lv] && info.hashes[0][lv] === info.hashes[1][rv];
  const hashes = `${sides[0]} ${hashText(left, lv, mask)} · ${sides[1]} ${hashText(right, rv, mask)} · ${eq ? 'hashes equal' : 'hashes differ'}`;
  const merged = mine.pair[v] === partner;
  const where = merged ? `row ${row}` : `row ${row}; shown twice, the partner is at row ${(isLeft ? rec.right : rec.left).slots[partner].row} of the other pane`;
  return `${head} · ${hashes} · ${where} · ${STATUS_WORDS[o.status] || o.status}${o.rebound ? ' · refers to a different definition than its partner' : ''}`;
}

/**
 * Both drawings. `opts`: `yaw`, `tilt`, `spread`, `colour` (a stripe on nodes whose hash occurs more than
 * once in their own version), `arcs`, `uniform`, `paths` (fade the nodes `analyse` calls faded),
 * `fit` (per side, per node: the text length to squeeze a label to). Returns the two SVG strings, their
 * common box, and the scenes they were drawn from.
 */
export function buildPairSvgs(rec, left, right, opts, info) {
  const cam = camera(opts.tilt, opts.spread, GEOM, opts.yaw || 0);
  const scenes = [scene(rec.left, cam), scene(rec.right, cam)];
  // Plates and bounds are those of the union, the same for both panes.
  const bounds = {
    x0: Math.min(scenes[0].bounds.x0, scenes[1].bounds.x0), y0: Math.min(scenes[0].bounds.y0, scenes[1].bounds.y0),
    x1: Math.max(scenes[0].bounds.x1, scenes[1].bounds.x1), y1: Math.max(scenes[0].bounds.y1, scenes[1].bounds.y1),
  };
  let dmin = Infinity, dmax = -Infinity;
  for (const sc of scenes) for (const b of sc.boxes.concat(sc.ghostBoxes)) { dmin = Math.min(dmin, b.depth); dmax = Math.max(dmax, b.depth); }
  const fadeStrength = Math.min(1, opts.tilt / 20) * 0.3;
  const sides = [
    { graph: left, side: rec.left, sc: scenes[0], an: info.left, partner: info.pl, key: 'left' },
    { graph: right, side: rec.right, sc: scenes[1], an: info.right, partner: info.pr, key: 'right' },
  ];
  // Arcs may rise above the drawing; both panes get the higher of the two tops.
  let top = bounds.y0;
  const arcs = sides.map(({ graph, sc }) => {
    if (!opts.arcs) return [];
    const out = [];
    for (const [use, def] of graph.refs) {
      const a = sc.boxes[use], b = sc.boxes[def];
      if (!a || !b || use === def) continue;
      const arc = arcPath(a, b);
      top = Math.min(top, arc.top);
      out.push(arc.d);
    }
    return out;
  });
  const pad = 16, leftEdge = bounds.x0 - LABEL_ROOM - PLATE_PAD;
  const box = [leftEdge - pad, top - pad, bounds.x1 - leftEdge + 2 * pad, bounds.y1 - top + 2 * pad];
  const boxText = box.map(f1).join(' ');

  const svgs = sides.map(({ graph, side, sc, an, partner, key }, index) => {
    const hashes = info.hashes[index];
    const counts = hashCounts(hashes);
    const parts = ['<g class="plates">'];
    for (const p of sc.plates) { parts.push(plateSvg(p)); parts.push(plateLabelSvg(p)); }
    parts.push('</g><g class="edges">');
    const faded = (v) => opts.paths && an.fade[v];
    sc.edges.forEach((e) => parts.push(`<path class="e t${faded(e.child) ? ' fd' : ''}" d="${edgePath(e.points, GEOM.boxHeight)}"/>`));
    sc.ghostEdges.forEach((e) => parts.push(`<path class="e t g" d="${edgePath(e.points, GEOM.boxHeight)}"/>`));
    parts.push('</g><g class="nodes">');
    // Far to near; at equal depth ghosts before nodes, then by number.
    const items = sc.order.map((v) => ({ ghost: false, i: v, depth: sc.boxes[v].depth }))
      .concat(sc.ghostBoxes.map((b, i) => ({ ghost: true, i, depth: b.depth })));
    items.sort((a, b) => b.depth - a.depth || (a.ghost === b.ghost ? a.i - b.i : a.ghost ? -1 : 1));
    for (const it of items) {
      if (it.ghost) {
        const b = sc.ghostBoxes[it.i];
        parts.push(`<rect class="ghost" data-of="${b.of}" x="${f1(b.x - b.w / 2)}" y="${f1(b.y - b.h / 2)}" width="${f1(b.w)}" height="${f1(b.h)}" rx="3"/>`);
        continue;
      }
      const v = it.i, b = sc.boxes[v], node = graph.nodes[v];
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
      const fit = opts.fit && opts.fit[key] && opts.fit[key][v];
      const squeeze = fit ? ` textLength="${f1(fit)}" lengthAdjust="spacingAndGlyphs"` : '';
      const o = partner[v];
      const theirs = o >= 0 ? info.hashes[1 - index][o] : null;
      const title = [
        node.kind, node.label, STATUS_WORDS[node.status] || '', node.rebound ? 'refers to a different definition than its partner' : '',
        hashText(graph, v, info.sel.mask),
        o >= 0 ? `partner hash ${theirs || 'none'}: ${hash && hash === theirs ? 'equal' : 'differs'}` : 'no partner',
        `row ${b.row}`, side.pair[v] >= 0 ? '' : (o >= 0 ? 'shown twice (partner elsewhere)' : ''),
      ].filter(Boolean).join('\n');
      const status = node.status || 'plain';
      parts.push(
        `<g class="n ${status} ${kindClass(node.kind)}${equal ? ' eq' : ''}${faded(v) ? ' fd' : ''}" data-v="${v}" data-pm="${o}"${hash ? ` data-hash="${escapeText(hash)}"` : ''}` +
        `${equal ? ` style="--hc:var(--hash${hashColourIndex(hash)})"` : ''}${fade < 0.995 ? ` opacity="${fade.toFixed(2)}"` : ''}>` +
        `<title>${escapeText(title)}</title>` +
        `<rect class="box" x="${f1(b.x - b.w / 2)}" y="${f1(b.y - b.h / 2)}" width="${f1(b.w)}" height="${f1(b.h)}" rx="3"/>` +
        (equal ? `<rect class="stripe" x="${f1(b.x - b.w / 2 + 2)}" y="${f1(b.y + b.h / 2 - STRIPE - 1)}" width="${f1(b.w - 4)}" height="${STRIPE}" rx="1"/>` : '') +
        `<rect class="halo" x="${f1(b.x - b.w / 2 - 3)}" y="${f1(b.y - b.h / 2 - 3)}" width="${f1(b.w + 6)}" height="${f1(b.h + 6)}" rx="5"/>` +
        `<text x="${f1(b.x)}" y="${f1(b.y + 4)}"${squeeze}>${escapeText(label)}</text></g>`,
      );
    }
    parts.push('</g>');
    if (arcs[index].length) parts.push(`<g class="arcs">${arcs[index].map((d) => `<path class="e hr" d="${d}"/>`).join('')}</g>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" class="hg hp${opts.colour ? ' hs' : ''}" data-box="${boxText}" viewBox="${boxText}">${parts.join('')}</svg>`;
  });
  return { svgs, box, scenes };
}

// ---------------------------------------------------------------------------------------------
// The page part. `env`: `$` (querySelector), `panes` (the page's pan and zoom objects),
// `slot_union_layout` (the wasm export), `options()` (the camera and switches of the bar, with the
// colour switch resolved), `refreshUrl`.

export function createPairController(env) {
  const { $, panes, slot_union_layout, options } = env;
  // the names of the two versions for the texts under the graphs (a function, so that it follows the program shown)
  const sides = env.sides || (() => SIDES);
  const s = { active: false, left: null, right: null, rec: null, info: null, fit: null, layoutMs: 0, drawMs: 0 };
  // The nodes the page has pinned, as [pane, node] pairs (hashgraph.js): they keep their outline whatever is hovered.
  let pinned = () => [];
  const view = { left: $('#left'), right: $('#right') };

  // One pan and zoom for both panes: after a pane has handled a wheel or drag event (its own handlers
  // were attached first), the other pane takes its view box.
  const mirror = (from, to) => {
    if (!s.active || !from.vb || !to.svg) return;
    to.vb = [...from.vb];
    to.svg.setAttribute('viewBox', to.vb.join(' '));
  };
  view.left.addEventListener('wheel', () => mirror(panes.left, panes.right), { passive: true });
  view.right.addEventListener('wheel', () => mirror(panes.right, panes.left), { passive: true });
  view.left.addEventListener('pointermove', () => { if (panes.left.drag) mirror(panes.left, panes.right); });
  view.right.addEventListener('pointermove', () => { if (panes.right.drag) mirror(panes.right, panes.left); });

  const clearHalos = () => {
    for (const v of [view.left, view.right]) v.querySelectorAll('.n.hh').forEach((n) => n.classList.remove('hh'));
    for (const [key, node] of pinned()) view[key].querySelectorAll(`.n[data-v="${node}"]`).forEach((n) => n.classList.add('hh'));
  };
  const over = (isLeft) => (e) => {
    if (!s.active || !s.rec) return;
    clearHalos();
    const t = e.target;
    const g = t && t.closest ? t.closest('.n[data-v]') : null;
    const ghost = !g && t && t.closest ? t.closest('.ghost[data-of]') : null;
    const theirs = isLeft ? view.right : view.left;
    if (ghost) {
      // a ghost stands for a node of the other pane: outline it there
      const of = ghost.dataset.of;
      theirs.querySelectorAll(`.n[data-v="${of}"]`).forEach((n) => n.classList.add('hh'));
      $('#hg-hover').textContent = `a dotted box: the ${sides()[isLeft ? 1 : 0]} graph has a node here that the ${sides()[isLeft ? 0 : 1]} graph has not`;
      return;
    }
    if (!g) { $('#hg-hover').textContent = ''; return; }
    const v = Number(g.dataset.v);
    const partner = (isLeft ? s.info.pl : s.info.pr)[v];
    if (partner >= 0) theirs.querySelectorAll(`.n[data-v="${partner}"]`).forEach((n) => n.classList.add('hh'));
    $('#hg-hover').textContent = describeNode(isLeft, v, s.left, s.right, s.rec, s.info, sides());
  };
  const out = () => { if (!s.active) return; clearHalos(); $('#hg-hover').textContent = ''; };
  view.left.addEventListener('mouseover', over(true));
  view.right.addEventListener('mouseover', over(false));
  view.left.addEventListener('mouseleave', out);
  view.right.addEventListener('mouseleave', out);

  // Squeeze a label that is wider than its box, measured once per layout.
  function measureFit() {
    s.fit = {};
    for (const key of ['left', 'right']) {
      const nodes = [...view[key].querySelectorAll('.n')];
      const fit = new Array((key === 'left' ? s.left : s.right).nodes.length).fill(0);
      const reads = nodes.map((g) => [g, g.querySelector('text').getComputedTextLength(), Number(g.querySelector('rect').getAttribute('width')) - 8]);
      for (const [g, length, room] of reads) if (length > room) fit[Number(g.dataset.v)] = room;
      for (const [g] of reads) {
        const room = fit[Number(g.dataset.v)];
        if (room) { const t = g.querySelector('text'); t.setAttribute('textLength', room); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
      }
      s.fit[key] = fit;
    }
  }

  function layout() {
    const t0 = performance.now();
    s.rec = JSON.parse(slot_union_layout(JSON.stringify(s.left), JSON.stringify(s.right), options().uniform));
    s.layoutMs = performance.now() - t0;
    s.info = analyse(s.left, s.right, s.rec, options().hash);
    s.fit = null;
  }

  function fail(error) {
    s.rec = null;
    for (const [key, pane] of [['left', panes.left], ['right', panes.right]]) {
      pane.svg = null;
      view[key].innerHTML = `<div class="empty error">The comparison cannot be drawn: ${escapeText(error && error.message ? error.message : error)}</div>`;
    }
    $('#hg-numbers').textContent = '';
  }

  function render(keepView) {
    if (!s.active || !s.rec) return;
    const t0 = performance.now();
    const { svgs, box } = buildPairSvgs(s.rec, s.left, s.right, { ...options(), fit: s.fit }, s.info);
    const keep = keepView && panes.left.svg && panes.left.vb ? [...panes.left.vb] : null;
    for (const [key, pane, svg] of [['left', panes.left, svgs[0]], ['right', panes.right, svgs[1]]]) {
      view[key].innerHTML = svg;
      const el = view[key].firstElementChild;
      if (keep) {
        pane.svg = el;
        pane.box = box;
        pane.vb = [...keep];
        el.setAttribute('viewBox', keep.join(' '));
      } else {
        pane.set(el);
      }
    }
    if (s.fit === null) measureFit();
    s.drawMs = performance.now() - t0;
    clearHalos();
    $('#hg-numbers').textContent = numbersText(s.info.numbers, s.layoutMs, s.drawMs, s.info.sel, sides());
  }

  return {
    /** Lay out and draw two versions of a function. */
    show(left, right) {
      s.active = true;
      s.left = left;
      s.right = right;
      setPaneName($, 'left', left.name, `${left.nodes.length} nodes · hash graph, comparison`);
      setPaneName($, 'right', right.name, `${right.nodes.length} nodes · hash graph, comparison`);
      try {
        layout();
      } catch (error) {
        fail(error);
        return;
      }
      render(false);
    },
    render,
    /** The page tells which nodes are pinned: a function that returns [pane, node] pairs. */
    setPinned(f) { pinned = f; },
    /** The box rule changed: lay out again, keep the camera. */
    relayout() {
      if (!s.active || !s.left) return;
      try {
        layout();
      } catch (error) {
        fail(error);
        return;
      }
      render(false);
    },
    deactivate() {
      s.active = false;
      s.left = s.right = s.rec = s.info = null;
      clearHalos();
    },
    /** For tests: the record and the analysis of the current comparison. */
    get state() { return s; },
  };
}
