// The word lists and d6/d6 tables in lists/ (copies of trophy/lists/), loaded once and shared
// by the character sheet (Look descriptors), the Equipment page and the People page.
import { random, rollD6 } from './ui.js';

// GitHub Pages cannot list a folder, so the tables are named here, in display order.
export const TABLES = ['expedition_items', 'weaponry', 'backpack_items'];

const pick = list => list[Math.floor(random() * list.length)];
const once = fn => { let p = null; return () => (p ||= fn().catch(e => { p = null; throw e; })); };
const fetchText = async path => { const r = await fetch(path); if (!r.ok) throw new Error(path); return r.text(); };

// One table file: the first heading is the title; rows are "| d1 | d2 or lo–hi | item | item ... |".
export function parseTable(text, fallbackTitle) {
  let title = fallbackTitle, gotTitle = false;
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!gotTitle && s.startsWith('#')) { title = s.replace(/^#+/, '').trim(); gotTitle = true; continue; }
    if (!s.startsWith('|')) continue;
    const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 3 || !/^\d+$/.test(cells[0])) continue; // header or separator row
    const d1 = +cells[0], d2 = cells[1].replace(/[–—]/g, '-');
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

// [{key, title, rows}] for every table that has rows.
export const loadTables = once(async () => {
  const list = await Promise.all(TABLES.map(async key => ({
    key, ...parseTable(await fetchText(`lists/${key}.md`), key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
  })));
  return list.filter(t => t.rows.length);
});

// Every descriptor word (LOOK, SOUND and SMELL sections alike).
export const loadDescriptors = once(async () =>
  (await fetchText('lists/character_descriptors.md')).split('\n').map(s => s.trim())
    .filter(s => s && !/^-+$/.test(s) && s !== s.toUpperCase()));

// Roll 2d6 on a table: {d1, d2, row}.
export function rollOn(table) {
  const d1 = rollD6(), d2 = rollD6();
  return { d1, d2, row: table.rows.find(r => r.d1 === d1 && r.lo <= d2 && d2 <= r.hi) || null };
}
// The result shown on the Equipment page: a range row (Expedition Items) gives its whole set,
// an exact row one item (the only one, or a random column).
export const tableResult = row => (!row || !row.items.length ? '—' : row.range ? row.items.join(' · ') : pick(row.items));

// n different descriptors, e.g. "Gaunt, raspy, smoky".
export async function randomDescriptors(n = 3) {
  const pool = [...new Set(await loadDescriptors())];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  const text = out.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One random descriptor (the character sheet's Look button adds one at a time).
export async function randomDescriptor() { return pick(await loadDescriptors()); }

// One piece of equipment: a roll on a random table, one item from the row.
export async function randomEquipmentItem() {
  const tables = await loadTables();
  for (let i = 0; i < 20; i++) {
    const { row } = rollOn(pick(tables));
    if (row && row.items.length) return pick(row.items);
  }
  return '';
}

// Three pieces of equipment: one roll on each table, one item from the row each time.
export async function randomEquipment() {
  const tables = await loadTables();
  return tables.map(t => { const { row } = rollOn(t); return row && row.items.length ? pick(row.items) : null; })
    .filter(Boolean);
}
