// Cloudflare Worker + Durable Object for Trophy: one Durable Object per game room, holding
// the game database in its built-in SQLite storage and relaying messages between players.
// Based on the VoD relay; the room logic is in room-core.mjs and the database in trophy-db.mjs.
// Anyone connecting must present the shared secret (RELAY_SECRET), sent in the WebSocket
// subprotocol list as "k.<base64url of the secret>" so it stays out of URLs and logs.
import { RoomCore } from './room-core.mjs';
import { TrophyDB } from './trophy-db.mjs';

const unb64 = s => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); } catch (_) { return null; } };
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Trophy relay is running.', { status: 200 });
    const key = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim()).find(p => p.startsWith('k.'));
    const given = key && unb64(key.slice(2));
    if (!env.RELAY_SECRET || given === null || !key || !same(given, env.RELAY_SECRET)) return new Response('forbidden', { status: 403 });
    const room = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) return new Response('bad room name', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  }
};

export class Room {
  constructor(ctx) {
    const sql = {
      all: (q, ...params) => ctx.storage.sql.exec(q, ...params).toArray(),
      transaction: fn => ctx.storage.transactionSync(fn),
    };
    this.core = new RoomCore({ db: new TrophyDB(sql) });
  }
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept(); this.core.attach(server);
    server.addEventListener('message', e => this.core.message(server, e.data));
    const bye = () => this.core.detach(server);
    server.addEventListener('close', bye); server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'vodjs-relay' } });
  }
}
