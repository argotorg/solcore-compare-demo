// The record a node's hash is made from, as readable data: the "canonicalized node".
//
// Pure functions over the graph objects the page already has (`Graph` of `viewer/src/lib.rs`, as
// the data files and the comparison module give it). No DOM, no globals, no fetching; every function
// returns null, and never throws, for a graph or a node that does not have what it needs (data from
// before `tl` and `Node.facts` were kept, a mask outside 1 to 15, a node number out of range).
//
//   canonicalNode(graph, i, mask)  what the hash of node i (graph.h[mask]) is computed from
//   canonicalText(record)          that record as plain lines
//   scopedNode(graph, i, mask)     what the binding-aware hash (graph.sh[mask]) adds: the references
//                                  that stay inside the subtree and the pattern of those that leave it
//   scopedText(record)             that record as plain lines
//   compareRecords(a, b)           the lines in which the records of two partner nodes differ
//   pathText(path)                 a route from a node to a node of its subtree, as text
//   canPreview(graph)              whether the graph has the data these functions need
//
// What the hash is made of (read in riff-catalog-core `hash/local.rs`, `hash/condensed.rs`,
// `hash/mod.rs` `joint_graph`, `hash/scoped.rs`, and the engine's `mask_hashes`):
//
// - A mask is a set of facets: structure 1, names 2, constants 4, types 8. The facts of the ticked
//   facets are the facts of the hash; the others are not. The kind of the node is read only when
//   structure is ticked (without it every node reads `_`). The facts that Hull files under
//   structure (the index of an argument, the pattern of a case) go with the structure bit.
// - Each child is carried by its label, its ordinal and its own hash. Sibling order beyond the label
//   and the ordinal is not in the hash; the node number, the key and the node's own slot under its
//   parent are not in its hash (the parent folds the slot).
// - The binding-aware hash covers the same and also the references (use to definition) by relative
//   position: those inside the subtree one by one, those that leave it as groups of uses that reach
//   the same outside node, without saying which node.
//
// Facts reach the page as `[dimension, name, value]` text (`Node.facts`); a value over 400 characters
// is cut and ends with `…[N more]`, so two long values that differ only past the cut look equal here.
// A reference reaches the page as a pair of nodes. Its role and label are not in the data; every
// reference of the Hull lowering has the role `reference` and the label `binds` (checked by
// `engine/tests/preview.rs`), so a pair is all the hash can tell apart.

const FACETS = [[1, 'structure'], [2, 'names'], [4, 'constants'], [8, 'types']];
const NO_HASH = '--------';

/// `mask` as an integer from 1 to 15, or null.
function maskOf(mask) {
  const m = typeof mask === 'string' && /^\d+$/.test(mask) ? Number(mask) : mask;
  return Number.isInteger(m) && m >= 1 && m <= 15 ? m : null;
}

/// -1, 0 or 1 for two strings (UTF-16 order, which is the byte order for the ASCII names used here).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/// Per graph, once: the children of each node with the label and ordinal of the link, the parent
/// slot of each node, and the references by source. Null when the graph is not what these functions
/// read: no tree links labelled by `tl`, hashes missing, or facts missing (data from before them).
const known = new WeakMap();

function indexOf(graph) {
  if (!graph || typeof graph !== 'object') return null;
  let ix = known.get(graph);
  if (ix === undefined) {
    try { ix = build(graph); } catch { ix = null; }
    known.set(graph, ix);
  }
  return ix;
}

function build(graph) {
  const { nodes, tree, tl } = graph;
  if (!Array.isArray(nodes) || !Array.isArray(tree)) return null;
  const n = nodes.length;
  if (tree.length > 0 && !(Array.isArray(tl) && tl.length === tree.length)) return null;
  for (const node of nodes) {
    // A node that lists fields in `detail` but has no `facts` comes from before facts were kept.
    if (!node || typeof node !== 'object') return null;
    if (node.facts === undefined && typeof node.detail === 'string' && node.detail.includes('\n')) return null;
    if (node.facts !== undefined && !Array.isArray(node.facts)) return null;
  }
  const kids = Array.from({ length: n }, () => []);
  const slot = new Array(n).fill(null);
  tree.forEach((link, k) => {
    const [p, c] = link;
    const [label, ordinal] = tl[k];
    if (!(Number.isInteger(p) && Number.isInteger(c) && p >= 0 && p < n && c >= 0 && c < n && typeof label === 'string' && Number.isInteger(ordinal))) {
      throw new Error('bad link');
    }
    kids[p].push({ child: c, label, ordinal });
    slot[c] = { parent: p, label, ordinal };
  });
  const refs = Array.from({ length: n }, () => []);
  for (const pair of graph.refs || []) {
    const [s, t] = pair;
    if (!(Number.isInteger(s) && Number.isInteger(t) && s >= 0 && s < n && t >= 0 && t < n)) throw new Error('bad reference');
    refs[s].push(t);
  }
  return { n, kids, slot, refs, order: new Map() };
}

