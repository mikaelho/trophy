// People: supporting characters (a GM page). "Generate" adds one with three random
// descriptors (Look) and three random pieces of equipment, one roll on each equipment table,
// both as comma-separated lists; everything can then be edited freely, and the die buttons add
// one more descriptor or piece of equipment. Fields lock while someone edits them, like on the
// character sheet. Closed cards show name and title; which are open is each viewer's own.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { attempt, toast, dieIcon } from '../ui.js';
import { compareIds } from '../model/rules.js';
import { randomDescriptors, randomEquipment, randomDescriptor, randomEquipmentItem } from '../lists.js';
import { fieldsFor, OpenCards, cardHeader, matches, searchBox } from './records.js';

const open = new OpenCards('people');
let search = ''; // per viewer, for this tab

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
  const shownPeople = all.filter(p => matches(search, [p.name, p.title, p.location, p.look, p.equipment, p.description]));
  const act = (op, args) => attempt(data.op(op, args)).finally(() => app.render());

  const add = async () => {
    const [look, equipment] = await Promise.all([generated('look'), generated('equipment')]);
    if (look == null || equipment == null) return;
    search = '';
    const r = await act('person_add', { look, equipment });
    if (r) { open.set(r.id, true); app.focus(`.person-box[data-id="${r.id}"] [data-field=name]`); app.render(); }
  };

  const card = p => {
    const f = fieldsFor(data, { kind: 'person', row: p, op: 'person_save' });
    const isOpen = open.has(p.id);
    const addOne = field => html`<button class="btn btn-ghost btn-xs" ?disabled=${f.locked(field)}
      title=${field === 'look' ? 'Add a random descriptor' : 'Add a random piece of equipment'}
      @click=${async () => { const v = await oneMore(field); if (v) attempt(data.op('person_append', { id: p.id, field, value: v })); }}>${dieIcon}</button>`;
    const header = cardHeader(isOpen, f.shown('name').trim() || html`<span class="placeholder">Unnamed</span>`,
      f.shown('title').trim(), () => { open.toggle(p.id); app.render(); });

    return html`<div class="person-box record ${isOpen ? 'open' : ''}" data-id=${p.id}>
      ${header}
      ${isOpen ? html`<div class="record-body">
        <div class="person-top">
          <div class="grow"><div class="field-label">Name</div>${f.input('name')}</div>
          <div class="grow2"><div class="field-label">Title</div>${f.input('title', 'short description')}</div>
          <button class="btn btn-ghost btn-xs text-error" title="Remove"
            @click=${() => act('person_remove', { id: p.id })}>&times;</button>
        </div>
        <div class="field-label">Location</div>${f.input('location')}
        <div class="card-head center"><div class="field-label">Look</div>${addOne('look')}</div>
        ${f.input('look')}
        <div class="card-head center"><div class="field-label">Equipment</div>${addOne('equipment')}</div>
        ${f.input('equipment')}
        <div class="field-label">Description</div>${f.textarea('description', 2)}
      </div>` : nothing}
    </div>`;
  };

  return html`
    <div class="page medium">
      <div class="page-head tight">
        <h1>People</h1>
        <div class="head-actions">
          ${all.length > 1 ? searchBox(search, v => { search = v; app.render(); }) : nothing}
          <button class="btn btn-primary btn-sm" @click=${add}>+ Generate</button>
        </div>
      </div>
      <div class="people records">
        ${!all.length ? html`<div class="hint-text">No one yet. Generate a person to get started.</div>`
          : !shownPeople.length ? html`<div class="hint-text">No one matches the search.</div>`
          : repeat(shownPeople, p => p.id, card)}
      </div>
    </div>`;
}
