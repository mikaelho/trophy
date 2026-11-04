// Tests of the generic document store and the room, without Cloudflare. Run: node --test worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DocStore, PROTOCOL } from '../src/store.mjs';
import { RoomCore } from '../src/room-core.mjs';
import { nodeSql } from '../src/node-sql.mjs';

const fresh = () => new DocStore(nodeSql());
const ready = () => { const db = fresh(); db.replaceAll({ docs: {}, dataVersion: 1, from: 0, reason: 'test' }); return db; };
const put = (key, data, extra = {}) => ({ op: 'put', key, data, ...extra });

// --- store -----------------------------------------------------------------------

test('store: a new room is at data version 0 with no documents', () => {
  const db = fresh();
  assert.deepEqual(db.snapshot(), { dataVersion: 0, docs: [] });
});

test('store: batches are all or nothing and bump revisions', () => {
  const db = ready();
  const r = db.write({ version: 1, writes: [put('character/a', { name: 'Evian', ruin: 1 }), put('skill/x', { character: 'a', name: 'Grace' })] });
  assert.equal(r.docs.length, 2); assert.equal(r.seq, 2);
  db.write({ version: 1, writes: [{ op: 'patch', key: 'character/a', fields: { ruin: 2 } }] });
  assert.deepEqual(db.getDoc('character/a'), { rev: 2, data: { name: 'Evian', ruin: 2 } });
  // the second write fails, so the first is not applied either
  assert.throws(() => db.write({ version: 1, writes: [
    { op: 'patch', key: 'character/a', fields: { name: 'X' } },
    { op: 'patch', key: 'character/nope', fields: { name: 'Y' } }] }), e => e.code === 'missing');
  assert.equal(db.getDoc('character/a').data.name, 'Evian');
  assert.equal(db.seq, 3);
  const d = db.write({ version: 1, writes: [{ op: 'delete', key: 'skill/x' }] });
  assert.deepEqual(d.deleted, ['skill/x']); assert.equal(db.getDoc('skill/x'), null);
});

test('store: a stale revision is a conflict and changes nothing', () => {
  const db = ready();
  db.write({ version: 1, writes: [put('roller/main', { mat: [] }, { ifRev: 0 })] });
  assert.throws(() => db.write({ version: 1, writes: [put('roller/main', { mat: [1] }, { ifRev: 0 })] }),
    e => e.code === 'conflict' && e.key === 'roller/main' && e.rev === 1);
  db.write({ version: 1, writes: [put('roller/main', { mat: [1] }, { ifRev: 1 })] });
  assert.throws(() => db.write({ version: 1, writes: [put('roller/main', { mat: [2] }, { ifRev: 1 })] }), e => e.code === 'conflict');
  assert.deepEqual(db.getDoc('roller/main').data.mat, [1]);
});

test('store: writes for another data version are refused', () => {
  const db = ready();
  assert.throws(() => db.write({ version: 0, writes: [put('character/a', {})] }), e => e.code === 'version' && e.dataVersion === 1);
});

test('store: a batch resent with the same id is applied once and gets the same result', () => {
  const db = ready();
  db.write({ version: 1, oid: 'o1', result: { id: 'a' }, writes: [{ op: 'put', key: 'character/a', data: { n: 1 } }] });
  const again = db.write({ version: 1, oid: 'o1', result: { id: 'zzz' }, writes: [{ op: 'put', key: 'character/a', data: { n: 2 } }] });
  assert.equal(again.duplicate, true); assert.deepEqual(again.result, { id: 'a' });
  assert.deepEqual(db.getDoc('character/a'), { rev: 1, data: { n: 1 } });
  // a refused batch is not remembered, so the same id can be retried
  assert.throws(() => db.write({ version: 1, oid: 'o2', writes: [put('character/a', {}, { ifRev: 7 })] }));
  db.write({ version: 1, oid: 'o2', writes: [put('character/a', { n: 3 }, { ifRev: 1 })] });
  assert.equal(db.getDoc('character/a').data.n, 3);
});