/// The eight hex digits of node `i` in a string of `Graph.h` or `Graph.sh`, or null.
function slice(strings, m, ix, i) {
  const s = strings && typeof strings === 'object' ? strings[String(m)] : undefined;
  return typeof s === 'string' && s.length === 8 * ix.n ? s.slice(8 * i, 8 * i + 8) : null;
}

/// Whether the functions of this module have what they need from the graph (the facts, the labels of the
/// links, and the hashes of the 15 masks).
export function canPreview(graph) {
  const ix = indexOf(graph);
  return ix !== null && (ix.n === 0 || Array.from({ length: 15 }, (_, k) => k + 1).every((m) => slice(graph.h, m, ix, 0) !== null));
}

const facetsOf = (m) => FACETS.filter(([bit]) => m & bit).map(([, dim]) => dim);

/// What the hash of node `i` over the facets of `mask` is computed from:
///
///   kind      the node kind, or null when structure is not ticked (every kind reads the same)
///   facts     [[dimension, name, value]] of the ticked facets, in the order the hash sorts them
///   children  [{label, ordinal, hash}] sorted by ordinal, label and hash, `hash` the child's own
///   hash      the node's own eight hex digits, graph.h[mask]
///   left_out  short texts for what the node has and this hash does not read
///
/// Two nodes have the same `hash` exactly when their records are equal (apart from `left_out` and
/// `hash`), up to a collision of the eight digits; `webtest/canon.test.mjs` checks that on the stored data.
export function canonicalNode(graph, i, mask) {
  try {
    const m = maskOf(mask);
    const ix = indexOf(graph);
    if (m === null || ix === null || !Number.isInteger(i) || i < 0 || i >= ix.n) return null;
    const hash = slice(graph.h, m, ix, i);
    if (hash === null) return null;
    const node = graph.nodes[i];
    const ticked = facetsOf(m);
    const own = node.facts || [];
    // Facts sort by dimension and name; equal names keep the order of their values, which the data keeps
    // as the hash sorts them (Array.prototype.sort is stable).
    const facts = own
      .filter((f) => ticked.includes(f[0]))
      .map((f) => [f[0], f[1], f[2]])
      .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
    const children = ix.kids[i]
      .map((k) => ({ label: k.label, ordinal: k.ordinal, hash: slice(graph.h, m, ix, k.child) }))
      .sort((a, b) => a.ordinal - b.ordinal || cmp(a.label, b.label) || cmp(a.hash, b.hash));
    if (children.some((c) => c.hash === null)) return null;

    const left_out = [];
    if (!(m & 1)) left_out.push('kind (structure not ticked)');
    const unticked = [...new Set(own.map((f) => f[0]).filter((d) => !ticked.includes(d)))].sort();
    for (const dim of unticked) left_out.push(dim === 'structure' ? 'structure facts (structure not ticked)' : `${dim} (not ticked)`);
    if (ix.refs[i].length > 0) left_out.push('binding to its definition (binding-aware hash only)');
    if (ix.kids[i].length > 1) left_out.push('sibling order beyond the label and ordinal');
    if (ix.slot[i] !== null) left_out.push('its own slot under its parent (the parent folds it)');
    left_out.push('node number');

    return { kind: m & 1 ? node.kind : null, facts, children, hash, left_out };
  } catch {
    return null;
  }
}

/// A value on one line: a backslash and a control character are written out, so that one fact is one line.
const oneLine = (s) => String(s).replace(/[\\\u0000-\u001f\u007f]/g, (c) => (c === '\\' ? '\\\\' : c === '\n' ? '\\n' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));

