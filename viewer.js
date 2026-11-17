import init, { render_graph, render_pair, slot_layout, slot_union_layout } from './pkg/viewer.js?v=e4c3ea8f71';
import { initHashView, setPaneName } from './hashgraph.js?v=9159ac74de';
import * as hashPair from './hashgraph-pair.js?v=5127849db9';
import { withBindings } from './bindings.js?v=3eafae25c0';
import { parse as parseAddress, serialise as serialiseAddress, maskOfFacets, facetsOfMask } from './addressState.js?v=635d8d12f3';

const $ = (selector) => document.querySelector(selector);
// What the two sides of a stored program are: the same program from two compilers, or one program before and after
// an edit. `prep` writes the labels in the index entry of each program; `labels` here are for an index written
// without them (only programs of two compilers). `key` is what the address calls the side in the name of a
// function that has no partner (`Haskell only: name`): fixed words, so that a link does not change with a label.
const KINDS = {
  compilers: { labels: ['Haskell compiler', 'Rust compiler'], key: ['Haskell', 'Rust'] },
  edits: { labels: ['before', 'after'], key: ['before', 'after'] },
};
const withKind = (e) => {
  const kind = e.kind in KINDS ? e.kind : 'compilers';
  return { ...e, kind, left_label: e.left_label || KINDS[kind].labels[0], right_label: e.right_label || KINDS[kind].labels[1] };
};
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// `files` holds the two Hull files the reader loaded (or the two files of an example); when `live` is set
// the program shown was compared in the browser from them, over the chosen facets, and is compared again
// whenever the facets change. `example` names the built-in example they came from (null for the reader's
// own files, which cannot be in an address), `stored` the stored program shown last (the address of a
// state with the reader's own files names it), `autoPairs` how many of the pairs the comparison found
// itself (pairs made by hand come after them) and `unknown` the parameters of the address that the page
// does not know, which it keeps when it writes the address.
// `kind` and `sides` (the labels) are those of the stored program shown last (see `KINDS`).
const state = { index: [], program: null, kind: 'compilers', sides: KINDS.compilers.labels, entries: [], files: null, live: false, example: null, stored: null, autoPairs: 0, unknown: [], compareMs: 0 };

// The comparison module (riff-catalog, the Hull recipe and the matching, about
// 1 MB) is fetched only when the reader loads files of their own.
let compareLib = null;
async function compareModule() {
  if (!compareLib) {
    const lib = await import('./pkg-compare/browser.js');
    await lib.default();
    compareLib = lib;
  }
  return compareLib;
}

