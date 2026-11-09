// Building blocks for the GM's record lists (People, Notes): text fields that lock while
// someone edits them and save when left, cards that open and close, and search.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { editValue } from '../ui.js';

const LOCKED_TITLE = 'Someone is editing this';

// Fields of one record. `op` saves a field ({id, field, value}); saves go through the outbox,
// and the field shows a waiting save until it is confirmed. Lock keys: "<kind>:<id>:<field>".
export function fieldsFor(data, { kind, row, op }) {
  const key = f => `${kind}:${row.id}:${f}`;
  const locked = f => data.lockedByOther(key(f));
  const shown = f => data.queued(op, { id: row.id, field: f }, 'value') ?? row[f] ?? '';
  const attrs = f => ({
    cls: locked(f) ? 'locked-field' : '', disabled: locked(f), title: locked(f) ? LOCKED_TITLE : nothing,
    value: editValue(shown(f)),
    focus: () => data.lock(key(f)),
    blur: e => {
      if (e.target.value.trim() === String(shown(f)).trim()) { data.unlock(key(f)); e.target.value = e.target.defaultValue; return; }
      data.edit(op, { id: row.id, field: f, value: e.target.value }, key(f));
    },
  });
  return {
    locked, shown,
    input: (f, placeholder = '') => { const a = attrs(f); return html`
      <input class="input ${a.cls}" data-edit data-field=${f} autocomplete="off" placeholder=${placeholder || nothing}
        .value=${a.value} ?disabled=${a.disabled} title=${a.title} @focus=${a.focus} @blur=${a.blur} />`; },
    textarea: (f, rows, placeholder = '') => { const a = attrs(f); return html`
      <textarea class="textarea ${a.cls}" rows=${rows} data-edit data-field=${f} placeholder=${placeholder || nothing}
        .value=${a.value} ?disabled=${a.disabled} title=${a.title} @focus=${a.focus} @blur=${a.blur}></textarea>`; },
  };
}

// Which cards this viewer has open (kept for the tab, also over a reload).
export class OpenCards {
  constructor(name) {
    this.name = 'trophy-open-' + name;
    try { this.ids = new Set(JSON.parse(sessionStorage.getItem(this.name) || '[]')); } catch (_) { this.ids = new Set(); }
  }
  has(id) { return this.ids.has(id); }
  set(id, open) {
    open ? this.ids.add(id) : this.ids.delete(id);
    try { sessionStorage.setItem(this.name, JSON.stringify([...this.ids])); } catch (_) {}
  }
  toggle(id) { this.set(id, !this.has(id)); }
}

// The clickable top of a card: an arrow, the main text and a dimmer second text.
export const cardHeader = (open, main, sub, onToggle) => html`
  <button class="record-head" aria-expanded=${open} @click=${onToggle}>
    <span class="record-arrow">${open ? '▾' : '▸'}</span>
    <span class="record-main">${main}</span>
    ${sub ? html`<span class="record-sub">${sub}</span>` : nothing}
  </button>`;

// Search: every word must appear somewhere in the given texts (case does not matter).
export function matches(query, texts) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = texts.map(x => String(x ?? '')).join(' ').toLowerCase();
  return words.every(w => t.includes(w));
}

export const searchBox = (value, onInput) => html`
  <input class="input input-sm record-search" type="search" placeholder="Search" aria-label="Search"
    .value=${value} @input=${e => onInput(e.target.value)} />`;
