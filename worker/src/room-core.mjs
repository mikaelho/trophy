// One game room, independent of Cloudflare. It keeps the plain relay behaviour of the
// VoD relay (peers registering under an id and passing messages), and adds one built-in
// peer, "db", which owns the game database. Browsers connect to "db" with the normal
// transport (peer.connect('db')) and talk to it over that connection.
//
// Relay protocol (JSON text frames), as in the VoD relay:
//   client -> relay  {t:'hi', id} | {t:'to', to, d} | {t:'bc', d} | {t:'ping'}
//   relay -> client  {t:'ok', id} | {t:'from', from, d} | {t:'err', type, ...} | {t:'pong'}
//   New error type: 'too-big' (message over the size limit; the connection stays open).
//
// Messages inside the "db" connection (the d of {t:'data', cid, d}). The room is a generic
// document store (store.mjs); the page owns the data layout, the rules and the migrations.
//   client -> db  {t:'connect', cid, proto}            (the connection request itself)
//                 {t:'write', rid, oid, version, writes, result?, release?}
//                                                    apply a batch (see store.mjs); oid = unique
//                                                    id, so a resend is applied once; result is
//                                                    echoed in the reply; release = lock key to free
//                 {t:'migrate', rid, from, to, docs} upgrade: replace all documents if still at `from`
//                 {t:'import', rid, version, docs}   replace all documents (backup kept)
//                 {t:'export', rid}                  -> reply {result: {format, dataVersion, docs}}
//                 {t:'backups', rid}                 -> reply {result: [{id, at, reason, dataVersion, size}]}
//                 {t:'backup', rid, id}              -> reply {result: {dataVersion, docs}}
//                 {t:'lock', rid, key}               take a field lock -> reply {ok}
//                 {t:'unlock', key}                  free a field lock
//                 {t:'resync'}                       ask for a fresh snapshot
//   db -> client  {t:'snap', protocol, epoch, seq, dataVersion, docs: [[key, rev, data]], legacy?, locks, you}
//                 {t:'chg', epoch, seq, docs: [[key, rev, data]], del: [key]}
//                 {t:'locks', locks: {key: peerId}}
//                 {t:'reply', rid, ok, result?, error?, code?, key?}   code: 'conflict' | 'version' | ...
//                 {t:'version', protocol}            the page is a different version: reload it
// `seq` increases by one with every change. A client that sees a gap asks for a resync.
// `epoch` identifies the database; seq continues across restarts of the room.
//
// The room can be stopped and rebuilt at any time (Cloudflare hibernates idle rooms and keeps
// the connections open). Everything it needs about a connection is handed to hooks.save, and
// restore() rebuilds the room from that. Hooks (all optional):
//   save(ws, state)       keep state with the connection (Cloudflare: ws.serializeAttachment)
//   lastSeen(ws)          time of the last automatic pong to this connection, in ms
//   locksChanged(any)     called when locks change; any = some lock is held

import { StoreError, PROTOCOL } from './store.mjs';

const DB_ID = 'db';

export class RoomCore {
  constructor({ db, maxMessage = 1 << 20, staleMs = 70_000, now = () => Date.now(), hooks = {} } = {}) {
    this.byId = new Map(); this.st = new Map();
    this.db = db; this.maxMessage = maxMessage; this.staleMs = staleMs; this.now = now; this.hooks = hooks;
    this.locks = new Map(); // lock key -> peer id
  }

  attach(ws) { this.st.set(ws, { id: null, seen: this.now(), dbCid: null }); }

  // Bring back a connection after the room was rebuilt, from what save() stored.
  restore(ws, saved) {
    const s = { id: null, seen: this.now(), dbCid: null };
    if (saved && typeof saved === 'object' && saved.id && !this.byId.has(saved.id)) {
      s.id = String(saved.id); s.dbCid = saved.dbCid || null; s.seen = Number(saved.seen) || s.seen;
      this.byId.set(s.id, ws);
      for (const k of saved.locks || []) if (!this.locks.has(k)) this.locks.set(k, s.id);
    }
    this.st.set(ws, s);
  }

  save(ws) {
    const s = this.st.get(ws);
    if (s && s.id && this.hooks.save) {
      this.hooks.save(ws, { id: s.id, dbCid: s.dbCid, seen: s.seen, locks: this.locksOf(s.id) });
    }
  }
  locksOf(id) { const out = []; for (const [k, h] of this.locks) if (h === id) out.push(k); return out; }
  lastSeen(ws, s) { return Math.max(s.seen, Number(this.hooks.lastSeen?.(ws)) || 0); }

  detach(ws) {
    const s = this.st.get(ws);
    this.st.delete(ws);
    if (!s || !s.id) return;
    if (this.byId.get(s.id) === ws) this.byId.delete(s.id);
    if (this.locksOf(s.id).length) {
      for (const k of this.locksOf(s.id)) this.locks.delete(k);
      this.locksUpdated(null);
    }
  }

  // Close connections that have sent nothing for a while (a phone that went to sleep
  // without closing its socket). Live clients ping every 5 s.
  sweep() {
    const limit = this.now() - this.staleMs;
    for (const [ws, s] of [...this.st]) {
      if (this.lastSeen(ws, s) < limit) { try { ws.close(1001, 'idle'); } catch (_) {} this.detach(ws); }
    }
  }

