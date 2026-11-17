// The panel "What this hash is made of" of the hash graph view, as HTML: the record a node's hash is
// computed from (canon.js) for the current facets, in one graph or, in a comparison, for two partner nodes
// side by side with the lines that differ marked. Pure (no DOM), so Node can test it; hashgraph.js puts the
// HTML into the page. Every value that comes from a graph is escaped.

import { canonicalNode, canonicalText, scopedNode, scopedText, compareRecords, canPreview } from './canon.js?v=d65421f426';

export const HINT = 'Click a node to see what its hash is made of';
export const NEEDS_DATA = 'The preview needs data from the current build.';
export const DIGEST_NOTE = 'The hash shown is the first 8 hex digits of the digest of this record.';
const BINDING_NOTE = 'The binding-aware hash is the first 8 hex digits of the digest of this record and the references listed under "With bindings".';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const needs = () => `<p>${NEEDS_DATA}</p>`;

// The lines of a text, a differing line wrapped in <mark> (the browser's own marking).
const lines = (text, marked) => text.split('\n').map((line) => (marked.has(line) ? `<mark>${esc(line)}</mark>` : esc(line))).join('\n');
const pre = (text, marked = new Set()) => `<pre>${lines(text, marked)}</pre>`;

/**
 * What the two records differ in, in words: "hashes equal", or "hashes differ in: own facts (kind, names.name),
 * child link body 1, child hash then 0". A child slot that one side lacks is a child link; a slot both
 * sides have, with other child hashes, is a child hash. Null for diffs that are not a list.
 */
export function verdictText(diffs) {
  if (!Array.isArray(diffs)) return null;
  if (diffs.length === 0) return 'hashes equal';
  const items = [];
  const own = diffs.filter((d) => d.part !== 'child');
  if (own.length > 0) items.push(`own facts (${own.map((d) => d.key).join(', ')})`);
  for (const d of diffs) if (d.part === 'child') items.push(`${d.left.length === 0 || d.right.length === 0 ? 'child link' : 'child hash'} ${d.key}`);
  return `hashes differ in: ${items.join(', ')}`;
}

// The two parts of a binding record (scopedText): the lines about the references inside the subtree and the
// lines about the uses that reach outside; the final hash line is in neither.
function parts(record) {
  const all = scopedText(record).split('\n');
  const mid = all.findIndex((l) => l.startsWith('uses that reach outside'));
  const end = all.findIndex((l) => l.startsWith('binding-aware hash'));
  return { inside: all.slice(1, mid), outgoing: all.slice(mid + 1, end < 0 ? all.length : end) };
}

// The lines that one side of a binding record has more of than the other (as multisets), and which parts differ.
function scopedDiff(a, b) {
  const [pa, pb] = [parts(a), parts(b)];
  const more = (x, y) => {
    const left = new Map();
    for (const l of y) left.set(l, (left.get(l) || 0) + 1);
    const out = new Set();
    for (const l of x) { if (left.get(l) > 0) left.set(l, left.get(l) - 1); else out.add(l); }
    return out;
  };
  const differs = [];
  if (pa.inside.join('\n') !== pb.inside.join('\n')) differs.push('references inside the subtree');
  if (pa.outgoing.join('\n') !== pb.outgoing.join('\n')) differs.push('uses that reach outside');
  return {
    left: more([...pa.inside, ...pa.outgoing], [...pb.inside, ...pb.outgoing]),
    right: more([...pb.inside, ...pb.outgoing], [...pa.inside, ...pa.outgoing]),
    differs,
  };
}

/** The part of the verdict about the binding-aware hash (bindings switch on, both nodes have a record). */
export function bindingVerdict(a, b) {
  if (!a || !b) return null;
  const d = scopedDiff(a, b);
  return d.differs.length === 0 && a.hash === b.hash ? 'with bindings: equal' : `with bindings: hashes differ${d.differs.length ? ` in: ${d.differs.join(', ')}` : ''}`;
}

// One node's block: its kind, label and number, the record, with bindings the binding record, and what the
// hash leaves out. `marks` names the lines to mark in the record and in the binding record.
function block(graph, i, mask, bindings, who, marks) {
  const rec = canonicalNode(graph, i, mask);
  if (!rec) return null;
  const node = graph.nodes[i];
  let html = `<p><b>${who ? `${who}: ` : ''}${esc(node.kind)} · ${esc(node.label)}</b> (node ${i})</p>${pre(canonicalText(rec), marks.tree)}`;
  let scoped = null;
  if (bindings) {
    scoped = scopedNode(graph, i, mask);
    html += `<h4>With bindings</h4>${scoped ? pre(scopedText(scoped), marks.scoped) : '<p>This node has no binding-aware hash.</p>'}`;
  }
  html += `<p>Not in this hash: ${rec.left_out.map(esc).join('; ')}.</p>`;
  return { html, rec, scoped };
}

const none = { tree: new Set(), scoped: new Set() };
const notes = (bindings) => `<p>${DIGEST_NOTE}${bindings ? ` ${BINDING_NOTE}` : ''}</p>`;

/** The panel for node `i` of one graph at the facet `mask`; `bindings`: the switch is on. */
export function singlePanel(graph, i, mask, bindings = false) {
  try {
    if (!canPreview(graph)) return needs();
    const b = block(graph, i, mask, bindings, '', none);
    return b ? b.html + notes(bindings) : needs();
  } catch {
    return needs();
  }
}

/**
 * The panel for a node of a comparison: `l` and `r` are the indices of the partner nodes in the left and the
 * right graph, -1 for a node with no partner. Two columns, left and right, with a verdict above them and the
 * lines in which the two records differ marked; one column and "no partner" for a node with no partner.
 */
export function pairPanel(left, right, l, r, mask, bindings = false) {
  try {
    if (!canPreview(left) || !canPreview(right)) return needs();
    if (l < 0 || r < 0) {
      const side = l >= 0 ? ['left', left, l] : ['right', right, r];
      const b = block(side[1], side[2], mask, bindings, side[0], none);
      return b ? `<p>no partner</p><div class="hg-cols"><div>${b.html}</div></div>${notes(bindings)}` : needs();
    }
    const [ra, rb] = [canonicalNode(left, l, mask), canonicalNode(right, r, mask)];
    const diffs = compareRecords(ra, rb);
    if (!ra || !rb || diffs === null) return needs();
    const tree = { left: new Set(), right: new Set() };
    for (const d of diffs) { d.leftLines.forEach((x) => tree.left.add(x)); d.rightLines.forEach((x) => tree.right.add(x)); }
    let sd = { left: new Set(), right: new Set() }, bv = null;
    if (bindings) {
      const [sa, sb] = [scopedNode(left, l, mask), scopedNode(right, r, mask)];
      if (sa && sb) { sd = scopedDiff(sa, sb); bv = bindingVerdict(sa, sb); }
    }
    const a = block(left, l, mask, bindings, 'left', { tree: tree.left, scoped: sd.left });
    const b = block(right, r, mask, bindings, 'right', { tree: tree.right, scoped: sd.right });
    if (!a || !b) return needs();
    const verdict = [verdictText(diffs), bv].filter(Boolean).join('; ');
    return `<p>${esc(verdict)}</p><div class="hg-cols"><div>${a.html}</div><div>${b.html}</div></div>${notes(bindings)}`;
  } catch {
    return needs();
  }
}
