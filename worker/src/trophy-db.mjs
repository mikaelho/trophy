// The Trophy game database and its write operations, independent of Cloudflare.
// `sql` is a small adapter: { all(query, ...params) -> array of row objects, transaction(fn) }.
// In the Worker it wraps ctx.storage.sql; in tests and the local dev server it wraps node:sqlite.
//
// Rows travel to clients in the same shape as Django's dumpdata "fields", plus "id":
// booleans as true/false, JSON fields parsed, foreign keys under the name without "_id",
// datetimes as ISO strings ending in "Z".
//
// Every write is an "op" (an intent such as "add a power", never "here is the new list").
// apply() runs one op synchronously in a transaction and returns which rows changed, so the
// room can broadcast exactly those rows to everybody. Changes are numbered (seq, kept in the
// database so the numbering survives restarts). An op may carry an id (oid): an op whose id
// was already applied is not applied again, and gets the original result back.

import {
  DDL, MODELS, CHILD_KINDS, SCHEMA_VERSION,
  FREE_POWERS, FREE_SKILLS, BACKPACK_SLOTS, RUIN_MAX, HOARD_MAX, AMMO_MAX, BASE_BURDEN,
} from './schema.mjs';

const TEXT_FIELDS = new Set(['name', 'gender', 'player_name', 'occupation', 'background', 'look',
  'drive', 'conditions', 'notes']);
const INT_FIELDS = new Set(['hoard', 'coin', 'hunt_tokens']);
const FLAG_FIELDS = new Set(['hireling', 'archived']);

export class OpError extends Error {}

const APPLIED_KEEP_MS = 2 * 24 * 3600 * 1000; // how long applied op ids are remembered

// --- value conversion -----------------------------------------------------

// Django's SQLite backend stores datetimes as "2026-09-05 08:12:34.071000" (UTC).
const isoToDb = iso => {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(String(iso || ''));
  if (!m) return isoToDb(new Date().toISOString());
  return `${m[1]} ${m[2]}.${(m[3] || '').padEnd(6, '0').slice(0, 6)}`;
};
const dbToIso = v => {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(String(v || ''));
  return m ? `${m[1]}T${m[2]}.${(m[3] || '').padEnd(3, '0').slice(0, 3)}Z` : v;
};
const nowDb = () => isoToDb(new Date().toISOString());

const kindOf = d => d === 'datetime' ? 'datetime' : d === 'json' ? 'json' : typeof d;
const fieldName = col => col.endsWith('_id') ? col.slice(0, -3) : col; // character_id -> character

function rowOut(model, r) {
  const out = { id: Number(r.id) };
  for (const [col, d] of Object.entries(MODELS[model].fields)) {
    const v = r[col], k = kindOf(d);
    out[fieldName(col)] = k === 'boolean' ? !!v : k === 'json' ? safeJson(v) : k === 'datetime' ? dbToIso(v)
      : k === 'number' ? Number(v) : v;
  }
  return out;
}
const safeJson = v => { try { return JSON.parse(v); } catch (_) { return []; } };

// Value in the client/dump shape -> value to store, with the column's type.
function valueIn(model, col, v) {
  const d = MODELS[model].fields[col], k = kindOf(d);
  if (k === 'boolean') return v ? 1 : 0;
  if (k === 'json') return JSON.stringify(v ?? []);
  if (k === 'datetime') return v ? isoToDb(v) : nowDb();
  if (k === 'number') { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; }
  let s = v == null ? '' : String(v);
  const max = MODELS[model].max?.[col];
  return max ? s.slice(0, max) : s;
}
const defaultIn = (model, col) => {
  const d = MODELS[model].fields[col];
  return valueIn(model, col, kindOf(d) === 'json' ? [] : kindOf(d) === 'datetime' ? null : d);
};

// Ids for dice and roller sections, from the platform's random source (same in Node and Workers).
const uid = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
const HABIT_COUNT = 6;
const MONSTER_TEXT_FIELDS = new Set(['name', 'description', 'defences', 'weakness']);
const DIE_COLORS = new Set(['light', 'dark']);

const toInt = (v, dflt = 0) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : dflt; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// --- the database ---------------------------------------------------------

