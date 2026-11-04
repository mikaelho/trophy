# Trophy relay (Cloudflare Worker)

One Durable Object per game room. It relays messages between the players' browsers like the
VoD relay, and keeps the room's data in the Durable Object's built-in SQLite as a small,
generic **document store**. It knows nothing about Trophy: the page (`docs/`) owns the data
layout, the game rules and the schema migrations. Schema and feature changes therefore only
need the page to be published; the worker rarely changes. The Free Cloudflare plan is enough.

- `src/store.mjs` – the document store: documents with revisions, all-or-nothing batches,
  data version, migrate/import with backups, hand-over of old tables
- `src/room-core.mjs` – the room: relay, the built-in `db` peer, field locks, change broadcast
- `src/worker.js` – the Cloudflare wrapper (secret check, hibernation, `/check`)
- `test/` – tests that run without Cloudflare (Node 22.5+); from the repository root:
  `node --test test/*.test.mjs worker/test/*.test.mjs`

## Deploy

1. Install Node.js, then in this folder: `npm install -g wrangler` and `wrangler login`
2. Choose a secret and store it in Cloudflare, not in git: `wrangler secret put RELAY_SECRET`
3. `wrangler deploy` – it prints the relay address, like `trophy-relay.<your-name>.workers.dev`
4. Check it from the command line (reads only, changes nothing):
   `node ../dev/check-relay.mjs trophy-relay.<your-name>.workers.dev 'YOUR-SECRET' campaign1`
   It checks the address, the secret, the version, the live connection, the game data and
   round-trip times, and says what to fix if something is wrong. Worth running before a session.
5. Open the game with the relay address, a room name and the secret:
   `https://<you>.github.io/trophy/?relay=trophy-relay.<your-name>.workers.dev&room=campaign1#key=YOUR-SECRET`

Each room name is a separate game with its own data. The page remembers the relay settings,
so after the first visit the plain page address works on that device.

## Moving from the previous relay version

Rooms made by the previous version keep their data in Django-style tables. Deploy this
version over it: the tables stay as they are, and the first page to open the room converts
them into documents and hands them to the relay (once, even if several pages open the room
at the same moment). The old tables are never changed or removed. Data from the Django app
itself comes in with **Import data…** in the page's ⋯ menu (a `dumpdata` file).

## The store

- **Documents:** key `kind/id` (e.g. `character/16`) → a JSON object, with a revision number
  that goes up on every change. The page describes the kinds in `docs/js/model/migrations.js`.
- **Batches:** `put` / `patch` (merge fields) / `delete`, applied all or nothing. A write can
  require the document's current revision (`ifRev`; 0 = must not exist): when two people
  change the same thing at once, the later batch is refused and the page computes it again.
- **Data version:** which layout the documents follow. Every write states the version it was
  made for; writes for another version are refused, so a page with old code can't write
  old-style data after an upgrade.
- **Upgrades:** a page with newer code converts the documents and sends them with "replace
  everything if still at version N"; one page wins, everybody gets the new data.
- **Backups:** before every upgrade, import and restore the full data is kept (the last 10).
  **Backups…** in the page's menu lists and restores them; a restore is itself backed up.
- **No double edits:** every batch carries a unique id; a batch resent after a lost reply is
  not applied again (ids are remembered for two days).

## Keeping connections reliable

- **Hibernation.** Rooms use Cloudflare's WebSocket Hibernation API: between messages the room
  can be unloaded while connections stay open, so an idle room (a tab left open for days)
  uses no duration and cannot run down the free plan's daily allowance. Pings are answered by
  Cloudflare itself without waking the room. What the room knows about each connection
  (peer id, held field locks) is stored with the connection and restored on wake-up; change
  numbering is stored in the database.
- **Dead connections.** Browsers ping every 5 s. The room closes connections silent for 70 s
  and frees their field locks; while locks are held, an alarm checks every 30 s.
- **Versions.** The page and the relay check that they speak the same protocol version
  (`PROTOCOL` in `src/store.mjs` and `docs/js/data.js`); on a mismatch the page asks to be
  reloaded or the worker to be redeployed. This only changes when the store itself changes.
- **/check.** `GET /check` with header `X-Relay-Key` (base64url of the secret) reports whether
  the secret is right and the protocol version. The page uses it to explain connection
  problems in plain words; `dev/check-relay.mjs` uses it too.

## Limits

Messages from browsers are limited to 1 MB (`maxMessage` in `room-core.mjs`), documents to
256 KB, batches to 500 writes. Cloudflare limits a stored value to 2 MB, which also bounds a
backup (the whole data; today about 20 KB).

Cloudflare also keeps 30 days of point-in-time history of every Durable Object's storage,
restorable with the `getBookmarkForTime()` / `onNextSessionRestoreBookmark()` storage API.
