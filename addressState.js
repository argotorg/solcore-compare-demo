// The settings of the page as the address holds them (the part after `#`): `parse` reads an address into
// a settings object and `serialise` writes one back, leaving out every value that equals its default so
// that addresses stay short. Pure (no DOM), so Node can test it; viewer.js connects it to the controls.
//
//   program       a stored program, as the Program list names it
//   example       a built-in example (the part of the Example list's value before the first colon)
//   fn, fnn       the chosen function: its name as the Function list shows it (the Haskell name; for a
//                 function with no partner, "Haskell only: name" or "Rust only: name"), and, only when
//                 several entries share that name, K = its 0-based place among them (default 0)
//   sel           the node pinned in the hash graph view: its index (`12`), in a comparison with the side
//                 (`L12`, `R7`); null when none
//   entry         the position in the Function list; read as a fallback when `fn` is absent (links from
//                 before `fn`), never written for a chosen function
//   facets        the ticked facts as letters: s structure, n names, c constants, t types (default sct)
//   diff stack refs similar            on by default; written as `x=0` when off
//   align dim onlychanged bindings     off by default; written as `x=1` when on (an older link with `align=0`
//                                      is still valid: off)
//   view          the hash graph view's own parameters (view, yaw, tilt, spread, arcs, uniform, paths,
//                 colour) as [name, value] pairs, in order; hashgraph.js reads and writes their meaning
//   unknown       every other parameter as [name, value] pairs, in order, kept so that a rewrite of the
//                 address does not lose what another tool put there
//
// Files that the reader loads from their own machine have no address; the page leaves them out.

export const FACETS = [['s', 1], ['n', 2], ['c', 4], ['t', 8]];
export const VIEW_KEYS = ['view', 'yaw', 'tilt', 'spread', 'arcs', 'uniform', 'paths', 'colour'];
// The on/off settings with their defaults, in the order they are written.
const FLAGS = [['diff', true], ['align', false], ['stack', true], ['dim', false], ['onlychanged', false], ['refs', true], ['similar', true], ['bindings', false]];
const TEXTS = ['program', 'example', 'fn'];

export const DEFAULTS = Object.freeze({
  program: null, example: null, fn: null, fnn: 0, sel: null, entry: null, facets: 'sct',
  ...Object.fromEntries(FLAGS), view: Object.freeze([]), unknown: Object.freeze([]),
});
const OWNED = new Set([...TEXTS, 'fnn', 'sel', 'entry', 'facets', ...FLAGS.map(([name]) => name)]);

/** The facet mask of the page's digest dimensions for facet letters (structure 1, names 2, constants 4, types 8). */
export function maskOfFacets(letters) {
  return FACETS.reduce((m, [letter, bit]) => m | (String(letters).includes(letter) ? bit : 0), 0);
}

/** The facet letters of a mask, in the order s, n, c, t. */
export function facetsOfMask(mask) {
  return FACETS.filter(([, bit]) => mask & bit).map(([letter]) => letter).join('');
}

// The pinned node: an index, with L or R in front of it in a comparison.
const pin = (v) => (typeof v === 'string' && /^[LR]?\d{1,9}$/.test(v) ? v : null);
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
const natural = (v, fallback) => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : fallback;
  return typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : fallback;
};
// A letter set in canonical order; nothing usable (or nothing at all) is the default.
const facets = (v) => {
  const letters = facetsOfMask(maskOfFacets(typeof v === 'string' ? v.toLowerCase() : ''));
  return letters === '' ? DEFAULTS.facets : letters;
};
const flag = (v, byDefault) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return byDefault;
  return byDefault ? v !== '0' : v === '1';
};
const pairs = (list, keep) => {
  const seen = new Set(), out = [];
  for (const [k, v] of Array.isArray(list) ? list : []) {
    if (!keep(k) || typeof v !== 'string') continue;
    if (VIEW_KEYS.includes(k)) { if (seen.has(k)) continue; seen.add(k); }
    out.push([k, v]);
  }
  return out;
};

/**
 * A complete settings object: defaults for what is missing, values that cannot be read replaced by their
 * default, the facets in canonical order. `entry` is kept only when no function name is given, `fnn` only
 * with a name.
 */
export function normalise(s = {}) {
  const out = { ...DEFAULTS };
  for (const key of TEXTS) out[key] = text(s[key]);
  out.fnn = out.fn === null ? 0 : natural(s.fnn, 0);
  out.sel = pin(s.sel);
  out.entry = out.fn === null ? natural(s.entry, null) : null;
  out.facets = facets(s.facets);
  for (const [name, byDefault] of FLAGS) out[name] = flag(s[name], byDefault);
  out.view = pairs(s.view, (k) => VIEW_KEYS.includes(k));
  out.unknown = pairs(s.unknown, (k) => !OWNED.has(k) && !VIEW_KEYS.includes(k));
  return out;
}

/** The settings in an address (`#a=1&b=2` or `a=1&b=2`). Nothing in an address makes this throw. */
export function parse(hash) {
  const raw = String(hash ?? '');
  const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
  const s = {}, view = [], unknown = [];
  for (const [k, v] of params) {
    if (OWNED.has(k)) { if (!(k in s)) s[k] = v; } else if (VIEW_KEYS.includes(k)) view.push([k, v]); else unknown.push([k, v]);
  }
  return normalise({ ...s, view, unknown });
}

/**
 * The address (without `#`) for a settings object: only what differs from the defaults, in a fixed order
 * (program or example, function, pinned node, facets, switches, the hash view's parameters, unknown parameters).
 * `parse(serialise(s))` equals `normalise(s)`.
 */
export function serialise(settings) {
  const s = normalise(settings);
  const p = new URLSearchParams();
  if (s.program !== null) p.set('program', s.program);
  if (s.example !== null) p.set('example', s.example);
  if (s.fn !== null) {
    p.set('fn', s.fn);
    if (s.fnn > 0) p.set('fnn', String(s.fnn));
  } else if (s.entry !== null) {
    p.set('entry', String(s.entry));
  }
  if (s.sel !== null) p.set('sel', s.sel);
  if (s.facets !== DEFAULTS.facets) p.set('facets', s.facets);
  for (const [name, byDefault] of FLAGS) if (s[name] !== byDefault) p.set(name, byDefault ? '0' : '1');
  for (const [k, v] of s.view) p.append(k, v);
  for (const [k, v] of s.unknown) p.append(k, v);
  return p.toString();
}
