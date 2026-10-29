// Bayad database worker: runs SQLite (WebAssembly) and stores the database file
// in the browser's private file storage (OPFS) on this device.
// If OPFS isn't available (e.g. some private-browsing modes), it keeps the
// database in memory and saves a copy of the file to IndexedDB after each change.
import sqlite3InitModule from './sqlite/sqlite3.mjs';

const DB_NAME = '/bayad.sqlite3';
const SCHEMA_VERSION = 2;
let sqlite3, db, poolUtil, mode = 'opfs';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  dir         TEXT NOT NULL DEFAULT 'out' CHECK (dir IN ('in','out')),
  name        TEXT NOT NULL,
  amount      REAL,
  freq        TEXT NOT NULL DEFAULT 'monthly' CHECK (freq IN ('monthly','once')),
  due_day     INTEGER,
  due_date    TEXT,
  start_month TEXT,
  paid_on     TEXT,
  note        TEXT NOT NULL DEFAULT '',
  example     INTEGER NOT NULL DEFAULT 0,
  created     TEXT,
  updated_at  TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS item_months (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  month   TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  PRIMARY KEY (item_id, month)
);
CREATE TABLE IF NOT EXISTS loans (
  id           TEXT PRIMARY KEY,
  friend       TEXT NOT NULL,
  amount       REAL NOT NULL,
  lent_date    TEXT,
  promise_date TEXT,
  settled_on   TEXT,
  note         TEXT NOT NULL DEFAULT '',
  example      INTEGER NOT NULL DEFAULT 0,
  created      TEXT,
  updated_at   TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS loan_payments (
  id        INTEGER PRIMARY KEY,
  loan_id   TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount    REAL NOT NULL,
  paid_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loan_payments_loan ON loan_payments(loan_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/* ---------- IndexedDB copy (fallback mode only) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bayad-sqlite', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet() {
  const d = await idb();
  return new Promise((res, rej) => {
    const q = d.transaction('files').objectStore('files').get('main');
    q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
  });
}
async function idbPut(bytes) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('files', 'readwrite');
    t.objectStore('files').put(bytes, 'main');
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}

/* ---------- open ---------- */
function memoryDbFrom(bytes) {
  const mem = new sqlite3.oo1.DB(':memory:', 'c');
  if (bytes && bytes.byteLength) {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const c = sqlite3.capi;
    const rc = c.sqlite3_deserialize(mem.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
      c.SQLITE_DESERIALIZE_FREEONCLOSE | c.SQLITE_DESERIALIZE_RESIZEABLE);
    mem.checkRc(rc);
  }
  return mem;
}
function ensureSchema(d) {
  d.exec(SCHEMA);
  // v1 -> v2: sync columns
  for (const t of ['items', 'loans']) {
    const cols = d.selectValues(`SELECT name FROM pragma_table_info('${t}')`);
    if (!cols.includes('updated_at')) d.exec(`ALTER TABLE ${t} ADD COLUMN updated_at TEXT`);
    if (!cols.includes('deleted')) d.exec(`ALTER TABLE ${t} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('dirty')) d.exec(`ALTER TABLE ${t} ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1`);
    d.exec(`UPDATE ${t} SET updated_at = COALESCE(created, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL`);
  }
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
const now = () => new Date().toISOString();
async function open() {
  sqlite3 = await sqlite3InitModule();
  const opfsSupported = !!(self.navigator && navigator.storage && navigator.storage.getDirectory &&
    self.FileSystemFileHandle && 'createSyncAccessHandle' in FileSystemFileHandle.prototype);
  if (opfsSupported) {
    // The database file can only be open in one window at a time; wait briefly if another has it.
    let lastErr;
    for (let i = 0; i < 6; i++) {
      try {
        poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'bayad-pool', initialCapacity: 6 });
        db = new poolUtil.OpfsSAHPoolDb(DB_NAME);
        mode = 'opfs';
        break;
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 500)); }
    }
    if (!db) throw new Error('in_use: ' + (lastErr && lastErr.message));
  } else {
    mode = 'memory';
    db = memoryDbFrom(await idbGet().catch(() => null));
  }
  ensureSchema(db);
}
async function afterWrite() {
  if (mode === 'memory') await idbPut(sqlite3.capi.sqlite3_js_db_export(db.pointer));
}

/* ---------- rows <-> app objects ---------- */
function childMaps(d = db) {
  const byItem = {}, byLoan = {};
  d.selectObjects('SELECT item_id, month, paid_on FROM item_months').forEach(m => { (byItem[m.item_id] ||= {})[m.month] = m.paid_on; });
  d.selectObjects('SELECT loan_id, amount, paid_date FROM loan_payments ORDER BY id').forEach(p => { (byLoan[p.loan_id] ||= []).push({ amount: p.amount, date: p.paid_date }); });
  return { byItem, byLoan };
}
function itemObj(r, byItem) {
  const o = { id: r.id, dir: r.dir, name: r.name, amount: r.amount, freq: r.freq, note: r.note, created: r.created };
  if (r.example) o.example = true;
  if (r.freq === 'monthly') { o.dueDay = r.due_day; o.startMonth = r.start_month; o.paid = byItem[r.id] || {}; }
  else { o.dueDate = r.due_date; if (r.paid_on) o.paidOn = r.paid_on; }
  return o;
}
function loanObj(r, byLoan) {
  const o = { id: r.id, friend: r.friend, amount: r.amount, lentDate: r.lent_date, promiseDate: r.promise_date,
    note: r.note, created: r.created, payments: byLoan[r.id] || [] };
  if (r.settled_on) o.settledOn = r.settled_on;
  if (r.example) o.example = true;
  return o;
}
function readAll(d = db) {
  const { byItem, byLoan } = childMaps(d);
  return {
    bills: d.selectObjects('SELECT * FROM items WHERE deleted = 0 ORDER BY created, id').map(r => itemObj(r, byItem)),
    loans: d.selectObjects('SELECT * FROM loans WHERE deleted = 0 ORDER BY created, id').map(r => loanObj(r, byLoan))
  };
}
const n = v => (v === undefined || v === '' ? null : v);
function writeItem(b, stamp = now(), dirty = 1) {
  db.exec({
    sql: `INSERT INTO items (id,dir,name,amount,freq,due_day,due_date,start_month,paid_on,note,example,created,updated_at,deleted,dirty)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
          ON CONFLICT(id) DO UPDATE SET dir=excluded.dir,name=excluded.name,amount=excluded.amount,freq=excluded.freq,
          due_day=excluded.due_day,due_date=excluded.due_date,start_month=excluded.start_month,paid_on=excluded.paid_on,
          note=excluded.note,example=excluded.example,updated_at=excluded.updated_at,deleted=0,dirty=excluded.dirty`,
    bind: [b.id, b.dir === 'in' ? 'in' : 'out', b.name || '', n(b.amount), b.freq === 'once' ? 'once' : 'monthly',
      n(b.dueDay), n(b.dueDate), n(b.startMonth), n(b.paidOn), b.note || '', b.example ? 1 : 0, b.created || now(), stamp, dirty]
  });
  db.exec({ sql: 'DELETE FROM item_months WHERE item_id = ?', bind: [b.id] });
  for (const [month, paidOn] of Object.entries(b.paid || {})) {
    db.exec({ sql: 'INSERT INTO item_months (item_id, month, paid_on) VALUES (?,?,?)', bind: [b.id, month, paidOn] });
  }
}
function writeLoan(l, stamp = now(), dirty = 1) {
  db.exec({
    sql: `INSERT INTO loans (id,friend,amount,lent_date,promise_date,settled_on,note,example,created,updated_at,deleted,dirty)
          VALUES (?,?,?,?,?,?,?,?,?,?,0,?)
          ON CONFLICT(id) DO UPDATE SET friend=excluded.friend,amount=excluded.amount,lent_date=excluded.lent_date,
          promise_date=excluded.promise_date,settled_on=excluded.settled_on,note=excluded.note,example=excluded.example,
          updated_at=excluded.updated_at,deleted=0,dirty=excluded.dirty`,
    bind: [l.id, l.friend || '', Number(l.amount) || 0, n(l.lentDate), n(l.promiseDate), n(l.settledOn), l.note || '',
      l.example ? 1 : 0, l.created || now(), stamp, dirty]
  });
  db.exec({ sql: 'DELETE FROM loan_payments WHERE loan_id = ?', bind: [l.id] });
  for (const p of l.payments || []) {
    db.exec({ sql: 'INSERT INTO loan_payments (loan_id, amount, paid_date) VALUES (?,?,?)', bind: [l.id, Number(p.amount) || 0, p.date || ''] });
  }
}
const TABLE = { item: 'items', loan: 'loans' };
function softDelete(kind, id, stamp = now(), dirty = 1) {
  const t = TABLE[kind];
  if (kind === 'item') db.exec({ sql: 'DELETE FROM item_months WHERE item_id = ?', bind: [id] });
  else db.exec({ sql: 'DELETE FROM loan_payments WHERE loan_id = ?', bind: [id] });
  db.exec({ sql: `UPDATE ${t} SET deleted = 1, dirty = ?, updated_at = ? WHERE id = ?`, bind: [dirty, stamp, id] });
}
function replaceAll(data) {
  const stamp = now();
  db.transaction(() => {
    // Mark everything removed, then write the new set, so removals also reach your other devices.
    db.exec({ sql: 'DELETE FROM item_months; DELETE FROM loan_payments;' });
    db.exec({ sql: 'UPDATE items SET deleted = 1, dirty = 1, updated_at = ? WHERE deleted = 0', bind: [stamp] });
    db.exec({ sql: 'UPDATE loans SET deleted = 1, dirty = 1, updated_at = ? WHERE deleted = 0', bind: [stamp] });
    db.exec('DELETE FROM items WHERE example = 1; DELETE FROM loans WHERE example = 1;');
    (data.bills || []).forEach(b => writeItem(b, stamp));
    (data.loans || []).forEach(l => writeLoan(l, stamp));
  });
}

/* ---------- sync with the server ---------- */
function pendingChanges() {
  const { byItem, byLoan } = childMaps();
  const out = [];
  db.selectObjects('SELECT * FROM items WHERE dirty = 1 AND example = 0').forEach(r =>
    out.push({ kind: 'item', id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.deleted ? null : itemObj(r, byItem) }));
  db.selectObjects('SELECT * FROM loans WHERE dirty = 1 AND example = 0').forEach(r =>
    out.push({ kind: 'loan', id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.deleted ? null : loanObj(r, byLoan) }));
  return out;
}
function applyRemote({ pushed = [], changes = [], cursor = 0 }) {
  db.transaction(() => {
    for (const p of pushed) {
      db.exec({ sql: `UPDATE ${TABLE[p.kind]} SET dirty = 0 WHERE id = ? AND updated_at = ?`, bind: [p.id, p.updated_at] });
    }
    for (const c of changes) {
      const t = TABLE[c.kind]; if (!t) continue;
      const local = db.selectObject(`SELECT updated_at, dirty FROM ${t} WHERE id = ?`, [c.id]);
      if (local && local.updated_at >= c.updated_at) {
        if (local.updated_at === c.updated_at) db.exec({ sql: `UPDATE ${t} SET dirty = 0 WHERE id = ?`, bind: [c.id] });
        continue; // this device has the same or a newer version
      }
      if (c.deleted) {
        if (local) softDelete(c.kind, c.id, c.updated_at, 0);
        else db.exec({ sql: `INSERT INTO ${t} (id, ${c.kind === 'item' ? 'name' : 'friend, amount'}, updated_at, deleted, dirty) VALUES (?, '', ${c.kind === 'item' ? '' : '0, '}?, 1, 0)`, bind: [c.id, c.updated_at] });
      } else if (c.data) {
        const obj = Object.assign({}, c.data, { id: c.id }); delete obj.example;
        if (c.kind === 'item') writeItem(obj, c.updated_at, 0); else writeLoan(obj, c.updated_at, 0);
      }
    }
    // Once real data exists on the server, the sample entries aren't needed on this device.
    if (changes.some(c => !c.deleted)) db.exec('DELETE FROM items WHERE example = 1; DELETE FROM loans WHERE example = 1;');
    setMeta('sync_cursor', String(cursor));
  });
}
function resetSync() {
  db.transaction(() => {
    setMeta('sync_cursor', '0');
    db.exec('UPDATE items SET dirty = 1 WHERE example = 0; UPDATE loans SET dirty = 1 WHERE example = 0;');
  });
}
function getMeta(key) { return db.selectValue('SELECT value FROM meta WHERE key = ?', [key]) ?? null; }
function setMeta(key, value) { db.exec({ sql: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)', bind: [key, value] }); }

/* ---------- import a .sqlite backup ---------- */
async function importFile(bytes) {
  // Check it's a Bayad database before touching the real one.
  const test = memoryDbFrom(bytes);
  let data;
  try {
    const t = test.selectValues("SELECT name FROM sqlite_master WHERE type='table'");
    if (!['items', 'loans'].every(x => t.includes(x))) throw new Error('not_bayad');
    ensureSchema(test);
    data = readAll(test);
  } finally { test.close(); }
  replaceAll(data);
  await afterWrite();
  return readAll();
}

/* ---------- message handling (one at a time, in order) ---------- */
const ready = open();
let queue = Promise.resolve();
self.onmessage = e => {
  const { id, op, arg } = e.data;
  queue = queue.then(async () => {
    try {
      await ready;
      let result = null;
      if (op === 'init') {
        result = { mode, migrated: getMeta('migrated_v1') === '1', empty: db.selectValue('SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM loans)') === 0, ...readAll() };
      } else if (op === 'putItem') { db.transaction(() => writeItem(arg)); await afterWrite(); }
      else if (op === 'putLoan') { db.transaction(() => writeLoan(arg)); await afterWrite(); }
      else if (op === 'deleteItem') { db.transaction(() => softDelete('item', arg)); await afterWrite(); }
      else if (op === 'deleteLoan') { db.transaction(() => softDelete('loan', arg)); await afterWrite(); }
      else if (op === 'pending') { result = { cursor: Number(getMeta('sync_cursor') || 0), changes: pendingChanges() }; }
      else if (op === 'applyRemote') { applyRemote(arg); await afterWrite(); result = readAll(); }
      else if (op === 'readAll') { result = readAll(); }
      else if (op === 'resetSync') { resetSync(); await afterWrite(); }
      else if (op === 'replaceAll') { replaceAll(arg); if (arg.markMigrated) setMeta('migrated_v1', '1'); await afterWrite(); result = readAll(); }
      else if (op === 'setMeta') { setMeta(arg.key, arg.value); await afterWrite(); }
      else if (op === 'export') { result = sqlite3.capi.sqlite3_js_db_export(db.pointer); }
      else if (op === 'importFile') { result = await importFile(new Uint8Array(arg)); }
      else throw new Error('unknown op ' + op);
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
  });
};
