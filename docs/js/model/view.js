// The local copy of the documents, read the way the rules and pages need it:
// get(kind, id), all(kind), childrenOf(kind, characterId). Rows are the document's fields
// plus id (the part of the key after "kind/") and rev. Used by data.js and the tests.
import { byPosition } from './rules.js';

export class DocView {
  constructor() { this.docs = new Map(); this.cache = new Map(); }

  // Replace everything: docs = [[key, rev, data]].
  load(docs) { this.docs = new Map(docs.map(([k, rev, data]) => [k, { rev, data }])); this.cache.clear(); }
  // Apply changes from the relay.
  apply(docs, deleted = []) {
    for (const [k, rev, data] of docs) this.docs.set(k, { rev, data });
    for (const k of deleted) this.docs.delete(k);
    this.cache.clear();
  }
  // {key: data}, e.g. for a migration.
  asObject() { return Object.fromEntries([...this.docs].map(([k, d]) => [k, d.data])); }

  all(kind) {
    if (!this.cache.has(kind)) {
      const prefix = kind + '/', rows = [];
      for (const [k, d] of this.docs) if (k.startsWith(prefix)) rows.push({ ...d.data, id: k.slice(prefix.length), rev: d.rev });
      this.cache.set(kind, rows);
    }
    return this.cache.get(kind);
  }
  get(kind, id) {
    const d = this.docs.get(`${kind}/${id}`);
    return d ? { ...d.data, id: String(id), rev: d.rev } : null;
  }
  rev(key) { return this.docs.get(key)?.rev ?? 0; }
  // Rows of a child list of one character, in sheet order.
  childrenOf(kind, characterId, order = byPosition) {
    return this.all(kind).filter(r => r.character === characterId).sort(order);
  }
}
