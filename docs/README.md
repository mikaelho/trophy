# Trophy web client

A static page version of the Trophy app: no Python, served from GitHub Pages, with the game
data held by the Cloudflare relay in `../worker`. Every browser keeps a full copy of the
(small) database; writes go to the room as operations and the room broadcasts the changed
rows to everyone, so all views stay live like the Django + alive version.

Status: the character list and character sheet are ported. Overview, Roller, Bestiary and
Equipment are still to do.

## Layout

- `index.html`, `css/app.css` – page and styles (hand-written, matching the DaisyUI look)
- `js/app.js` – start-up, page routing (`?view=character&id=5`), menu, export/import, theme
- `js/data.js` – the local database copy and the connection to the room
- `js/transport.js` – the relay client, copied from vod-js
- `js/ui.js` – edit-field behaviour, markdown, small helpers
- `js/views/characters.js` – character list and sheet
- `lists/` – copy of `trophy/lists/` (the page fetches these; GitHub Pages only serves this folder)
- `vendor/` – third-party code, nothing loads from a CDN:
  lit-html 3.3.3 (built from the lit repo sources), marked 18.0.10, DOMPurify 3.4.14

## Run locally

The dev server stands in for both GitHub Pages and the Cloudflare relay, using Node's
built-in SQLite:

    cd dev && npm install && node server.mjs --seed ../trophy-db.json

Then open http://localhost:8787/?relay=localhost:8787&room=test#key=dev in two browsers.
`--memory` keeps the database in memory only; otherwise it is saved in `dev/dev-<room>.sqlite`.

## Publish on GitHub Pages

In the repository settings, under Pages, choose "Deploy from a branch", branch `main`,
folder `/docs`. The empty `.nojekyll` file makes Pages serve every file as it is.