  message(ws, text) {
    if (!this.st.has(ws)) this.attach(ws);
    const s = this.st.get(ws);
    s.seen = this.now();
    this.sweep();
    if (!this.st.has(ws)) return; // cannot happen (just seen), but keeps the rest safe
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
      if (!dst) out({ t: 'err', type: 'peer-unavailable', to: m.to });
      else send(dst, { t: 'from', from: s.id, d: m.d });
    } else if (m.t === 'bc') {
      const msg = JSON.stringify({ t: 'from', from: s.id, d: m.d });
      this.byId.forEach(dst => { if (dst !== ws) try { dst.send(msg); } catch (_) {} });
    } else if (m.t === 'ping') out({ t: 'pong' });
    this.save(ws);
  }

  // --- the "db" peer ---------------------------------------------------------

  // Send a message to a client over its connection with the db peer.
  toClient(ws, payload) {
    const s = this.st.get(ws);
    if (s && s.dbCid) send(ws, { t: 'from', from: DB_ID, d: { t: 'data', cid: s.dbCid, d: payload } });
  }
  toAll(payload) {
    const text = JSON.stringify(payload);
    for (const [ws, s] of this.st) if (s.dbCid) sendRaw(ws, `{"t":"from","from":"${DB_ID}","d":{"t":"data","cid":${JSON.stringify(s.dbCid)},"d":${text}}}`);
  }

  snapshotFor(s) {
    return { t: 'snap', protocol: PROTOCOL, epoch: this.db.epoch, seq: this.db.seq, ...this.db.snapshot(),
      locks: Object.fromEntries(this.locks), you: s.id };
  }
  // Locks changed: tell everyone, keep the holder's saved state current, let the host know.
  locksUpdated(ws) {
    if (ws) this.save(ws);
    this.toAll({ t: 'locks', locks: Object.fromEntries(this.locks) });
    this.hooks.locksChanged?.(this.locks.size > 0);
  }

  fromClient(ws, s, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'connect') {
      s.dbCid = String(d.cid);
      send(ws, { t: 'from', from: DB_ID, d: { t: 'accept', cid: s.dbCid } });
      if (d.proto !== PROTOCOL) this.toClient(ws, { t: 'version', protocol: PROTOCOL });
      else this.toClient(ws, this.snapshotFor(s));
      return;
    }
    if (d.t !== 'data' || d.cid !== s.dbCid || !d.d || typeof d.d !== 'object') return;
    const r = d.d, reply = o => this.toClient(ws, { t: 'reply', rid: r.rid, ...o });
    try {
      if (r.t === 'write') {
        const { result, docs, deleted, seq, duplicate } = this.db.write({ version: r.version, writes: r.writes, oid: r.oid, result: r.result ?? null });
        if (!duplicate) this.toAll({ t: 'chg', epoch: this.db.epoch, seq, docs, del: deleted });
        if (r.release && this.locks.get(r.release) === s.id) { this.locks.delete(r.release); this.locksUpdated(ws); }
        reply({ ok: true, result });
      } else if (r.t === 'migrate' || r.t === 'import') {
        const migrate = r.t === 'migrate';
        this.db.replaceAll({ docs: r.docs, dataVersion: migrate ? r.to : r.version, from: migrate ? r.from : null,
          reason: migrate ? `before upgrade to version ${r.to}` : 'before import' });
        for (const [w, st] of this.st) if (st.dbCid) this.toClient(w, this.snapshotFor(st));
        reply({ ok: true, result: { count: Object.keys(r.docs).length } });
      } else if (r.t === 'backups') {
        reply({ ok: true, result: this.db.listBackups() });
      } else if (r.t === 'backup') {
        reply({ ok: true, result: this.db.getBackup(Number(r.id)) });
      } else if (r.t === 'lock') {
        const key = String(r.key || '').slice(0, 200), holder = this.locks.get(key);
        if (!key || (holder && holder !== s.id)) return reply({ ok: false, error: 'Someone is editing this.' });
        if (!holder) { this.locks.set(key, s.id); this.locksUpdated(ws); }
        reply({ ok: true });
      } else if (r.t === 'unlock') {
        if (this.locks.get(r.key) === s.id) { this.locks.delete(r.key); this.locksUpdated(ws); }
      } else if (r.t === 'resync') {
        this.toClient(ws, this.snapshotFor(s));
      } else if (r.t === 'export') {
        reply({ ok: true, result: this.db.exportAll() });
      }
    } catch (e) {
      // Store errors go back to the caller; anything else is a bug, logged as such.
      if (!(e instanceof StoreError)) { console.error(e); return reply({ ok: false, error: 'Internal error' }); }
      reply({ ok: false, error: e.message, code: e.code, key: e.key, rev: e.rev, dataVersion: e.dataVersion });
    }
  }
}

function send(ws, o) { sendRaw(ws, JSON.stringify(o)); }
function sendRaw(ws, text) { try { ws.send(text); } catch (_) {} }
