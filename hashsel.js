// Which hash of a node the hash graph view uses. A graph carries `h[mask]` and `sh[mask]` for every choice
// of facets (mask "1" to "15": structure 1, names 2, constants 4, types 8): one string with eight hex
// digits per node, in node order. `h` is the hash of the subtree under the node; `sh` also covers which
// definition each variable use inside the subtree refers to, and is eight hyphens for a node that has none
// (see "Two hashes" in README.md). The page's choice is the facet mask of the ticked facets and, with the
// "bindings" switch, the binding-aware hash. Graphs from older data have only `node.hash` (the hash of
// mask 13, structure, constants and types), which is then used whatever the choice. Pure, so Node can test it.

/** What the view used before there was a choice: the default facets, without bindings. */
export const DEFAULT_SEL = Object.freeze({ mask: 13, bindings: false });

const NONE = '--------';
const FACET_NAMES = [[1, 'structure'], [2, 'names'], [4, 'constants'], [8, 'types']];

const sliceOf = (strings, mask, i) => {
  const all = strings && strings[String(mask)];
  if (typeof all !== 'string') return null;
  const part = all.slice(8 * i, 8 * i + 8);
  return part.length === 8 && part !== NONE ? part : null;
};

/**
 * The hash of node `i` of `graph` for the facet `mask`, or, with `withBindings`, its binding-aware hash;
 * null when there is none (a node whose `sh` is eight hyphens, a missing mask, a graph with `h` but no
 * `sh`). A graph without `h` gives `node.hash`, whatever the mask and the switch say.
 */
export function hashOf(graph, i, mask, withBindings = false) {
  if (!graph.h) return graph.nodes[i].hash || null;
  return sliceOf(withBindings ? graph.sh : graph.h, mask, i);
}

/** `hashOf` for every node, in node order. */
export function hashesOf(graph, mask, withBindings = false) {
  return graph.nodes.map((_, i) => hashOf(graph, i, mask, withBindings));
}

/** The names of the ticked facets of a mask, in the page's order: ["structure", "constants", "types"]. */
export function facetNames(mask) {
  return FACET_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name);
}

/** What the hash is called in the numbers line: "hash (structure, constants, types)", with ", with bindings" when it is the binding-aware one. */
export function hashName(sel = DEFAULT_SEL) {
  return `hash (${[...facetNames(sel.mask), ...(sel.bindings ? ['with bindings'] : [])].join(', ')})`;
}

/**
 * Both hashes of a node for the hover text: "hash X · with bindings Y" for the mask, or "hash X · no
 * binding-aware hash" when the node has none. For a graph from data without `h` only "hash X" (there is
 * nothing to compare it with). X is "none" when the node has no hash.
 */
export function hashText(graph, i, mask) {
  const plain = hashOf(graph, i, mask, false) ?? 'none';
  if (!graph.h) return `hash ${plain}`;
  const bound = sliceOf(graph.sh, mask, i);
  return bound ? `hash ${plain} · with bindings ${bound}` : `hash ${plain} · no binding-aware hash`;
}
