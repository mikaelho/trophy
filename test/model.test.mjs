// Tests of the page's data layout, migrations and game rules, run against the real document
// store. Run with the server tests: node --test test/*.test.mjs worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DocStore } from '../worker/src/store.mjs';
import { RoomCore } from '../worker/src/room-core.mjs';
import { nodeSql } from '../worker/src/node-sql.mjs';
import { DATA_VERSION, upgrade, fromDjangoDump } from '../docs/js/model/migrations.js';
import { compute, burdenBase, burdenOf, RuleError } from '../docs/js/model/rules.js';
import { DocView } from '../docs/js/model/view.js';

const dump = JSON.parse(readFileSync(new URL('../trophy-db.json', import.meta.url), 'utf8'));
const legacyTables = JSON.parse(readFileSync(new URL('./fixtures/legacy-tables.json', import.meta.url), 'utf8'));
const count = (docs, kind) => Object.keys(docs).filter(k => k.startsWith(kind + '/')).length;

// A store with pages on it: run() computes an operation from a page's view and writes it.
function setup(docs = {}) {
  const store = new DocStore(nodeSql());
  store.replaceAll({ docs, dataVersion: DATA_VERSION, from: 0, reason: 'test' });
  const page = () => { const v = new DocView(); v.load(store.allDocs()); return v; };
  const sync = v => v.load(store.allDocs());
  const run = (view, op, args) => {
    const { writes, result } = compute(view, op, args);
    if (writes.length) { const r = store.write({ version: DATA_VERSION, writes, result }); view.apply(r.docs, r.deleted); }
    return result;
  };
  return { store, page, sync, run };
}

// --- migrations ----------------------------------------------------------------------

test('the Django dump converts to version 1 documents', () => {
  const docs = fromDjangoDump(dump);
  const n = model => dump.filter(x => x.model === 'trophy.' + model).length;
  assert.equal(count(docs, 'character'), n('character'));
  assert.equal(count(docs, 'power'), n('power'));
  assert.equal(count(docs, 'skill'), n('skill'));
  assert.equal(count(docs, 'combat'), n('combatitem'));
  assert.equal(count(docs, 'found'), n('foundequipment'));
  assert.equal(count(docs, 'backpack'), n('backpackitem'));
  assert.equal(count(docs, 'monster'), n('monster'));
  const lora = dump.find(x => x.model === 'trophy.character' && x.fields.name === 'Lora');
  const doc = docs[`character/${lora.pk}`];
  assert.deepEqual(doc, { ...lora.fields }, 'every character field carried over as it was');
  const skill = dump.find(x => x.model === 'trophy.skill');
  assert.deepEqual(docs[`skill/${skill.pk}`], { character: String(skill.fields.character), name: skill.fields.name, position: skill.fields.position });
  assert.equal(docs['roller/main'].sections.length, 2);
  for (const k of Object.keys(docs).filter(k => k.startsWith('monster/'))) assert.equal(docs[k].habits.length, 6);
});

test('a room of the previous relay version upgrades to the same documents, with its later changes', () => {
  const fromDump = fromDjangoDump(dump);
  const fromRoom = upgrade(0, { legacy: legacyTables });
  // the fixture room = the dump + a power and a weapon for Lora, a rolled die, a habit
  assert.equal(Object.keys(fromRoom).length, Object.keys(fromDump).length + 2);
  const lora = Object.keys(fromDump).find(k => k.startsWith('character/') && fromDump[k].name === 'Lora');
  assert.equal(fromRoom[lora].ruin, fromDump[lora].ruin + 1);
  const mat = fromRoom['roller/main'].mat;
  assert.equal(mat.length, 1); assert.equal(mat[0].value, 4); assert.equal(mat[0].roll, 1); assert.equal(mat[0].color, 'dark');
  const changedMonster = Object.keys(fromRoom).find(k => k.startsWith('monster/') && fromRoom[k].habits[1] === 'Hunts at dusk');
  assert.ok(changedMonster);
  // everything else is identical, including times and booleans converted from SQL
  for (const [k, v] of Object.entries(fromDump)) {
    if (k === lora || k === 'roller/main' || k === changedMonster) continue;
    assert.deepEqual(fromRoom[k], v, k);
  }
  const added = Object.keys(fromRoom).filter(k => !(k in fromDump));
  assert.deepEqual(added.map(k => [k.split('/')[0], fromRoom[k].name, fromRoom[k].character]).sort(),
    [['combat', 'Crossbow', lora.split('/')[1]], ['power', 'Ward', lora.split('/')[1]]]);
});

