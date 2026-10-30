// One game room, independent of Cloudflare. It keeps the plain relay behaviour of the
// VoD relay (peers registering under an id and passing messages), and adds one built-in
// peer, "db", which owns the game database. Browsers connect to "db" with the normal
// transport (peer.connect('db')) and talk to it over that connection.
//
// Relay protocol (JSON text frames), unchanged from the VoD relay:
//   client -> relay  {t:'hi', id} | {t:'to', to, d} | {t:'bc', d} | {t:'ping'}
//   relay -> client  {t:'ok', id} | {t:'from', from, d} | {t:'err', type, ...} | {t:'pong'}
//   New error type: 'too-big' (message over the size limit; the connection stays open).
//
// Messages inside the "db" connection (the d of {t:'data', cid, d}):
//   client -> db  {t:'op', rid, op, args, release?}  run a write; release = lock key to free after it
//                 {t:'lock', rid, key}               take a field lock -> reply {ok}
//                 {t:'unlock', key}                  free a field lock
//                 {t:'resync'}                       ask for a fresh snapshot
//                 {t:'export', rid}                  -> reply {result: dump}
//                 {t:'import', rid, dump}            replace everything -> snapshot to all
//   db -> client  {t:'snap', epoch, seq, tables, locks, you}
//                 {t:'chg', epoch, seq, rows: [[model, row]], del: [[model, id]]}
//                 {t:'locks', locks: {key: peerId}}
//                 {t:'reply', rid, ok, result?, error?}
// `seq` increases by one with every change. A client that sees a gap asks for a resync.
// `epoch` changes whenever the room restarts, which also resets seq.

import { OpError } from './trophy-db.mjs';

const DB_ID = 'db';

export class RoomCore {
  constructor({ db, maxMessage = 1 << 20, staleMs = 70_000, now = () => Date.now() } = {}) {
    this.byId = new Map(); this.st = new Map();
    this.db = db; this.maxMessage = maxMessage; this.staleMs = staleMs; this.now = now;
    this.epoch = Math.random().toString(36).slice(2, 10); this.seq = 0;
    this.locks = new Map(); // lock key -> peer id
  }

  attach(ws) { this.st.set(ws, { id: null, seen: this.now(), dbCid: null }); }

  detach(ws) {
    const s = this.st.get(ws);
    this.st.delete(ws);
    if (!s || !s.id) return;
    if (this.byId.get(s.id) === ws) this.byId.delete(s.id);
    let freed = false;
    for (const [k, holder] of this.locks) if (holder === s.id) { this.locks.delete(k); freed = true; }
    if (freed) this.broadcastLocks();
  }

  // Close connections that have sent nothing for a while (a phone that went to sleep
  // without closing its socket). Clients ping every 25 s, so live ones never hit this.
  sweep() {
    const limit = this.now() - this.staleMs;
    for (const [ws, s] of [...this.st]) {
      if (s.seen < limit) { try { ws.close(1001, 'idle'); } catch (_) {} this.detach(ws); }
    }
  }

  message(ws, text) {
    const s = this.st.get(ws);
    if (!s) return;
    s.seen = this.now();
    this.sweep();
    const out = o => send(ws, o);
    if (typeof text !== 'string') return;
    if (text.length > this.maxMessage) return out({ t: 'err', type: 'too-big', limit: this.maxMessage });
    let m; try { m = JSON.parse(text); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hi') {
      if (s.id) return;
      const id = String(m.id || '');
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || id === DB_ID) { out({ t: 'err', type: 'bad-id' }); try { ws.close(1008, 'bad id'); } catch (_) {} return; }
      if (this.byId.has(id)) { out({ t: 'err', type: 'unavailable-id' }); try { ws.close(1000, 'id taken'); } catch (_) {} return; }
      s.id = id; this.byId.set(id, ws); out({ t: 'ok', id });
    } else if (!s.id) return;
    else if (m.t === 'to' && m.to === DB_ID) this.fromClient(ws, s, m.d);
    else if (m.t === 'to') {
      const dst = this.byId.get(String(m.to));
      if (!dst) return out({ t: 'err', type: 'peer-unavailable', to: m.to });
      send(dst, { t: 'from', from: s.id, d: m.d });
    } else if (m.t === 'bc') {
      const msg = JSON.stringify({ t: 'from', from: s.id, d: m.d });
      this.byId.forEach(dst => { if (dst !== ws) try { dst.send(msg); } catch (_) {} });
    } else if (m.t === 'ping') out({ t: 'pong' });
  }

  // --- the "db" peer ---------------------------------------------------------

  // Send a message to a client over its connection with the db peer.
  toClient(ws, payload) {
    const s = this.st.get(ws);
    if (s && s.dbCid) send(ws, { t: 'from', from: DB_ID, d: { t: 'data', cid: s.dbCid, d: payload } });
  }
  toAll(payload) { for (const [ws, s] of this.st) if (s.dbCid) this.toClient(ws, payload); }

  snapshotFor(s) {
    return { t: 'snap', epoch: this.epoch, seq: this.seq, tables: this.db.snapshot(), locks: Object.fromEntries(this.locks), you: s.id };
  }
  broadcastLocks() { this.toAll({ t: 'locks', locks: Object.fromEntries(this.locks) }); }

  fromClient(ws, s, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'connect') {
      s.dbCid = String(d.cid);
      send(ws, { t: 'from', from: DB_ID, d: { t: 'accept', cid: s.dbCid } });
      this.toClient(ws, this.snapshotFor(s));
      return;
    }
    if (d.t !== 'data' || d.cid !== s.dbCid || !d.d || typeof d.d !== 'object') return;
    const r = d.d, reply = o => this.toClient(ws, { t: 'reply', rid: r.rid, ...o });
    try {
      if (r.t === 'op') {
        const { result, changed, deleted } = this.db.apply(String(r.op), r.args || {});
        if (changed.length || deleted.length) {
          this.seq++;
          this.toAll({ t: 'chg', epoch: this.epoch, seq: this.seq, rows: changed, del: deleted });
        }
        if (r.release && this.locks.get(r.release) === s.id) { this.locks.delete(r.release); this.broadcastLocks(); }
        reply({ ok: true, result });
      } else if (r.t === 'lock') {
        const key = String(r.key || ''), holder = this.locks.get(key);
        if (!key || (holder && holder !== s.id)) return reply({ ok: false });
        if (!holder) { this.locks.set(key, s.id); this.broadcastLocks(); }
        reply({ ok: true });
      } else if (r.t === 'unlock') {
        if (this.locks.get(r.key) === s.id) { this.locks.delete(r.key); this.broadcastLocks(); }
      } else if (r.t === 'resync') {
        this.toClient(ws, this.snapshotFor(s));
      } else if (r.t === 'export') {
        reply({ ok: true, result: this.db.exportDump() });
      } else if (r.t === 'import') {
        const n = this.db.importDump(r.dump);
        this.seq++;
        for (const [w, st] of this.st) if (st.dbCid) this.toClient(w, this.snapshotFor(st));
        reply({ ok: true, result: { count: n } });
      }
    } catch (e) {
      // Operation errors go back to the caller; anything else is a bug, logged as such.
      if (!(e instanceof OpError)) console.error(e);
      reply({ ok: false, error: e instanceof OpError ? e.message : 'Internal error' });
    }
  }
}

function send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (_) {} }