// The layout sizes boxes by an estimate of the text width; a font that is wider
// than the estimate would let a label run out of its box, so squeeze it to fit.
function fitLabels(view) {
  for (const g of view.querySelectorAll('.n')) {
    const text = g.querySelector('text'), room = Number(g.querySelector('rect').getAttribute('width')) - 8;
    if (text.getComputedTextLength() > room) {
      text.setAttribute('textLength', room);
      text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}

// The scale Fit gives a drawing, from `own`, the scale at which it would fill its pane. Until the hash graph view exists (below) that
// is `own`; then: the hash graph view is fitted to its pane as before (its two panes are drawn from one union layout, one box),
// and the layered view never enlarges a drawing beyond its own size (scale 1, a node box is as wide as it was laid out) and fits both
// panes at one scale, the smaller of the two, so that the same graph is the same size in both panes (a small graph on one side is
// not drawn larger than the same graph on the other), with "align" on or off.
let fitScale = (own) => own;

// Pan and zoom by changing the viewBox; the viewBox always has the aspect ratio
// of the pane, so a pixel is the same distance in both directions.
function attach(view) {
  const view_state = { vb: null, box: null, drag: null, svg: null };
  const apply = () => view_state.svg && view_state.svg.setAttribute('viewBox', view_state.vb.join(' '));
  view_state.set = (svg) => {
    view_state.svg = svg;
    view_state.box = svg.dataset.box.split(' ').map(Number);
    view_state.fit();
  };
  // the scale at which the drawing fills the pane
  view_state.ownScale = () => {
    const r = view.getBoundingClientRect();
    const [, , w, h] = view_state.box;
    return Math.min(r.width / w, r.height / h);
  };
  view_state.fit = () => {
    if (!view_state.svg) return;
    const r = view.getBoundingClientRect();
    const [x, y, w, h] = view_state.box;
    const scale = fitScale(view_state.ownScale());
    const vw = r.width / scale, vh = r.height / scale;
    view_state.vb = [x - (vw - w) / 2, y - (vh - h) / 2, vw, vh];
    apply();
  };
  view.addEventListener('wheel', (e) => {
    if (!view_state.svg) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const k = Math.exp(e.deltaY * 0.0015);
    const [x, y, w, h] = view_state.vb;
    const px = x + ((e.clientX - r.left) / r.width) * w;
    const py = y + ((e.clientY - r.top) / r.height) * h;
    view_state.vb = [px - (px - x) * k, py - (py - y) * k, w * k, h * k];
    apply();
  }, { passive: false });
  view.addEventListener('pointerdown', (e) => {
    view_state.drag = { x: e.clientX, y: e.clientY, vb: [...view_state.vb] };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    const d = view_state.drag;
    if (!d) return;
    const r = view.getBoundingClientRect();
    view_state.vb = [d.vb[0] - ((e.clientX - d.x) / r.width) * d.vb[2], d.vb[1] - ((e.clientY - d.y) / r.height) * d.vb[3], d.vb[2], d.vb[3]];
    apply();
  });
  view.addEventListener('pointerup', () => { view_state.drag = null; });
  return view_state;
}

const panes = { left: attach($('#left')), right: attach($('#right')) };

// The hash graph view (hashgraph.js) draws one function in the left pane, from the slot layout; for a
// pair it draws both versions, one in each pane, from the union layout (hashgraph-pair.js).
// The hashes it uses are those of the ticked facets, and with "bindings" the binding-aware ones (hashsel.js).
const hashView = initHashView({
  $, panes, slot_layout, slot_union_layout, pair: hashPair,
  reshow: () => { if (state.entries.length) show(state.entries[Number($('#pair').value)]); },
  refreshUrl: () => writeAddress('replace'),
  hashSel: () => ({ mask: mask(), bindings: $('#bindings').checked }),
  sides: () => [sideWord(0), sideWord(1)],
});
fitScale = (own) => (hashView.active
  ? own
  : Math.min(1, ...[panes.left, panes.right].filter((p) => p.svg).map((p) => p.ownScale())));

function draw(side, graph, label) {
  const view = $('#' + side);
  if (!graph) {
    view.innerHTML = '<div class="empty">No counterpart in this program.</div>';
    panes[side].svg = null;
    setPaneName($, side, '');
    return;
  }
  const t0 = performance.now();
  const svg = render_graph(JSON.stringify(graph), $('#changes').checked);
  place(side, svg, graph, performance.now() - t0);
}

function place(side, svg, graph, ms) {
  const view = $('#' + side);
  view.innerHTML = svg;
  fitLabels(view);
  panes[side].set(view.firstElementChild);
  setPaneName($, side, graph.name, `${graph.nodes.length} nodes · layout and drawing ${ms.toFixed(1)} ms`);
}

// A function whose shape (node kinds and links) is the same in this many
// programs is compiler entry or library code, not something written in this
// program. It is listed after the functions specific to the program.
const SHARED = 3;

// The facets (digest dimensions) the comparison uses, as the bits `prep` writes.
const FACETS = [['structure', 1], ['names', 2], ['constants', 4], ['types', 8]];
const CODES = { p: 'plain', s: 'same', o: 'own', b: 'below', n: 'only', m: 'moved' };

// What the two sides are called in a sentence: the labels of the stored program, or "left" and "right" for
// loaded files. The titles of the panes are the labels with a capital, or the names of the loaded files.
const sideWord = (side) => (state.live ? ['left', 'right'] : state.sides)[side];
const sideKey = (side) => (state.live ? ['left', 'right'] : KINDS[state.kind].key)[side];
const paneTitle = (side) => (state.live ? state.files[['left', 'right'][side]].name : cap(state.sides[side]));

function mask() {
  return FACETS.reduce((m, [name, bit]) => m | ($(`#f-${name}`).checked ? bit : 0), 0);
}

// The comparison of a pair over the chosen facets. With "bindings" on, matched nodes whose links lead to
// different definitions are marked as differing too (bindings.js), so the statuses, the counts and everything
// drawn from them follow from this one place.
function variantAt(pair, facets) {
  return withBindings(pair, pair.variants.find((v) => v.mask === facets), $('#bindings').checked);
}
const variantOf = (pair) => variantAt(pair, mask());

// A copy of a graph with the statuses and pairing of a comparison (and, with bindings, which nodes are rebound).
function withVariant(graph, letters, numbers, rebound) {
  return {
    ...graph,
    nodes: graph.nodes.map((n, i) => ({ ...n, status: CODES[letters[i]], m: numbers[i] >= 0 ? numbers[i] : undefined, rebound: rebound ? rebound[i] : undefined })),
  };
}

// How the address names an entry of the Function list: `key` is the name of a pair's left function, or
// "Haskell only: name" / "Rust only: name" (`sideKey`) for a function with no partner, and `k` the 0-based
// place of the entry among those with the same key, in the order of the program (not of the list, which the
// facets and "only pairs that differ" change).
function nameEntries(program) {
  const seen = new Map(), out = { pair: [], left: [], right: [] };
  const add = (kind, i, key) => { const k = seen.get(key) || 0; seen.set(key, k + 1); out[kind][i] = { key, k }; };
  program.pairs.forEach((p, i) => add('pair', i, p.left.name));
  program.left_only.forEach((g, i) => add('left', i, `${sideKey(0)} only: ${g.name}`));
  program.right_only.forEach((g, i) => add('right', i, `${sideKey(1)} only: ${g.name}`));
  return out;
}

function entriesOf(program, onlyChanged) {
  const out = [];
  const shared = (n) => n >= SHARED;
  const named = nameEntries(program);
  program.pairs.forEach((pair, i) => {
    const p = variantOf(pair);
    const diff = p.own + p.below + p.only_left + p.only_right + p.moved;
    if (onlyChanged && diff === 0) return;
    const what = diff === 0 ? 'no difference' : `${p.own} own, ${p.below} below, ${p.only_left}/${p.only_right} only, ${p.moved} moved`;
    const also = (shared(pair.repeated) ? `, same shape in ${pair.repeated} programs` : '') + (pair.similar > 0 ? `, paired by similarity ${pair.similar}%` : '');
    out.push({ kind: 'pair', i, diff, ...named.pair[i], shared: shared(pair.repeated), text: `${pair.name}  (${what}${also})` });
  });
  if (!onlyChanged) {
    const only = (list, kind, label) => list.forEach((g, i) => out.push({
      kind, i, diff: 0, ...named[kind][i], shared: shared(g.repeated),
      text: `${label} only: ${g.name}${shared(g.repeated) ? `  (same shape in ${g.repeated} programs)` : ''}`,
    }));
    only(program.left_only, 'left', sideWord(0));
    only(program.right_only, 'right', sideWord(1));
  }
  return [...out.filter((e) => !e.shared), ...out.filter((e) => e.shared)];
}

// The first difference that is specific to the program, else the first
// specific function, else the first entry.
function defaultEntry(entries) {
  const specific = entries.map((e, i) => [e, i]).filter(([e]) => !e.shared);
  const differing = specific.find(([e]) => e.diff > 0);
  return (differing || specific[0] || [null, 0])[1];
}

// The entry a selection names: `{ key, k }` (a name from the address, and its place among equal names), `{ index }`
// (a position in the list, the form of older links) or nothing (the default entry). A name that is not in the
// list (the pair no longer differs, another program) gives the default entry.
function pick(entries, selection) {
  if (selection && selection.key !== undefined) {
    const same = entries.map((e, i) => [e, i]).filter(([e]) => e.key === selection.key);
    if (same.length) return (same.find(([e]) => e.k === selection.k) || same[0])[1];
  } else if (selection && selection.index !== undefined) {
    return Math.min(selection.index, entries.length - 1);
  }
  return defaultEntry(entries);
}

const currentSelection = () => {
  const entry = state.entries[Number($('#pair').value)];
  return entry ? { key: entry.key, k: entry.k } : undefined;
};

// How much the three rarely used facts matter for the pair shown: the status letters of the comparison over
// the ticked facts against those over the same facts plus structure, constants and types (names and the
// bindings switch as they are), counted over the nodes of both sides. Stored data has every combination;
// files compared in the browser are compared over the ticked facts only, so nothing is said for them.
function updateFacetNote(entry) {
  const note = $('#facet-effect');
  let text = '';
  if (entry && entry.kind !== 'pair') {
    text = 'This function has no counterpart, so there is nothing to compare.';
  } else if (entry && state.live) {
    text = 'Not shown for files compared in the browser, which compare only the facts that are ticked.';
  } else if (entry) {
    const pair = state.program.pairs[entry.i];
    const here = variantOf(pair), full = variantAt(pair, mask() | 13);
    let n = 0;
    for (const [a, b] of [[here.ls, full.ls], [here.rs, full.rs]]) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    text = `With the current choice, ${n === 0 ? 'no node marks change' : `${n} node ${n === 1 ? 'mark differs' : 'marks differ'}`} from structure, constants and types all ticked.`;
  }
  note.textContent = text;
  note.hidden = text === '';
}

// Which function the page last drew: a node pinned in the hash graph view stays pinned while the same function is
// drawn again (another facet, the bindings switch) and is let go when another one is drawn.
let shownId = null;

function show(entry) {
  const program = state.program;
  const id = `${state.live ? `live:${state.example || ''}:${state.files.left.name}:${state.files.right.name}` : program.program}:${entry.kind}:${entry.key}:${entry.k}`;
  if (id !== shownId) hashView.unpin();
  shownId = id;
  $('#lname').textContent = paneTitle(0);
  $('#rname').textContent = paneTitle(1);
  let left = null, right = null, summary = '';
  if (entry.kind === 'pair') {
    const pair = program.pairs[entry.i], p = variantOf(pair);
    left = withVariant(pair.left, p.ls, p.lm, p.lr); right = withVariant(pair.right, p.rs, p.rm, p.rr);
    const compared = [...FACETS.filter(([, bit]) => mask() & bit).map(([name]) => name), ...($('#bindings').checked ? ['bindings'] : [])].join(', ');
    const rebound = p.rebound === undefined ? '' : ` ${p.rebound} ${p.rebound === 1 ? 'node refers' : 'nodes refer'} to a different definition than ${p.rebound === 1 ? 'its' : 'their'} counterpart.`;
    const took = state.live ? `Compared in the browser in ${state.compareMs.toFixed(0)} ms. ` : '';
    const how = pair.similar > 0 ? `Paired by similarity (${pair.similar}% of the nodes match), not by name. ` : '';
    summary = `${took}${how}Nodes that differ: ${p.own} with own differences, ${p.below} with a difference below, ${p.only_left} only in the ${sideWord(0)} graph, ${p.only_right} only in the ${sideWord(1)} graph, ${p.moved} moved (same content, but reordered among its siblings or under another parent).${rebound} Compared: ${compared}.`;
  } else if (entry.kind === 'left') {
    left = program.left_only[entry.i];
    summary = `Only the ${sideWord(0)} graph has this function: it was not paired with one in the ${sideWord(1)} graph by name, so nothing is compared.`;
  } else {
    right = program.right_only[entry.i];
    summary = `Only the ${sideWord(1)} graph has this function: it was not paired with one in the ${sideWord(0)} graph by name, so nothing is compared.`;
  }
  $('#summary').textContent = summary;
  updateFacetNote(entry);
  if (hashView.active) {
    if (left && right) hashView.showPair(left, right, $('#lname').textContent, $('#rname').textContent);
    else hashView.show(left || right, left ? $('#lname').textContent : $('#rname').textContent);
    return;
  }
  if (left && right && $('#align').checked) {
    const t0 = performance.now();
    const [l, r] = render_pair(JSON.stringify(left), JSON.stringify(right), $('#changes').checked);
    const ms = performance.now() - t0;
    place('left', l, left, ms);
    place('right', r, right, ms);
  } else {
    draw('left', left);
    draw('right', right);
  }
  // each pane was fitted when it was drawn, to the other pane's previous drawing: fit both again, to the two new ones
  panes.left.fit(); panes.right.fit();
}

function fillEntries(selection) {
  const entries = entriesOf(state.program, $('#onlychanged').checked);
  state.entries = entries;
  const option = (e, i) => `<option value="${i}">${e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`;
  const group = (label, wanted) => {
    const items = entries.map((e, i) => [e, i]).filter(([e]) => e.shared === wanted);
    return items.length ? `<optgroup label="${label}">${items.map(([e, i]) => option(e, i)).join('')}</optgroup>` : '';
  };
  $('#pair').innerHTML = group('Specific to this program', false)
    + group(`Same shape in ${SHARED} or more programs (compiler entry and library code)`, true);
  if (entries.length === 0) {
    $('#summary').textContent = 'No function pair differs in this program.';
    updateFacetNote(null);
    draw('left', null); draw('right', null);
    if (hashView.active) hashView.show(null);
    return;
  }
  const i = pick(entries, selection);
  $('#pair').value = String(i);
  show(entries[i]);
}

function fail(error) {
  $('#summary').textContent = `Could not compare: ${error && error.message ? error.message : error}`;
  $('#summary').classList.add('error');
}

// Compare the loaded files over the chosen facets, in the browser.
async function recompute(selection) {
  try {
    $('#summary').classList.remove('error');
    const lib = await compareModule();
    const { left, right, manual } = state.files;
    const t0 = performance.now();
    const program = JSON.parse(lib.compare_hull(left.text, right.text, mask(), 'your files', $('#similar').checked));
    state.autoPairs = program.pairs.length;
    for (const [l, r] of manual) program.pairs.push(JSON.parse(lib.compare_functions(left.text, l, right.text, r, mask())));
    state.compareMs = performance.now() - t0;
    state.program = program;
    state.live = true;
    setNamesTitle();
    const label = `your files: ${left.name} and ${right.name}`;
    if (!$('#program option[value="__files__"]')) $('#program').insertAdjacentHTML('afterbegin', '<option value="__files__"></option>');
    $('#program option[value="__files__"]').textContent = label;
    $('#program').value = '__files__';
    fillEntries(selection);
  } catch (error) {
    fail(error);
  }
}

async function loadFiles() {
  const [l, r] = [$('#file-left').files[0], $('#file-right').files[0]];
  if (!l || !r) return;
  await useTexts({ name: l.name, text: await l.text() }, { name: r.name, text: await r.text() }, null);
  writeAddress('replace');   // files of the reader's own are not part of an address: nothing is added to the history
}

// The examples are small: the Hull of one program from two compilers, or from one compiler before and after a
// fix. The files are `samples/NAME-A.hull` and `samples/NAME-B.hull`, with the sides called haskell and rust or
// before and after; the address names the example by NAME. False if there is no such example.
const EXAMPLE_SIDES = [['haskell', 'rust'], ['before', 'after']];
async function exampleSides(name) {
  for (const sides of EXAMPLE_SIDES) {
    try {
      if ((await fetch(`samples/${name}-${sides[0]}.hull`)).ok) return sides;
    } catch { /* not this kind of example */ }
  }
  return null;
}

async function loadExample(name, selection) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  try {
    const sides = await exampleSides(name);
    if (!sides) return false;
    const get = async (side) => ({ name: `${name}-${side}.hull`, text: await (await fetch(`samples/${name}-${side}.hull`)).text() });
    $('#example').value = `${name}:${sides.join(':')}`;
    await useTexts(await get(sides[0]), await get(sides[1]), name, selection);
  } catch (error) {
    fail(error);
  }
  return true;
}

async function useTexts(left, right, example, selection) {
  try {
    const [lt, rt] = [left.text, right.text];
    state.files = { left, right, manual: [] };
    state.example = example;
    if (!example) $('#example').value = '';
    const lib = await compareModule();
    const options = (text) => JSON.parse(lib.function_names(text)).map((n) => `<option>${n.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`).join('');
    $('#hand-left').innerHTML = options(lt);
    $('#hand-right').innerHTML = options(rt);
    $('#hand').hidden = false;
    await recompute(selection);
  } catch (error) {
    fail(error);
  }
}

async function pairByHand() {
  const pair = [$('#hand-left').value, $('#hand-right').value];
  if (!pair[0] || !pair[1]) return;
  state.files.manual.push(pair);
  await recompute();
  const last = state.program.pairs.length - 1;
  const at = state.entries.findIndex((e) => e.kind === 'pair' && e.i === last);
  if (at >= 0) { $('#pair').value = String(at); show(state.entries[at]); }
  writeAddress('replace');
}

// The two uses of the page, chosen by the two radio buttons at the start of the header: one program from two
// compilers (the stored run), or one program before and after an edit. The Program list holds the programs of the
// chosen kind only, in the order of the index. A program of two compilers is listed with how many of its pairs
// differ and how many of those are specific to it; an edited program by its name and its note (`prep`'s NAME.note).
const USES = [['compilers', 'use-compilers'], ['edits', 'use-edits']];
const programOption = (e) => {
  const detail = e.kind === 'edits' ? (e.note ? ` (${e.note})` : '') : `  (${e.changed_pairs}/${e.pairs} pairs differ, ${e.specific_changed} specific to it)`;
  return `<option value="${e.program}">${e.program}${detail}</option>`;
};

// Show the programs of one kind in the Program list and tick that kind's radio button. The list is written again
// only when the kind changes, so that an unchanged list keeps its `__files__` entry.
let listed = null;
function listKind(kind) {
  for (const [k, id] of USES) $('#' + id).checked = k === kind;
  if (listed === kind) return;
  listed = kind;
  $('#program').innerHTML = state.index.filter((e) => e.kind === kind).map(programOption).join('');
}

// The program the page opens on when the address does not name one: the first program of two compilers with a
// difference of its own. Choosing the second use opens on the first edited program that shows a difference at the
// default settings (the list keeps its order: a program with none, like swap-binding, stays in it and can be chosen).
const defaultProgram = () => state.index.find((e) => e.kind === 'compilers' && e.specific_changed > 0) || state.index[0];
const firstOf = (kind) => (kind === 'compilers'
  ? defaultProgram()
  : state.index.find((e) => e.kind === kind && e.changed_pairs > 0) || state.index.find((e) => e.kind === kind));

// A program with a note in the index (`prep`'s NAME.note; today only swap-binding, "only the bindings differ") shows no
// difference unless a switch is on, so choosing it turns the bindings switch on. This is for a choice made on the page;
// an address is read as it is. The switch stays where it is (the reader can turn it off, and it is not turned off again).
function noteSwitch(name) {
  const entry = state.index.find((e) => e.program === name);
  if (entry && entry.note) $('#bindings').checked = true;
}

// What the Compare row's "names" box says about names: the two compilers invent different names, which is why it
// starts off for them; in an edited program, or in files of the reader's own, the names are the author's.
function setNamesTitle() {
  $('#names-label').title = !state.live && state.kind === 'compilers'
    ? 'The two compilers invent different names; leave off to ignore them'
    : 'Count a name that differs as a difference; leave off to ignore names';
}

async function loadProgram(name, selection) {
  const have = !state.live && state.program && state.program.program === name;
  const entry = state.index.find((e) => e.program === name);
  state.kind = entry.kind;
  state.sides = [entry.left_label, entry.right_label];
  state.live = false;
  setNamesTitle();
  state.example = null;
  state.stored = name;
  $('#example').value = '';
  if (!have) {
    const response = await fetch(`data/${encodeURIComponent(name)}.json`);
    state.program = await response.json();
  }
  state.autoPairs = state.program.pairs.length;
  fillEntries(selection);
}

// ---------------------------------------------------------------------------------------------------------
// The address holds every setting (addressState.js has the parameters). `applyAddress` is the one place that
// reads it and sets the controls and the view: at load, and on hashchange and popstate (the back and forward
// buttons, a pasted link). `writeAddress` is the one place that writes it, from the controls: `'push'` adds a
// history entry (a chosen program, example or function, so that back returns to the one before),
// `'replace'` changes the current one (a toggled checkbox, a moved slider). Neither fires a hashchange.

// The checkboxes of the address, by setting name.
const SWITCHES = [['diff', '#changes'], ['align', '#align'], ['stack', '#stack'], ['dim', '#dim'], ['onlychanged', '#onlychanged'], ['refs', '#refs'], ['similar', '#similar'], ['bindings', '#bindings']];
let applied = null;   // the address (location.hash) last read or written
let queue = Promise.resolve();

// What the layout switches do to the page itself (their handlers call this too).
function setLayoutClasses() {
  $('#main').classList.toggle('stacked', $('#stack').checked);
  $('#main').classList.toggle('dim', $('#dim').checked);
  $('#main').classList.toggle('norefs', !$('#refs').checked);
}

function currentSettings() {
  const s = { facets: facetsOfMask(mask()), unknown: state.unknown };
  for (const [name, id] of SWITCHES) s[name] = $(id).checked;
  const view = new URLSearchParams();
  hashView.addParams(view);
  s.view = [...view];
  s.sel = hashView.pinText();
  if (state.live && state.example) s.example = state.example;
  else s.program = state.live ? state.stored : state.program.program;
  // A function of the reader's own files has no name in a stored program, and neither has a pair made by hand.
  const entry = state.entries[Number($('#pair').value)];
  const own = !state.live || (state.example && !(entry && entry.kind === 'pair' && entry.i >= state.autoPairs));
  if (entry && own) { s.fn = entry.key; s.fnn = entry.k; }
  return s;
}

function writeAddress(how) {
  if (!state.program) return;
  const hash = '#' + serialiseAddress(currentSettings());
  if (hash === applied) return;
  history[how === 'push' ? 'pushState' : 'replaceState'](null, '', hash);
  applied = location.hash;
}

async function applyAddress() {
  const s = parseAddress(location.hash);
  applied = location.hash;
  state.unknown = s.unknown;
  const facets = maskOfFacets(s.facets);
  for (const [name, bit] of FACETS) $(`#f-${name}`).checked = (facets & bit) !== 0;
  for (const [name, id] of SWITCHES) $(id).checked = s[name];
  setLayoutClasses();
  hashView.readParams(new URLSearchParams(s.view));
  hashView.requestPin(s.sel);   // taken when the function is drawn; a link without `sel` unpins
  $('#summary').classList.remove('error');
  const selection = s.fn !== null ? { key: s.fn, k: s.fnn } : s.entry !== null ? { index: s.entry } : undefined;
  if (!(s.example && await loadExample(s.example, selection))) {
    const first = state.index.find((e) => e.program === s.program) || defaultProgram();
    listKind(first.kind);   // the choice of use follows the program
    $('#program').value = first.program;
    await loadProgram(first.program, selection);
  }
  hashView.requestPin(undefined);
  writeAddress('replace');   // the address in its own form: defaults left out, `entry` turned into `fn`
}

// One handler for hashchange and popstate (a traversal fires both); an address that is already applied is skipped.
function onAddress() {
  queue = queue.then(() => (location.hash === applied ? undefined : applyAddress())).catch(fail);
  return queue;
}

async function main() {
  await init();
  state.index = (await (await fetch('data/index.json')).json()).map(withKind);
  for (const [kind, id] of USES) $('#' + id).disabled = !state.index.some((e) => e.kind === kind);   // an index without that kind
  listKind('compilers');
  await applyAddress();

  // Choosing a use lists the programs of that kind and shows the first of them at once; like choosing a program, it
  // adds a history entry. The address names the program, which is how it carries the choice.
  for (const [kind, id] of USES) {
    $('#' + id).addEventListener('change', async () => {
      if (!$('#' + id).checked) return;
      $('#summary').classList.remove('error');
      const first = firstOf(kind);
      if (!first) return;
      listKind(kind);
      $('#program').value = first.program;
      noteSwitch(first.program);
      await loadProgram(first.program, undefined);
      writeAddress('push');
    });
  }

  // Choosing a program, an example or a function adds a history entry; every other control changes the current one.
  $('#program').addEventListener('change', async () => {
    $('#summary').classList.remove('error');
    if ($('#program').value === '__files__') { await recompute(); writeAddress('replace'); return; }
    noteSwitch($('#program').value);
    await loadProgram($('#program').value, undefined);
    writeAddress('push');
  });
  $('#file-left').addEventListener('change', () => { $('#compare-files').disabled = !($('#file-left').files[0] && $('#file-right').files[0]); });
  $('#file-right').addEventListener('change', () => { $('#compare-files').disabled = !($('#file-left').files[0] && $('#file-right').files[0]); });
  $('#compare-files').addEventListener('click', loadFiles);
  $('#similar').addEventListener('change', async () => {
    if (state.live) await recompute(currentSelection());
    writeAddress('replace');
  });
  $('#example').addEventListener('change', async () => {
    const name = $('#example').value.split(':')[0];
    if (name && await loadExample(name)) writeAddress('push');
  });
  $('#hand-go').addEventListener('click', pairByHand);
  $('#pair').addEventListener('change', () => {
    show(state.entries[Number($('#pair').value)]);
    writeAddress('push');
  });
  for (const [name] of FACETS) {
    $(`#f-${name}`).addEventListener('change', async (e) => {
      if (mask() === 0) { e.target.checked = true; return; }
      // Stored programs carry every facet combination; loaded files are compared again.
      if (state.live) await recompute(currentSelection());
      else fillEntries(currentSelection());
      writeAddress('replace');
    });
  }
  $('#onlychanged').addEventListener('change', () => { fillEntries(currentSelection()); writeAddress('replace'); });
  // The counts and the "only pairs that differ" list depend on the switch; nothing is compared again.
  $('#bindings').addEventListener('change', () => { fillEntries(currentSelection()); writeAddress('replace'); });
  for (const id of ['#dim', '#refs']) $(id).addEventListener('change', () => { setLayoutClasses(); writeAddress('replace'); });
  for (const id of ['#changes', '#align']) {
    $(id).addEventListener('change', () => { show(state.entries[Number($('#pair').value)]); writeAddress('replace'); });
  }
  $('#stack').addEventListener('change', () => {
    setLayoutClasses();
    panes.left.fit(); panes.right.fit();
    writeAddress('replace');
  });
  // `pushState` and `replaceState` fire neither event, so these run only when the address is changed from
  // outside: the back and forward buttons, a pasted link.
  window.addEventListener('hashchange', onAddress);
  window.addEventListener('popstate', onAddress);
  $('#fit').addEventListener('click', () => { panes.left.fit(); panes.right.fit(); });
  window.addEventListener('resize', () => { panes.left.fit(); panes.right.fit(); });

  // Hovering a node marks the node it was paired with on the other side.
  $('#main').addEventListener('mouseover', (e) => {
    document.querySelectorAll('.n.hl').forEach((n) => n.classList.remove('hl'));
    const node = e.target.closest('.n[data-m]');
    if (node) document.querySelectorAll(`.n[data-m="${node.dataset.m}"]`).forEach((n) => n.classList.add('hl'));
  });
}

main().catch((error) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="error">${String(error)}</div>`);
  console.error(error);
});
