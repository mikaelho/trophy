// Tests of the game database and the room, without Cloudflare. Run: node --test worker/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrophyDB } from '../src/trophy-db.mjs';
import { RoomCore } from '../src/room-core.mjs';
import { nodeSql } from '../src/node-sql.mjs';
import { PROTOCOL } from '../src/schema.mjs';

const fresh = () => new TrophyDB(nodeSql());

test('new character gets six backpack slots', () => {
  const db = fresh();
  const { result, changed } = db.apply('new_character');
  assert.equal(changed.filter(([m]) => m === 'backpackitem').length, 6);
  const c = db.get('character', result.id);
  assert.equal(c.ruin, 1); assert.equal(c.hireling, false); assert.match(c.created_at, /Z$/);
});

test('powers raise Ruin and Burden past three', () => {
  const db = fresh();
  const { id } = db.apply('new_character').result;
  for (const n of ['a', 'b', 'c', 'd']) db.apply('add_child', { id, kind: 'power', name: n });
  assert.equal(db.get('character', id).ruin, 5);
  assert.equal(db.burdenBase(id), 2);
  const p = db.rows('power', 'WHERE character_id = ?', id);
  assert.deepEqual(p.map(r => r.position), [0, 1, 2, 3]);
  db.apply('remove_child', { kind: 'power', item: p[0].id });
  assert.equal(db.get('character', id).ruin, 4);
});

test('burden adjustment keeps the offset relative to the derived value', () => {
  const db = fresh();
  const { id } = db.apply('new_character').result;
  db.apply('adjust_burden', { id, delta: -1 });
  db.apply('adjust_burden', { id, delta: -1 }); // floored at 0
  assert.equal(db.get('character', id).burden_offset, -1);
  db.apply('add_child', { id, kind: 'combat', name: 'Spear', combat_kind: 'weapon' });
  assert.equal(db.burdenBase(id) + db.get('character', id).burden_offset, 1);
});

test('field rules: trimming, clamping, ruin toggle, ammo toggle', () => {
  const db = fresh();
  const { id } = db.apply('new_character').result;
  db.apply('save_field', { id, field: 'name', value: '  Evian  ' });
  db.apply('save_field', { id, field: 'hoard', value: '99' });
  db.apply('save_field', { id, field: 'coin', value: '-5' });
  db.apply('set_ruin', { id, n: 3 }); db.apply('set_ruin', { id, n: 3 });
  const c = db.get('character', id);
  assert.equal(c.name, 'Evian'); assert.equal(c.hoard, 50); assert.equal(c.coin, 0); assert.equal(c.ruin, 2);
  const w = db.apply('add_child', { id, kind: 'combat', name: 'Bow', combat_kind: 'weapon' }).result.id;
  db.apply('set_ammo', { item: w, n: 2 }); db.apply('set_ammo', { item: w, n: 2 });
  assert.equal(db.get('combatitem', w).ammo, 1);
  assert.throws(() => db.apply('save_field', { id, field: 'ruin', value: 6 }), /Unknown field/);
});

test('deleting a character removes its rows', () => {
  const db = fresh();
  const { id } = db.apply('new_character').result;
  db.apply('add_child', { id, kind: 'skill', name: 'Climb' });
  const { deleted } = db.apply('delete_character', { id });
  assert.equal(deleted.length, 8); // character + 6 backpack + 1 skill
  assert.equal(db.rows('backpackitem').length, 0);
});

test('the existing Django dump round-trips', () => {
  const dump = JSON.parse(readFileSync(new URL('../../trophy-db.json', import.meta.url), 'utf8'));
  const db = fresh();
  const n = db.importDump(dump);
  const trophy = dump.filter(x => x.model.startsWith('trophy.'));
  assert.equal(n, trophy.length);
  const back = db.exportDump();
  const key = x => x.model + ':' + x.pk;
  const orig = new Map(trophy.map(x => [key(x), x]));
  assert.equal(back.length, trophy.length);
  for (const x of back) assert.deepEqual(x.fields, orig.get(key(x)).fields, key(x));
  // ids continue after the imported ones
  const { id } = db.apply('new_character').result;
  assert.ok(id > Math.max(...trophy.filter(x => x.model === 'trophy.character').map(x => x.pk)));
});

