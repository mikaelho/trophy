// People: supporting characters (a GM page). "Generate" adds one with three random
// descriptors (Look) and three random pieces of equipment, one roll on each equipment table,
// both as comma-separated lists; everything can then be edited freely, and the die buttons add
// one more descriptor or piece of equipment. Fields lock while someone edits them, like on the
// character sheet.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { editValue, attempt, toast, dieIcon } from '../ui.js';
import { compareIds } from '../model/rules.js';
import { randomDescriptors, randomEquipment, randomDescriptor, randomEquipmentItem } from '../lists.js';

const LOCKED_TITLE = 'Someone is editing this';
let filter = ''; // per viewer, for this tab

// Three of each for a new person; one at a time from the die buttons.
const generated = async what => {
  try { return what === 'look' ? await randomDescriptors(3) : (await randomEquipment()).join(', '); }
  catch (_) { toast('Could not load the lists to generate from.'); return null; }
};
const oneMore = async what => {
  try { return what === 'look' ? await randomDescriptor() : await randomEquipmentItem(); }
  catch (_) { toast('Could not load the lists to generate from.'); return null; }
};

export function people(app) {
  const { data } = app;
  const all = [...data.all('person')].sort((a, b) => b.position - a.position || compareIds(b.id, a.id)); // newest first
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shownPeople = words.length
    ? all.filter(p => { const t = [p.name, p.title, p.location].join(' ').toLowerCase(); return words.every(w => t.includes(w)); })
    : all;
  const act = (op, args) => attempt(data.op(op, args)).finally(() => app.render());

  const add = async () => {
    const [look, equipment] = await Promise.all([generated('look'), generated('equipment')]);
    if (look == null || equipment == null) return;
    filter = '';
    act('person_add', { look, equipment });
  };

  const card = p => {
    const key = f => `person:${p.id}:${f}`;
    const locked = f => data.lockedByOther(key(f));
    const shown = f => data.queued('person_save', { id: p.id, field: f }, 'value') ?? p[f] ?? '';
    // Leaving a field saves it when changed (through the outbox) and frees its lock.
    const attrs = f => ({
      cls: locked(f) ? 'locked-field' : '', disabled: locked(f), title: locked(f) ? LOCKED_TITLE : nothing,
      value: editValue(shown(f)),
      focus: () => data.lock(key(f)),
      blur: e => {
        if (e.target.value.trim() === String(shown(f)).trim()) { data.unlock(key(f)); e.target.value = e.target.defaultValue; return; }
        data.edit('person_save', { id: p.id, field: f, value: e.target.value }, key(f));
      },
    });
    const input = (f, placeholder = '') => { const a = attrs(f); return html`
      <input class="input ${a.cls}" data-edit autocomplete="off" placeholder=${placeholder || nothing}
        .value=${a.value} ?disabled=${a.disabled} title=${a.title} @focus=${a.focus} @blur=${a.blur} />`; };
    const textarea = (f, rows, placeholder = '') => { const a = attrs(f); return html`
      <textarea class="textarea ${a.cls}" rows=${rows} data-edit placeholder=${placeholder || nothing}
        .value=${a.value} ?disabled=${a.disabled} title=${a.title} @focus=${a.focus} @blur=${a.blur}></textarea>`; };
    const addOne = f => html`<button class="btn btn-ghost btn-xs" ?disabled=${locked(f)}
      title=${f === 'look' ? 'Add a random descriptor' : 'Add a random piece of equipment'}
      @click=${async () => { const v = await oneMore(f); if (v) attempt(data.op('person_append', { id: p.id, field: f, value: v })); }}>${dieIcon}</button>`;

    return html`<div class="person-box">
      <div class="person-top">
        <div class="grow"><div class="field-label">Name</div>${input('name')}</div>
        <div class="grow2"><div class="field-label">Title</div>${input('title', 'short description')}</div>
        <button class="btn btn-ghost btn-xs text-error" title="Remove"
          @click=${() => { if (confirm(`Remove ${p.name.trim() || 'this person'}?`)) act('person_remove', { id: p.id }); }}>&times;</button>
      </div>
      <div class="field-label">Location</div>${input('location')}
      <div class="card-head center"><div class="field-label">Look</div>${addOne('look')}</div>
      ${input('look')}
      <div class="card-head center"><div class="field-label">Equipment</div>${addOne('equipment')}</div>
      ${input('equipment')}
      <div class="field-label">Description</div>${textarea('description', 2)}
    </div>`;
  };

  return html`
    <div class="page medium">
      <div class="page-head tight">
        <h1>People</h1>
        <div class="head-actions">
          ${all.length > 1 ? html`<input class="input input-sm people-filter" type="search" placeholder="Filter"
            .value=${filter} @input=${e => { filter = e.target.value; app.render(); }} />` : nothing}
          <button class="btn btn-primary btn-sm" @click=${add}>+ Generate</button>
        </div>
      </div>
      <div class="people">
        ${!all.length ? html`<div class="hint-text">No one yet. Generate a person to get started.</div>`
          : !shownPeople.length ? html`<div class="hint-text">No one matches the filter.</div>`
          : repeat(shownPeople, p => p.id, card)}
      </div>
    </div>`;
}
