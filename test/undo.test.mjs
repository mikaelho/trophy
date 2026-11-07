// Undo/redo (docs/js/model/undo.js) against the real document store, with two pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DocStore } from '../worker/src/store.mjs';
import { nodeSql } from '../worker/src/node-sql.mjs';
import { DATA_VERSION, fromDjangoDump, upgrade } from '../docs/js/model/migrations.js';
import { compute } from '../docs/js/model/rules.js';
import { DocView } from '../docs/js/model/view.js';
import { record, revert, describe } from '../docs/js/model/undo.js';

const dump = JSON.parse(readFileSync(new URL('../trophy-db.json', import.meta.url), 'utf8'));

function setup(docs = {}) {
  const store = new DocStore(nodeSql());
  store.replaceAll({ docs, dataVersion: DATA_VERSION, from: 0, reason: 'test' });
  const sync = v => { v.load(store.allDocs()); return v; };
  const page = () => sync(new DocView());
  const write = (v, writes) => { const r = store.write({ version: DATA_VERSION, writes }); v.apply(r.docs, r.deleted); };
  // what data.js does: compute, record, send
  const run = (v, op, args = {}) => {
    const { writes, result } = compute(v, op, args);
    const step = record(v, writes, describe(v, op, args));
    write(v, writes);
    return { step, result };
  };
  // undo or redo one step; returns the step that reverses it, and what was skipped
  const back = (v, step) => {
    const r = revert(v, step);
    const again = record(v, r.writes, step.label);
    if (r.writes.length) write(v, r.writes);
    return { step: again, skipped: r.skipped, writes: r.writes };
  };
  return { store, page, sync, run, back };
}

test('undo and redo a field edit', () => {
  const { page, run, back } = setup();
  const v = page();
  const { result: { id } } = run(v, 'new_character');
  const { step } = run(v, 'save_field', { id, field: 'name', value: 'Evian' });
  assert.equal(step.label, 'a character: name'); // named as it was before the edit
  const undo = back(v, step);
  assert.equal(v.get('character', id).name, '');
  back(v, undo.step); // redo
  assert.equal(v.get('character', id).name, 'Evian');
});

test('undoing a character deletion brings back everything with the same ids', () => {
  const { page, run, back, store } = setup(upgrade(1, { docs: fromDjangoDump(dump) }));
  const v = page();
  const before = new Map(store.allDocs().map(([k, , d]) => [k, d]));
  const lora = v.all('character').find(c => c.name === 'Lora');
  const { step } = run(v, 'delete_character', { id: lora.id });
  assert.equal(step.label, 'delete Lora');
  assert.equal(v.get('character', lora.id), null);
  const undo = back(v, step);
  assert.deepEqual(undo.skipped, []);
  const after = new Map(store.allDocs().map(([k, , d]) => [k, d]));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [k, d] of before) assert.deepEqual(after.get(k), d, k);
  back(v, undo.step); // redo deletes again
  assert.equal(v.get('character', lora.id), null);
  assert.equal(v.childrenOf('skill', lora.id).length, 0);
});

test('undoing a new power removes it and lowers Ruin again', () => {
  const { page, run, back } = setup();
  const v = page();
  const { result: { id } } = run(v, 'new_character');
  const { step } = run(v, 'add_child', { id, kind: 'power', name: 'Ward' });
  assert.equal(step.label, 'add power "Ward"');
  assert.equal(v.get('character', id).ruin, 2);
  back(v, step);
  assert.equal(v.childrenOf('power', id).length, 0);
  assert.equal(v.get('character', id).ruin, 1);
});

test('what someone else changed since is left alone and reported', () => {
  const { page, sync, run, back } = setup();
  const a = page();
  const { result: { id } } = run(a, 'new_character');
  const { step } = run(a, 'add_child', { id, kind: 'power', name: 'Ward' }); // ruin 1 -> 2
  const b = sync(page());
  run(b, 'set_ruin', { id, n: 4 });                                           // b: ruin -> 4
  sync(a);
  const undo = back(a, step);
  assert.equal(a.childrenOf('power', id).length, 0, 'the power is removed');
  assert.equal(a.get('character', id).ruin, 4, "b's Ruin is kept");
  assert.deepEqual(undo.skipped, [`character/${id}`]);
});

test("someone else's change to another field of the same record does not block undo", () => {
  const { page, sync, run, back } = setup();
  const a = page();
  const { result: { id } } = run(a, 'new_character');
  const { step } = run(a, 'save_field', { id, field: 'name', value: 'Evian' });
  const b = sync(page());
  run(b, 'save_field', { id, field: 'look', value: 'tall' });
  sync(a);
  const undo = back(a, step);
  assert.deepEqual(undo.skipped, []);
  assert.equal(a.get('character', id).name, ''); assert.equal(a.get('character', id).look, 'tall');
});

test('a created record that someone has changed since is not removed', () => {
  const { page, sync, run, back } = setup();
  const a = page();
  const { result: { id } } = run(a, 'new_character');
  const { step, result } = run(a, 'add_child', { id, kind: 'skill', name: 'Climb' });
  const b = sync(page());
  run(b, 'rename_child', { kind: 'skill', item: result.id, name: 'Climb walls' });
  sync(a);
  const undo = back(a, step);
  assert.equal(a.get('skill', result.id).name, 'Climb walls');
  assert.deepEqual(undo.skipped, [`skill/${result.id}`]);
});

test('an undo computed on stale data is refused by the relay (and is then computed again)', () => {
  const { page, sync, run, store } = setup();
  const a = page();
  const { result: { id } } = run(a, 'new_character');
  const { step } = run(a, 'save_field', { id, field: 'name', value: 'Evian' });
  const b = sync(page());
  const stale = revert(a, step);                          // a computes the undo...
  run(b, 'save_field', { id, field: 'notes', value: 'x' }); // ...b changes the record meanwhile
  assert.throws(() => store.write({ version: DATA_VERSION, writes: stale.writes }), e => e.code === 'conflict');
  sync(a);
  store.write({ version: DATA_VERSION, writes: revert(a, step).writes });
  assert.equal(sync(page()).get('character', id).name, '');
});

test('undoing counters, flags and bestiary/people edits', () => {
  const { page, run, back } = setup();
  const v = page();
  const { result: { id } } = run(v, 'new_character');
  const slot = v.childrenOf('backpack', id)[0].id;
  const s1 = run(v, 'adjust_uses', { item: slot, delta: 2 }).step;
  const s2 = run(v, 'toggle_flag', { id, field: 'hireling' }).step;
  const m = run(v, 'monster_add').result.id;
  const s3 = run(v, 'monster_save_habit', { id: m, n: 2, value: 'Lurks' }).step;
  const p = run(v, 'person_add', { look: 'Gaunt' }).result.id;
  const s4 = run(v, 'person_remove', { id: p }).step;
  for (const s of [s4, s3, s2, s1]) back(v, s);
  assert.equal(v.get('backpack', slot).uses, 0);
  assert.equal(v.get('character', id).hireling, false);
  assert.deepEqual(v.get('monster', m).habits, ['', '', '', '', '', '']);
  assert.equal(v.get('person', p).look, 'Gaunt');
});