test('store: bad input is refused', () => {
  const db = ready();
  for (const key of ['', 'Character/a', 'character', 'character/', 'a/b/c', 'character/a b', 'x'.repeat(40) + '/a']) {
    assert.throws(() => db.write({ version: 1, writes: [put(key, {})] }), /key/, key);
  }
  assert.throws(() => db.write({ version: 1, writes: [put('character/a', [1])] }), /object/);
  assert.throws(() => db.write({ version: 1, writes: [put('character/a', { t: 'x'.repeat(300000) })] }), /too large/);
  assert.throws(() => db.write({ version: 1, writes: [] }), /Nothing/);
});

test('store: migrate replaces everything once, keeps a backup, and loses a race cleanly', () => {
  const db = ready();
  db.write({ version: 1, writes: [put('character/a', { name: 'Old' })] });
  db.replaceAll({ docs: { 'character/a': { name: 'New', extra: true } }, dataVersion: 2, from: 1, reason: 'before upgrade to version 2' });
  assert.equal(db.dataVersion, 2);
  assert.deepEqual(db.getDoc('character/a'), { rev: 1, data: { name: 'New', extra: true } });
  assert.throws(() => db.replaceAll({ docs: {}, dataVersion: 2, from: 1, reason: 'x' }), e => e.code === 'version');
  const [b] = db.listBackups();
  assert.equal(b.dataVersion, 1); assert.match(b.reason, /upgrade/);
  assert.deepEqual(db.getBackup(b.id).docs, { 'character/a': { name: 'Old' } });
});

test('store: only the last 10 backups are kept', () => {
  const db = ready();
  for (let i = 0; i < 13; i++) {
    db.write({ version: db.dataVersion, writes: [put('character/a', { i })] });
    db.replaceAll({ docs: { 'character/a': { i } }, dataVersion: 1, reason: 'before import' });
  }
  assert.equal(db.listBackups().length, 10);
});

test('store: version, numbering and documents survive a restart', () => {
  const file = mkdtempSync(tmpdir() + '/trophy-') + '/db.sqlite';
  const db1 = new DocStore(nodeSql(file));
  db1.replaceAll({ docs: { 'character/a': { n: 1 } }, dataVersion: 1, from: 0, reason: 'x' });
  db1.write({ version: 1, writes: [put('character/b', {})] });
  const db2 = new DocStore(nodeSql(file));
  assert.equal(db2.dataVersion, 1); assert.equal(db2.seq, db1.seq); assert.equal(db2.epoch, db1.epoch);
  assert.equal(db2.allDocs().length, 2);
});

test('store: tables of the previous relay version are handed over while at version 0, never changed', () => {
  const sql = nodeSql();
  sql.all(`CREATE TABLE trophy_character (id integer PRIMARY KEY, name text)`);
  sql.all(`INSERT INTO trophy_character (id, name) VALUES (5, 'Lora')`);
  sql.all(`CREATE TABLE _cf_KV (key text, value blob)`); // Cloudflare's own table: not handed over
  const db = new DocStore(sql);
  assert.deepEqual(db.snapshot().legacy, { trophy_character: [{ id: 5, name: 'Lora' }] });
  db.replaceAll({ docs: { 'character/5': { name: 'Lora' } }, dataVersion: 1, from: 0, reason: 'x' });
  assert.equal(db.snapshot().legacy, undefined);
  assert.equal(db.listBackups().length, 0); // nothing in docs yet, so nothing to back up
  assert.deepEqual(sql.all(`SELECT * FROM trophy_character`).map(r => ({ ...r })), [{ id: 5, name: 'Lora' }]);
});

// --- room ------------------------------------------------------------------------

class FakeWs {
  constructor() { this.sent = []; this.closed = null; }
  send(t) { this.sent.push(JSON.parse(t)); }
  close(code) { this.closed = code; }
  db() { return this.sent.filter(m => m.t === 'from' && m.from === 'db' && m.d.t === 'data').map(m => m.d.d); }
}