test('upgrading a real room database: the page converts, the relay stores, old tables stay', () => {
  const file = mkdtempSync(tmpdir() + '/trophy-') + '/room.sqlite';
  copyFileSync(new URL('./fixtures/legacy-room.sqlite', import.meta.url), file);
  const store = new DocStore(nodeSql(file));
  const room = new RoomCore({ db: store });
  const sent = [], ws = { send: t => sent.push(JSON.parse(t)), close() {} };
  room.attach(ws);
  room.message(ws, JSON.stringify({ t: 'hi', id: 'gm' }));
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c', proto: 3 } }));
  const msgs = () => sent.filter(m => m.from === 'db' && m.d.t === 'data').map(m => m.d.d);
  const snap = msgs()[0];
  assert.equal(snap.dataVersion, 0);
  assert.equal(snap.legacy.trophy_character.length, 11);
  const docs = upgrade(snap.dataVersion, { docs: {}, legacy: snap.legacy });  // what the page does
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c', d: { t: 'migrate', rid: 1, from: 0, to: DATA_VERSION, docs } } }));
  assert.equal(msgs().find(m => m.rid === 1).ok, true);
  const after = new DocStore(nodeSql(file));
  assert.equal(after.dataVersion, DATA_VERSION);
  assert.equal(after.allDocs().length, Object.keys(docs).length);
  assert.equal(after.snapshot().legacy, undefined);
  assert.equal(nodeSql(file).all(`SELECT COUNT(*) AS n FROM trophy_character`)[0].n, 11, 'old tables kept as they were');
});

test('data from a newer page is refused, versions are checked', () => {
  assert.throws(() => upgrade(DATA_VERSION + 1, {}), /newer/);
  assert.throws(() => upgrade(-1, {}), /Unknown/);
  assert.deepEqual(upgrade(DATA_VERSION, { docs: { 'character/a': { x: 1 } } }), { 'character/a': { x: 1 } });
  assert.deepEqual(upgrade(0, {}), {}, 'a brand new room starts empty');
});

// --- rules ---------------------------------------------------------------------------

test('new character gets six backpack slots', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'new_character');
  assert.equal(v.childrenOf('backpack', id).length, 6);
  const c = v.get('character', id);
  assert.equal(c.ruin, 1); assert.equal(c.hireling, false); assert.match(c.created_at, /Z$/);
});

test('powers raise Ruin and Burden past three; removing one lowers Ruin', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'new_character');
  for (const n of ['a', 'b', 'c', 'd']) run(v, 'add_child', { id, kind: 'power', name: n });
  assert.equal(v.get('character', id).ruin, 5);
  assert.equal(burdenBase(v, id), 2);
  const p = v.childrenOf('power', id);
  assert.deepEqual(p.map(r => r.position), [0, 1, 2, 3]);
  run(v, 'remove_child', { kind: 'power', item: p[0].id });
  assert.equal(v.get('character', id).ruin, 4);
});

test('burden adjustment keeps the offset relative to the derived value', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'new_character');
  run(v, 'adjust_burden', { id, delta: -1 });
  run(v, 'adjust_burden', { id, delta: -1 }); // floored at 0
  assert.equal(v.get('character', id).burden_offset, -1);
  run(v, 'add_child', { id, kind: 'combat', name: 'Spear', combat_kind: 'weapon' });
  assert.equal(burdenOf(v, v.get('character', id)), 1);
});

