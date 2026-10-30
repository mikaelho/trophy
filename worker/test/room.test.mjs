// Tests of the game database and the room, without Cloudflare. Run: node --test worker/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrophyDB } from '../src/trophy-db.mjs';
import { RoomCore } from '../src/room-core.mjs';
import { nodeSql } from '../src/node-sql.mjs';

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
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c-' + id } }));
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