function join(room, id, proto = PROTOCOL) {
  const ws = new FakeWs();
  room.attach(ws);
  room.message(ws, JSON.stringify({ t: 'hi', id }));
  room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c-' + id, proto } }));
  ws.req = d => room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c-' + id, d } }));
  return ws;
}

test('room: snapshot, broadcast, replies, errors with codes', () => {
  const room = new RoomCore({ db: ready() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  const snap = a.db()[0];
  assert.equal(snap.t, 'snap'); assert.equal(snap.you, 'alice'); assert.equal(snap.dataVersion, 1); assert.equal(snap.protocol, PROTOCOL);
  a.req({ t: 'write', rid: 1, oid: 'x1', version: 1, result: { id: 'a' }, writes: [put('character/a', { name: 'E' })] });
  const chg = b.db().find(m => m.t === 'chg');
  assert.deepEqual(chg.docs, [['character/a', 1, { name: 'E' }]]); assert.equal(chg.seq, 2);
  assert.deepEqual(a.db().find(m => m.rid === 1), { t: 'reply', rid: 1, ok: true, result: { id: 'a' } });
  const order = a.db().map(m => m.t);
  assert.ok(order.indexOf('chg') < order.indexOf('reply'), 'the change arrives before the reply');
  a.req({ t: 'write', rid: 2, version: 1, writes: [put('character/a', {}, { ifRev: 0 })] });
  const r2 = a.db().find(m => m.rid === 2);
  assert.equal(r2.ok, false); assert.equal(r2.code, 'conflict'); assert.equal(r2.key, 'character/a'); assert.equal(r2.rev, 1);
  // a duplicate resend is answered but not broadcast again
  const before = b.db().length;
  a.req({ t: 'write', rid: 3, oid: 'x1', version: 1, writes: [put('character/a', { name: 'E' })] });
  assert.equal(b.db().length, before);
  assert.deepEqual(a.db().find(m => m.rid === 3).result, { id: 'a' });
});

test('room: migrate from version 0 reaches everyone as a fresh snapshot; a second migrate loses', () => {
  const room = new RoomCore({ db: fresh() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'migrate', rid: 1, from: 0, to: 1, docs: { 'character/a': { name: 'Lora' } } });
  b.req({ t: 'migrate', rid: 2, from: 0, to: 1, docs: { 'character/a': { name: 'Other' } } });
  assert.equal(a.db().find(m => m.rid === 1).ok, true);
  const lost = b.db().find(m => m.rid === 2);
  assert.equal(lost.ok, false); assert.equal(lost.code, 'version');
  const snap = b.db().filter(m => m.t === 'snap').at(-1);
  assert.equal(snap.dataVersion, 1); assert.deepEqual(snap.docs, [['character/a', 1, { name: 'Lora' }]]);
});

test('room: export, import, backups', () => {
  const room = new RoomCore({ db: ready() });
  const a = join(room, 'alice');
  a.req({ t: 'write', rid: 1, version: 1, writes: [put('monster/m', { name: 'Kulpsis' })] });
  a.req({ t: 'export', rid: 2 });
  const exp = a.db().find(m => m.rid === 2).result;
  assert.equal(exp.format, 'trophy-docs'); assert.deepEqual(exp.docs, { 'monster/m': { name: 'Kulpsis' } });
  a.req({ t: 'import', rid: 3, version: 1, docs: { 'monster/n': { name: 'Tentacrow' } } });
  assert.deepEqual(a.db().filter(m => m.t === 'snap').at(-1).docs, [['monster/n', 1, { name: 'Tentacrow' }]]);
  a.req({ t: 'backups', rid: 4 });
  const [b] = a.db().find(m => m.rid === 4).result;
  a.req({ t: 'backup', rid: 5, id: b.id });
  assert.deepEqual(a.db().find(m => m.rid === 5).result.docs, { 'monster/m': { name: 'Kulpsis' } });
});

test('room: locks are exclusive and freed on save and on disconnect', () => {
  const room = new RoomCore({ db: ready() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'lock', rid: 1, key: 'a:name' });
  b.req({ t: 'lock', rid: 2, key: 'a:name' });
  assert.equal(a.db().find(m => m.rid === 1).ok, true);
  assert.equal(b.db().find(m => m.rid === 2).ok, false);
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, { 'a:name': 'alice' });
  a.req({ t: 'write', rid: 3, version: 1, writes: [put('character/a', { name: 'X' })], release: 'a:name' });
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, {});
  b.req({ t: 'lock', rid: 4, key: 'a:look' });
  room.detach(b);
  assert.deepEqual(a.db().filter(m => m.t === 'locks').at(-1).locks, {});
});