test('a bad import changes nothing', () => {
  const db = fresh();
  db.apply('new_character');
  assert.throws(() => db.importDump([{ model: 'trophy.character', pk: 1, fields: { ruin: -3 } }]));
  assert.equal(db.rows('character').length, 1);
  assert.throws(() => db.importDump({}), /not a database dump/);
});

// --- room ---------------------------------------------------------------------

class FakeWs {
  constructor() { this.sent = []; this.closed = null; }
  send(t) { this.sent.push(JSON.parse(t)); }
  close(code) { this.closed = code; }
  // messages from the db peer, unwrapped
  db() { return this.sent.filter(m => m.t === 'from' && m.from === 'db' && m.d.t === 'data').map(m => m.d.d); }
}

function join(room, id) {
  const ws = new FakeWs();
  room.attach(ws);
  room.message(ws, JSON.stringify({ t: 'hi', id }));
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c-' + id, proto: PROTOCOL } }));
  ws.req = d => room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c-' + id, d } }));
  return ws;
}

test('room: snapshot, broadcast, replies', () => {
  const room = new RoomCore({ db: fresh() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  assert.equal(a.db()[0].t, 'snap'); assert.equal(a.db()[0].you, 'alice');
  a.req({ t: 'op', rid: 1, op: 'new_character' });
  const chg = b.db().find(m => m.t === 'chg');
  assert.equal(chg.seq, 1); assert.equal(chg.rows.length, 7);
  const rep = a.db().find(m => m.t === 'reply');
  assert.equal(rep.ok, true); assert.ok(rep.result.id);
  // the change arrives before the reply, so the store is up to date when the reply resolves
  const order = a.db().map(m => m.t);
  assert.ok(order.indexOf('chg') < order.indexOf('reply'));
  a.req({ t: 'op', rid: 2, op: 'nope' });
  assert.equal(a.db().at(-1).ok, false); assert.match(a.db().at(-1).error, /Unknown operation/);
});

test('room: locks are exclusive and freed on save and on disconnect', () => {
  const room = new RoomCore({ db: fresh() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'op', rid: 1, op: 'new_character' });
  const id = a.db().find(m => m.t === 'reply').result.id;
  a.req({ t: 'lock', rid: 2, key: `${id}:name` });
  b.req({ t: 'lock', rid: 3, key: `${id}:name` });
  assert.equal(a.db().find(m => m.rid === 2).ok, true);
  assert.equal(b.db().find(m => m.rid === 3).ok, false);
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, { [`${id}:name`]: 'alice' });
  a.req({ t: 'op', rid: 4, op: 'save_field', args: { id, field: 'name', value: 'X' }, release: `${id}:name` });
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, {});
  b.req({ t: 'lock', rid: 5, key: `${id}:look` });
  room.detach(b);
  assert.deepEqual(a.db().filter(m => m.t === 'locks').at(-1).locks, {});
});

test('room: stale sockets are closed, oversized messages get an error', () => {
  let t = 0;
  const room = new RoomCore({ db: fresh(), now: () => t, maxMessage: 100 });
  const a = join(room, 'alice'), b = join(room, 'bob');
  t = 60_000; room.message(a, '{"t":"ping"}');
  t = 100_000; room.message(a, '{"t":"ping"}');
  assert.equal(b.closed, 1001); assert.equal(a.closed, null);
  room.message(a, JSON.stringify({ t: 'bc', d: 'x'.repeat(200) }));
  assert.equal(a.sent.at(-1).type, 'too-big'); assert.equal(a.closed, null);
});

