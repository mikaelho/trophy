// The game's operations, run in the page. Each takes the local copy of the data (`db`: get,
// all, childrenOf) and the arguments, and returns {writes, result}: the batch to send to the
// relay. A write that depends on what was read carries ifRev (the revision it was read at),
// so when two people change the same thing at once, the relay refuses the later batch and the
// page computes it again from the fresh data (data.js does that). Text saves patch only the
// field they change, so edits to different fields never collide.
// Rules ported from trophy/alive_hooks.py; the data layout is described in migrations.js.

export const FREE_POWERS = 3, FREE_SKILLS = 4, BACKPACK_SLOTS = 6, RUIN_MAX = 6, HOARD_MAX = 50, AMMO_MAX = 3;
const HABIT_COUNT = 6;
const TEXT_FIELDS = new Set(['name', 'gender', 'player_name', 'occupation', 'background', 'look', 'drive', 'conditions', 'notes']);
const INT_FIELDS = new Set(['hoard', 'hunt_tokens']);
const FLAG_FIELDS = new Set(['hireling', 'archived']);
const MAX_LEN = { name: 120, gender: 60, player_name: 120, occupation: 200, background: 200, look: 200 };
const LIST_KINDS = new Set(['power', 'skill', 'household', 'combat', 'found', 'backpack']);
const CHILD_KINDS = [...LIST_KINDS, 'ledger'];
const MONSTER_TEXT = { name: 200, description: 400, defences: null, weakness: 300 };
const DIE_COLORS = new Set(['light', 'dark']);
const PERSON_TEXT = { name: 120, title: 200, location: 200, look: 300, equipment: 1000, description: 20000 };

export class RuleError extends Error {}

// Ids for new records: random, so pages never need to ask the relay for one.
export const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 10);

// Sort ids: numbers (records from the Django era) numerically, others as text.
export const compareIds = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
export const byPosition = (a, b) => a.position - b.position || compareIds(a.id, b.id);
export const bySlot = (a, b) => a.slot - b.slot || byPosition(a, b);

const toInt = (v, d = 0) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const cut = (s, max) => (max ? s.slice(0, max) : s);
const key = (kind, id) => `${kind}/${id}`;
const patch = (kind, row, fields, checked = true) => ({ op: 'patch', key: key(kind, row.id), fields, ...(checked ? { ifRev: row.rev } : {}) });
const put = (kind, id, data, ifRev) => ({ op: 'put', key: key(kind, id), data, ...(ifRev != null ? { ifRev } : {}) });
const del = (kind, id) => ({ op: 'delete', key: key(kind, id) });
const done = (writes, result = null) => ({ writes, result });

function character(db, id) {
  const c = db.get('character', id);
  if (!c) throw new RuleError('This character no longer exists.');
  return c;
}
function child(db, kind, id) {
  if (!LIST_KINDS.has(kind)) throw new RuleError('Unknown list: ' + kind);
  const r = db.get(kind, id);
  if (!r) throw new RuleError('This item no longer exists.');
  return r;
}
const nextPosition = rows => rows.length ? Math.max(...rows.map(r => r.position)) + 1 : 0;

// --- ledgers: Ruin, Burdens and Coin are the sums of their entries -------------------------
// An entry: ledger/<id> {character, field, amount, description, position, created_at}.
// Ruin starts at 1: the "+1 Initial" line is not stored, every Ruin ledger has it.
export const LEDGERS = { ruin: 'Ruin', burden: 'Burdens', coin: 'Coin' };
export const LEDGER_START = { ruin: 1, burden: 0, coin: 0 };
// The lowest each can go: Ruin never below 1, Burdens and Coin never below 0.
export const LEDGER_MIN = { ruin: 1, burden: 0, coin: 0 };
export const ledgerEntries = (db, characterId, field) =>
  db.childrenOf('ledger', characterId).filter(e => e.field === field);
export const ledgerTotal = (db, characterId, field) =>
  ledgerEntries(db, characterId, field).reduce((sum, e) => sum + (Number(e.amount) || 0), LEDGER_START[field] ?? 0);
