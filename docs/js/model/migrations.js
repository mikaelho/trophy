// The layout of the game data and how to get there from older layouts. Runs in the page
// (and in Node for tests); the relay only stores documents and the current DATA_VERSION.
//
// Layout, version 1 — one document per record, key "<kind>/<id>", ids are strings:
//   character/<id>   {name, gender, player_name, occupation, background, look, drive, conditions,
//                     notes, ruin, hoard, coin, hunt_tokens, burden_offset, hireling, archived, created_at}
//   power/<id>, skill/<id>, household/<id>, found/<id>   {character, name, position}
//   combat/<id>      {character, name, kind: 'weapon'|'armor', marked, ammo, position}
//   backpack/<id>    {character, name, uses, slot, position}
//   roller/main      {mat: [die], sections: [{id, name, dice: [die]}]}   die = {id, color, value, roll?}
//   monster/<id>     {endurance, name, description, habits: [6 strings], defences, weakness, position, created_at}
//   person/<id>      {name, title, location, look, equipment, description, position, created_at}
//                    (supporting characters; look and equipment are comma-separated lists)
//
// Version 2: person equipment changed from one item per line to a comma-separated list.
// `character` in child records is the character's id. created_at is an ISO time.
// A new kind of record (like person) needs no new version: pages that don't know it ignore it.
//
// Changing the layout: add version N+1 to STEPS as a function from the version-N documents
// ({key: data}) to the new ones, and raise DATA_VERSION. The first page with the new code to
// open a room upgrades it; older pages then ask to be reloaded. Keep every step forever: a
// room left unopened for a long time upgrades through all of them.
//
// Version 0 is the data of the previous relay version: Django-style SQL tables, handed over
// by the relay as raw rows. Django dumps (dumpdata files, and exports of that relay version)
// convert to version 1 with fromDjangoDump.

export const DATA_VERSION = 2;

const STEPS = {
  1: ({ legacy }) => v1FromRecords(recordsFromTables(legacy || {})),
  2: ({ docs }) => mapKind(docs, 'person', p => ({
    ...p, equipment: String(p.equipment ?? '').split(/\n+/).map(s => s.trim()).filter(Boolean).join(', '),
  })),
};

// Change every document of one kind; other documents stay as they are.
const mapKind = (docs, kind, fn) =>
  Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, k.startsWith(kind + '/') ? fn(d) : d]));

// Bring documents from `version` up to DATA_VERSION. `legacy` is only used from version 0.
export function upgrade(version, { docs = {}, legacy = null } = {}) {
  if (!Number.isInteger(version) || version < 0) throw new Error('Unknown data version: ' + version);
  if (version > DATA_VERSION) throw new Error(`The data is from a newer version of the page (${version}). Reload the page.`);
  let cur = docs;
  for (let v = version + 1; v <= DATA_VERSION; v++) cur = STEPS[v]({ docs: cur, legacy });
  return cur;
}

// --- version 0: Django-style records ---------------------------------------------------
// Records: {model: [{id, ...fields}]} in Django dumpdata naming (character = the character's
// id; booleans true/false; JSON fields parsed; times as ISO strings).

const BOOL_COLS = new Set(['hireling', 'archived', 'marked']);
const JSON_COLS = new Set(['mat', 'sections', 'habits']);
const TIME_COLS = new Set(['created_at', 'updated_at']);
const sqlTimeToIso = v => {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(String(v ?? ''));
  return m ? `${m[1]}T${m[2]}.${(m[3] || '').padEnd(3, '0').slice(0, 3)}Z` : null;
};
const parseJson = v => { if (typeof v !== 'string') return v ?? []; try { return JSON.parse(v); } catch (_) { return []; } };

