// The client's copy of the game database and its connection to the room's "db" peer.
//
// Every browser holds the whole database (it is small). Reads are local; writes are sent to
// the room as ops, and the room broadcasts the changed rows to everybody, this browser
// included. Changes are numbered; on a gap, or after reconnecting, the client gets a fresh
// snapshot.
//
// Keeping the connection healthy:
// - The page pings every 5 s and the relay answers. Nothing heard for 15 s (while the page is
//   visible) means the connection is dead, even if the browser still thinks it is open.
// - When the page becomes visible again, the network comes back, or a reply is slow, the page
//   sends a ping and reconnects unless something arrives within 4 s.
// - Reconnecting retries with a growing pause (1 s up to 10 s) for as long as needed.
// - Text edits (field saves, renames, new list items) go through an outbox: they are kept,
//   also over a page reload, until the room confirms them, and resent after reconnecting.
//   Each carries a unique id, so the room applies a resent edit only once. Until confirmed,
//   the page shows the edited text. Other actions (clicks) need a live connection.
// - When connecting keeps failing, /check on the relay tells apart a wrong secret, an
//   unreachable relay, a version mismatch and a network that blocks WebSockets.

import { RelayPeer, b64url } from './transport.js';

export const PROTOCOL = 2;     // must match PROTOCOL in worker/src/schema.mjs