export const burdenOf = (db, c) => ledgerTotal(db, c.id, 'burden');
export const ruinOf = (db, c) => ledgerTotal(db, c.id, 'ruin');
export const coinOf = (db, c) => ledgerTotal(db, c.id, 'coin');
// "+2", "-1", "−1" (a typographic minus) or "3" -> a whole number; anything else -> null.
export function parseAmount(v) {
  const s = String(v ?? '').trim().replace(/[−–]/g, '-').replace(/\s+/g, '');
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}
// Why changing a ledger's total by `change` is not allowed, or null when it is.
export function ledgerProblem(db, characterId, field, change) {
  const total = ledgerTotal(db, characterId, field) + change, min = LEDGER_MIN[field] ?? 0;
  return change < 0 && total < min ? `${LEDGERS[field]} cannot go below ${min} (it would be ${total}).` : null;
}
const checkLedger = (db, characterId, field, change) => {
  const problem = ledgerProblem(db, characterId, field, change);
  if (problem) throw new RuleError(problem);
};
export const formatAmount = n => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');

// --- the roller: one document holding the mat and the sections --------------------------
function roller(db) {
  const r = db.get('roller', 'main');
  return {
    rev: r ? r.rev : 0,
    mat: r && Array.isArray(r.mat) ? r.mat.map(d => ({ ...d })) : [],
    sections: r && Array.isArray(r.sections) ? r.sections.map(s => ({ ...s, dice: Array.isArray(s.dice) ? s.dice.map(d => ({ ...d })) : [] })) : [],
  };
}
const saveRoller = r => done([put('roller', 'main', { mat: r.mat, sections: r.sections }, r.rev)]);
function section(r, sid) {
  const s = r.sections.find(x => x.id === sid);
  if (!s) throw new RuleError('This section no longer exists.');
  return s;
}
const dieColor = c => { if (!DIE_COLORS.has(c)) throw new RuleError('Unknown die colour.'); return c; };
// The faces were rolled when Roll was clicked: {dieId: 1..6}. A die added by someone else
// meanwhile is not in `values` and stays as it was.
function rolled(dice, values) {
  if (!values || typeof values !== 'object') throw new RuleError('No dice values.');
  for (const v of Object.values(values)) if (!Number.isInteger(v) || v < 1 || v > 6) throw new RuleError('Dice show 1 to 6.');
  return dice.map(d => (d.id in values ? { ...d, value: values[d.id], roll: (Number(d.roll) || 0) + 1 } : d));
}

const LEDGER_TEXT = 300;
function ledgerEntry(db, id) {
  const e = db.get('ledger', id);
  if (!e) throw new RuleError('This ledger line no longer exists.');
  return e;
}

function monster(db, id) {
  const m = db.get('monster', id);
  if (!m) throw new RuleError('This creature no longer exists.');
  return m;
}