// Raw rows of the tables trophy_<model> -> records.
export function recordsFromTables(tables) {
  const records = {};
  for (const [table, rows] of Object.entries(tables)) {
    const m = /^trophy_([a-z]+)$/.exec(table);
    if (!m || !Array.isArray(rows)) continue;
    records[m[1]] = rows.map(r => {
      const out = {};
      for (const [col, v] of Object.entries(r)) {
        if (col === 'id') out.id = Number(v);
        else if (col.endsWith('_id')) out[col.slice(0, -3)] = Number(v);
        else if (BOOL_COLS.has(col)) out[col] = !!v;
        else if (JSON_COLS.has(col)) out[col] = parseJson(v);
        else if (TIME_COLS.has(col)) out[col] = sqlTimeToIso(v);
        else out[col] = v;
      }
      return out;
    });
  }
  return records;
}

// A Django dumpdata list ([{model: 'trophy.character', pk, fields}]) -> records.
// Entries of other apps (auth, sessions, ...) are skipped.
export function recordsFromDjangoDump(dump) {
  if (!Array.isArray(dump)) throw new Error('The file is not a database dump.');
  const records = {};
  for (const x of dump) {
    if (!x || typeof x.model !== 'string' || !x.model.startsWith('trophy.')) continue;
    if (!Number.isInteger(x.pk) || !x.fields || typeof x.fields !== 'object') throw new Error('Malformed entry in the dump.');
    (records[x.model.slice(7)] ||= []).push({ id: x.pk, ...x.fields });
  }
  return records;
}

export const fromDjangoDump = dump => v1FromRecords(recordsFromDjangoDump(dump));

// --- version 1 -------------------------------------------------------------------------

const KIND_OF = { power: 'power', skill: 'skill', householdmember: 'household', foundequipment: 'found',
  combatitem: 'combat', backpackitem: 'backpack' };
const str = v => (v == null ? '' : String(v));
const int = (v, d = 0) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; };
const HABITS = 6;

export function v1FromRecords(records) {
  const docs = {};
  const characters = new Set();
  for (const c of records.character || []) {
    const id = String(c.id);
    characters.add(id);
    docs[`character/${id}`] = {
      name: str(c.name), gender: str(c.gender), player_name: str(c.player_name), occupation: str(c.occupation),
      background: str(c.background), look: str(c.look), drive: str(c.drive), conditions: str(c.conditions),
      notes: str(c.notes), ruin: int(c.ruin, 1), hoard: int(c.hoard), coin: int(c.coin), hunt_tokens: int(c.hunt_tokens),
      burden_offset: int(c.burden_offset), hireling: !!c.hireling, archived: !!c.archived,
      created_at: c.created_at || new Date(0).toISOString(),
    };
  }
  for (const [model, kind] of Object.entries(KIND_OF)) {
    for (const r of records[model] || []) {
      const character = String(r.character);
      if (!characters.has(character)) continue; // belonged to a deleted character
      const doc = { character, name: str(r.name), position: int(r.position) };
      if (kind === 'combat') Object.assign(doc, { kind: r.kind === 'weapon' ? 'weapon' : 'armor', marked: !!r.marked, ammo: int(r.ammo) });
      if (kind === 'backpack') Object.assign(doc, { uses: int(r.uses), slot: int(r.slot) });
      docs[`${kind}/${r.id}`] = doc;
    }
  }
  const roller = (records.roller || [])[0];
  if (roller) {
    docs['roller/main'] = {
      mat: Array.isArray(roller.mat) ? roller.mat : [],
      sections: (Array.isArray(roller.sections) ? roller.sections : []).map(s => ({ ...s, dice: Array.isArray(s.dice) ? s.dice : [] })),
    };
  }
  for (const m of records.monster || []) {
    docs[`monster/${m.id}`] = {
      endurance: int(m.endurance), name: str(m.name), description: str(m.description),
      habits: [...(Array.isArray(m.habits) ? m.habits.map(str) : []), ...Array(HABITS).fill('')].slice(0, HABITS),
      defences: str(m.defences), weakness: str(m.weakness), position: int(m.position),
      created_at: m.created_at || new Date(0).toISOString(),
    };
  }
  return docs;
}