/// The lines of the record of `canonicalNode`: the kind, one line per fact, one per child link, and
/// the node's own hash last. The hash line is left out when the record has no `hash` (to compare
/// records without the node's own hash). With `{ leftOut: true }` the `left_out` texts follow, under
/// a line that says they are not part of the hash.
export function canonicalText(record, options = {}) {
  if (!record || typeof record !== 'object') return null;
  const lines = [record.kind === null || record.kind === undefined ? 'kind -  (structure not ticked: every kind reads the same)' : `kind ${record.kind}`];
  for (const [dim, name, value] of record.facts || []) lines.push(`${dim}.${name} = ${oneLine(value)}`);
  for (const c of record.children || []) lines.push(`child ${c.label} ${c.ordinal}: ${c.hash}`);
  if (record.hash) lines.push(`hash ${record.hash}`);
  if (options.leftOut && (record.left_out || []).length > 0) {
    lines.push('not in this hash:');
    for (const text of record.left_out) lines.push(`  ${text}`);
  }
  return lines.join('\n');
}

/// The children of every node in the order the binding-aware hash sorts them (label, ordinal, then the
/// child's own binding-aware hash), each with its step: the index of its tie class in that order. A
/// child's step is its index in its parent's sorted list; look-alike children (same slot, same
/// hash) are twins and share the step of the first of them, as the hash gives them one offset.
function sortedKids(graph, ix, m) {
  let sorted = ix.order.get(m);
  if (sorted !== undefined) return sorted;
  sorted = null;
  if (slice(graph.sh, m, ix, 0) !== null || ix.n === 0) {
    const sh = (c) => graph.sh[String(m)].slice(8 * c, 8 * c + 8);
    sorted = ix.kids.map((list) => {
      const byKey = list.slice().sort((a, b) => cmp(a.label, b.label) || a.ordinal - b.ordinal || cmp(sh(a.child), sh(b.child)));
      let first = 0;
      return byKey.map((k, j) => {
        const prev = byKey[j - 1];
        if (j > 0 && (k.label !== prev.label || k.ordinal !== prev.ordinal || sh(k.child) !== sh(prev.child))) first = j;
        return { child: k.child, step: first };
      });
    });
  }
  ix.order.set(m, sorted);
  return sorted;
}

/// A route from a node to a node of its subtree as text: the steps joined by dots, or `self`.
export function pathText(path) {
  return path.length === 0 ? 'self' : path.join('.');
}

const cmpPath = (a, b) => {
  for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] - b[k];
  return a.length - b.length;
};