test('field rules: trimming, clamping, ruin toggle, ammo toggle, uses', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'new_character');
  run(v, 'save_field', { id, field: 'name', value: '  Evian  ' });
  run(v, 'save_field', { id, field: 'hoard', value: '99' });
  run(v, 'save_field', { id, field: 'coin', value: '-5' });
  run(v, 'set_ruin', { id, n: 3 }); run(v, 'set_ruin', { id, n: 3 });
  const c = v.get('character', id);
  assert.equal(c.name, 'Evian'); assert.equal(c.hoard, 50); assert.equal(c.coin, 0); assert.equal(c.ruin, 2);
  const w = run(v, 'add_child', { id, kind: 'combat', name: 'Bow', combat_kind: 'weapon' }).id;
  run(v, 'set_ammo', { item: w, n: 2 }); run(v, 'set_ammo', { item: w, n: 2 });
  assert.equal(v.get('combat', w).ammo, 1);
  const slot = v.childrenOf('backpack', id)[0];
  run(v, 'adjust_uses', { item: slot.id, delta: -1 }); run(v, 'adjust_uses', { item: slot.id, delta: 2 });
  assert.equal(v.get('backpack', slot.id).uses, 2);
  assert.throws(() => compute(v, 'save_field', { id, field: 'ruin', value: 6 }), RuleError);
  assert.throws(() => compute(v, 'remove_child', { kind: 'backpack', item: slot.id }), /fixed/);
});

test('deleting a character removes its records', () => {
  const { page, run, store } = setup();
  const v = page();
  const { id } = run(v, 'new_character');
  run(v, 'add_child', { id, kind: 'skill', name: 'Climb' });
  run(v, 'delete_character', { id });
  assert.equal(store.allDocs().length, 0);
});

test('records from the Django era work with the rules', () => {
  const { page, run } = setup(fromDjangoDump(dump));
  const v = page();
  const lora = v.all('character').find(c => c.name === 'Lora');
  run(v, 'add_child', { id: lora.id, kind: 'skill', name: 'New' });
  const skills = v.childrenOf('skill', lora.id);
  assert.equal(skills.at(-1).name, 'New');
  assert.equal(skills.at(-1).position, Math.max(...skills.slice(0, -1).map(s => s.position)) + 1);
  run(v, 'toggle_flag', { id: lora.id, field: 'archived' });
  assert.equal(v.get('character', lora.id).archived, true);
});

test('roller: faces come from the click, a die added meanwhile is left alone, sections keep names', () => {
  const { page, run } = setup();
  const v = page();
  run(v, 'roller_add_die', { color: 'light' }); run(v, 'roller_add_die', { color: 'dark' });
  assert.throws(() => compute(v, 'roller_add_die', { color: 'red' }), /colour/);
  const [l, d] = v.get('roller', 'main').mat;
  run(v, 'roller_roll', { values: { [l.id]: 6, [d.id]: 2 } });
  assert.deepEqual(v.get('roller', 'main').mat.map(x => [x.value, x.roll]), [[6, 1], [2, 1]]);
  for (const bad of [0, 7, 2.5, '3']) assert.throws(() => compute(v, 'roller_roll', { values: { [l.id]: bad } }), /1 to 6/);
  run(v, 'roller_add_section', { name: ' Evian ' });
  const sid = v.get('roller', 'main').sections[0].id;
  run(v, 'roller_section_add_die', { sid, color: 'dark' });
  const die = v.get('roller', 'main').sections[0].dice[0];
  run(v, 'roller_section_roll', { sid, values: { [die.id]: 4 } });
  run(v, 'roller_rename_section', { sid, name: 'Lora' });
  run(v, 'roller_clear'); run(v, 'roller_clear_sections');
  const r = v.get('roller', 'main');
  assert.deepEqual(r.mat, []); assert.deepEqual(r.sections[0].dice, []); assert.equal(r.sections[0].name, 'Lora');
  run(v, 'roller_remove_section', { sid });
  assert.deepEqual(v.get('roller', 'main').sections, []);
});

