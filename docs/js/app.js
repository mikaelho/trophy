// Trophy client: boots the connection, routes between pages and draws the frame.
//
// Page address: index.html?relay=RELAY-ADDRESS&room=ROOM#key=SECRET
// Pages are chosen with ?view=...&id=...; relay, room and the #key are kept on every link.
import { html, render, nothing } from '../vendor/lit-html/lit-html.js';
import { relayConfig } from './transport.js';
import { Data } from './data.js';
import { installKeys, toast, attempt } from './ui.js';
import { characterList, characterSheet } from './views/characters.js';

const root = document.getElementById('app');
const SAVED = 'trophy-relay';
const ROUTE_KEYS = ['view', 'id'];

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
    return { view: q.get('view') || '', id: q.get('id') ? Number(q.get('id')) : null };
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
    if (!app.descriptors) {
      try {
        const text = await (await fetch('lists/character_descriptors.md')).text();
        app.descriptors = text.split('\n').map(s => s.trim())
          .filter(s => s && !/^-+$/.test(s) && s !== s.toUpperCase());
      } catch (_) { toast('Could not load the descriptor list.'); return ''; }
    }
    const d = app.descriptors;
    return d.length ? d[Math.floor(Math.random() * d.length)] : '';
  },
};
addEventListener('popstate', () => { app.editing = null; app.render(); });

// --- export / import ------------------------------------------------------------------
async function exportData() {
  const dump = await attempt(app.data.exportDump());
  if (!dump) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `trophy-${cfg.room}-${stamp}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let dump;
    try { dump = JSON.parse(await file.text()); } catch (_) { return toast('That file is not valid JSON.'); }
    if (!confirm(`Replace ALL game data in room "${cfg.room}" with "${file.name}"? This affects everyone in the room.`)) return;
    const r = await attempt(app.data.importDump(dump));
    if (r) { toast(`Loaded ${r.count} rows.`); app.nav({}); }
  };
  input.click();
}

// --- drawing --------------------------------------------------------------------------
function page() {
  const { view, id } = app.route();
  if (view === 'character' && id) return characterSheet(app, id);
  return characterList(app);
}

const statusText = { connecting: 'Connecting…', live: 'Connected', offline: 'Reconnecting…' };

function frame(content) {
  const d = app.data;
  return html`
    <header class="topbar">
      <a class="brand" href=${app.href({})} @click=${app.link}>Trophy</a>
      <nav><a href=${app.href({})} @click=${app.link}>Characters</a></nav>
      <div class="spacer"></div>
      <span class="status ${d.status}" title=${statusText[d.status]}><span class="dot"></span><span class="label">${statusText[d.status]}</span></span>
      <details class="menu">
        <summary class="btn btn-ghost btn-sm">⋯</summary>
        <div class="menu-body" @click=${e => e.currentTarget.parentElement.removeAttribute('open')}>
          <button class="btn btn-ghost btn-sm" @click=${exportData} ?disabled=${d.status !== 'live'}>Export data…</button>
          <button class="btn btn-ghost btn-sm" @click=${importData} ?disabled=${d.status !== 'live'}>Import data…</button>
          <button class="btn btn-ghost btn-sm" @click=${cycleTheme}>Theme: ${theme}</button>
          <div class="menu-note">Room: ${cfg.room}</div>
        </div>
      </details>
    </header>
    ${d.status === 'offline' ? html`<div class="banner">Connection lost — reconnecting. Changes can't be saved until then.</div>` : nothing}
    <main class="container">${content}</main>
    <div id="toast" class="toast" hidden></div>`;
}

function draw() {
  if (!cfg) return render(setupPage(), root);
  const d = app.data;
  if (!d.ready) {
    render(frame(html`<div class="empty"><p class="big">${statusText[d.status]}</p></div>`), root);
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
if (cfg) {
  app.data = new Data(cfg);
  app.data.subscribe(() => app.render());
}
draw();
