// The `sql` adapter of TrophyDB on top of Node's built-in SQLite (node:sqlite), for tests
// and the local dev server. Path ':memory:' gives a throwaway database.
import { DatabaseSync } from 'node:sqlite';

export function nodeSql(path = ':memory:') {
  const db = new DatabaseSync(path);
  return {
    all(q, ...params) {
      const st = db.prepare(q);
      return /^\s*(SELECT|INSERT[\s\S]*RETURNING|WITH)/i.test(q) ? st.all(...params) : (st.run(...params), []);
    },
    transaction(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}
