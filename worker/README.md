# Trophy relay and database (Cloudflare Worker)

One Durable Object per game room. It relays messages between the players' browsers like the
VoD relay, and also owns the room's game database in the Durable Object's built-in SQLite.
The Free Cloudflare plan is enough.

- `src/trophy-db.mjs` – tables and write operations (ported from `trophy/alive_hooks.py`)
- `src/room-core.mjs` – the room: relay, the built-in `db` peer, field locks, change broadcast
- `src/worker.js` – the Cloudflare wrapper (secret check, Durable Object)
- `test/` – tests that run without Cloudflare: `node --test test/*.test.mjs` (Node 22.5+)

## Deploy

1. Install Node.js, then in this folder: `npm install -g wrangler` and `wrangler login`
2. Choose a secret and store it in Cloudflare, not in git: `wrangler secret put RELAY_SECRET`
3. `wrangler deploy` – it prints the relay address, like `trophy-relay.<your-name>.workers.dev`
4. Open the game with the relay address, a room name and the secret:
   `https://<you>.github.io/trophy/?relay=trophy-relay.<your-name>.workers.dev&room=campaign1#key=YOUR-SECRET`

Each room name is a separate game with its own database. The page remembers the relay
settings, so after the first visit the plain page address works on that device.

## Backups

- **Export data…** in the page's ⋯ menu downloads the whole database as a Django
  `dumpdata`-style JSON file. **Import data…** replaces everything with such a file
  (also the Django app's own `dumpdata` output; other apps' entries are skipped).
- Cloudflare also keeps 30 days of point-in-time history of every Durable Object's
  storage, restorable with the `getBookmarkForTime()` / `onNextSessionRestoreBookmark()`
  storage API if ever needed.

## Limits

Messages from browsers are limited to 1 MB (`maxMessage` in `room-core.mjs`); a larger
one gets an error reply instead of closing the connection. Connections silent for 70
seconds are closed (browsers ping every 25 seconds), which frees their field locks.