test('room: plain relay still works and "db" is reserved', () => {
  const room = new RoomCore({ db: fresh() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  room.message(a, JSON.stringify({ t: 'bc', d: { hello: 1 } }));
  assert.deepEqual(b.sent.at(-1), { t: 'from', from: 'alice', d: { hello: 1 } });
  const c = new FakeWs(); room.attach(c); room.message(c, JSON.stringify({ t: 'hi', id: 'db' }));
  assert.equal(c.sent[0].type, 'bad-id');
});

test('room: import sends a fresh snapshot to everyone', () => {
  const room = new RoomCore({ db: fresh() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'import', rid: 1, dump: [{ model: 'trophy.character', pk: 3, fields: { name: 'Lora' } }] });
  const snap = b.db().filter(m => m.t === 'snap').at(-1);
  assert.equal(snap.tables.character[0].name, 'Lora');
  assert.equal(snap.seq, 1);
});

test('an op resent with the same id is applied once and gets the same result', () => {
  const db = fresh();
  const a = db.apply('new_character', {}, 'op-1');
  const b = db.apply('new_character', {}, 'op-1');
  assert.equal(b.duplicate, true); assert.deepEqual(b.result, a.result);
  assert.equal(db.rows('character').length, 1);
  assert.equal(db.seq, 1);
  const { id } = a.result;
  db.apply('add_child', { id, kind: 'power', name: 'Ward' }, 'op-2');
  db.apply('add_child', { id, kind: 'power', name: 'Ward' }, 'op-2');
  assert.equal(db.rows('power').length, 1);
  assert.equal(db.get('character', id).ruin, 2);
});

test('a failing op changes nothing and does not count', () => {
  const db = fresh();
  const { id } = db.apply('new_character').result;
  assert.throws(() => db.apply('save_field', { id, field: 'bogus', value: 1 }, 'op-x'));
  assert.equal(db.seq, 1);
  assert.throws(() => db.apply('save_field', { id, field: 'bogus', value: 1 }, 'op-x')); // not remembered
});

test('change numbering and epoch survive a restart of the room', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = mkdtempSync(tmpdir() + '/trophy-') + '/db.sqlite';
  const db1 = new TrophyDB(nodeSql(file));
  db1.apply('new_character'); db1.apply('new_character');
  const db2 = new TrophyDB(nodeSql(file));
  assert.equal(db2.seq, 2); assert.equal(db2.epoch, db1.epoch);
});

test('room: an old page is told to reload', () => {
  const room = new RoomCore({ db: fresh() });
  const ws = new FakeWs(); room.attach(ws);
  room.message(ws, JSON.stringify({ t: 'hi', id: 'old' }));
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c' } }));
  assert.deepEqual(ws.db(), [{ t: 'version', protocol: PROTOCOL }]);
});

test('room: rebuilt from saved connection state keeps peers, connections and locks', () => {
  const saved = new Map();
  const hooks = { save: (ws, s) => saved.set(ws, structuredClone(s)) };
  const db = fresh();
  let room = new RoomCore({ db, hooks });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'op', rid: 1, op: 'new_character' });
  const id = a.db().find(m => m.t === 'reply').result.id;
  a.req({ t: 'lock', rid: 2, key: `${id}:name` });
  // the room is unloaded and built again, as after hibernation
  room = new RoomCore({ db, hooks });
  for (const ws of [a, b]) room.restore(ws, saved.get(ws));
  b.req = d => room.message(b, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c-bob', d } }));
  a.req = d => room.message(a, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c-alice', d } }));
  b.req({ t: 'lock', rid: 3, key: `${id}:name` });
  assert.equal(b.db().find(m => m.rid === 3).ok, false);
  a.req({ t: 'op', rid: 4, op: 'save_field', args: { id, field: 'name', value: 'Z' }, release: `${id}:name` });
  const chg = b.db().filter(m => m.t === 'chg').at(-1);
  assert.equal(chg.seq, 2); // continues: no resync needed
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, {});
  room.message(a, JSON.stringify({ t: 'bc', d: 'hello' }));
  assert.deepEqual(b.sent.at(-1), { t: 'from', from: 'alice', d: 'hello' });
});

test('room: automatic pongs count as signs of life', () => {
  let t = 0;
  const auto = new Map();
  const room = new RoomCore({ db: fresh(), now: () => t, hooks: { lastSeen: ws => auto.get(ws) || 0 } });
  const a = join(room, 'alice'), b = join(room, 'bob');
  t = 100_000; auto.set(b, 95_000);       // b only pinged (answered without the room)
  room.message(a, '{"t":"bc","d":1}');
  assert.equal(b.closed, null);
  t = 200_000; room.message(a, '{"t":"bc","d":2}');
  assert.equal(b.closed, 1001);
});

