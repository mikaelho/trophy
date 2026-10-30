// The Trophy game database and its write operations, independent of Cloudflare.
// `sql` is a small adapter: { all(query, ...params) -> array of row objects, transaction(fn) }.
// In the Worker it wraps ctx.storage.sql; in tests and the local dev server it wraps node:sqlite.
//
// Rows travel to clients in the same shape as Django's dumpdata "fields", plus "id":
// booleans as true/false, JSON fields parsed, foreign keys under the name without "_id",
// datetimes as ISO strings ending in "Z".
//
// Every write is an "op" (an intent such as "add a power", never "here is the new list").
// apply() runs one op synchronously and returns which rows changed, so the room can
// broadcast exactly those rows to everybody.

import {
  DDL, MODELS, CHILD_KINDS, SCHEMA_VERSION,
  FREE_POWERS, FREE_SKILLS, BACKPACK_SLOTS, RUIN_MAX, HOARD_MAX, AMMO_MAX, BASE_BURDEN,
} from './schema.mjs';

const TEXT_FIELDS = new Set(['name', 'gender', 'player_name', 'occupation', 'background', 'look',
  'drive', 'conditions', 'notes']);
const INT_FIELDS = new Set(['hoard', 'coin', 'hunt_tokens']);
const FLAG_FIELDS = new Set(['hireling', 'archived']);

export class OpError extends Error {}

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

const toInt = (v, dflt = 0) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : dflt; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// --- the database ---------------------------------------------------------

export class TrophyDB {
  constructor(sql) {
    this.sql = sql;
    for (const q of DDL) sql.all(q);
    const v = sql.all(`SELECT value FROM trophy_meta WHERE key = 'schema_version'`)[0];
    if (!v) sql.all(`INSERT INTO trophy_meta (key, value) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
    // Future schema changes: compare v.value with SCHEMA_VERSION and upgrade here.
  }

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
      });
    } catch (e) {
      throw new OpError('The dump could not be loaded: ' + e.message);
    }
    return items.length;
  }

  // --- write operations ------------------------------------------------------

  // Run one op. Returns { result, changed: [[model, row]], deleted: [[model, id]] }.
  apply(op, args = {}) {
    const fn = OPS[op];
    if (!fn) throw new OpError('Unknown operation: ' + op);
    const ch = new Changes(this);
    const result = fn.call(this, args, ch);
    return { result: result ?? null, ...ch.collect() };
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

TrophyDB.prototype.bumpRuin = function (c, delta, ch) {
  this.update('character', c.id, { ruin: clamp(c.ruin + delta, 1, RUIN_MAX) });
  ch.touch('character', c.id);
};
