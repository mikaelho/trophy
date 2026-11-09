// Notes: the GM's notes, each a title and a description, with search over both. Closed cards
// show only the title; which are open is each viewer's own.
// Fields lock while someone edits them, like on the character sheet.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { attempt } from '../ui.js';
import { compareIds } from '../model/rules.js';
import { fieldsFor, OpenCards, cardHeader, matches, searchBox } from './records.js';

const open = new OpenCards('notes');
let search = ''; // per viewer, for this tab

export function notes(app) {
  const { data } = app;
  const all = [...data.all('note')].sort((a, b) => b.position - a.position || compareIds(b.id, a.id)); // newest first
  const shownNotes = all.filter(n => matches(search, [n.title, n.description]));
  const act = (op, args) => attempt(data.op(op, args)).finally(() => app.render());

  const add = async () => {
    search = '';
    const r = await act('note_add');
    if (r) { open.set(r.id, true); app.focus(`.note-box[data-id="${r.id}"] [data-field=title]`); app.render(); }
  };

  const card = n => {
    const f = fieldsFor(data, { kind: 'note', row: n, op: 'note_save' });
    const isOpen = open.has(n.id);
    const header = cardHeader(isOpen, f.shown('title').trim() || html`<span class="placeholder">Untitled</span>`,
      '', () => { open.toggle(n.id); app.render(); });
    return html`<div class="note-box record ${isOpen ? 'open' : ''}" data-id=${n.id}>
      ${header}
      ${isOpen ? html`<div class="record-body">
        <div class="person-top">
          <div class="grow"><div class="field-label">Title</div>${f.input('title')}</div>
          <button class="btn btn-ghost btn-xs text-error" title="Remove"
            @click=${() => act('note_remove', { id: n.id })}>&times;</button>
        </div>
        <div class="field-label">Description</div>${f.textarea('description', 4)}
      </div>` : nothing}
    </div>`;
  };

  return html`
    <div class="page medium">
      <div class="page-head tight">
        <h1>Notes</h1>
        <div class="head-actions">
          ${all.length > 1 ? searchBox(search, v => { search = v; app.render(); }) : nothing}
          <button class="btn btn-primary btn-sm" @click=${add}>+ Add</button>
        </div>
      </div>
      <div class="records">
        ${!all.length ? html`<div class="hint-text">No notes yet.</div>`
          : !shownNotes.length ? html`<div class="hint-text">No notes match the search.</div>`
          : repeat(shownNotes, n => n.id, card)}
      </div>
    </div>`;
}
