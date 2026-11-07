// The page's copy of the game data and its connection to the room's "db" peer.
//
// The relay is a generic document store (worker/src/store.mjs). The page holds every
// document (the data is small), applies the game rules itself (model/rules.js) and upgrades
// the data layout when needed (model/migrations.js). Writes go to the relay as batches; the
// relay broadcasts the changed documents to everybody, this page included. Changes are
// numbered; on a gap, or after reconnecting, the page gets a fresh snapshot.
//
// Two pages changing the same thing at once: a rule that changes something it read sends the
// revision it read, the relay refuses the later batch, and the page computes it again from
// the fresh data and resends (a few times at most).
//
// Upgrades: the snapshot says which layout the data follows (dataVersion). Older than this
// page's DATA_VERSION: the page converts everything and sends it to the relay, which accepts
// it only if nobody upgraded first (and keeps a backup). Newer: the page is out of date and
// asks to be reloaded; the relay refuses its writes anyway.
//
// Keeping the connection healthy:
// - The page pings every 5 s and the relay answers. Nothing heard for 15 s (while the page is
//   visible) means the connection is dead, even if the browser still thinks it is open.
// - When the page becomes visible again, the network comes back, or a reply is slow, the page
//   sends a ping and reconnects unless something arrives within 4 s.
// - Reconnecting retries with a growing pause (1 s up to 10 s) for as long as needed.
// - Text edits (field saves, renames, new list items) go through an outbox: they are kept,
//   also over a page reload, until the relay confirms them, and resent after reconnecting.
//   Each carries a unique id, so the relay applies a resent edit only once. Until confirmed,
//   the page shows the edited text. Other actions (clicks) need a live connection.
// - When connecting keeps failing, /check on the relay tells apart a wrong secret, an
//   unreachable relay, a version mismatch and a network that blocks WebSockets.

import { RelayPeer, b64url } from './transport.js';
import { DocView } from './model/view.js';
import { compute, RuleError } from './model/rules.js';
import { record, revert, describe } from './model/undo.js';
import { DATA_VERSION, upgrade } from './model/migrations.js';
export { byPosition, bySlot } from './model/rules.js';

export const PROTOCOL = 3;     // must match PROTOCOL in worker/src/store.mjs

const PING_EVERY = 5000;       // keepalive interval (answered by Cloudflare without waking the room)
const DEAD_AFTER = 15000;      // nothing heard this long while visible -> reconnect
const PROBE_WAIT = 4000;       // after a probe ping, wait this long for any message
const SLOW_REPLY = 5000;       // a reply slower than this triggers a probe
const REQUEST_TIMEOUT = 15000; // give up on a reply
const CONFLICT_RETRIES = 6;    // recompute this many times when someone else changed the same thing
const OUTBOX_MAX_AGE = 6 * 3600 * 1000; // queued edits older than this are dropped
const UNDO_STEPS = 50;         // how many of this tab's changes can be undone
const NOT_UNDOABLE = op => op.startsWith('roller_');   // dice and the mat are left out
const UNDO_TOAST_OPS = new Set(['delete_character', 'monster_remove', 'person_remove', 'remove_child']);
const QUEUED_OPS = new Set(['save_field', 'rename_child', 'add_child',
  'monster_save', 'monster_save_habit', 'roller_rename_section', 'roller_add_section', 'person_save']);

