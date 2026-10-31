# Trophy web client

A static page version of the Trophy app: no Python, served from GitHub Pages, with the game
data held by the Cloudflare relay in `../worker`. Every browser keeps a full copy of the
(small) database; writes go to the room as operations and the room broadcasts the changed
rows to everyone, so all views stay live like the Django + alive version.

All pages of the Django app are ported: Characters (list and sheet), Overview, Roller,
Bestiary and Equipment. On the Roller, the browser whose Roll button is clicked rolls the
dice and the relay passes the faces to everyone; Equipment rolls are each viewer's own, as before.

## Layout

- `index.html`, `css/app.css` – page and styles (hand-written, matching the DaisyUI look)
- `js/app.js` – start-up, page routing (`?view=character&id=5`), menu, export/import, theme
- `js/data.js` – the local database copy and the connection to the room
- `js/transport.js` – the relay client, copied from vod-js
- `js/ui.js` – edit-field behaviour, markdown, small helpers
- `js/views/characters.js` – character list and sheet
- `js/views/overview.js` – read-only table of all characters (column groups fold per viewer)
- `js/views/roller.js` – shared dice mat, per-character sections, roll reference
- `js/views/bestiary.js` – shared monster boxes, with field locks like the sheet
- `js/views/equipment.js` – 2d6 rolls on the tables in `lists/` (the file names are listed in
  `TABLES` there, since GitHub Pages cannot list a folder)
- `lists/` – copy of `trophy/lists/` (the page fetches these; GitHub Pages only serves this folder)
- `vendor/` – third-party code, nothing loads from a CDN:
  lit-html 3.3.3 (built from the lit repo sources), marked 18.0.10, DOMPurify 3.4.14

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