/// What the binding-aware hash of node `i` (graph.sh[mask]) covers besides the tree record, for the
/// subtree under the node. A path is the route from the node to a node of its subtree by child steps:
/// a step is the index of the child among its parent's children sorted as the hash sorts them
/// (`sortedKids`), so the same route names the same place in two subtrees that have the same hash.
///
///   inside    [{from, to}] the references with both ends in the subtree, by path, sorted
///   outgoing  [{group, uses}] the references that leave the subtree: `uses` the paths of the nodes
///             that hold them, grouped by the outside node they reach (nodes of one group reach the same
///             node, which is not named), groups sorted by their uses and numbered from 1
///   hash      the binding-aware hash, eight hex digits; null where there is none
///   residual  whether look-alike children make the hash weaker (graph.sr), false when not listed
///   nodes     [{path, node}] every node of the subtree with its path, sorted by path; not part of the
///             hash, for finding the nodes of a record on the graph
///
/// References that enter the subtree from outside are not in the hash, and not here.
export function scopedNode(graph, i, mask) {
  try {
    const m = maskOf(mask);
    const ix = indexOf(graph);
    if (m === null || ix === null || !Number.isInteger(i) || i < 0 || i >= ix.n) return null;
    const hash = slice(graph.sh, m, ix, i);
    if (hash === null) return null;
    const sorted = sortedKids(graph, ix, m);
    if (sorted === null) return null;

    const at = new Map();
    const stack = [[i, []]];
    while (stack.length > 0) {
      const [v, path] = stack.pop();
      if (at.has(v)) return null; // not a forest: the hash is unavailable, and so is this
      at.set(v, path);
      for (const k of sorted[v]) stack.push([k.child, [...path, k.step]]);
    }
    const inside = [];
    const leaving = new Map();
    for (const [v, path] of at) {
      for (const t of ix.refs[v]) {
        if (at.has(t)) inside.push({ from: path, to: at.get(t) });
        else {
          if (!leaving.has(t)) leaving.set(t, []);
          leaving.get(t).push(path);
        }
      }
    }
    inside.sort((a, b) => cmpPath(a.from, b.from) || cmpPath(a.to, b.to));
    const groups = [...leaving.values()].map((uses) => uses.sort(cmpPath));
    groups.sort((a, b) => {
      for (let k = 0; k < Math.min(a.length, b.length); k++) {
        const c = cmpPath(a[k], b[k]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    });
    const sr = graph.sr && typeof graph.sr[String(m)] === 'string' ? graph.sr[String(m)] : null;
    return {
      inside,
      outgoing: groups.map((uses, g) => ({ group: g + 1, uses })),
      hash: hash === NO_HASH ? null : hash,
      residual: sr !== null && sr[i] === '1',
      nodes: [...at].map(([node, path]) => ({ path, node })).sort((a, b) => cmpPath(a.path, b.path) || a.node - b.node),
    };
  } catch {
    return null;
  }
}

/// The lines of the record of `scopedNode`: the references inside the subtree, the groups of uses
/// that leave it, and the binding-aware hash last (left out when the record has none).
export function scopedText(record) {
  if (!record || typeof record !== 'object') return null;
  const lines = ['references inside the subtree:'];
  for (const r of record.inside || []) lines.push(`  ${pathText(r.from)} -> ${pathText(r.to)}`);
  if (!(record.inside || []).length) lines.push('  none');
  lines.push('uses that reach outside, by the outside node they reach (not named):');
  for (const g of record.outgoing || []) lines.push(`  group ${g.group}: ${g.uses.map(pathText).join(', ')}`);
  if (!(record.outgoing || []).length) lines.push('  none');
  if (record.hash) lines.push(`binding-aware hash ${record.hash}`);
  return lines.join('\n');
}

/// The lines in which the records of two partner nodes differ, left and right, as the objects
///
///   { part, key, left, right, leftLines, rightLines }
///
/// `part` is 'kind', 'fact' or 'child'. `key` names the line: 'kind', `dimension.name` of a fact, or
/// `label ordinal` of a child slot. `left` and `right` are the values (a kind, the values of the fact,
/// the hashes of the children in the slot) as lists, empty where that side has none. `leftLines` and
/// `rightLines` are the lines of `canonicalText` they stand for, so that the lines to mark are
/// those that appear in them. Records of the same node, or of nodes with equal hash, give an empty
/// list. A record that is null gives null.
export function compareRecords(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  try {
    const diffs = [];
    const sameList = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    const ka = a.kind === null || a.kind === undefined ? [] : [a.kind];
    const kb = b.kind === null || b.kind === undefined ? [] : [b.kind];
    if (!sameList(ka, kb)) {
      const line = (k) => canonicalText({ kind: k[0] ?? null }).split('\n')[0];
      diffs.push({ part: 'kind', key: 'kind', left: ka, right: kb, leftLines: ka.length ? [line(ka)] : [], rightLines: kb.length ? [line(kb)] : [] });
    }
    // Facts by dimension and name: the values in the order of the record, which is the order of the hash.
    const byName = (facts) => {
      const map = new Map();
      for (const [dim, name, value] of facts || []) {
        const key = `${dim}.${name}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
      }
      return map;
    };
    const [fa, fb] = [byName(a.facts), byName(b.facts)];
    for (const key of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
      const [x, y] = [fa.get(key) || [], fb.get(key) || []];
      if (!sameList(x, y)) diffs.push({ part: 'fact', key, left: x, right: y, leftLines: x.map((v) => `${key} = ${oneLine(v)}`), rightLines: y.map((v) => `${key} = ${oneLine(v)}`) });
    }
    // Children by slot.
    const bySlot = (children) => {
      const map = new Map();
      for (const c of children || []) {
        const key = `${c.label} ${c.ordinal}`;
        if (!map.has(key)) map.set(key, { label: c.label, ordinal: c.ordinal, hashes: [] });
        map.get(key).hashes.push(c.hash);
      }
      for (const slot of map.values()) slot.hashes.sort();
      return map;
    };
    const [ca, cb] = [bySlot(a.children), bySlot(b.children)];
    const slots = [...new Set([...ca.keys(), ...cb.keys()])].map((key) => (ca.get(key) || cb.get(key)));
    slots.sort((p, q) => p.ordinal - q.ordinal || cmp(p.label, q.label));
    for (const { label, ordinal } of slots) {
      const key = `${label} ${ordinal}`;
      const [x, y] = [(ca.get(key) || { hashes: [] }).hashes, (cb.get(key) || { hashes: [] }).hashes];
      if (!sameList(x, y)) {
        const lines = (hashes) => hashes.map((h) => `child ${label} ${ordinal}: ${h}`);
        diffs.push({ part: 'child', key, left: x, right: y, leftLines: lines(x), rightLines: lines(y) });
      }
    }
    return diffs;
  } catch {
    return null;
  }
}
