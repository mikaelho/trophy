// Local stand-in for GitHub Pages + the Cloudflare relay, for development without deploying.
// Serves docs/ over HTTP and runs the same room code over WebSockets, with the database in
// dev/dev.sqlite (or memory with --memory).
//
//   cd dev && npm install && node server.mjs
//   open http://localhost:8787/?relay=localhost:8787&room=test#key=dev
//
// Options: --port N, --secret S (default "dev"), --memory, --seed path/to/dump.json
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
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
    core.attach(ws);
    ws.on('message', (data, isBinary) => core.message(ws, isBinary ? data : data.toString()));
    ws.on('close', () => core.detach(ws));
    ws.on('error', () => core.detach(ws));
  });
});

server.listen(port, () => console.log(`Trophy dev server: http://localhost:${port}/?relay=localhost:${port}&room=test#key=${secret}`));