test('room: stale sockets are closed, oversized messages get an error', () => {
  let t = 0;
  const room = new RoomCore({ db: ready(), now: () => t, maxMessage: 100 });
  const a = join(room, 'alice'), b = join(room, 'bob');
  t = 60_000; room.message(a, '{"t":"ping"}');
  t = 100_000; room.message(a, '{"t":"ping"}');
  assert.equal(b.closed, 1001); assert.equal(a.closed, null);
  room.message(a, JSON.stringify({ t: 'bc', d: 'x'.repeat(200) }));
  assert.equal(a.sent.at(-1).type, 'too-big'); assert.equal(a.closed, null);
});

test('room: plain relay still works and "db" is reserved', () => {
  const room = new RoomCore({ db: ready() });
  const a = join(room, 'alice'), b = join(room, 'bob');
  room.message(a, JSON.stringify({ t: 'bc', d: { hello: 1 } }));
  assert.deepEqual(b.sent.at(-1), { t: 'from', from: 'alice', d: { hello: 1 } });
  const c = new FakeWs(); room.attach(c); room.message(c, JSON.stringify({ t: 'hi', id: 'db' }));
  assert.equal(c.sent[0].type, 'bad-id');
});

test('room: a page of another protocol version is told to reload', () => {
  const room = new RoomCore({ db: ready() });
  const ws = join(room, 'old', 2);
  assert.deepEqual(ws.db(), [{ t: 'version', protocol: PROTOCOL }]);
});

test('room: rebuilt from saved connection state keeps peers, connections and locks', () => {
  const saved = new Map();
  const hooks = { save: (ws, s) => saved.set(ws, structuredClone(s)) };
  const db = ready();
  let room = new RoomCore({ db, hooks });
  const a = join(room, 'alice'), b = join(room, 'bob');
  a.req({ t: 'lock', rid: 1, key: 'a:name' });
  room = new RoomCore({ db, hooks }); // unloaded and built again, as after hibernation
  for (const ws of [a, b]) room.restore(ws, saved.get(ws));
  const req = (ws, id) => d => room.message(ws, JSON.stringify({ t: 'to', to: 'db', d: { t: 'data', cid: 'c-' + id, d } }));
  b.req = req(b, 'bob'); a.req = req(a, 'alice');
  b.req({ t: 'lock', rid: 2, key: 'a:name' });
  assert.equal(b.db().find(m => m.rid === 2).ok, false);
  a.req({ t: 'write', rid: 3, version: 1, writes: [put('character/a', {})], release: 'a:name' });
  assert.equal(b.db().filter(m => m.t === 'chg').at(-1).seq, 2); // numbering continues
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, {});
});

test('room: automatic pongs count as signs of life', () => {
  let t = 0;
  const auto = new Map();
  const room = new RoomCore({ db: ready(), now: () => t, hooks: { lastSeen: ws => auto.get(ws) || 0 } });
  const a = join(room, 'alice'), b = join(room, 'bob');
  t = 100_000; auto.set(b, 95_000);
  room.message(a, '{"t":"bc","d":1}');
  assert.equal(b.closed, null);
  t = 200_000; room.message(a, '{"t":"bc","d":2}');
  assert.equal(b.closed, 1001);
});