export class TrophyDB {
  constructor(sql, { now = () => Date.now() } = {}) {
    this.sql = sql; this.now = now;
    for (const q of DDL) sql.all(q);
    if (this.getMeta('schema_version') == null) this.setMeta('schema_version', SCHEMA_VERSION);
    // Future schema changes: compare getMeta('schema_version') with SCHEMA_VERSION and upgrade here.
    if (this.getMeta('epoch') == null) this.setMeta('epoch', Math.random().toString(36).slice(2, 10));
    this.epoch = this.getMeta('epoch');
    this.seq = Number(this.getMeta('seq') || 0);
  }

  getMeta(key) {
    const r = this.sql.all(`SELECT value FROM trophy_meta WHERE key = ?`, key)[0];
    return r ? r.value : null;
  }
  setMeta(key, value) {
    this.sql.all(`INSERT INTO trophy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
  }
  bumpSeq() { this.seq++; this.setMeta('seq', this.seq); }

  // low-level helpers
  get(model, id) {
    const r = this.sql.all(`SELECT * FROM "${MODELS[model].table}" WHERE id = ?`, id)[0];
    return r ? rowOut(model, r) : null;
  }
  rows(model, where = '', ...params) {
    return this.sql.all(`SELECT * FROM "${MODELS[model].table}" ${where} ORDER BY id`, ...params).map(r => rowOut(model, r));
  }
  insert(model, values, id = null) {
    const cols = Object.keys(MODELS[model].fields);
    const vals = cols.map(c => c in values ? valueIn(model, c, values[c]) : defaultIn(model, c));
    const allCols = id == null ? cols : ['id', ...cols], allVals = id == null ? vals : [id, ...vals];
    const q = allCols.length
      ? `INSERT INTO "${MODELS[model].table}" (${allCols.map(c => `"${c}"`).join(', ')}) VALUES (${allCols.map(() => '?').join(', ')}) RETURNING id`
      : `INSERT INTO "${MODELS[model].table}" DEFAULT VALUES RETURNING id`;
    return Number(this.sql.all(q, ...allVals)[0].id);
  }
  update(model, id, values) {
    const cols = Object.keys(values);
    if (!cols.length) return;
    this.sql.all(`UPDATE "${MODELS[model].table}" SET ${cols.map(c => `"${c}" = ?`).join(', ')} WHERE id = ?`,
      ...cols.map(c => valueIn(model, c, values[c])), id);
  }
  remove(model, id) { this.sql.all(`DELETE FROM "${MODELS[model].table}" WHERE id = ?`, id); }
  count(model, characterId) {
    return Number(this.sql.all(`SELECT COUNT(*) AS n FROM "${MODELS[model].table}" WHERE character_id = ?`, characterId)[0].n);
  }

  // Everything, for a client that joins or resyncs: { model: [row, ...] }.
  snapshot() {
    const out = {};
    for (const m of Object.keys(MODELS)) out[m] = this.rows(m);
    return out;
  }

  // --- export / import in Django dumpdata format ------------------------------

  exportDump() {
    const out = [];
    for (const m of Object.keys(MODELS)) {
      for (const r of this.rows(m)) {
        const { id, ...fields } = r;
        out.push({ model: 'trophy.' + m, pk: id, fields });
      }
    }
    return out;
  }

  // Replace all game data with a dump. Accepts a full Django dumpdata file: entries of
  // other apps (auth, sessions, ...) are skipped. Throws OpError on invalid input.
  importDump(dump) {
    if (!Array.isArray(dump)) throw new OpError('The file is not a database dump.');
    const items = dump.filter(x => x && typeof x.model === 'string' && x.model.startsWith('trophy.'));
    for (const x of items) {
      if (!MODELS[x.model.slice(7)]) throw new OpError('Unknown table in dump: ' + x.model);
      if (!Number.isInteger(x.pk) || !x.fields || typeof x.fields !== 'object') throw new OpError('Malformed entry in dump.');
    }
    const order = Object.keys(MODELS); // characters before their children
    items.sort((a, b) => order.indexOf(a.model.slice(7)) - order.indexOf(b.model.slice(7)));
    try {
      this.sql.transaction(() => {
        for (const m of [...order].reverse()) this.sql.all(`DELETE FROM "${MODELS[m].table}"`);
        for (const x of items) {
          const m = x.model.slice(7), values = {};
          for (const col of Object.keys(MODELS[m].fields)) {
            const f = fieldName(col);
            if (f in x.fields) values[col] = x.fields[f];
          }
          this.insert(m, values, x.pk);
        }
        this.bumpSeq();
      });
    } catch (e) {
      this.seq = Number(this.getMeta('seq') || 0);
      throw new OpError('The dump could not be loaded: ' + e.message);
    }
    return items.length;
  }

  // --- write operations ------------------------------------------------------

  // Run one op. Returns { result, changed: [[model, row]], deleted: [[model, id]], seq, duplicate }.
  // `seq` is the number of this change (unchanged when nothing changed).
  apply(op, args = {}, oid = null) {
    const fn = OPS[op];
    if (!fn) throw new OpError('Unknown operation: ' + op);
    oid = oid == null ? null : String(oid).slice(0, 64);
    if (oid) {
      const seen = this.sql.all(`SELECT result FROM trophy_applied WHERE oid = ?`, oid)[0];
      if (seen) return { result: JSON.parse(seen.result), changed: [], deleted: [], seq: this.seq, duplicate: true };
    }
    const seqBefore = this.seq;
    try {
      return this.sql.transaction(() => {
        const ch = new Changes(this);
        const result = fn.call(this, args, ch) ?? null;
        const out = { result, ...ch.collect(), duplicate: false };
        if (out.changed.length || out.deleted.length) this.bumpSeq();
        if (oid) {
          const now = this.now();
          this.sql.all(`DELETE FROM trophy_applied WHERE at < ?`, now - APPLIED_KEEP_MS);
          this.sql.all(`INSERT INTO trophy_applied (oid, at, result) VALUES (?, ?, ?)`, oid, now, JSON.stringify(result));
        }
        return { ...out, seq: this.seq };
      });
    } catch (e) {
      this.seq = seqBefore; // the transaction was rolled back
      throw e;
    }
  }

  character(id) {
    const c = this.get('character', toInt(id));
    if (!c) throw new OpError('No such character.');
    return c;
  }
  child(kind, id) {
    const model = CHILD_KINDS[kind];
    if (!model) throw new OpError('Unknown list: ' + kind);
    const r = this.get(model, toInt(id));
    if (!r) throw new OpError('No such item.');
    return [model, r];
  }
  burdenBase(cid) {
    return BASE_BURDEN
      + Math.max(0, this.count('power', cid) - FREE_POWERS)
      + Math.max(0, this.count('skill', cid) - FREE_SKILLS)
      + this.count('householdmember', cid)
      + this.count('combatitem', cid);
  }
}

// Collects touched rows during one op, then reads their final state.
class Changes {
  constructor(db) { this.db = db; this.touched = new Map(); this.gone = []; }
  touch(model, id) { this.touched.set(model + ':' + id, [model, id]); }
  remove(model, id) { this.touched.delete(model + ':' + id); this.gone.push([model, id]); }
  collect() {
    const changed = [];
    for (const [model, id] of this.touched.values()) {
      const r = this.db.get(model, id);
      if (r) changed.push([model, r]);
    }
    return { changed, deleted: this.gone };
  }
}

const OPS = {
  new_character(_, ch) {
    const id = this.insert('character', { name: '' });
    ch.touch('character', id);
    for (let i = 0; i < BACKPACK_SLOTS; i++) {
      ch.touch('backpackitem', this.insert('backpackitem', { character_id: id, slot: i, position: i }));
    }
    return { id };
  },

  delete_character({ id }, ch) {
    const c = this.character(id);
    for (const model of Object.values(CHILD_KINDS)) {
      for (const r of this.rows(model, 'WHERE character_id = ?', c.id)) { this.remove(model, r.id); ch.remove(model, r.id); }
    }
    this.remove('character', c.id);
    ch.remove('character', c.id);
  },

  toggle_flag({ id, field }, ch) {
    if (!FLAG_FIELDS.has(field)) throw new OpError('Unknown flag: ' + field);
    const c = this.character(id);
    this.update('character', c.id, { [field]: !c[field] });
    ch.touch('character', c.id);
  },

  save_field({ id, field, value }, ch) {
    const c = this.character(id);
    if (TEXT_FIELDS.has(field)) {
      this.update('character', c.id, { [field]: String(value ?? '').trim() });
    } else if (INT_FIELDS.has(field)) {
      let n = Math.max(0, toInt(value, 0));
      if (field === 'hoard') n = Math.min(n, HOARD_MAX);
      this.update('character', c.id, { [field]: n });
    } else throw new OpError('Unknown field: ' + field);
    ch.touch('character', c.id);
  },

  // The client picks the descriptor (it has the word list); appending happens here so
  // that two quick clicks never overwrite each other.
  append_look({ id, word }, ch) {
    const c = this.character(id), w = String(word ?? '').trim();
    if (!w) return;
    const existing = c.look.trim();
    this.update('character', c.id, { look: existing ? existing + ', ' + w : w });
    ch.touch('character', c.id);
  },

  // +/- moves the displayed total (floored at 0); the offset absorbs the gap so
  // automatic list contributions still shift the total afterwards.
  adjust_burden({ id, delta }, ch) {
    const c = this.character(id), d = toInt(delta);
    if (!d) return;
    const base = this.burdenBase(c.id);
    const total = Math.max(0, base + c.burden_offset);
    this.update('character', c.id, { burden_offset: Math.max(0, total + d) - base });
    ch.touch('character', c.id);
  },

  // Clicking the current level clears down to it; box 1 always stays ticked.
  set_ruin({ id, n }, ch) {
    const c = this.character(id), k = toInt(n);
    if (!k) return;
    this.update('character', c.id, { ruin: clamp(k === c.ruin ? k - 1 : k, 1, RUIN_MAX) });
    ch.touch('character', c.id);
  },

  add_child({ id, kind, name, combat_kind }, ch) {
    const c = this.character(id), model = CHILD_KINDS[kind], nm = String(name ?? '').trim();
    if (!model || kind === 'backpack') throw new OpError('Unknown list: ' + kind);
    if (!nm) return;
    const last = this.sql.all(`SELECT MAX(position) AS p FROM "${MODELS[model].table}" WHERE character_id = ?`, c.id)[0];
    const values = { character_id: c.id, name: nm, position: last && last.p != null ? Number(last.p) + 1 : 0 };
    if (kind === 'combat') values.kind = combat_kind === 'weapon' ? 'weapon' : 'armor';
    const newId = this.insert(model, values);
    ch.touch(model, newId);
    if (kind === 'power') this.bumpRuin(c, 1, ch); // each power raises Ruin by 1
    return { id: newId };
  },

  rename_child({ kind, item, name }, ch) {
    const [model, r] = this.child(kind, item);
    this.update(model, r.id, { name: String(name ?? '').trim() });
    ch.touch(model, r.id);
  },

  remove_child({ kind, item }, ch) {
    const [model, r] = this.child(kind, item);
    if (kind === 'backpack') throw new OpError('Backpack slots are fixed.');
    this.remove(model, r.id);
    ch.remove(model, r.id);
    if (kind === 'power') this.bumpRuin(this.character(r.character), -1, ch); // removing a power lowers Ruin
  },

  toggle_marked({ item }, ch) {
    const [, r] = this.child('combat', item);
    this.update('combatitem', r.id, { marked: !r.marked });
    ch.touch('combatitem', r.id);
  },

  set_ammo({ item, n }, ch) {
    const [, r] = this.child('combat', item), k = toInt(n);
    if (!k) return;
    this.update('combatitem', r.id, { ammo: clamp(k === r.ammo ? k - 1 : k, 0, AMMO_MAX) });
    ch.touch('combatitem', r.id);
  },

  adjust_uses({ item, delta }, ch) {
    const [, r] = this.child('backpack', item), d = toInt(delta);
    if (!d) return;
    this.update('backpackitem', r.id, { uses: Math.max(0, r.uses + d) });
    ch.touch('backpackitem', r.id);
  },
};

// --- Dice roller: one shared row (id 1) holding the mat and per-section trays as JSON ------
// mat: [{id, color, value, roll}]   sections: [{id, name, dice: [{id, color, value, roll}]}]
// `roll` counts rolls of that die, so the page can animate a re-roll that lands on the same face.
// The browser whose Roll button was clicked rolls the dice and sends the faces as
// values: {dieId: 1..6}; the room only checks and stores them. A die missing from `values`
// (added by someone else meanwhile) is left as it was.

TrophyDB.prototype.roller = function () {
  let r = this.get('roller', 1);
  if (!r) { this.insert('roller', { mat: [], sections: [] }, 1); r = this.get('roller', 1); }
  return { mat: Array.isArray(r.mat) ? r.mat : [], sections: Array.isArray(r.sections) ? r.sections : [] };
};
TrophyDB.prototype.saveRoller = function (r, ch) {
  this.update('roller', 1, { mat: r.mat, sections: r.sections, updated_at: new Date(this.now()).toISOString() });
  ch.touch('roller', 1);
};
const newDie = color => ({ id: uid(), color, value: null });
function rolled(dice, values) {
  if (!values || typeof values !== 'object') throw new OpError('No dice values sent.');
  for (const v of Object.values(values)) {
    if (!Number.isInteger(v) || v < 1 || v > 6) throw new OpError('Dice show 1 to 6.');
  }
  return dice.map(d => d.id in values ? { ...d, value: values[d.id], roll: (Number(d.roll) || 0) + 1 } : d);
}
const color = c => { if (!DIE_COLORS.has(c)) throw new OpError('Unknown die colour.'); return c; };
function section(r, sid) {
  const s = r.sections.find(x => x.id === sid);
  if (!s) throw new OpError('No such section.');
  s.dice = Array.isArray(s.dice) ? s.dice : [];
  return s;
}

Object.assign(OPS, {
  roller_add_die({ color: c }, ch) { const r = this.roller(); r.mat.push(newDie(color(c))); this.saveRoller(r, ch); },
  roller_roll({ values }, ch) { const r = this.roller(); r.mat = rolled(r.mat, values); this.saveRoller(r, ch); },
  roller_clear(_, ch) { const r = this.roller(); r.mat = []; this.saveRoller(r, ch); },
  roller_add_section({ name }, ch) {
    const nm = String(name ?? '').trim().slice(0, 120);
    if (!nm) return;
    const r = this.roller(), id = uid();
    r.sections.push({ id, name: nm, dice: [] }); this.saveRoller(r, ch);
    return { id };
  },
  roller_rename_section({ sid, name }, ch) {
    const r = this.roller(); section(r, sid).name = String(name ?? '').trim().slice(0, 120); this.saveRoller(r, ch);
  },
  roller_remove_section({ sid }, ch) {
    const r = this.roller(); section(r, sid); r.sections = r.sections.filter(s => s.id !== sid); this.saveRoller(r, ch);
  },
  roller_section_add_die({ sid, color: c }, ch) {
    const r = this.roller(); section(r, sid).dice.push(newDie(color(c))); this.saveRoller(r, ch);
  },
  roller_section_roll({ sid, values }, ch) {
    const r = this.roller(), s = section(r, sid); s.dice = rolled(s.dice, values); this.saveRoller(r, ch);
  },
  roller_section_clear({ sid }, ch) { const r = this.roller(); section(r, sid).dice = []; this.saveRoller(r, ch); },
  roller_clear_sections(_, ch) { const r = this.roller(); for (const s of r.sections) s.dice = []; this.saveRoller(r, ch); },

  // --- Bestiary ---------------------------------------------------------------
  monster_add(_, ch) {
    const last = this.sql.all(`SELECT MAX(position) AS p FROM trophy_monster`)[0];
    const id = this.insert('monster', { position: last && last.p != null ? Number(last.p) + 1 : 0, habits: Array(HABIT_COUNT).fill('') });
    ch.touch('monster', id);
    return { id };
  },
  monster_remove({ id }, ch) {
    const m = this.monster(id);
    this.remove('monster', m.id); ch.remove('monster', m.id);
  },
  monster_save({ id, field, value }, ch) {
    const m = this.monster(id);
    if (MONSTER_TEXT_FIELDS.has(field)) this.update('monster', m.id, { [field]: String(value ?? '').trim() });
    else if (field === 'endurance') this.update('monster', m.id, { endurance: Math.max(0, toInt(value, 0)) });
    else throw new OpError('Unknown field: ' + field);
    ch.touch('monster', m.id);
  },
  monster_save_habit({ id, n, value }, ch) {
    const m = this.monster(id), k = toInt(n);
    if (k < 1 || k > HABIT_COUNT) throw new OpError('Habits are numbered 1 to 6.');
    const habits = [...(Array.isArray(m.habits) ? m.habits : []), ...Array(HABIT_COUNT).fill('')].slice(0, HABIT_COUNT);
    habits[k - 1] = String(value ?? '').trim();
    this.update('monster', m.id, { habits });
    ch.touch('monster', m.id);
  },
});

TrophyDB.prototype.monster = function (id) {
  const m = this.get('monster', toInt(id));
  if (!m) throw new OpError('No such monster.');
  return m;
};

TrophyDB.prototype.bumpRuin = function (c, delta, ch) {
  this.update('character', c.id, { ruin: clamp(c.ruin + delta, 1, RUIN_MAX) });
  ch.touch('character', c.id);
};