const newOid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const refused = (message, extra = {}) => Object.assign(new Error(message), { refused: true }, extra);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Data {
  constructor(cfg) {
    this.cfg = cfg;
    this.view = new DocView(); // the documents
    this.locks = {};           // lock key -> peer id holding it
    this.me = null;            // this browser's peer id
    this.status = 'connecting'; // 'connecting' | 'upgrading' | 'live' | 'offline' | 'outdated'
    this.problem = '';         // explanation when connecting keeps failing
    this.ready = false;        // data has arrived at least once
    this.dataVersion = null;
    this.epoch = null; this.seq = 0;
    this.pending = new Map(); this.rid = 0;
    this.listeners = new Set();
    this.notice = () => {};    // set by the app: shows a message to the person
    this.backoff = 1000; this.failures = 0;
    this.outboxKey = 'trophy-outbox:' + cfg.base + '/' + cfg.room;
    this.outbox = this.loadOutbox(); this.sending = null;
    this.history = []; this.future = []; this.reverting = false; // undo / redo of this tab's own changes

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
      if (m.protocol !== PROTOCOL) return this.outdated(`This page (version ${PROTOCOL}) and the relay (version ${m.protocol ?? '?'}) don't match. Reload the page; if that doesn't help, redeploy the worker.`);
      this.locks = m.locks || {}; this.me = m.you; this.epoch = m.epoch; this.seq = m.seq;
      if (this.dataVersion != null && m.dataVersion !== this.dataVersion) this.clearHistory();
      this.dataVersion = m.dataVersion;
      if (m.dataVersion > DATA_VERSION) return this.outdated('The game data was upgraded by a newer version of this page. Reload the page.');
      if (m.dataVersion < DATA_VERSION) return this.upgradeRoom(m);
      this.view.load(m.docs);
      this.ready = true; this.status = 'live'; this.problem = ''; this.failures = 0; this.backoff = 1000;
      this.changed();
      this.pump();
    } else if (m.t === 'version') {
      this.outdated(`This page (version ${PROTOCOL}) and the relay (version ${m.protocol ?? '?'}) don't match. Reload the page; if that doesn't help, redeploy the worker.`);
    } else if (m.t === 'chg') {
      if (m.epoch !== this.epoch || m.seq !== this.seq + 1) return this.resync();
      this.seq = m.seq;
      this.view.apply(m.docs, m.del);
      this.changed();
    } else if (m.t === 'locks') {
      this.locks = m.locks || {};
      this.changed();
    } else if (m.t === 'reply') {
      const p = this.pending.get(m.rid);
      if (!p) return;
      this.pending.delete(m.rid); clearTimeout(p.timer); clearTimeout(p.slow);
      m.ok ? p.resolve(m.result) : p.reject(refused(m.error || 'Refused.', { code: m.code, key: m.key, rev: m.rev }));
    }
  }

  // The data is in an older layout: convert it here and hand it to the relay. Whoever upgrades
  // first wins; everybody then receives the upgraded data as a fresh snapshot.
  async upgradeRoom(m) {
    this.status = 'upgrading'; this.changed();
    let docs;
    try {
      docs = upgrade(m.dataVersion, { docs: Object.fromEntries(m.docs.map(([k, , d]) => [k, d])), legacy: m.legacy });
    } catch (e) {
      console.error(e);
      return this.outdated('The game data could not be upgraded: ' + e.message);
    }
    try {
      await this.request({ t: 'migrate', from: m.dataVersion, to: DATA_VERSION, docs }, { beforeReady: true });
    } catch (e) {
      if (e.code !== 'version') { this.notice('Upgrading the game data failed: ' + e.message); this.changed(); }
      // 'version': another page upgraded first; its snapshot is on the way
    }
  }

  outdated(problem) {
    this.status = 'outdated';
    this.problem = problem;
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.changed();
  }

  resync() { if (this.conn) this.conn.send({ t: 'resync' }); }

  // --- outgoing ----------------------------------------------------------------
  // beforeReady: the upgrade, the one request sent before the data is ready.
  request(payload, { beforeReady = false } = {}) {
    if (!this.conn || (this.status !== 'live' && !(beforeReady && this.status === 'upgrading'))) return Promise.reject(new Error('Not connected — try again in a moment.'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('No answer from the relay.')); this.probe(); }, REQUEST_TIMEOUT);
      const slow = setTimeout(() => this.probe(), SLOW_REPLY);
      this.pending.set(rid, { resolve, reject, timer, slow });
      this.conn.send({ ...payload, rid });
    });
  }

  // Send a batch computed by make() from the local data; on a conflict (someone else changed
  // the same thing first) compute it again from the fresh data. The same oid is kept
  // throughout, so a resend after a lost reply is applied only once.
  async sendComputed(make, { oid = newOid(), release } = {}) {
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
      const batch = make();
      if (!batch.writes.length) { if (release) this.unlock(release); return batch; }
      try {
        await this.request({ t: 'write', oid, version: this.dataVersion, writes: batch.writes, result: batch.result, release });
        return batch;
      } catch (e) {
        if (e.code !== 'conflict') throw e;
        // the other change reaches this page before (or soon after) the refusal
        if (this.view.rev(e.key) < e.rev) await sleep(100 * (attempt + 1));
      }
    }
    throw refused('Too many changes at the same moment — try again.');
  }

  // Run a game operation (model/rules.js) and remember it for Undo.
  async run(op, args = {}, opts = {}) {
    const label = describe(this.view, op, args); // named before the change (e.g. before a delete)
    let step = null;
    const batch = await this.sendComputed(() => {
      let b;
      try { b = compute(this.view, op, args); } catch (e) {
        if (e instanceof RuleError) throw refused(e.message);
        throw e;
      }
      step = NOT_UNDOABLE(op) ? null : record(this.view, b.writes, label);
      return b;
    }, opts);
    if (step && batch.writes.length) {
      this.history.push(step);
      if (this.history.length > UNDO_STEPS) this.history.shift();
      this.future = [];
      if (UNDO_TOAST_OPS.has(op)) this.notice(label.charAt(0).toUpperCase() + label.slice(1) + '.', { undo: step });
      this.changed();
    }
    return batch.result;
  }

  // --- undo / redo (model/undo.js) ------------------------------------------------
  get undoLabel() { return this.history.at(-1)?.label ?? null; }
  get redoLabel() { return this.future.at(-1)?.label ?? null; }
  undo() { return this.revertStep(this.history, this.future, 'Undone'); }
  // The Undo button in a message: undo that step, if nothing has been done since.
  undoStep(step) {
    if (this.history.at(-1) !== step) return this.notice('Other changes were made after that; use ↶ to undo them in turn.');
    return this.undo();
  }
  redo() { return this.revertStep(this.future, this.history, 'Redone'); }
  clearHistory() { this.history = []; this.future = []; }

  async revertStep(from, to, verb) {
    if (this.reverting || !from.length) return;
    if (this.outbox.length) return this.notice('Wait a moment: a change is still being saved.');
    if (this.status !== 'live') return this.notice('Not connected — try again in a moment.');
    const step = from.at(-1);
    if (this.lockKeysOf(step).some(k => this.lockedByOther(k))) return this.notice(`Someone is editing that right now (${step.label}); try again in a moment.`);
    this.reverting = true; this.changed();
    try {
      let result, next;
      await this.sendComputed(() => {
        result = revert(this.view, step);
        next = record(this.view, result.writes, step.label);
        return { writes: result.writes, result: null };
      });
      from.pop();
      if (result.writes.length) {
        to.push(next);
        this.notice(`${verb}: ${step.label}` + (result.skipped.length ? ' — except what someone else has changed since.' : '.'));
      } else {
        this.notice(`Nothing to ${verb === 'Undone' ? 'undo' : 'redo'} for "${step.label}": someone else has changed it since.`);
      }
    } catch (e) {
      this.notice(e.message);
    } finally {
      this.reverting = false; this.changed();
    }
  }

  // The field locks that cover what a step would change (see the views for the key formats).
  lockKeysOf(step) {
    return step.changes.flatMap(c => {
      const [kind, id] = c.key.split('/');
      const fields = c.fields || Object.keys({ ...c.before, ...c.after });
      if (kind === 'character') return fields.map(f => `${id}:${f}`);
      if (kind === 'monster') return fields.flatMap(f => f === 'habits' ? [1, 2, 3, 4, 5, 6].map(n => `monster:${id}:habit:${n}`) : [`monster:${id}:${f}`]);
      if (kind === 'person') return fields.map(f => `person:${id}:${f}`);
      const character = (c.after || c.before)?.character;
      return character ? [`${character}:${kind}:${id}`] : [];
    });
  }

  // A write that needs the connection now (clicks). Rejects when offline.
  op(op, args = {}, release = undefined) { return this.run(op, args, { release }); }

  // A text edit: kept until confirmed, resent after reconnecting.
  edit(op, args = {}, release = undefined) {
    if (!QUEUED_OPS.has(op)) return this.op(op, args, release);
    this.outbox.push({ oid: newOid(), op, args, release, at: Date.now(), dataVersion: DATA_VERSION });
    this.saveOutbox(); this.changed(); this.pump();
  }

  async pump() {
    if (this.sending || this.status !== 'live' || !this.outbox.length) return;
    const e = this.sending = this.outbox[0];
    try {
      if (e.dataVersion !== this.dataVersion) throw refused('it was made before the game data was upgraded.');
      await this.run(e.op, e.args, { oid: e.oid, release: e.release });
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

  // Export/import/backups. Imports and restores come in any known layout and are upgraded here.
  exportData() { return this.request({ t: 'export' }); }
  importDocs(dataVersion, docs) {
    this.clearHistory();
    return this.request({ t: 'import', version: DATA_VERSION, docs: upgrade(dataVersion, { docs }) });
  }
  listBackups() { return this.request({ t: 'backups' }); }
  async restoreBackup(id) {
    const b = await this.request({ t: 'backup', id });
    return this.importDocs(b.dataVersion, b.docs);
  }

  // --- reading -----------------------------------------------------------------
  all(kind) { return this.view.all(kind); }
  get(kind, id) { return this.view.get(kind, id); }
  childrenOf(kind, characterId, order) { return this.view.childrenOf(kind, characterId, order); }
  // True when somebody else is editing the thing behind this lock key.
  lockedByOther(key) { const h = this.locks[key]; return !!h && h !== this.me; }

  // The text of the latest edit waiting in the outbox for op with these args, or undefined.
  // E.g. queued('save_field', {id: '5', field: 'name'}, 'value').
  queued(op, match, valueKey) {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const e = this.outbox[i];
      if (e.op === op && Object.entries(match).every(([k, v]) => e.args[k] === v)) return e.args[valueKey];
    }
  }
  pendingField(id, field) { return this.queued('save_field', { id, field }, 'value'); }
  pendingName(kind, item) { return this.queued('rename_child', { kind, item }, 'name'); }
}