test('bestiary: add, edit, habits, remove', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'monster_add');
  const { id: id2 } = run(v, 'monster_add');
  assert.equal(v.get('monster', id2).position, 1);
  run(v, 'monster_save', { id, field: 'name', value: '  Kulpsis ' });
  run(v, 'monster_save', { id, field: 'endurance', value: '-3' });
  run(v, 'monster_save_habit', { id, n: 3, value: 'Lurks' });
  assert.throws(() => compute(v, 'monster_save_habit', { id, n: 7, value: 'x' }));
  const m = v.get('monster', id);
  assert.equal(m.name, 'Kulpsis'); assert.equal(m.endurance, 0);
  assert.deepEqual(m.habits, ['', '', 'Lurks', '', '', '']);
  run(v, 'monster_remove', { id });
  assert.equal(v.get('monster', id), null);
});

// --- two pages at once ---------------------------------------------------------------

test('two pages changing the same thing: the later one is refused, then recomputed on fresh data', () => {
  const { page, sync, run, store } = setup();
  const a = page();
  const { id } = run(a, 'new_character');
  const slot = a.childrenOf('backpack', id)[0].id;
  const b = page();
  // both pages see uses = 0 and press +1 at the same moment
  const fromA = compute(a, 'adjust_uses', { item: slot, delta: 1 });
  const fromB = compute(b, 'adjust_uses', { item: slot, delta: 1 });
  store.write({ version: DATA_VERSION, writes: fromA.writes });
  assert.throws(() => store.write({ version: DATA_VERSION, writes: fromB.writes }), e => e.code === 'conflict');
  sync(b);                                                // b receives a's change
  store.write({ version: DATA_VERSION, writes: compute(b, 'adjust_uses', { item: slot, delta: 1 }).writes });
  sync(a);
  assert.equal(a.get('backpack', slot).uses, 2, 'both presses counted');
  // text saves touch only their own field, so they never collide
  const t1 = compute(a, 'save_field', { id, field: 'name', value: 'A' });
  const t2 = compute(b, 'save_field', { id, field: 'look', value: 'tall' });
  store.write({ version: DATA_VERSION, writes: t1.writes });
  store.write({ version: DATA_VERSION, writes: t2.writes });
  sync(a);
  assert.equal(a.get('character', id).name, 'A'); assert.equal(a.get('character', id).look, 'tall');
  // two powers added at once: both kept, Ruin counts both after the retry
  const p1 = compute(a, 'add_child', { id, kind: 'power', name: 'P1' });
  const p2 = compute(b, 'add_child', { id, kind: 'power', name: 'P2' });
  store.write({ version: DATA_VERSION, writes: p1.writes });
  assert.throws(() => store.write({ version: DATA_VERSION, writes: p2.writes }), e => e.code === 'conflict');
  sync(b);
  store.write({ version: DATA_VERSION, writes: compute(b, 'add_child', { id, kind: 'power', name: 'P2' }).writes });
  sync(a);
  assert.deepEqual(a.childrenOf('power', id).map(p => p.name), ['P1', 'P2']);
  assert.equal(a.get('character', id).ruin, 3);
});

test('people: generated look and equipment kept, fields edited, removed', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'person_add', { look: 'Gaunt, raspy, smoky', equipment: 'Bayonet, Cloak, Bucket' });
  const { id: id2 } = run(v, 'person_add', {});
  assert.equal(v.get('person', id2).position, 1);
  let p = v.get('person', id);
  assert.equal(p.look, 'Gaunt, raspy, smoky'); assert.equal(p.equipment, 'Bayonet, Cloak, Bucket');
  assert.deepEqual([p.name, p.title, p.location, p.description], ['', '', '', '']);
  run(v, 'person_save', { id, field: 'name', value: '  Old Marta ' });
  run(v, 'person_save', { id, field: 'description', value: 'Knows the **tunnels**.\nOwes Lora.' });
  assert.throws(() => compute(v, 'person_save', { id, field: 'ruin', value: 1 }), /Unknown field/);
  p = v.get('person', id);
  assert.equal(p.name, 'Old Marta'); assert.equal(p.description, 'Knows the **tunnels**.\nOwes Lora.');
  run(v, 'person_remove', { id });
  assert.equal(v.get('person', id), null);
  assert.throws(() => compute(v, 'person_save', { id, field: 'name', value: 'x' }), /no longer exists/);
});

