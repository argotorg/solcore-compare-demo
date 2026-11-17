// "bindings": which definition each use refers to.
//
// The matcher compares nodes and their containment links. A use of a variable is a node with a link
// (a `refs` entry) to its definition, and two matched uses can lead to different definitions while
// everything about the nodes themselves is equal (`a := b` against `b := a`, names ignored). This module
// finds those nodes from what the page already has: the two graphs, a status letter per node and the
// matcher's pairing number per node (`ls`/`rs` and `lm`/`rm` of a facet variant). It needs nothing
// from the matcher and does not touch the wasm modules or the stored data. Pure, so Node can test it.
//
// The rule. Two nodes are partners if their pairing numbers are equal (and not -1). For each pair of
// partners, compare the multiset of the pairing numbers of the targets of their `refs`. A target that
// has no partner is a token of its own that equals nothing (it names the side and the target node), so
// a link to a node without a counterpart always counts as a different definition. If the multisets
// differ, both nodes are *rebound*. A rebound node becomes `own` unless it is already `only`, `moved` or
// `own`; every ancestor (by the `tree` links of its own graph) that is `same` becomes `below`.

const KEEP = 'nmo'; // letters that a rebound node keeps: only, moved, own
const OWN = 'o';
const BELOW = 'b';
const SAME = 's';

/** The partner of each right node number: the first right node with that number. */
function indexByNumber(numbers) {
  const out = new Map();
  numbers.forEach((m, i) => { if (m >= 0 && !out.has(m)) out.set(m, i); });
  return out;
}

/**
 * For each node that has links, its links as one string: the sorted tokens of its targets. A target
 * with a partner is `m<number>`; one without is `<side><index>`, which equals no token of the other side.
 */
function linkKeys(graph, numbers, partnerNumbers, side) {
  const tokens = new Map();
  for (const [from, to] of graph.refs) {
    const m = numbers[to];
    const token = m >= 0 && partnerNumbers.has(m) ? `m${m}` : `${side}${to}`;
    if (!tokens.has(from)) tokens.set(from, []);
    tokens.get(from).push(token);
  }
  const keys = new Map();
  for (const [from, list] of tokens) keys.set(from, list.sort().join(','));
  return keys;
}

/** The letters of one side after the rule: `rebound[i]` says node i is rebound. */
function mark(graph, letters, rebound) {
  const out = Array.from(letters);
  const parents = Array.from({ length: out.length }, () => []);
  for (const [p, c] of graph.tree) parents[c].push(p);
  const climbed = new Uint8Array(out.length);
  rebound.forEach((is, v) => { if (is && !KEEP.includes(out[v])) out[v] = OWN; });
  rebound.forEach((is, v) => {
    if (!is) return;
    const stack = [...parents[v]];
    while (stack.length) {
      const a = stack.pop();
      if (climbed[a]) continue;
      climbed[a] = 1;
      if (out[a] === SAME) out[a] = BELOW;
      stack.push(...parents[a]);
    }
  });
  return out.join('');
}

/**
 * Apply the rule to a compared pair. `left` and `right` are the two graphs (`tree` and `refs` as in
 * the page's data), `ls` and `rs` their status letters (p, s, o, b, n, m), `lm` and `rm` the pairing
 * numbers (-1 for none). Returns new letters and which nodes are rebound; the arguments are not changed.
 *
 *   { ls, rs, left: boolean per left node, right: boolean per right node, count }
 *
 * `count` is the number of rebound pairs (the rebound nodes of one side).
 */
export function applyBindings(left, right, ls, rs, lm, rm) {
  const lKeys = linkKeys(left, lm, new Set(rm.filter((m) => m >= 0)), 'l');
  const rKeys = linkKeys(right, rm, new Set(lm.filter((m) => m >= 0)), 'r');
  const rightOf = indexByNumber(rm);
  const reboundL = new Array(left.nodes.length).fill(false);
  const reboundR = new Array(right.nodes.length).fill(false);
  let count = 0;
  lm.forEach((m, i) => {
    const j = m >= 0 ? rightOf.get(m) : undefined;
    if (j === undefined || (lKeys.get(i) ?? '') === (rKeys.get(j) ?? '')) return;
    reboundL[i] = true;
    reboundR[j] = true;
    count++;
  });
  return { ls: mark(left, ls, reboundL), rs: mark(right, rs, reboundR), left: reboundL, right: reboundR, count };
}

const tally = (letters, letter) => {
  let n = 0;
  for (const c of letters) if (c === letter) n++;
  return n;
};

/**
 * One facet variant of a pair (`{ ls, rs, lm, rm, own, below, ... }` as the page stores it) seen with
 * or without bindings. Off: the variant itself. On: a copy with the new letters, the counts of the
 * variant taken from them in the way the engine counts (own, below and moved by the left letters of
 * the pair, only by each side's own letters), `rebound` (the number of rebound pairs) and `lr`/`rr`
 * (which nodes are rebound, per side).
 */
export function withBindings(pair, variant, on) {
  if (!on) return variant;
  const r = applyBindings(pair.left, pair.right, variant.ls, variant.rs, variant.lm, variant.rm);
  return {
    ...variant,
    ls: r.ls,
    rs: r.rs,
    lr: r.left,
    rr: r.right,
    rebound: r.count,
    own: tally(r.ls, OWN),
    below: tally(r.ls, BELOW),
    moved: tally(r.ls, 'm'),
    only_left: tally(r.ls, 'n'),
    only_right: tally(r.rs, 'n'),
  };
}
