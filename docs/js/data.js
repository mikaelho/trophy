// The client's copy of the game database and its connection to the room's "db" peer.
//
// Every browser holds the whole database (it is small). Reads are local; writes are sent to
// the room as ops, and the room broadcasts the changed rows to everybody, this browser
// included. Changes are numbered; on a gap, or after reconnecting, the client asks for a
// fresh snapshot.

import { RelayPeer } from './transport.js';

const ALIVE_TIMEOUT = 60000;  // nothing heard from the relay this long -> reconnect (it pongs every 25 s)
const REQUEST_TIMEOUT = 15000;

export class Data {
  constructor(cfg) {
    this.cfg = cfg;
    this.tables = {};          // model -> Map(id -> row)
    this.locks = {};           // lock key -> peer id holding it
    this.me = null;            // this browser's peer id
    this.status = 'connecting'; // 'connecting' | 'live' | 'offline'
    this.ready = false;        // a snapshot has arrived at least once
    this.epoch = null; this.seq = 0;
    this.pending = new Map(); this.rid = 0;
    this.listeners = new Set();
    this.backoff = 1000;
    // Waiting for the next retry when the network returns or the page is shown again: retry now.
    const nudge = () => { if (!this.peer && this.status !== 'live') this.reconnectSoon(0); };
    addEventListener('online', nudge);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') nudge(); });
    this.connect();
  }

  // --- subscriptions ---------------------------------------------------------
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  // --- connection ------------------------------------------------------------
  connect() {
    clearTimeout(this.retryTimer);
    if (this.peer) this.peer.destroy();
    this.status = this.ready ? 'offline' : 'connecting';
    const peer = this.peer = new RelayPeer(null, this.cfg);
    const mine = () => this.peer === peer;
    peer.on('activity', () => { if (mine()) this.lastHeard = Date.now(); });
    peer.on('open', () => {
      if (!mine()) return;
      this.conn = peer.connect('db');
      this.conn.on('data', m => { if (mine()) this.receive(m); });
    });
    peer.on('error', e => {
      if (!mine()) return;
      if (e.type === 'too-big') return this.failAll('The change was too large to send.');
      this.dropped();
    });
    peer.on('disconnected', () => { if (mine()) this.dropped(); });
    this.lastHeard = Date.now();
    clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (mine() && Date.now() - this.lastHeard > ALIVE_TIMEOUT) this.dropped();
    }, 5000);
  }

  dropped() {
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.conn = null;
    clearInterval(this.watch);
    this.failAll('Not connected.');
    if (this.status === 'live') { this.status = 'offline'; this.changed(); }
    this.reconnectSoon(this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10000);
  }

  reconnectSoon(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.status !== 'live') this.connect(); }, ms);
  }

  failAll(msg) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(msg)); }
    this.pending.clear();
  }

  // --- incoming ----------------------------------------------------------------
  receive(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'snap') {
      this.tables = {};
      for (const [model, rows] of Object.entries(m.tables)) this.tables[model] = new Map(rows.map(r => [r.id, r]));
      this.locks = m.locks || {}; this.me = m.you; this.epoch = m.epoch; this.seq = m.seq;
      this.ready = true; this.status = 'live'; this.backoff = 1000;
      this.changed();
    } else if (m.t === 'chg') {
      if (m.epoch !== this.epoch || m.seq !== this.seq + 1) return this.resync();
      this.seq = m.seq;
      for (const [model, row] of m.rows) (this.tables[model] ||= new Map()).set(row.id, row);
      for (const [model, id] of m.del) this.tables[model]?.delete(id);
      this.changed();
    } else if (m.t === 'locks') {
      this.locks = m.locks || {};
      this.changed();
    } else if (m.t === 'reply') {
      const p = this.pending.get(m.rid);
      if (!p) return;
      this.pending.delete(m.rid); clearTimeout(p.timer);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'Refused.'));
    }
  }

  resync() { if (this.conn) this.conn.send({ t: 'resync' }); }

  // --- outgoing ----------------------------------------------------------------
  request(payload) {
    if (!this.conn || this.status !== 'live') return Promise.reject(new Error('Not connected.'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('No answer from the server.')); }, REQUEST_TIMEOUT);
      this.pending.set(rid, { resolve, reject, timer });
      this.conn.send({ ...payload, rid });
    });
  }
  op(op, args = {}, release = undefined) { return this.request({ t: 'op', op, args, release }); }
  // Resolves true when this browser holds the lock.
  lock(key) { return this.request({ t: 'lock', key }).then(() => true, () => false); }
  unlock(key) { if (this.conn && this.status === 'live') this.conn.send({ t: 'unlock', key }); }
  exportDump() { return this.request({ t: 'export' }); }
  importDump(dump) { return this.request({ t: 'import', dump }); }

  // --- reading -----------------------------------------------------------------
  all(model) { return [...(this.tables[model]?.values() || [])]; }
  get(model, id) { return this.tables[model]?.get(Number(id)) || null; }
  // Rows of a child list of one character, in sheet order.
  childrenOf(model, characterId, order = byPosition) {
    return this.all(model).filter(r => r.character === characterId).sort(order);
  }
  // True when somebody else is editing the thing behind this lock key.
  lockedByOther(key) { const h = this.locks[key]; return !!h && h !== this.me; }
}

export const byPosition = (a, b) => a.position - b.position || a.id - b.id;
export const bySlot = (a, b) => a.slot - b.slot || byPosition(a, b);
