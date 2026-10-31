// Runs worker.js in a stand-in for the Cloudflare runtime: SQLite storage through node:sqlite,
// the WebSocket Hibernation API (acceptWebSocket, getWebSockets, attachments, automatic
// ping responses, alarms) as Cloudflare documents it. "Hibernation" = throwing the Room
// object away and building a new one on the same storage and connections, which is what
// Cloudflare does. This checks worker.js's use of the API, not the real runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL } from '../src/schema.mjs';

class WebSocketRequestResponsePair {
  constructor(request, response) { this.request = request; this.response = response; }
}
globalThis.WebSocketRequestResponsePair = WebSocketRequestResponsePair;
const { default: worker, Room } = await import('../src/worker.js');

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sockets = new Set();
  const ctx = {
    auto: null, alarmAt: null,
    storage: {
      sql: { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } },
      transactionSync(fn) {
        db.exec('BEGIN');
        try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
      },
      getAlarm: async () => ctx.alarmAt,
      setAlarm: async at => { ctx.alarmAt = at; },
    },
    acceptWebSocket: ws => { sockets.add(ws); ws.ctx = ctx; },
    getWebSockets: () => [...sockets].filter(ws => !ws.closed),
    setWebSocketAutoResponse: pair => { ctx.auto = pair; },
    getWebSocketAutoResponseTimestamp: ws => ws.autoAt || null,
  };
  return ctx;
}

class FakeWs {
  constructor() { this.sent = []; this.att = null; this.closed = null; }
  send(t) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(t)); }
  close(code) { this.closed = code ?? 1000; }
  serializeAttachment(v) { const s = JSON.stringify(v); if (s.length > 16384) throw new Error('too big'); this.att = JSON.parse(s); }
  deserializeAttachment() { return this.att; }
  db() { return this.sent.filter(m => m.t === 'from' && m.from === 'db' && m.d.t === 'data').map(m => m.d.d); }
}

// What the runtime does with a message from a browser.
async function deliver(ctx, room, ws, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (ctx.auto && text === ctx.auto.request) { ws.sent.push(JSON.parse(ctx.auto.response)); ws.autoAt = new Date(); return; }
  await room().webSocketMessage(ws, text);
}

async function join(ctx, room, id) {
  const ws = new FakeWs();
  ctx.acceptWebSocket(ws); room().core.attach(ws); // what Room.fetch() does
  await deliver(ctx, room, ws, { t: 'hi', id });
  await deliver(ctx, room, ws, { t: 'to', to: 'db', d: { t: 'connect', cid: 'c-' + id, proto: PROTOCOL } });
  ws.req = d => deliver(ctx, room, ws, { t: 'to', to: 'db', d: { t: 'data', cid: 'c-' + id, d } });
  return ws;
}

test('worker: a game survives hibernation between every message', async () => {
  const ctx = fakeCtx();
  let current = new Room(ctx, {});
  const room = () => current;
  const hibernate = () => { current = new Room(ctx, {}); };

  const a = await join(ctx, room, 'alice'); hibernate();
  const b = await join(ctx, room, 'bob'); hibernate();
  assert.equal(a.db()[0].t, 'snap'); assert.equal(a.db()[0].protocol, PROTOCOL);

  await a.req({ t: 'op', rid: 1, oid: 'o1', op: 'new_character' }); hibernate();
  const id = a.db().find(m => m.rid === 1).result.id;
  assert.equal(b.db().find(m => m.t === 'chg').seq, 1);

  await a.req({ t: 'lock', rid: 2, key: `${id}:name` }); hibernate();
  await b.req({ t: 'lock', rid: 3, key: `${id}:name` }); hibernate();
  assert.equal(b.db().find(m => m.rid === 3).ok, false, 'lock kept across hibernation');
  assert.ok(ctx.alarmAt, 'a sweep is scheduled while locks are held');

  // the reply to this op is "lost"; the browser resends it after reconnecting
  await a.req({ t: 'op', rid: 4, oid: 'o2', op: 'add_child', args: { id, kind: 'power', name: 'Ward' }, release: `${id}:name` });
  hibernate();
  await a.req({ t: 'op', rid: 5, oid: 'o2', op: 'add_child', args: { id, kind: 'power', name: 'Ward' } });
  const chgs = b.db().filter(m => m.t === 'chg');
  assert.deepEqual(chgs.map(m => m.seq), [1, 2], 'numbering continues, duplicate not applied');
  assert.deepEqual(b.db().filter(m => m.t === 'locks').at(-1).locks, {});

  // pings are answered by the runtime and do not reach the room
  const before = b.sent.length;
  await deliver(ctx, room, b, '{"t":"ping"}');
  assert.deepEqual(b.sent.slice(before), [{ t: 'pong' }]);

  // plain relaying between peers still works after hibernation
  hibernate();
  await deliver(ctx, room, a, { t: 'to', to: 'bob', d: { hello: 1 } });
  assert.deepEqual(b.sent.at(-1), { t: 'from', from: 'alice', d: { hello: 1 } });
});

test('worker: a dead connection holding a lock is swept by the alarm', async () => {
  const ctx = fakeCtx();
  let current = new Room(ctx, {});
  const room = () => current;
  const a = await join(ctx, room, 'alice');
  const b = await join(ctx, room, 'bob');
  await a.req({ t: 'op', rid: 1, op: 'new_character' });
  const id = a.db().find(m => m.rid === 1).result.id;
  await b.req({ t: 'lock', rid: 2, key: `${id}:look` });
  // b's phone goes to sleep: nothing more from it. a keeps pinging (answered automatically).
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 120_000;
    a.autoAt = new Date(Date.now());
    current = new Room(ctx, {});            // woken by the alarm
    await current.alarm();
    assert.equal(b.closed, 1001);
    assert.equal(a.closed, null);
    assert.deepEqual(a.db().filter(m => m.t === 'locks').at(-1).locks, {});
  } finally { Date.now = realNow; }
});

test('worker: /check reports reachability, secret and protocol', async () => {
  const env = { RELAY_SECRET: 'sésame' };
  const enc = s => Buffer.from(s).toString('base64url');
  const ask = async key => {
    const r = await worker.fetch(new Request('https://relay.example/check', key == null ? {} : { headers: { 'X-Relay-Key': key } }), env);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    return r.json();
  };
  assert.deepEqual(await ask(enc('sésame')), { service: 'trophy-relay', protocol: PROTOCOL, key: 'ok' });
  assert.equal((await ask(enc('nope'))).key, 'wrong');
  assert.equal((await ask(null)).key, 'missing');
  const pre = await worker.fetch(new Request('https://relay.example/check', { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  const ws = await worker.fetch(new Request('https://relay.example/room', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'vodjs-relay, k.' + enc('nope') } }), env);
  assert.equal(ws.status, 403);
});
