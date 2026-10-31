// Equipment tables, ported from templates/equipment.html and the equipment part of
// trophy/alive_hooks.py. Rolls 2d6 on the Markdown tables in lists/. Like the Django app,
// each viewer's rolls are their own (not shared); they are kept for this browser tab.
import { html } from '../../vendor/lit-html/lit-html.js';
import { spin, dieSvg, toast, random, rollD6 } from '../ui.js';

// GitHub Pages cannot list a folder, so the tables are named here, in display order.
const TABLES = ['expedition_items', 'weaponry', 'backpack_items'];
const ROLLS_KEY = 'trophy-equipment-rolls';

let tables = null; // [{key, title, rows: [{d1, lo, hi, range, items}]}]
let loading = null;
let rolls = (() => { try { return JSON.parse(sessionStorage.getItem(ROLLS_KEY) || '{}'); } catch (_) { return {}; } })();

// One table file: the first heading is the title; rows are "| d1 | d2 or lo–hi | item | item ... |".
export function parseTable(text, fallbackTitle) {
  let title = fallbackTitle, gotTitle = false;
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!gotTitle && s.startsWith('#')) { title = s.replace(/^#+/, '').trim(); gotTitle = true; continue; }
    if (!s.startsWith('|')) continue;
    const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 3) continue;
    const d1 = parseInt(cells[0], 10);
    if (!/^\d+$/.test(cells[0])) continue; // header or separator row
    const d2 = cells[1].replace(/[–—]/g, '-');
    let lo, hi, range = false;
    if (d2.includes('-')) {
      const [a, b] = d2.split('-', 2).map(x => x.trim());
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) continue;
      lo = +a; hi = +b; range = true;
    } else {
      if (!/^\d+$/.test(d2)) continue;
      lo = hi = +d2;
    }
    rows.push({ d1, lo, hi, range, items: cells.slice(2).filter(Boolean) });
  }
  return { title, rows };
}

const pick = list => list[Math.floor(random() * list.length)];

// Roll 2d6 and resolve once. Range tables (Expedition Items) give a set of items: show all.
// Exact tables give one item: the only one, or a random column.
function rollOn(table) {
  const d1 = rollD6(), d2 = rollD6();
  const row = table.rows.find(r => r.d1 === d1 && r.lo <= d2 && d2 <= r.hi);
  const result = !row || !row.items.length ? '—' : row.range ? row.items.join(' · ') : pick(row.items);
  return { d1, d2, result, n: (rolls[table.key]?.n || 0) + 1 };
}

function load(app) {
  loading ||= Promise.all(TABLES.map(async key => {
    const r = await fetch(`lists/${key}.md`);
    if (!r.ok) throw new Error(key);
    const t = parseTable(await r.text(), key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    return { key, ...t };
  })).then(list => { tables = list.filter(t => t.rows.length); app.render(); })
    .catch(() => { loading = null; toast('Could not load the equipment tables.'); app.render(); });
}

export function equipment(app) {
  if (!tables) load(app);
  const doRoll = t => {
    rolls = { ...rolls, [t.key]: rollOn(t) };
    try { sessionStorage.setItem(ROLLS_KEY, JSON.stringify(rolls)); } catch (_) {}
    app.render();
  };
  return html`
    <div class="page narrow">
      <h1 class="page-title">Equipment</h1>
      <div class="eq-rows">
        ${!tables ? html`<div class="hint-text">Loading tables…</div>` : !tables.length
          ? html`<div class="hint-text">No equipment lists found.</div>`
          : tables.map(t => {
            const r = rolls[t.key];
            return html`<div class="eq-row">
              <button class="btn btn-sm btn-primary" @click=${() => doRoll(t)}>Roll</button>
              <span class="die" ${spin(r ? `${r.d1}:${r.n}` : null)}>${dieSvg('light', r?.d1)}</span>
              <span class="die" ${spin(r ? `${r.d2}:${r.n}` : null)}>${dieSvg('light', r?.d2)}</span>
              <div class="eq-text"><span class="eq-title">${t.title}</span>${r ? html`<span class="dim-text"> — </span><span>${r.result}</span>` : ''}</div>
            </div>`;
          })}
      </div>
    </div>`;
}
