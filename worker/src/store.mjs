// A small, generic document store on the room's SQLite database. It knows nothing about
// Trophy: the page owns the data layout, the game rules and the schema migrations.
// `sql` is an adapter: { all(query, ...params) -> rows, transaction(fn) }.
//
// - Documents: key (e.g. "character/16") -> JSON object, with a revision number (rev) that
//   goes up by one on every change.
// - dataVersion: which layout the documents follow. Set only by migrate/import. Every write
//   says which version it was made for and is refused if that is not the current one, so a
//   page with old code cannot write old-style data after an upgrade.
// - Batches: a list of put / patch / delete, applied all or nothing. Each may require the
//   document's current rev (ifRev; 0 = must not exist), so a page can change something it
//   read without overwriting a change it has not seen; on a conflict nothing is written.
// - Op ids: a batch may carry an id (oid); a batch whose id was already applied is not applied
//   again (a resend after a lost reply).
// - Backups: the full document set is kept before every migrate/import/restore (last 10).
// - Legacy: tables other than the store's own (the rooms of the previous relay version kept
//   their data in Django-style tables) are handed to the page as raw rows while dataVersion
//   is 0, so the page can convert them. They are never changed or removed.

export const PROTOCOL = 3; // version of the page <-> room protocol; the page has the same number

const OWN_TABLES = new Set(['docs', 'store_meta', 'store_applied', 'store_backups']);
const KEY_RE = /^[a-z][a-z0-9_]{0,31}\/[A-Za-z0-9_-]{1,64}$/;
const MAX_DOC = 256 * 1024;       // bytes of JSON per document
const MAX_BATCH = 500;            // writes per batch
const APPLIED_KEEP_MS = 2 * 24 * 3600 * 1000;
const BACKUPS_KEEP = 10;

