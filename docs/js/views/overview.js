// Overview: a read-only table comparing all characters, ported from templates/overview.html
// and _fetch_overview in trophy/alive_hooks.py. Computed from the local copy of the data,
// so it updates live like every other page.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { bySlot } from '../data.js';
import { markdown, markdownInline } from '../ui.js';
import { burdenOf, sortedCharacters, HOARD_MAX } from './characters.js';

const pair = (...parts) => { const v = parts.map(p => String(p ?? '').trim()).filter(Boolean); return v.length ? v.join(' · ') : '—'; };
const scalar = v => String(v ?? '').trim() || '—';
const names = rows => rows.map(r => r.name.trim()).filter(Boolean);
const list = items => items.length
  ? html`<ul class="ov-list">${items.map(i => html`<li>${markdownInline(i)}</li>`)}</ul>` : '—';
const md = text => text && text.trim() ? html`<div class="prose ov-md">${markdown(text)}</div>` : '—';

// Per-viewer: which column groups are collapsed (remembered in this browser).
const hiddenKey = g => 'trophy-ov-hide-' + g;
const isHidden = g => { try { return localStorage.getItem(hiddenKey(g)) === '1'; } catch (_) { return false; } };

export function overview(app) {
  const { data } = app;
  const all = sortedCharacters(data);
  const groups = [
    { key: 'players', title: 'Characters', chars: all.filter(c => !c.archived && !c.hireling) },
    { key: 'hirelings', title: 'Hirelings', chars: all.filter(c => !c.archived && c.hireling), toggle: true },
    { key: 'archived', title: 'Archived', chars: all.filter(c => c.archived), toggle: true },
  ].filter(g => g.chars.length);
  const shown = groups.filter(g => !(g.toggle && isHidden(g.key)));

  const kids = (model, c, order) => data.childrenOf(model, c.id, order);
  const rows = [
    ['Player', c => scalar(c.player_name)],
    ['Occupation · Background', c => pair(c.occupation, c.background)],
    ['Look', c => scalar(c.look)],
    ['Ruin · Burden', c => `${c.ruin} · ${burdenOf(data, c)}`],
    ['Coin · Hunt Tokens', c => `${c.coin} · ${c.hunt_tokens}`],
    ['Skills', c => list(names(kids('skill', c)))],
    ['Powers', c => list(names(kids('power', c)))],
    ['Combat', c => list(names(kids('combatitem', c)))],
    ['Backpack', c => list(kids('backpackitem', c, bySlot).filter(b => b.name.trim())
      .map(b => b.uses ? `${b.name} (${b.uses})` : b.name))],
    ['Found', c => list(names(kids('foundequipment', c)))],
    ['Drive', c => md(c.drive)],
    ['Conditions', c => md(c.conditions)],
    ['Notes', c => md(c.notes)],
    ['Hoard', c => `${c.hoard} / ${HOARD_MAX}`],
    ['Household', c => list(names(kids('householdmember', c)))],
  ];

  const toggle = g => {
    try { localStorage.setItem(hiddenKey(g), isHidden(g) ? '0' : '1'); } catch (_) {}
    app.render();
  };
  // The first column of every group after the first gets a divider line.
  const cells = fn => shown.map((g, gi) => g.chars.map((c, i) => fn(c, gi && !i ? 'ov-divider' : '')));

  return html`
    <div class="page-head">
      <h1>Overview</h1>
      <div class="head-actions">
        ${groups.filter(g => g.toggle).map(g => html`
          <button class="btn btn-xs ${isHidden(g.key) ? 'btn-outline' : ''}" @click=${() => toggle(g.key)}
            aria-pressed=${!isHidden(g.key)}>${g.title} ${isHidden(g.key) ? '▸' : '▾'}</button>`)}
      </div>
    </div>
    ${!all.length ? html`<div class="empty">No characters yet.</div>` : html`
    <div class="ov-wrap">
      <table class="ov">
        <thead>
          <tr>
            <th class="ov-corner" rowspan="2">Field</th>
            ${shown.map((g, gi) => html`<th class="ov-group ${gi ? 'ov-divider' : ''}" colspan=${g.chars.length}>${g.title}</th>`)}
          </tr>
          <tr class="ov-names">
            ${cells((c, cls) => html`<th class="ov-name ${cls}">
              <a href=${app.href({ view: 'character', id: c.id, from: 'overview' })} @click=${app.link}>
                ${c.name.trim() || 'Unnamed'}${c.gender.trim() ? ' · ' + c.gender.trim() : nothing} ▸</a></th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(([label, fn]) => html`<tr>
            <th class="ov-rowhead">${label}</th>
            ${cells((c, cls) => html`<td class=${cls}>${fn(c)}</td>`)}
          </tr>`)}
        </tbody>
      </table>
    </div>`}`;
}
