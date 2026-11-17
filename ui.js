// Groups the hash graph view's bar into two <details> (Camera, Hash view options), folds the view's long
// legend into a <details>, and remembers which <details> of the page are open. hashgraph.js builds the bar
// and the legend when viewer.js loads, so this runs after it (see index.html). Without it the page works,
// with the hash view's controls in one flat bar.
const $ = (selector) => document.querySelector(selector);
const make = (tag, text) => Object.assign(document.createElement(tag), text ? { textContent: text } : {});

// A <details> with the given controls moved into it (a control inside a label moves with its label).
function group(id, title, ids, row) {
  const details = make('details'), body = make('div');
  details.id = id;
  body.className = row ? 'group row' : 'group';
  for (const control of ids) body.append($('#' + control).closest('label') || $('#' + control));
  details.append(make('summary', title), body);
  return details;
}

try {
  $('#hg-bar').append(
    group('g-camera', 'Camera', ['hg-front', 'hg-depth', 'hg-iso', 'hg-yaw', 'hg-tilt', 'hg-spread', 'hg-hint'], true),
    group('g-hash', 'Hash view options', ['hg-colour', 'hg-paths', 'hg-arcs', 'hg-uniform']),
  );
  const how = make('details'), legend = $('#hg-legend');
  how.id = 'g-how';
  legend.before(how);
  how.append(make('summary', 'How to read this view'), legend);
} catch (error) {
  console.error('ui.js: the hash view controls stay in one bar:', error);
}

// Closed by default, with two exceptions. From 1000 px wide (where the controls stand in a column at the side) the
// groups that are used most start open: Layout options and, in the hash view, Camera and Hash view options. And a
// group that the page itself made open (the record of a pinned node) stays open until the reader closes it. The
// reader's choice is kept in the browser, if it allows, and wins over both.
let open = {};
try { open = JSON.parse(localStorage.getItem('hullview.open')) || {}; } catch { /* no storage: all closed */ }
let wide = false;
try { wide = matchMedia('(min-width: 1000px)').matches; } catch { /* no media queries: the narrow layout */ }
const OPEN_WIDE = ['g-layout', 'g-camera', 'g-hash'];
// A group opened here fires a toggle event of its own; that is not the reader's choice and is not kept.
const scripted = new Set();
for (const details of document.querySelectorAll('details[id]')) {
  const want = details.id in open ? open[details.id] === true : details.open || (wide && OPEN_WIDE.includes(details.id));
  if (details.open !== want) { scripted.add(details.id); details.open = want; }
  details.addEventListener('toggle', () => {
    if (scripted.delete(details.id)) return;
    open[details.id] = details.open;
    try { localStorage.setItem('hullview.open', JSON.stringify(open)); } catch { /* not kept */ }
  });
}