export class StoreError extends Error {
  constructor(message, code = 'invalid', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS docs (key TEXT NOT NULL PRIMARY KEY, rev INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS store_meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS store_applied (oid TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL, result TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS store_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, reason TEXT NOT NULL, data_version INTEGER NOT NULL, docs TEXT NOT NULL)`,
];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export class DocStore {
  constructor(sql, { now = () => Date.now() } = {}) {
    this.sql = sql; this.now = now;
    for (const q of DDL) sql.all(q);
    if (this.getMeta('epoch') == null) this.setMeta('epoch', Math.random().toString(36).slice(2, 10));
    this.epoch = this.getMeta('epoch');
    this.seq = Number(this.getMeta('seq') || 0);
    this.dataVersion = Number(this.getMeta('data_version') || 0);
  }

  getMeta(key) { const r = this.sql.all(`SELECT value FROM store_meta WHERE key = ?`, key)[0]; return r ? r.value : null; }
  setMeta(key, value) {
    this.sql.all(`INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
  }
  bumpSeq() { this.seq++; this.setMeta('seq', this.seq); }

  // --- reading ---------------------------------------------------------------------
  allDocs() { return this.sql.all(`SELECT key, rev, data FROM docs ORDER BY key`).map(r => [r.key, Number(r.rev), JSON.parse(r.data)]); }
  getDoc(key) { const r = this.sql.all(`SELECT rev, data FROM docs WHERE key = ?`, key)[0]; return r ? { rev: Number(r.rev), data: JSON.parse(r.data) } : null; }

  // Raw rows of tables the store does not own (data of the previous relay version).
  legacyTables() {
    const names = this.sql.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(r => r.name)
      .filter(n => !OWN_TABLES.has(n) && !n.startsWith('sqlite_') && !n.startsWith('_cf'));
    const out = {};
    for (const n of names) out[n] = this.sql.all(`SELECT * FROM "${n.replace(/"/g, '""')}"`).map(r => ({ ...r }));
    return out;
  }

  snapshot() {
    const snap = { dataVersion: this.dataVersion, docs: this.allDocs() };
    if (this.dataVersion === 0) {
      const legacy = this.legacyTables();
      if (Object.keys(legacy).length) snap.legacy = legacy;
    }
    return snap;
  }

  // --- writing ---------------------------------------------------------------------

  // Apply a batch. Returns { result, docs: [[key, rev, data]], deleted: [key], seq, duplicate }.
  write({ version, writes, oid = null, result = null }) {
    if (version !== this.dataVersion) throw new StoreError(`The data is at version ${this.dataVersion}, not ${version}. Reload the page.`, 'version', { dataVersion: this.dataVersion });
    if (!Array.isArray(writes) || !writes.length) throw new StoreError('Nothing to write.');
    if (writes.length > MAX_BATCH) throw new StoreError('Too many changes at once.');
    oid = oid == null ? null : String(oid).slice(0, 64);
    if (oid) {
      const seen = this.sql.all(`SELECT result FROM store_applied WHERE oid = ?`, oid)[0];
      if (seen) return { result: JSON.parse(seen.result), docs: [], deleted: [], seq: this.seq, duplicate: true };
    }
    const seqBefore = this.seq;
    try {
      return this.sql.transaction(() => {
        const touched = new Map(), deleted = new Set();
        for (const w of writes) {
          if (!isObject(w) || typeof w.key !== 'string' || !KEY_RE.test(w.key)) throw new StoreError('Bad document key: ' + (w && w.key));
          const cur = this.getDoc(w.key);
          if (w.ifRev != null && (cur ? cur.rev : 0) !== w.ifRev) {
            throw new StoreError('Someone else changed this at the same time.', 'conflict', { key: w.key, rev: cur ? cur.rev : 0 });
          }
          if (w.op === 'delete') {
            if (cur) { this.sql.all(`DELETE FROM docs WHERE key = ?`, w.key); deleted.add(w.key); touched.delete(w.key); }
            continue;
          }
          let data;
          if (w.op === 'put') {
            if (!isObject(w.data)) throw new StoreError('A document must be an object.');
            data = w.data;
          } else if (w.op === 'patch') {
            if (!cur) throw new StoreError('This no longer exists.', 'missing', { key: w.key });
            if (!isObject(w.fields)) throw new StoreError('A patch must be an object.');
            data = { ...cur.data, ...w.fields };
          } else throw new StoreError('Unknown write: ' + w.op);
          const text = JSON.stringify(data);
          if (text.length > MAX_DOC) throw new StoreError('A document is too large.');
          const rev = (cur ? cur.rev : 0) + 1;
          this.sql.all(`INSERT INTO docs (key, rev, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev, data = excluded.data`, w.key, rev, text);
          deleted.delete(w.key); touched.set(w.key, [w.key, rev, data]);
        }
        this.bumpSeq();
        if (oid) {
          const now = this.now();
          this.sql.all(`DELETE FROM store_applied WHERE at < ?`, now - APPLIED_KEEP_MS);
          this.sql.all(`INSERT INTO store_applied (oid, at, result) VALUES (?, ?, ?)`, oid, now, JSON.stringify(result));
        }
        return { result, docs: [...touched.values()], deleted: [...deleted], seq: this.seq, duplicate: false };
      });
    } catch (e) {
      this.seq = seqBefore;
      throw e;
    }
  }

  // Replace every document and set the data version, keeping a backup first.
  // migrate: only if the data is still at `from` (two pages upgrading at once: one wins).
  replaceAll({ docs, dataVersion, from = null, reason }) {
    if (from != null && from !== this.dataVersion) throw new StoreError('Already upgraded by someone else.', 'version', { dataVersion: this.dataVersion });
    if (!Number.isInteger(dataVersion) || dataVersion < 1) throw new StoreError('Bad data version.');
    if (!isObject(docs)) throw new StoreError('Documents must be an object of key -> document.');
    for (const [k, v] of Object.entries(docs)) {
      if (!KEY_RE.test(k)) throw new StoreError('Bad document key: ' + k);
      if (!isObject(v)) throw new StoreError('A document must be an object: ' + k);
      if (JSON.stringify(v).length > MAX_DOC) throw new StoreError('A document is too large: ' + k);
    }
    const before = { seq: this.seq, dataVersion: this.dataVersion };
    try {
      this.sql.transaction(() => {
        this.backup(reason);
        this.sql.all(`DELETE FROM docs`);
        for (const [k, v] of Object.entries(docs)) this.sql.all(`INSERT INTO docs (key, rev, data) VALUES (?, 1, ?)`, k, JSON.stringify(v));
        this.dataVersion = dataVersion; this.setMeta('data_version', dataVersion);
        this.bumpSeq();
      });
    } catch (e) {
      Object.assign(this, before);
      throw e;
    }
  }

  backup(reason) {
    const docs = Object.fromEntries(this.allDocs().map(([k, , d]) => [k, d]));
    if (!Object.keys(docs).length) return; // nothing worth keeping (e.g. the first upgrade of an old room)
    this.sql.all(`INSERT INTO store_backups (at, reason, data_version, docs) VALUES (?, ?, ?, ?)`, this.now(), String(reason).slice(0, 100), this.dataVersion, JSON.stringify(docs));
    this.sql.all(`DELETE FROM store_backups WHERE id NOT IN (SELECT id FROM store_backups ORDER BY id DESC LIMIT ${BACKUPS_KEEP})`);
  }

  listBackups() {
    return this.sql.all(`SELECT id, at, reason, data_version, length(docs) AS size FROM store_backups ORDER BY id DESC`)
      .map(r => ({ id: Number(r.id), at: Number(r.at), reason: r.reason, dataVersion: Number(r.data_version), size: Number(r.size) }));
  }
  getBackup(id) {
    const r = this.sql.all(`SELECT data_version, docs FROM store_backups WHERE id = ?`, id)[0];
    if (!r) throw new StoreError('No such backup.');
    return { dataVersion: Number(r.data_version), docs: JSON.parse(r.docs) };
  }

  exportAll() {
    return { format: 'trophy-docs', dataVersion: this.dataVersion, exportedAt: new Date(this.now()).toISOString(),
      docs: Object.fromEntries(this.allDocs().map(([k, , d]) => [k, d])) };
  }
}
