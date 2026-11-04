// Equipment tables, ported from templates/equipment.html and the equipment part of
// trophy/alive_hooks.py. Rolls 2d6 on the Markdown tables in lists/. Like the Django app,
// each viewer's rolls are their own (not shared); they are kept for this browser tab.
import { html } from '../../vendor/lit-html/lit-html.js';
import { spin, dieSvg, toast } from '../ui.js';
import { loadTables, rollOn, tableResult } from '../lists.js';

const ROLLS_KEY = 'trophy-equipment-rolls';

let tables = null; // [{key, title, rows}]
let rolls = (() => { try { return JSON.parse(sessionStorage.getItem(ROLLS_KEY) || '{}'); } catch (_) { return {}; } })();

function load(app) {
  loadTables().then(list => { tables = list; app.render(); })
    .catch(() => { toast('Could not load the equipment tables.'); });
}

export function equipment(app) {
  if (!tables) load(app);
  const doRoll = t => {
    const { d1, d2, row } = rollOn(t);
    rolls = { ...rolls, [t.key]: { d1, d2, result: tableResult(row), n: (rolls[t.key]?.n || 0) + 1 } };
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
