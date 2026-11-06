# Trophy web client

A static page version of the Trophy app: no Python, served from GitHub Pages. The Cloudflare
relay in `../worker` stores the game data as generic JSON documents; everything about Trophy
(the data layout, the game rules, the schema migrations) lives here in the page. Every browser
keeps a full copy of the (small) data; changes go to the relay as batches of document writes
and the relay passes them to everyone, so all views stay live like the Django + alive version.

All pages of the Django app are ported: Characters (list and sheet), Overview, Roller,
Bestiary and Equipment, plus People (supporting characters). Overview, Equipment and People are the GM's pages,
shown only in **GM mode** (⋯ menu), a setting of each browser. On the Roller, the browser whose Roll button is clicked rolls the
dice and the relay passes the faces to everyone; Equipment rolls are each viewer's own, as before.

## Layout

- `index.html`, `css/app.css` – page and styles (hand-written, matching the DaisyUI look)
- `js/app.js` – start-up, page routing (`?view=character&id=5`), menu, export/import, theme.
  Exports are made for version control: always `trophy-<room>.json`, no time stamp inside,
  keys sorted, so unchanged data exports to an identical file
- `js/data.js` – the local copy of the data, the connection to the room, retries on
  simultaneous changes, the offline outbox, upgrading old data
- `js/model/migrations.js` – the data layout, its version (`DATA_VERSION`) and how to get there
  from older layouts, the previous relay version and Django dumps
- `js/model/rules.js` – every game operation (ported from the Django app's `alive_hooks.py`)
- `js/model/view.js` – reading the documents (`get`, `all`, `childrenOf`)
- `js/transport.js` – the relay client, copied from vod-js
- `js/ui.js` – edit-field behaviour, markdown, small helpers
- `js/views/characters.js` – character list and sheet
- `js/views/overview.js` – read-only table of all characters (column groups fold per viewer)
- `js/views/roller.js` – shared dice mat, per-character sections, roll reference
- `js/views/bestiary.js` – shared monster boxes, with field locks like the sheet
- `js/views/equipment.js` – 2d6 rolls on the equipment tables (GM mode)
- `js/views/people.js` – supporting characters (GM mode): generated Look (three descriptors) and
  Equipment (one roll on each equipment table) as comma-separated lists, then freely edited;
  the die buttons add one more; filter per viewer
- `js/lists.js` – loads `lists/`: descriptors and the d6/d6 tables (named in `TABLES` there,
  since GitHub Pages cannot list a folder)
- `lists/` – copy of `trophy/lists/` (the page fetches these; GitHub Pages only serves this folder)
- `vendor/` – third-party code, nothing loads from a CDN:
  lit-html 3.3.3 (built from the lit repo sources), marked 18.0.10, DOMPurify 3.4.14

## Changing the data layout

1. In `js/model/migrations.js`, add step N+1 to `STEPS`: a function from the version-N
   documents (`{key: data}`) to the new ones. Raise `DATA_VERSION`. Describe the new layout
   in the comment at the top.
2. Change the rules and views to the new layout.
3. Add a test in `../test/model.test.mjs` (e.g. upgrade the real dump and check the result).
4. Publish the page. The first page with the new code to open a room upgrades it (the relay
   keeps a backup); pages with older code ask to be reloaded. The worker does not change.

Keep every step: a room left unopened for a long time upgrades through all of them.
`package.json` here only tells Node that these files are modules, for the tests.

## Run locally

The dev server stands in for both GitHub Pages and the Cloudflare relay, using Node's
built-in SQLite:

    cd dev && npm install && node server.mjs --seed ../trophy-db.json

Then open http://localhost:8787/?relay=localhost:8787&room=test#key=dev in two browsers.
`--memory` keeps the database in memory only; otherwise it is saved in `dev/dev-<room>.sqlite`.

To try bad connections, start it with `--chaos` and open
http://localhost:8787/__chaos?do=freeze (connections go silent without closing, like a phone
that lost its network) or `?do=drop` (all connections cut). Stopping the server tests an outage.

## When the connection breaks

- The status in the top bar shows Connected / Saving… / Reconnecting…; a banner explains an
  outage and has a "Retry now" button.
- A connection that goes silent is noticed within about 15 seconds (sooner when you edit
  something); a cut connection is back within a few seconds once the network is.
- Text edits made while disconnected (fields, list item names, new list items) are kept, also
  over a page reload, and sent when the connection is back. Clicks (Ruin, checkboxes, +/−)
  need the connection and say so.
- If connecting fails, the page says why: wrong secret, wrong address, the relay and page
  being different versions, or a network that blocks WebSockets.

**Plan B for game night:** if the internet at the table fails, export the data, run the dev
server on a laptop (`node server.mjs --seed exported.json`), and have everyone open
`http://LAPTOP-IP:8787/?relay=http://LAPTOP-IP:8787&room=test#key=dev` on the same Wi-Fi.
Afterwards export from there and import back into the Cloudflare room.

## Publish on GitHub Pages

In the repository settings, under Pages, choose "Deploy from a branch", branch `main`,
folder `/docs`. The empty `.nojekyll` file makes Pages serve every file as it is.
