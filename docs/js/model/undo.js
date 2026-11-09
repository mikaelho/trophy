// Undo and redo of this page's own changes, at the level of documents, so no operation needs
// undo code of its own.
//
// record(view, writes) is called just before a batch is sent: it notes, for each document the
// batch touches, how it was before and how it will be after. revert(view, step) computes the
// batch that turns those documents back, checked against the data as it is now:
//   - a changed field is put back only if it still holds the value this page gave it;
//   - a document this page created is removed only if nobody has changed it since;
//   - a document this page deleted is recreated (same id and contents) if it doesn't exist.
// Whatever someone else has changed since is left alone and reported in `skipped`. The batch
// carries the revisions it was computed against (ifRev), so if someone changes the same
// document at the same moment, the relay refuses it and the page computes it again.
// Redo is the same thing the other way: reverting an undo.

const equal = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => equal(a[k], b[k]));
};

// {label, changes: [{key, before, after, fields}]}; before/after = document data or null.
// fields: the fields a patch changed (null = the whole document).
export function record(view, writes, label) {
  const state = new Map(), fields = new Map(), first = new Map();
  const current = key => (state.has(key) ? state.get(key) : view.docs.get(key)?.data ?? null);
  for (const w of writes) {
    if (!first.has(w.key)) first.set(w.key, current(w.key));
    const cur = current(w.key);
    if (w.op === 'delete') { state.set(w.key, null); fields.set(w.key, null); }
    else if (w.op === 'put') { state.set(w.key, w.data); fields.set(w.key, null); }
    else if (w.op === 'patch') {
      state.set(w.key, cur ? { ...cur, ...w.fields } : null);
      const f = fields.has(w.key) ? fields.get(w.key) : [];
      fields.set(w.key, f === null ? null : [...new Set([...f, ...Object.keys(w.fields)])]);
    }
  }
  const changes = [...first.keys()].map(key => {
    const before = first.get(key), after = state.get(key);
    // a patch on an existing document: remember just the fields it changed
    const f = before && after ? (fields.get(key) || Object.keys({ ...before, ...after })) : null;
    return { key, before, after, fields: f };
  });
  return { label, changes };
}

// -> {writes, skipped: [key], undone: [key]}
export function revert(view, step) {
  const writes = [], skipped = [], undone = [];
  for (const c of step.changes) {
    const now = view.docs.get(c.key) || null;
    if (c.before === null) {                      // this page created it: remove it
      if (!now) continue;                         // already gone
      if (c.after && equal(now.data, c.after)) { writes.push({ op: 'delete', key: c.key, ifRev: now.rev }); undone.push(c.key); }
      else skipped.push(c.key);
    } else if (c.after === null) {                // this page deleted it: bring it back
      if (!now) { writes.push({ op: 'put', key: c.key, data: c.before, ifRev: 0 }); undone.push(c.key); }
      else skipped.push(c.key);
    } else {                                      // this page changed fields: put them back
      if (!now) { skipped.push(c.key); continue; }
      const back = {}, untouched = [];
      for (const f of c.fields) {
        if (equal(now.data[f], c.after[f])) { if (!equal(now.data[f], c.before[f])) back[f] = c.before[f] ?? null; }
        else untouched.push(f);
      }
      if (Object.keys(back).length) { writes.push({ op: 'patch', key: c.key, fields: back, ifRev: now.rev }); undone.push(c.key); }
      if (untouched.length) skipped.push(c.key);
    }
  }
  return { writes, skipped, undone };
}

// --- what to call a step, for the Undo button and messages ------------------------------

const KIND = { power: 'power', skill: 'skill', household: 'household detail', combat: 'combat item',
  found: 'found item', backpack: 'backpack item' };
const field = f => String(f).replace(/_/g, ' ');
const quote = s => (String(s || '').trim() ? `"${String(s).trim().slice(0, 30)}"` : '');

export function describe(view, op, args = {}) {
  const char = id => view.get('character', id)?.name?.trim() || 'a character';
  const item = (kind, id) => view.get(kind, id)?.name?.trim();
  const monster = id => view.get('monster', id)?.name?.trim() || 'a monster';
  const person = id => view.get('person', id)?.name?.trim() || 'a person';
  switch (op) {
    case 'new_character': return 'new character';
    case 'delete_character': return `delete ${char(args.id)}`;
    case 'toggle_flag': return `${char(args.id)}: ${field(args.field)}`;
    case 'save_field': return `${char(args.id)}: ${field(args.field)}`;
    case 'append_look': return `${char(args.id)}: look`;
    case 'adjust_burden': return `${char(args.id)}: burdens`;
    case 'set_ruin': return `${char(args.id)}: ruin`;
    case 'add_child': return `add ${KIND[args.kind] || 'item'} ${quote(args.name)}`.trim();
    case 'rename_child': return `rename ${KIND[args.kind] || 'item'} ${quote(item(args.kind, args.item))}`.trim();
    case 'remove_child': return `remove ${KIND[args.kind] || 'item'} ${quote(item(args.kind, args.item))}`.trim();
    case 'toggle_marked': return `mark ${quote(item('combat', args.item))}`.trim();
    case 'set_ammo': return `ammo of ${quote(item('combat', args.item))}`.trim();
    case 'adjust_uses': return `uses of ${quote(item('backpack', args.item)) || 'a backpack item'}`;
    case 'monster_add': return 'new monster';
    case 'monster_remove': return `delete ${monster(args.id)}`;
    case 'monster_save': return `${monster(args.id)}: ${field(args.field)}`;
    case 'monster_save_habit': return `${monster(args.id)}: habit ${args.n}`;
    case 'person_add': return 'new person';
    case 'person_remove': return `delete ${person(args.id)}`;
    case 'person_save': case 'person_append': return `${person(args.id)}: ${field(args.field)}`;
    case 'note_add': return 'new note';
    case 'note_remove': return `delete note ${quote(view.get('note', args.id)?.title) || ''}`.trim();
    case 'note_save': return `note ${quote(view.get('note', args.id)?.title)}: ${field(args.field)}`.replace('note : ', 'note: ');
    default: return field(op);
  }
}