test('people: the die buttons add one item to Look or Equipment', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'person_add', { look: 'Gaunt, raspy, smoky', equipment: 'Bayonet, Cloak' });
  run(v, 'person_append', { id, field: 'look', value: 'tattooed' });
  run(v, 'person_append', { id, field: 'equipment', value: 'Bucket' });
  assert.equal(v.get('person', id).look, 'Gaunt, raspy, smoky, tattooed');
  assert.equal(v.get('person', id).equipment, 'Bayonet, Cloak, Bucket');
  const { id: empty } = run(v, 'person_add', {});
  run(v, 'person_append', { id: empty, field: 'look', value: 'hollow-eyed' });
  assert.equal(v.get('person', empty).look, 'Hollow-eyed', 'the first item starts with a capital');
  assert.throws(() => compute(v, 'person_append', { id, field: 'name', value: 'x' }), /Unknown field/);
  assert.deepEqual(compute(v, 'person_append', { id, field: 'look', value: '  ' }).writes, []);
});

test('version 2: equipment of existing people becomes a comma-separated list, nothing else changes', () => {
  const v1 = {
    ...fromDjangoDump(dump),
    'person/a': { name: 'Old Marta', title: '', location: '', look: 'Gaunt', equipment: 'Rusty lantern\nFerry pole\n\n Rope ',
      description: 'Line one\nLine two', position: 0, created_at: '2026-11-04T10:00:00.000Z' },
    'person/b': { name: 'Nobody', title: '', location: '', look: '', equipment: '', description: '', position: 1, created_at: '2026-11-04T10:00:00.000Z' },
  };
  const v2 = upgrade(1, { docs: v1 });
  assert.equal(v2['person/a'].equipment, 'Rusty lantern, Ferry pole, Rope');
  assert.equal(v2['person/a'].description, 'Line one\nLine two', 'only equipment changes');
  assert.equal(v2['person/b'].equipment, '');
  for (const k of Object.keys(v1)) if (!k.startsWith('person/')) assert.deepEqual(v2[k], v1[k], k);
  // a room at version 1 is upgraded through the relay like any other upgrade, with a backup
  const store = new DocStore(nodeSql());
  store.replaceAll({ docs: v1, dataVersion: 1, from: 0, reason: 'test' });
  store.replaceAll({ docs: upgrade(store.dataVersion, { docs: v1 }), dataVersion: DATA_VERSION, from: 1, reason: 'before upgrade to version 2' });
  assert.equal(store.getDoc('person/a').data.equipment, 'Rusty lantern, Ferry pole, Rope');
  assert.equal(store.listBackups()[0].dataVersion, 1);
});

test('notes: add, edit, remove', () => {
  const { page, run } = setup();
  const v = page();
  const { id } = run(v, 'note_add');
  const { id: id2 } = run(v, 'note_add');
  assert.equal(v.get('note', id2).position, 1);
  run(v, 'note_save', { id, field: 'title', value: '  The Baron ' });
  run(v, 'note_save', { id, field: 'description', value: 'Owes the ferry keeper.\nHides in the tower.' });
  assert.throws(() => compute(v, 'note_save', { id, field: 'name', value: 'x' }), /Unknown field/);
  assert.deepEqual([v.get('note', id).title, v.get('note', id).description], ['The Baron', 'Owes the ferry keeper.\nHides in the tower.']);
  run(v, 'note_remove', { id });
  assert.equal(v.get('note', id), null);
});