const PING_EVERY = 5000;       // keepalive interval (answered by Cloudflare without waking the room)
const DEAD_AFTER = 15000;      // nothing heard this long while visible -> reconnect
const PROBE_WAIT = 4000;       // after a probe ping, wait this long for any message
const SLOW_REPLY = 5000;       // a reply slower than this triggers a probe
const REQUEST_TIMEOUT = 15000; // give up on a reply
const OUTBOX_MAX_AGE = 6 * 3600 * 1000; // queued edits older than this are dropped
const QUEUED_OPS = new Set(['save_field', 'rename_child', 'add_child',
  'monster_save', 'monster_save_habit', 'roller_rename_section', 'roller_add_section']);

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export class Data {
  constructor(cfg) {
    this.cfg = cfg;
    this.tables = {};          // model -> Map(id -> row)
    this.locks = {};           // lock key -> peer id holding it
    this.me = null;            // this browser's peer id
    this.status = 'connecting'; // 'connecting' | 'live' | 'offline' | 'outdated'
    this.problem = '';         // explanation when connecting keeps failing
    this.ready = false;        // a snapshot has arrived at least once
    this.epoch = null; this.seq = 0;
    this.pending = new Map(); this.rid = 0;
    this.listeners = new Set();
    this.notice = () => {};    // set by the app: shows a message to the person
    this.backoff = 1000; this.failures = 0;
    this.outboxKey = 'trophy-outbox:' + cfg.base + '/' + cfg.room;
    this.outbox = this.loadOutbox(); this.sending = null;

    const wake = () => { if (this.status === 'outdated') return; this.peer ? this.probe() : this.reconnectSoon(0); };
    addEventListener('online', wake);
    addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !this.peer || !this.peer.up) return;
      if (Date.now() - this.lastHeard > DEAD_AFTER) this.dropped();
    }, 2000);
    this.connect();
  }

  // --- subscriptions ---------------------------------------------------------
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  // --- connection ------------------------------------------------------------
  connect() {
    clearTimeout(this.retryTimer);
    if (this.peer) this.peer.destroy();
    if (this.status !== 'outdated') this.status = this.ready ? 'offline' : 'connecting';
    const peer = this.peer = new RelayPeer(null, this.cfg, { pingEvery: PING_EVERY });
    const mine = () => this.peer === peer;
    peer.on('activity', () => { if (mine()) this.lastHeard = Date.now(); });
    peer.on('open', () => {
      if (!mine()) return;
      this.conn = peer.connect('db', { proto: PROTOCOL });
      this.conn.on('data', m => { if (mine()) this.receive(m); });
    });
    peer.on('error', e => {
      if (!mine()) return;
      if (e.type === 'too-big') return this.notice('That change was too large to send.');
      this.dropped();
    });
    peer.on('disconnected', () => { if (mine()) this.dropped(); });
    this.lastHeard = Date.now();
  }

  dropped() {
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.conn = null;
    for (const { reject, timer, slow } of this.pending.values()) { clearTimeout(timer); clearTimeout(slow); reject(new Error('Not connected.')); }
    this.pending.clear();
    if (this.status === 'outdated') return this.changed();
    this.status = this.ready ? 'offline' : 'connecting';
    this.failures++;
    if (this.failures >= 2) this.diagnose();
    this.changed();
    this.reconnectSoon(this.backoff + Math.random() * 500);
    this.backoff = Math.min(this.backoff * 2, 10000);
  }

  reconnectSoon(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.peer && this.status !== 'outdated') this.connect(); }, ms);
  }

  // Reconnect at once (the "Retry now" button).
  retry() { this.backoff = 1000; if (this.peer) this.peer.destroy(); this.peer = null; this.connect(); this.changed(); }

  // Is the connection really alive? Ping and reconnect unless something arrives soon.
  probe() {
    if (!this.peer || !this.peer.up || this.probing) return;
    const since = Date.now(), peer = this.peer;
    this.probing = true;
    peer.ping();
    setTimeout(() => {
      this.probing = false;
      if (this.peer === peer && this.lastHeard < since) this.dropped();
    }, PROBE_WAIT);
  }

  // Find out why connecting fails, in words the person can act on.
  async diagnose() {
    if (this.diagnosing) return;
    this.diagnosing = true;
    let problem;
    const http = this.cfg.base.replace(/^ws/, 'http');
    if (location.protocol === 'https:' && this.cfg.base.startsWith('ws:')) {
      problem = `This secure page can't use the insecure relay address ${this.cfg.host}. Use the https address of the relay.`;
    } else if (navigator.onLine === false) {
      problem = 'This device is offline.';
    } else {
      try {
        const r = await fetch(http + '/check', { headers: { 'X-Relay-Key': b64url(this.cfg.key) }, cache: 'no-store' });
        let j = null; try { j = await r.json(); } catch (_) {}
        if (!j || j.service !== 'trophy-relay') problem = `Something answers at ${this.cfg.host}, but it is not a Trophy relay (or an old version of it). Check the relay= part of the link, or redeploy the worker.`;
        else if (j.key === 'wrong' || j.key === 'missing') problem = 'The relay rejected the secret. Check the #key= part of the link.';
        else if (j.key === 'not-set') problem = 'The relay has no secret set. Run: wrangler secret put RELAY_SECRET';
        else if (j.protocol !== PROTOCOL) problem = `The relay (version ${j.protocol}) and this page (version ${PROTOCOL}) don't match. Redeploy the worker or reload the page.`;
        else problem = 'The relay is reachable, but the live connection fails. This network may block WebSockets; try another one (for example mobile data).';
      } catch (_) {
        problem = `Can't reach the relay at ${this.cfg.host}. Check the relay= part of the link and the network.`;
      }
    }
    this.diagnosing = false;
    if (this.status !== 'live' && this.problem !== problem) { this.problem = problem; this.changed(); }
  }

  // --- incoming ----------------------------------------------------------------
  receive(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'snap') {
      if (m.protocol !== PROTOCOL) return this.outdated(m.protocol);
      this.tables = {};
      for (const [model, rows] of Object.entries(m.tables)) this.tables[model] = new Map(rows.map(r => [r.id, r]));
      this.locks = m.locks || {}; this.me = m.you; this.epoch = m.epoch; this.seq = m.seq;
      this.ready = true; this.status = 'live'; this.problem = ''; this.failures = 0; this.backoff = 1000;
      this.changed();
      this.pump();
    } else if (m.t === 'version') {
      this.outdated(m.protocol);
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
      this.pending.delete(m.rid); clearTimeout(p.timer); clearTimeout(p.slow);
      m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error || 'Refused.'), { refused: true }));
    }
  }

  outdated(theirs) {
    this.status = 'outdated';
    this.problem = `This page (version ${PROTOCOL}) and the relay (version ${theirs ?? '?'}) don't match. Reload the page; if that doesn't help, redeploy the worker.`;
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.changed();
  }

  resync() { if (this.conn) this.conn.send({ t: 'resync' }); }

  // --- outgoing ----------------------------------------------------------------
  request(payload) {
    if (!this.conn || this.status !== 'live') return Promise.reject(new Error('Not connected — try again in a moment.'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('No answer from the relay.')); this.probe(); }, REQUEST_TIMEOUT);
      const slow = setTimeout(() => this.probe(), SLOW_REPLY);
      this.pending.set(rid, { resolve, reject, timer, slow });
      this.conn.send({ ...payload, rid });
    });
  }

  // A write that needs the connection now (clicks). Rejects when offline.
  op(op, args = {}, release = undefined) { return this.request({ t: 'op', oid: newId(), op, args, release }); }

  // A text edit: kept until confirmed, resent after reconnecting.
  edit(op, args = {}, release = undefined) {
    if (!QUEUED_OPS.has(op)) return this.op(op, args, release);
    this.outbox.push({ oid: newId(), op, args, release, at: Date.now() });
    this.saveOutbox(); this.changed(); this.pump();
  }

  async pump() {
    if (this.sending || this.status !== 'live' || !this.outbox.length) return;
    const e = this.sending = this.outbox[0];
    try {
      await this.request({ t: 'op', oid: e.oid, op: e.op, args: e.args, release: e.release });
      this.outbox = this.outbox.filter(x => x !== e);
    } catch (err) {
      if (!err.refused) { this.sending = null; return; } // connection trouble: kept and resent later
      this.outbox = this.outbox.filter(x => x !== e);
      this.notice('Not saved: ' + err.message);
    }
    this.sending = null;
    this.saveOutbox(); this.changed(); this.pump();
  }

  loadOutbox() {
    try {
      const list = JSON.parse(localStorage.getItem(this.outboxKey) || '[]');
      return Array.isArray(list) ? list.filter(e => e && e.oid && QUEUED_OPS.has(e.op) && Date.now() - e.at < OUTBOX_MAX_AGE) : [];
    } catch (_) { return []; }
  }
  saveOutbox() {
    try {
      if (this.outbox.length) localStorage.setItem(this.outboxKey, JSON.stringify(this.outbox));
      else localStorage.removeItem(this.outboxKey);
    } catch (_) {}
  }

  // Resolves true when this browser may edit the field: it holds the lock, or the connection is
  // down (the edit then waits in the outbox; whoever saves last wins).
  lock(key) {
    return this.request({ t: 'lock', key }).then(() => true, e => !e.refused);
  }
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

  // The text of the latest edit waiting in the outbox for op with these args, or undefined.
  // E.g. queued('save_field', {id: 5, field: 'name'}, 'value').
  queued(op, match, valueKey) {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const e = this.outbox[i];
      if (e.op === op && Object.entries(match).every(([k, v]) => e.args[k] === v)) return e.args[valueKey];
    }
  }
  pendingField(id, field) { return this.queued('save_field', { id, field }, 'value'); }
  pendingName(kind, item) { return this.queued('rename_child', { kind, item }, 'name'); }
}

export const byPosition = (a, b) => a.position - b.position || a.id - b.id;
export const bySlot = (a, b) => a.slot - b.slot || byPosition(a, b);