export const RULES = {
  // --- characters ----------------------------------------------------------------------
  new_character(db) {
    const id = newId();
    const writes = [put('character', id, {
      name: '', gender: '', player_name: '', occupation: '', background: '', look: '', drive: '', conditions: '', notes: '',
      hoard: 0, hunt_tokens: 0, hireling: false, archived: false,
      created_at: new Date().toISOString(),
    }, 0)];
    for (let i = 0; i < BACKPACK_SLOTS; i++) writes.push(put('backpack', newId(), { character: id, name: '', uses: 0, slot: i, position: i }, 0));
    return done(writes, { id });
  },

  delete_character(db, { id }) {
    const c = character(db, id);
    const writes = CHILD_KINDS.flatMap(kind => db.childrenOf(kind, c.id).map(r => del(kind, r.id)));
    writes.push(del('character', c.id));
    return done(writes);
  },

  toggle_flag(db, { id, field }) {
    if (!FLAG_FIELDS.has(field)) throw new RuleError('Unknown flag: ' + field);
    const c = character(db, id);
    return done([patch('character', c, { [field]: !c[field] })]);
  },

  save_field(db, { id, field, value }) {
    const c = character(db, id);
    if (TEXT_FIELDS.has(field)) return done([patch('character', c, { [field]: cut(String(value ?? '').trim(), MAX_LEN[field]) }, false)]);
    if (INT_FIELDS.has(field)) {
      let n = Math.max(0, toInt(value, 0));
      if (field === 'hoard') n = Math.min(n, HOARD_MAX);
      return done([patch('character', c, { [field]: n }, false)]);
    }
    throw new RuleError('Unknown field: ' + field);
  },

  append_look(db, { id, word }) {
    const c = character(db, id), w = String(word ?? '').trim();
    if (!w) return done([]);
    const existing = c.look.trim();
    return done([patch('character', c, { look: cut(existing ? existing + ', ' + w : w, MAX_LEN.look) })]);
  },

  // --- ledgers ---------------------------------------------------------------------------
  ledger_add(db, { id, field, amount, description }) {
    const c = character(db, id);
    if (!(field in LEDGERS)) throw new RuleError('Unknown ledger: ' + field);
    const n = parseAmount(amount);
    if (n === null) throw new RuleError('The amount must be a whole number, like +1 or -2.');
    const text = cut(String(description ?? '').trim(), LEDGER_TEXT);
    if (!n && !text) return done([]);
    checkLedger(db, c.id, field, n);
    const entryId = newId();
    return done([put('ledger', entryId, {
      character: c.id, field, amount: n, description: text,
      position: nextPosition(db.childrenOf('ledger', c.id)), created_at: new Date().toISOString(),
    }, 0)], { id: entryId });
  },
  ledger_save(db, { entry, field, value }) {
    const e = ledgerEntry(db, entry);
    if (field === 'description') return done([patch('ledger', e, { description: cut(String(value ?? '').trim(), LEDGER_TEXT) }, false)]);
    if (field === 'amount') {
      const n = parseAmount(value);
      if (n === null) throw new RuleError('The amount must be a whole number, like +1 or -2.');
      checkLedger(db, e.character, e.field, n - (Number(e.amount) || 0));
      return done([patch('ledger', e, { amount: n })]);
    }
    throw new RuleError('Unknown field: ' + field);
  },
  ledger_remove(db, { entry }) {
    const e = ledgerEntry(db, entry);
    checkLedger(db, e.character, e.field, -(Number(e.amount) || 0));
    return done([del('ledger', e.id)]);
  },

  add_child(db, { id, kind, name, combat_kind }) {
    if (!LIST_KINDS.has(kind) || kind === 'backpack') throw new RuleError('Unknown list: ' + kind);
    const c = character(db, id), nm = cut(String(name ?? '').trim(), 200);
    if (!nm) return done([]);
    const doc = { character: c.id, name: nm, position: nextPosition(db.childrenOf(kind, c.id)) };
    if (kind === 'combat') Object.assign(doc, { kind: combat_kind === 'weapon' ? 'weapon' : 'armor', marked: false, ammo: 0 });
    const newKey = newId();
    return done([put(kind, newKey, doc, 0)], { id: newKey });
  },

  rename_child(db, { kind, item, name }) {
    const r = child(db, kind, item);
    return done([patch(kind, r, { name: cut(String(name ?? '').trim(), 200) }, false)]);
  },

  remove_child(db, { kind, item }) {
    const r = child(db, kind, item);
    if (kind === 'backpack') throw new RuleError('Backpack slots are fixed.');
    return done([del(kind, r.id)]);
  },

  toggle_marked(db, { item }) {
    const r = child(db, 'combat', item);
    return done([patch('combat', r, { marked: !r.marked })]);
  },

  set_ammo(db, { item, n }) {
    const r = child(db, 'combat', item), k = toInt(n);
    if (!k) return done([]);
    return done([patch('combat', r, { ammo: clamp(k === r.ammo ? k - 1 : k, 0, AMMO_MAX) })]);
  },

  adjust_uses(db, { item, delta }) {
    const r = child(db, 'backpack', item), d = toInt(delta);
    if (!d) return done([]);
    return done([patch('backpack', r, { uses: Math.max(0, r.uses + d) })]);
  },

  // --- roller ----------------------------------------------------------------------------
  roller_add_die(db, { color }) { const r = roller(db); r.mat.push({ id: newId(), color: dieColor(color), value: null }); return saveRoller(r); },
  roller_roll(db, { values }) { const r = roller(db); r.mat = rolled(r.mat, values); return saveRoller(r); },
  roller_clear(db) { const r = roller(db); r.mat = []; return saveRoller(r); },
  roller_add_section(db, { name }) {
    const nm = cut(String(name ?? '').trim(), 120);
    if (!nm) return done([]);
    const r = roller(db); r.sections.push({ id: newId(), name: nm, dice: [] });
    return saveRoller(r);
  },
  roller_rename_section(db, { sid, name }) { const r = roller(db); section(r, sid).name = cut(String(name ?? '').trim(), 120); return saveRoller(r); },
  roller_remove_section(db, { sid }) { const r = roller(db); section(r, sid); r.sections = r.sections.filter(s => s.id !== sid); return saveRoller(r); },
  roller_section_add_die(db, { sid, color }) { const r = roller(db); section(r, sid).dice.push({ id: newId(), color: dieColor(color), value: null }); return saveRoller(r); },
  roller_section_roll(db, { sid, values }) { const r = roller(db), s = section(r, sid); s.dice = rolled(s.dice, values); return saveRoller(r); },
  roller_section_clear(db, { sid }) { const r = roller(db); section(r, sid).dice = []; return saveRoller(r); },
  roller_clear_sections(db) { const r = roller(db); for (const s of r.sections) s.dice = []; return saveRoller(r); },

  // --- bestiary --------------------------------------------------------------------------
  monster_add(db) {
    const id = newId();
    return done([put('monster', id, {
      endurance: 0, name: '', description: '', habits: Array(HABIT_COUNT).fill(''), defences: '', weakness: '',
      position: nextPosition(db.all('monster')), created_at: new Date().toISOString(),
    }, 0)], { id });
  },
  monster_remove(db, { id }) { const m = monster(db, id); return done([del('monster', m.id)]); },
  monster_save(db, { id, field, value }) {
    const m = monster(db, id);
    if (field in MONSTER_TEXT) return done([patch('monster', m, { [field]: cut(String(value ?? '').trim(), MONSTER_TEXT[field]) }, false)]);
    if (field === 'endurance') return done([patch('monster', m, { endurance: Math.max(0, toInt(value, 0)) }, false)]);
    throw new RuleError('Unknown field: ' + field);
  },
  monster_save_habit(db, { id, n, value }) {
    const m = monster(db, id), k = toInt(n);
    if (k < 1 || k > HABIT_COUNT) throw new RuleError('Habits are numbered 1 to 6.');
    const habits = [...(Array.isArray(m.habits) ? m.habits : []), ...Array(HABIT_COUNT).fill('')].slice(0, HABIT_COUNT);
    habits[k - 1] = cut(String(value ?? '').trim(), 300);
    return done([patch('monster', m, { habits })]);
  },
};

