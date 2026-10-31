// Checks a Trophy relay from the command line, step by step, and says what is wrong if
// something is. Reads only: it never changes the game data. Needs Node 22 or newer.
//
//   node check-relay.mjs <relay-address> <secret> [room]
//   node check-relay.mjs trophy-relay.you.workers.dev 'my secret' campaign1
//   node check-relay.mjs localhost:8787 dev test        (the local dev server)
//
// Steps: HTTP reachability and secret (/check), protocol version, live connection, database
// snapshot, round-trip times, and that a second connection sees the first (relaying).

const PROTOCOL = 2; // the page's protocol version (docs/js/data.js)
const [addrArg, secret, room = 'trophy'] = process.argv.slice(2);
if (!addrArg || secret == null) {
  console.log('Usage: node check-relay.mjs <relay-address> <secret> [room]');
  process.exit(2);
}
const addr = addrArg.trim().replace(/\/+$/, '');
const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(addr);
const http = /^https?:/.test(addr) ? addr : /^wss?:/.test(addr) ? addr.replace(/^ws/, 'http') : (local ? 'http://' : 'https://') + addr;
const wsBase = http.replace(/^http/, 'ws');
const b64url = x => Buffer.from(x, 'utf8').toString('base64url');

let failed = false;
const ok = msg => console.log('  ✓ ' + msg);
const bad = (msg, hint) => { failed = true; console.log('  ✗ ' + msg + (hint ? '\n      → ' + hint : '')); };

function open(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/${room}`, ['vodjs-relay', 'k.' + b64url(secret)]);
    const inbox = [], waiters = [];
    const timer = setTimeout(() => reject(new Error('no answer within 10 s')), 10000);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const w = waiters.findIndex(x => x.test(m));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m);
    };
    ws.onerror = () => {};
    ws.onclose = e => { clearTimeout(timer); reject(new Error(`closed (code ${e.code})`)); };
    const next = (test, ms = 10000) => {
      const i = inbox.findIndex(test);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { test, resolve: m => { clearTimeout(t); res(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out')); }, ms);
        waiters.push(w);
      });
    };
    ws.onopen = async () => {
      ws.send(JSON.stringify({ t: 'hi', id }));
      try {
        const m = await next(m => m.t === 'ok' || m.t === 'err');
        clearTimeout(timer);
        if (m.t === 'err') return reject(new Error('relay refused the id: ' + m.type));
        ws.onclose = null;
        resolve({ ws, next });
      } catch (e) { reject(e); }
    };
  });
}

console.log(`Checking ${http}  (room "${room}")\n`);

// 1. HTTP and secret
console.log('1. Relay reachable and secret accepted');
try {
  const r = await fetch(http + '/check', { headers: { 'X-Relay-Key': b64url(secret) } });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (!j || j.service !== 'trophy-relay') bad(`${http} answers (HTTP ${r.status}) but is not a Trophy relay`, 'check the address, or redeploy the worker (wrangler deploy)');
  else {
    ok(`Trophy relay answers (protocol ${j.protocol})`);
    if (j.key === 'ok') ok('secret accepted');
    else if (j.key === 'not-set') bad('the relay has no secret', 'run: wrangler secret put RELAY_SECRET');
    else bad('secret rejected', 'use the same secret you gave to wrangler secret put RELAY_SECRET');
    if (j.protocol !== PROTOCOL) bad(`relay protocol ${j.protocol}, page protocol ${PROTOCOL}`, 'deploy the worker from the same commit as docs/');
  }
} catch (e) {
  bad(`cannot reach ${http}: ${e.cause?.code || e.message}`, 'check the address and your network');
}
if (failed) process.exit(1);

// 2. Live connection and database
console.log('\n2. Live connection and game data');
let a, b;
try {
  const t0 = performance.now();
  a = await open('check-a-' + Math.random().toString(36).slice(2, 8));
  ok(`WebSocket connected in ${Math.round(performance.now() - t0)} ms`);
  a.ws.send(JSON.stringify({ t: 'to', to: 'db', d: { t: 'connect', cid: 'c1', proto: PROTOCOL } }));
  const t1 = performance.now();
  const m = await a.next(m => m.t === 'from' && m.from === 'db' && m.d.t === 'data');
  const snap = m.d.d;
  if (snap.t === 'version') bad(`relay speaks protocol ${snap.protocol}`, 'redeploy the worker');
  else {
    const n = k => (snap.tables[k] || []).length;
    const size = JSON.stringify(snap).length;
    ok(`snapshot in ${Math.round(performance.now() - t1)} ms: ${n('character')} characters, ${n('monster')} monsters, ${(size / 1024).toFixed(1)} KB, change #${snap.seq}`);
    if (size > 512 * 1024) bad('the snapshot is large', 'it still works, but joining gets slower');
  }
} catch (e) {
  bad('live connection failed: ' + e.message, 'if step 1 passed, this network may block WebSockets; try another network');
}

// 3. Round trips and relaying
if (a) {
  console.log('\n3. Round trips and relaying');
  try {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      a.ws.send('{"t":"ping"}');
      await a.next(m => m.t === 'pong', 5000);
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    ok(`ping round trip: median ${Math.round(times[2])} ms, worst ${Math.round(times[4])} ms`);
    if (times[2] > 500) bad('slow round trips', 'edits will feel sluggish on this network');
    b = await open('check-b-' + Math.random().toString(36).slice(2, 8));
    b.ws.send(JSON.stringify({ t: 'bc', d: { check: 'hello' } }));
    await a.next(m => m.t === 'from' && m.d && m.d.check === 'hello', 5000);
    ok('a second connection reaches the first (relaying works)');
  } catch (e) {
    bad('round trip failed: ' + e.message);
  }
}

a?.ws.close(); b?.ws.close();
console.log(failed ? '\nSomething is wrong — see ✗ above.' : '\nAll good: the relay is ready for play.');
process.exit(failed ? 1 : 0);
