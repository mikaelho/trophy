// Local stand-in for GitHub Pages + the Cloudflare relay, for development without deploying.
// Serves docs/ over HTTP and runs the same room code over WebSockets, with the database in
// dev/dev.sqlite (or memory with --memory).
//
//   cd dev && npm install && node server.mjs
//   open http://localhost:8787/?relay=localhost:8787&room=test#key=dev
//
// Options: --port N, --secret S (default "dev"), --memory, --seed path/to/dump.json,
//   --chaos  enables http://localhost:PORT/__chaos?do=drop|freeze for testing bad connections:
//            drop = cut every connection abruptly; freeze = existing connections go silent in
//            both directions without closing (like a phone that lost its network).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomCore } from '../worker/src/room-core.mjs';
import { TrophyDB } from '../worker/src/trophy-db.mjs';
import { nodeSql } from '../worker/src/node-sql.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../docs');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg('port', 8787)), secret = arg('secret', 'dev');
const memory = process.argv.includes('--memory'), seed = arg('seed', null);

const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) {
    const db = new TrophyDB(nodeSql(memory ? ':memory:' : path.join(here, `dev-${name}.sqlite`)));
    if (seed && db.rows('character').length === 0) db.importDump(JSON.parse(fs.readFileSync(seed, 'utf8')));
    rooms.set(name, new RoomCore({ db }));
  }
  return rooms.get(name);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json' };
const chaos = process.argv.includes('--chaos');
const sockets = new Set(); // { ws, frozen }
const PROTOCOL = (await import('../worker/src/schema.mjs')).PROTOCOL;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'X-Relay-Key' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/check') { // same answer as the worker's /check
    const k = req.headers['x-relay-key'];
    const key = k == null ? 'missing' : unb64(k) === secret ? 'ok' : 'wrong';
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ service: 'trophy-relay', protocol: PROTOCOL, key }));
  }
  if (chaos && url.pathname === '/__chaos') {
    const what = url.searchParams.get('do');
    for (const s of sockets) {
      if (what === 'drop') s.ws.terminate();
      if (what === 'freeze') s.frozen = true;
    }
    res.writeHead(200); return res.end(`${what}: ${sockets.size} connections`);
  }
  let file = path.join(webRoot, decodeURIComponent(url.pathname));
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const unb64 = s => { try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (_) { return null; } };
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: protocols => protocols.has('vodjs-relay') ? 'vodjs-relay' : false,
});
server.on('upgrade', (req, socket, head) => {
  const key = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(p => p.startsWith('k.'));
  const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '');
  if (!key || unb64(key.slice(2)) !== secret || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => {
    const core = room(name);
    // The room talks to this wrapper, so --chaos can silence a connection without closing it.
    const s = { ws, frozen: false };
    const conn = { send: t => { if (!s.frozen) ws.send(t); }, close: (c, r) => ws.close(c, r) };
    sockets.add(s);
    core.attach(conn);
    ws.on('message', (data, isBinary) => { if (!s.frozen) core.message(conn, isBinary ? data : data.toString()); });
    const bye = () => { sockets.delete(s); core.detach(conn); };
    ws.on('close', bye); ws.on('error', bye);
  });
});

server.listen(port, () => console.log(`Trophy dev server: http://localhost:${port}/?relay=localhost:${port}&room=test#key=${secret}`));
