// Trophy client: boots the connection, routes between pages and draws the frame.
//
// Page address: index.html?relay=RELAY-ADDRESS&room=ROOM#key=SECRET
// Pages are chosen with ?view=...&id=...; relay, room and the #key are kept on every link.
import { html, render, nothing } from '../vendor/lit-html/lit-html.js';
import { relayConfig } from './transport.js';
import { Data } from './data.js';
import { installKeys, toast, attempt } from './ui.js';
import { fromDjangoDump } from './model/migrations.js';
import { randomDescriptor } from './lists.js';
import { characterList, characterSheet } from './views/characters.js';
import { overview } from './views/overview.js';
import { roller } from './views/roller.js';
import { bestiary } from './views/bestiary.js';
import { equipment } from './views/equipment.js';
import { people } from './views/people.js';

const root = document.getElementById('app');
const SAVED = 'trophy-relay';
const ROUTE_KEYS = ['view', 'id', 'from'];

// --- relay settings: from the address, else from the last visit ---------------------
let cfg = relayConfig();
if (cfg) {
  try { localStorage.setItem(SAVED, JSON.stringify({ search: relaySearch(), hash: location.hash })); } catch (_) {}
} else {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) || 'null');
    if (saved) {
      const q = new URLSearchParams(saved.search);
      for (const k of ROUTE_KEYS) { const v = new URLSearchParams(location.search).get(k); if (v) q.set(k, v); }
      history.replaceState(null, '', '?' + q + saved.hash);
      cfg = relayConfig();
    }
  } catch (_) {}
}
function relaySearch() {
  const q = new URLSearchParams(location.search);
  for (const k of ROUTE_KEYS) q.delete(k);
  return q.toString();
}

// --- theme ----------------------------------------------------------------------------
const THEME = 'trophy-theme';
const applyTheme = t => {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
};
let theme = (() => { try { return localStorage.getItem(THEME) || 'auto'; } catch (_) { return 'auto'; } })();
applyTheme(theme);
// GM mode: shows the GM's pages (Overview, Equipment, People). A setting of this browser only.
const GM = 'trophy-gm';
let gm = (() => { try { return localStorage.getItem(GM) === '1'; } catch (_) { return false; } })();
const toggleGm = () => {
  gm = !gm;
  try { localStorage.setItem(GM, gm ? '1' : '0'); } catch (_) {}
  if (!gm && GM_VIEWS.has(app.route().view)) app.nav({}); else app.render();
};
const GM_VIEWS = new Set(['overview', 'equipment', 'people']);

const cycleTheme = () => {
  theme = { auto: 'light', light: 'dark', dark: 'auto' }[theme] || 'auto';
  try { localStorage.setItem(THEME, theme); } catch (_) {}
  applyTheme(theme); app.render();
};

// --- app state shared with the views --------------------------------------------------
const app = {
  data: null,
  editing: null,       // lock key of the markdown note being edited in this browser
  focusAfter: null,    // selector to focus after the next render
  route() {
    const q = new URLSearchParams(location.search);
    return { view: q.get('view') || '', id: q.get('id') || null, from: q.get('from') || '' };
  },
  href(route) {
    const q = new URLSearchParams(relaySearch());
    for (const k of ROUTE_KEYS) if (route[k] != null && route[k] !== '') q.set(k, route[k]);
    const s = q.toString();
    return location.pathname + (s ? '?' + s : '') + location.hash;
  },
  nav(route) {
    history.pushState(null, '', app.href(route));
    app.editing = null; scrollTo(0, 0); app.render();
  },
  // Click handler for in-app links: navigate without reloading (keep modifier-clicks as is).
  link(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(null, '', e.currentTarget.getAttribute('href'));
    app.editing = null; scrollTo(0, 0); app.render();
  },
  focus(sel) { app.focusAfter = sel; },
  render() {
    if (app.queued) return;
    app.queued = true;
    requestAnimationFrame(() => { app.queued = false; draw(); });
  },
  // One random descriptor from lists/character_descriptors.md (any section).
  async randomDescriptor() {
    try { return await randomDescriptor(); } catch (_) { toast('Could not load the descriptor list.'); return ''; }
  },
};
app.isGm = () => gm;
addEventListener('popstate', () => { app.editing = null; app.render(); });

// --- export / import / backups ---------------------------------------------------------
// Exports are meant for version control: always the same file name, no time stamp inside,
// and object keys sorted, so exporting unchanged data gives an identical file and a diff
// shows only what really changed.
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;

