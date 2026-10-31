// Cloudflare Worker + Durable Object for Trophy: one Durable Object per game room, holding
// the game database in its built-in SQLite storage and relaying messages between players.
// Based on the VoD relay; the room logic is in room-core.mjs and the database in trophy-db.mjs.
//
// Anyone connecting must present the shared secret (RELAY_SECRET), sent in the WebSocket
// subprotocol list as "k.<base64url of the secret>" so it stays out of URLs and logs.
//
// Connections use the WebSocket Hibernation API: between messages the room can be unloaded
// while connections stay open, so an idle room (a forgotten open tab) costs no duration.
// Pings are answered by Cloudflare without waking the room. Whatever the room needs about a
// connection is kept with the connection (serializeAttachment) and restored on wake-up.
//
// GET /check (header X-Relay-Key: base64url of the secret) answers whether the relay is
// reachable, whether the secret is right and which protocol version it runs; the page uses
// it to explain connection problems, and so does dev/check-relay.mjs.
import { RoomCore } from './room-core.mjs';
import { TrophyDB } from './trophy-db.mjs';
import { PROTOCOL } from './schema.mjs';

const PING = '{"t":"ping"}', PONG = '{"t":"pong"}';
const SWEEP_MS = 30_000; // while field locks are held, look for dead connections this often

const unb64 = s => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); } catch (_) { return null; } };
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const keyOk = (env, encoded) => { const given = encoded && unb64(encoded); return !!env.RELAY_SECRET && given !== null && !!given && same(given, env.RELAY_SECRET); };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Relay-Key',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === '/check') {
        const k = request.headers.get('X-Relay-Key');
        const key = !env.RELAY_SECRET ? 'not-set' : k == null ? 'missing' : keyOk(env, k) ? 'ok' : 'wrong';
        return new Response(JSON.stringify({ service: 'trophy-relay', protocol: PROTOCOL, key }),
          { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      return new Response('Trophy relay is running.', { status: 200, headers: CORS });
    }
    const key = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim()).find(p => p.startsWith('k.'));
    if (!key || !keyOk(env, key.slice(2))) return new Response('forbidden', { status: 403 });
    const room = url.pathname.replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) return new Response('bad room name', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    const sql = {
      all: (q, ...params) => ctx.storage.sql.exec(q, ...params).toArray(),
      transaction: fn => ctx.storage.transactionSync(fn),
    };
    this.core = new RoomCore({
      db: new TrophyDB(sql),
      hooks: {
        save: (ws, state) => { try { ws.serializeAttachment(state); } catch (_) {} },
        lastSeen: ws => { try { return ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0; } catch (_) { return 0; } },
        locksChanged: any => { if (any) this.scheduleSweep(); },
      },
    });
    // After hibernation the room starts afresh: bring back the open connections.
    for (const ws of ctx.getWebSockets()) {
      let saved = null; try { saved = ws.deserializeAttachment(); } catch (_) {}
      this.core.restore(ws, saved);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.core.attach(server);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'vodjs-relay' } });
  }

  async webSocketMessage(ws, message) {
    this.core.message(ws, typeof message === 'string' ? message : null);
  }

  async webSocketClose(ws, code) {
    this.core.detach(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch (_) {}
  }

  async webSocketError(ws) {
    this.core.detach(ws);
  }

  async alarm() {
    this.core.sweep();
    if (this.core.locks.size) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  scheduleSweep() {
    this.ctx.storage.getAlarm().then(at => {
      if (at == null) return this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    }).catch(() => {});
  }
}
