// WebSocket relay transport, copied from vod-js (src/net/transport.js) with small changes:
// - only the relay transport (the BroadcastChannel one has no database peer to talk to)
// - relayConfig() also reads ?room=
// - every message from the relay emits 'activity', so the app can notice a dead connection
// - the keepalive interval is an option, ping() sends one at once, connect() can carry extra
//   fields (the room's db peer reads the protocol version from them)
//
// Interface (PeerJS-like): new RelayPeer(id, cfg, {pingEvery})  .id  .on('open'|'error'|'disconnected'|'activity')
//   .connect(peerId, extra) -> conn   .ping()   .destroy()      conn: .on('open'|'data')  .send(message)

export const b64url = x => btoa(String.fromCharCode(...new TextEncoder().encode(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ?relay=ADDRESS&room=NAME and #key=SECRET (the part after # never leaves the browser). null when not configured.
export function relayConfig() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const a = (q.get('relay') || '').trim().replace(/\/+$/, ''); const key = h.get('key') || q.get('key') || '';
  if (!a || !key) return null;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(a);
  const base = /^https:/.test(a) ? a.replace(/^https:/, 'wss:') : /^http:/.test(a) ? a.replace(/^http:/, 'ws:')
    : /^wss?:/.test(a) ? a : (local ? 'ws://' : 'wss://') + a;
  const room = (q.get('room') || 'trophy').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'trophy';
  return { base, key, room, host: base.replace(/^wss?:\/\//, '') };
}

class RelayConn {
  constructor(p, remote, cid) { this.p = p; this.peer = remote; this.cid = cid; this.h = {}; }
  on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
  emit(e, ...a) { (this.h[e] || []).slice().forEach(f => f(...a)); }
  send(d) { this.p.send(this.peer, { t: 'data', cid: this.cid, d }); }
  close() {}
}

export class RelayPeer {
  constructor(id, cfg, { pingEvery = 25000 } = {}) { // cfg: { base, key, room }
    this.h = {}; this.conns = {}; this.up = false; this.failed = false; this.id = id || 'r' + Math.random().toString(36).slice(2, 9);
    try {
      this.ws = new WebSocket(cfg.base + '/' + cfg.room, ['vodjs-relay', 'k.' + b64url(cfg.key)]);
    } catch (_) { // e.g. an insecure ws:// address on an https page
      this.ws = { readyState: 3, send() {}, close() {} };
      setTimeout(() => this.emit('error', { type: 'relay-refused' }), 0);
      return;
    }
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hi', id: this.id }));
    this.ws.onmessage = e => { this.emit('activity'); let m; try { m = JSON.parse(e.data); } catch (_) { return; } this.recv(m); };
    this.ws.onclose = () => { clearInterval(this.ka); if (this.up) this.emit('disconnected'); else if (!this.failed) this.emit('error', { type: 'relay-refused' }); };
    this.ka = setInterval(() => this.ping(), pingEvery);
  }
  ping() { if (this.ws.readyState === 1) this.ws.send('{"t":"ping"}'); } // exactly this text: the relay answers it without waking up
  on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
  emit(e, ...a) { (this.h[e] || []).slice().forEach(f => f(...a)); }
  recv(m) {
    if (m.t === 'ok') { this.up = true; this.emit('open', this.id); }
    else if (m.t === 'err') { if (m.type !== 'peer-unavailable' && m.type !== 'too-big') this.failed = true; this.emit('error', { type: m.type }); }
    else if (m.t === 'from') this.inner(m.from, m.d);
  }
  inner(from, d) {
    if (!d) return;
    if (d.t === 'connect') { const c = new RelayConn(this, from, d.cid); this.conns[d.cid] = c; this.send(from, { t: 'accept', cid: d.cid }); this.emit('connection', c); setTimeout(() => c.emit('open'), 0); }
    else if (d.t === 'accept' && this.conns[d.cid]) { clearTimeout(this.conns[d.cid].timer); setTimeout(() => this.conns[d.cid].emit('open'), 0); }
    else if (d.t === 'data' && this.conns[d.cid]) this.conns[d.cid].emit('data', d.d);
  }
  send(to, d) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'to', to, d })); }
  connect(to, extra = {}) { const cid = Math.random().toString(36).slice(2), c = new RelayConn(this, to, cid); this.conns[cid] = c; c.timer = setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 6000); this.send(to, { ...extra, t: 'connect', cid }); return c; }
  destroy() { clearInterval(this.ka); this.h = {}; try { this.ws.close(); } catch (_) {} }
}