// --- people: supporting characters, generated and then freely edited -----------------------
function person(db, id) {
  const p = db.get('person', id);
  if (!p) throw new RuleError('This person no longer exists.');
  return p;
}
Object.assign(RULES, {
  // look and equipment come generated by the page (random words and table rolls)
  person_add(db, { look = '', equipment = '' } = {}) {
    const id = newId();
    return done([put('person', id, {
      name: '', title: '', location: '',
      look: cut(String(look).trim(), PERSON_TEXT.look), equipment: cut(String(equipment).trim(), PERSON_TEXT.equipment),
      description: '', position: nextPosition(db.all('person')), created_at: new Date().toISOString(),
    }, 0)], { id });
  },
  person_save(db, { id, field, value }) {
    const p = person(db, id);
    if (!(field in PERSON_TEXT)) throw new RuleError('Unknown field: ' + field);
    return done([patch('person', p, { [field]: cut(String(value ?? '').trim(), PERSON_TEXT[field]) }, false)]);
  },
  person_remove(db, { id }) { const p = person(db, id); return done([del('person', p.id)]); },
  // The die buttons: add one item to the comma-separated Look or Equipment.
  person_append(db, { id, field, value }) {
    if (field !== 'look' && field !== 'equipment') throw new RuleError('Unknown field: ' + field);
    const p = person(db, id), v = String(value ?? '').trim();
    if (!v) return done([]);
    const existing = String(p[field] ?? '').trim();
    const text = existing ? existing + ', ' + v : v.charAt(0).toUpperCase() + v.slice(1);
    return done([patch('person', p, { [field]: cut(text, PERSON_TEXT[field]) })]);
  },
});

// --- notes: the GM's notes, a title and a description ------------------------------------
const NOTE_TEXT = { title: 200, description: 50000 };
function note(db, id) {
  const n = db.get('note', id);
  if (!n) throw new RuleError('This note no longer exists.');
  return n;
}
Object.assign(RULES, {
  note_add(db) {
    const id = newId();
    return done([put('note', id, { title: '', description: '', position: nextPosition(db.all('note')), created_at: new Date().toISOString() }, 0)], { id });
  },
  note_save(db, { id, field, value }) {
    const n = note(db, id);
    if (!(field in NOTE_TEXT)) throw new RuleError('Unknown field: ' + field);
    return done([patch('note', n, { [field]: cut(String(value ?? '').trim(), NOTE_TEXT[field]) }, false)]);
  },
  note_remove(db, { id }) { const n = note(db, id); return done([del('note', n.id)]); },
});

export function compute(db, op, args = {}) {
  const fn = RULES[op];
  if (!fn) throw new RuleError('Unknown operation: ' + op);
  return fn(db, args);
}