test('roller: dice are added, rolled with the faces the browser sends, cleared; sections keep names', () => {
  const db = fresh();
  db.apply('roller_add_die', { color: 'light' });
  db.apply('roller_add_die', { color: 'dark' });
  assert.throws(() => db.apply('roller_add_die', { color: 'red' }), /colour/);
  let [l, d] = db.get('roller', 1).mat;
  db.apply('roller_roll', { values: { [l.id]: 6, [d.id]: 2 } });
  let r = db.get('roller', 1);
  assert.deepEqual(r.mat.map(x => [x.value, x.roll]), [[6, 1], [2, 1]]);
  db.apply('roller_roll', { values: { [l.id]: 6, [d.id]: 2 } });
  assert.deepEqual(db.get('roller', 1).mat.map(x => x.roll), [2, 2]); // same faces, still a new roll
  const { id: sid } = db.apply('roller_add_section', { name: ' Evian ' }).result;
  db.apply('roller_section_add_die', { sid, color: 'dark' });
  const die = db.get('roller', 1).sections[0].dice[0];
  db.apply('roller_section_roll', { sid, values: { [die.id]: 4 } });
  db.apply('roller_rename_section', { sid, name: 'Lora' });
  r = db.get('roller', 1);
  assert.equal(r.sections[0].name, 'Lora'); assert.equal(r.sections[0].dice[0].value, 4);
  db.apply('roller_clear'); db.apply('roller_clear_sections');
  r = db.get('roller', 1);
  assert.deepEqual(r.mat, []); assert.deepEqual(r.sections[0].dice, []); assert.equal(r.sections[0].name, 'Lora');
  db.apply('roller_remove_section', { sid });
  assert.deepEqual(db.get('roller', 1).sections, []);
});

test('roller: only faces 1-6 are accepted; a die added meanwhile is left as it was', () => {
  const db = fresh();
  db.apply('roller_add_die', { color: 'light' });
  const [a] = db.get('roller', 1).mat;
  for (const bad of [0, 7, 2.5, '3', null]) {
    assert.throws(() => db.apply('roller_roll', { values: { [a.id]: bad } }), /1 to 6/);
  }
  assert.throws(() => db.apply('roller_roll', {}), /No dice values/);
  db.apply('roller_add_die', { color: 'dark' }); // someone adds a die after the roller looked
  db.apply('roller_roll', { values: { [a.id]: 5 } });
  assert.deepEqual(db.get('roller', 1).mat.map(x => x.value), [5, null]);
});

test('bestiary: add, edit, habits, remove; existing dump data works', () => {
  const db = fresh();
  const { id } = db.apply('monster_add').result;
  const { id: id2 } = db.apply('monster_add').result;
  assert.equal(db.get('monster', id2).position, 1);
  db.apply('monster_save', { id, field: 'name', value: '  Kulpsis ' });
  db.apply('monster_save', { id, field: 'endurance', value: '-3' });
  db.apply('monster_save_habit', { id, n: 3, value: 'Lurks' });
  assert.throws(() => db.apply('monster_save_habit', { id, n: 7, value: 'x' }));
  const m = db.get('monster', id);
  assert.equal(m.name, 'Kulpsis'); assert.equal(m.endurance, 0);
  assert.deepEqual(m.habits, ['', '', 'Lurks', '', '', '']);
  db.apply('monster_remove', { id });
  assert.equal(db.get('monster', id), null);
  // the Django dump's roller and monsters load and stay editable
  const dump = JSON.parse(readFileSync(new URL('../../trophy-db.json', import.meta.url), 'utf8'));
  db.importDump(dump);
  db.apply('roller_add_die', { color: 'dark' });
  assert.equal(db.get('roller', 1).sections.length, 2);
  const mid = db.rows('monster')[0].id;
  db.apply('monster_save_habit', { id: mid, n: 1, value: 'Hunts in packs' });
  assert.equal(db.get('monster', mid).habits[0], 'Hunts in packs');
});