async function exportData() {
  const data = await attempt(app.data.exportData());
  if (!data) return;
  const { exportedAt, ...rest } = data; // the relay adds a time stamp; leave it out
  const text = JSON.stringify(sortKeys(rest), null, 2) + '\n';
  const blob = new Blob([text], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `trophy-${cfg.room}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A file to import: an export of this page ({format: 'trophy-docs', dataVersion, docs}), or a
// Django dump (dumpdata of the Django app, or an export of the previous relay version).
function readImport(json) {
  if (Array.isArray(json)) return { dataVersion: 1, docs: fromDjangoDump(json), kind: 'Django dump' };
  if (json && json.format === 'trophy-docs' && json.docs && typeof json.docs === 'object') {
    return { dataVersion: Number(json.dataVersion), docs: json.docs, kind: 'Trophy export' };
  }
  throw new Error('This is not a Trophy export or a Django dump.');
}

function importData() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let found;
    try { found = readImport(JSON.parse(await file.text())); } catch (e) { return toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message); }
    const n = kind => Object.keys(found.docs).filter(k => k.startsWith(kind + '/')).length;
    if (!confirm(`Replace ALL game data in room "${cfg.room}" with "${file.name}" (${found.kind}: ${n('character')} characters, ${n('monster')} monsters)?\n\nThis affects everyone in the room. The current data is kept as a backup.`)) return;
    const r = await attempt(app.data.importDocs(found.dataVersion, found.docs));
    if (r) { toast(`Loaded ${r.count} records.`); app.nav({}); }
  };
  input.click();
}

// Backups the relay keeps before every upgrade, import and restore (the last 10).
let backups = null;
async function loadBackups() {
  backups = await attempt(app.data.listBackups()) || [];
  app.render();
}
function backupsPage() {
  if (!backups) { loadBackups(); return html`<div class="hint-text">Loading backups…</div>`; }
  const restore = async b => {
    if (!confirm(`Replace ALL game data in room "${cfg.room}" with the backup from ${new Date(b.at).toLocaleString()}?\n\nThe current data is kept as a backup too.`)) return;
    if (await attempt(app.data.restoreBackup(b.id))) { toast('Backup restored.'); backups = null; app.nav({}); }
  };
  return html`<div class="page narrow">
    <h1 class="page-title">Backups</h1>
    <p class="dim-text backups-intro">The relay keeps the game data as it was before each upgrade, import and restore (the last 10).
      Restoring one keeps the current data as a backup too. Use Export for copies of your own.</p>
    ${backups.length ? html`<div class="eq-rows">${backups.map(b => html`<div class="eq-row">
      <div class="eq-text"><span class="eq-title">${new Date(b.at).toLocaleString()}</span>
        <span class="dim-text"> — ${b.reason} · ${(b.size / 1024).toFixed(1)} KB</span></div>
      <button class="btn btn-sm" @click=${() => restore(b)}>Restore</button>
    </div>`)}</div>` : html`<div class="hint-text">No backups yet.</div>`}
  </div>`;
}

// --- drawing --------------------------------------------------------------------------
function page() {
  const { view, id } = app.route();
  if (view === 'character' && id) return characterSheet(app, id);
  if (view === 'overview' && gm) return overview(app);
  if (view === 'roller') return roller(app);
  if (view === 'bestiary') return bestiary(app);
  if (view === 'people' && gm) return people(app);
  if (view === 'equipment' && gm) return equipment(app);
  if (view === 'backups') return backupsPage();
  return characterList(app);
}

const NAV = [['', 'Characters'], ['overview', 'Overview'], ['roller', 'Roller'], ['bestiary', 'Bestiary'], ['people', 'People'], ['equipment', 'Equipment']];
const navView = () => { const { view } = app.route(); return view === 'character' || (GM_VIEWS.has(view) && !gm) ? '' : view; };

const statusText = { connecting: 'Connecting…', upgrading: 'Upgrading the game data…', live: 'Connected', offline: 'Reconnecting…', outdated: 'Update needed' };

function banner(d) {
  const waiting = d.outbox.length;
  const waitingText = waiting ? ` ${waiting} text ${waiting === 1 ? 'edit is' : 'edits are'} kept and will be sent when the connection is back.` : '';
  if (d.status === 'outdated') return html`<div class="banner error">${d.problem}
    <button class="btn btn-sm" @click=${() => location.reload()}>Reload</button></div>`;
  if (d.status === 'offline') return html`<div class="banner">Connection lost — reconnecting.${waitingText}
    ${d.problem ? html`<div class="banner-detail">${d.problem}</div>` : nothing}
    <button class="btn btn-sm" @click=${() => d.retry()}>Retry now</button></div>`;
  return nothing;
}

function frame(content) {
  const d = app.data;
  const label = d.status === 'live' && d.outbox.length ? 'Saving…' : statusText[d.status];
  return html`
    <header class="topbar">
      <a class="brand" href=${app.href({})} @click=${app.link}>Trophy</a>
      <nav>${NAV.filter(([view]) => gm || !GM_VIEWS.has(view)).map(([view, title]) => html`<a href=${app.href({ view })} @click=${app.link}
        class=${navView() === view ? 'active' : ''}>${title}</a>`)}</nav>
      <span class="undo-redo">
        <button class="btn btn-ghost btn-sm" title=${d.undoLabel ? `Undo: ${d.undoLabel} (${MOD}Z)` : 'Nothing to undo'}
          aria-label="Undo" ?disabled=${!d.undoLabel || d.reverting} @click=${() => d.undo()}>↶</button>
        <button class="btn btn-ghost btn-sm" title=${d.redoLabel ? `Redo: ${d.redoLabel} (${MOD}⇧Z)` : 'Nothing to redo'}
          aria-label="Redo" ?disabled=${!d.redoLabel || d.reverting} @click=${() => d.redo()}>↷</button>
      </span>
      <span class="status ${d.status}" title=${label}><span class="dot"></span><span class="label">${label}</span></span>
      <details class="menu">
        <summary class="btn btn-ghost btn-sm">⋯</summary>
        <div class="menu-body" @click=${e => e.currentTarget.parentElement.removeAttribute('open')}>
          <button class="btn btn-ghost btn-sm" @click=${exportData} ?disabled=${d.status !== 'live'}>Export data…</button>
          <button class="btn btn-ghost btn-sm" @click=${importData} ?disabled=${d.status !== 'live'}>Import data…</button>
          <button class="btn btn-ghost btn-sm" @click=${() => { backups = null; app.nav({ view: 'backups' }); }} ?disabled=${d.status !== 'live'}>Backups…</button>
          <button class="btn btn-ghost btn-sm" @click=${cycleTheme}>Theme: ${theme}</button>
          <button class="btn btn-ghost btn-sm gm-toggle" @click=${toggleGm} aria-pressed=${gm}>GM mode: ${gm ? 'on' : 'off'}</button>
          <div class="menu-note">Room: ${cfg.room}</div>
        </div>
      </details>
    </header>
    ${banner(d)}
    <main class="container ${app.route().view === 'overview' && gm ? 'wide' : ''}">${content}</main>
    <div id="toast" class="toast" hidden></div>`;
}

function draw() {
  if (!cfg) return render(setupPage(), root);
  const d = app.data;
  if (!d.ready) {
    render(frame(html`<div class="empty connecting">
      <p class="big">${statusText[d.status]}</p>
      ${d.problem ? html`<p class="problem">${d.problem}</p>` : nothing}
      ${d.status !== 'outdated' && d.problem ? html`<button class="btn btn-sm" @click=${() => d.retry()}>Retry now</button>` : nothing}
    </div>`), root);
  } else {
    render(frame(page()), root);
  }
  if (app.focusAfter) {
    const el = document.querySelector(app.focusAfter);
    app.focusAfter = null;
    if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
  }
}

function setupPage() {
  return html`<main class="container narrow-page">
    <h1>Trophy</h1>
    <p>This page needs the relay address and the shared secret in its address, like this:</p>
    <pre>${location.origin + location.pathname}?relay=trophy-relay.YOUR-NAME.workers.dev&room=YOUR-GAME#key=YOUR-SECRET</pre>
    <p>Ask the game master for the full link.</p>
  </main>`;
}

installKeys();
// Undo / redo of this tab's own changes: Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y. Inside a text
// field the keys keep doing the browser's own undo of the typing.
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
document.addEventListener('keydown', e => {
  if (!app.data || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea, select'))) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); app.data.undo(); }
  else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey)) { e.preventDefault(); app.data.redo(); }
});
if (cfg) {
  app.data = new Data(cfg);
  app.data.notice = (msg, { undo } = {}) => toast(msg, undo ? { action: { label: 'Undo', fn: () => app.data.undoStep(undo) } } : {});
  app.data.subscribe(() => app.render());
}
draw();
