// Bayad database worker: runs SQLite (WebAssembly) and stores the database file
// in the browser's private file storage (OPFS) on this device.
// If OPFS isn't available (e.g. some private-browsing modes), it keeps the
// database in memory and saves a copy of the file to IndexedDB after each change.
import sqlite3InitModule from './sqlite/sqlite3.mjs';

const DB_NAME = '/bayad.sqlite3';
const SCHEMA_VERSION = 5;
const FREQS = ['monthly', 'twice', 'weekly', 'biweekly', 'quarterly', 'yearly', 'once'];
let sqlite3, db, poolUtil, mode = 'opfs';

// freq: monthly | twice (two days a month) | weekly | biweekly | quarterly | yearly | once
const ITEMS_TABLE = `CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  dir         TEXT NOT NULL DEFAULT 'out' CHECK (dir IN ('in','out')),
  name        TEXT NOT NULL,
  amount      REAL,
  freq        TEXT NOT NULL DEFAULT 'monthly',
  due_day     INTEGER,
  due_day2    INTEGER,
  due_date    TEXT,
  start_month TEXT,
  paid_on     TEXT,
  paid_amount REAL,
  paid_ref    TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  example     INTEGER NOT NULL DEFAULT 0,
  created     TEXT,
  updated_at  TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);`;
const SCHEMA = `
PRAGMA foreign_keys = ON;
${ITEMS_TABLE}
CREATE TABLE IF NOT EXISTS item_months (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  month   TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  amount  REAL,
  ref     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (item_id, month)
);
-- One payment of an item for one period. The id is item id + '|' + period, so the same period
-- recorded on two devices (or by two people in a household) is one record, not two.
CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  period     TEXT NOT NULL,
  paid_on    TEXT NOT NULL,
  amount     REAL,
  ref        TEXT NOT NULL DEFAULT '',
  scope      TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  updated_at TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS payments_item ON payments(item_id);
CREATE TABLE IF NOT EXISTS loans (
  id           TEXT PRIMARY KEY,
  dir          TEXT NOT NULL DEFAULT 'in',
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
  paid_date TEXT NOT NULL,
  ref       TEXT NOT NULL DEFAULT ''
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
  // v2 -> v3: more repeat options, money you owe, payment amounts and references
  const itemsSql = d.selectValue("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'") || '';
  if (itemsSql.includes("CHECK (freq IN")) {
    // SQLite can't drop a CHECK in place, so rebuild the table. Foreign keys are off so item_months isn't cascaded away.
    const keep = 'id,dir,name,amount,freq,due_day,due_date,start_month,paid_on,note,example,created,updated_at,deleted,dirty';
    d.exec('PRAGMA foreign_keys = OFF');
    d.transaction(() => {
      d.exec(ITEMS_TABLE.replace('IF NOT EXISTS items (', 'items_v3 ('));
      d.exec(`INSERT INTO items_v3 (${keep}) SELECT ${keep} FROM items`);
      d.exec('DROP TABLE items');
      d.exec('ALTER TABLE items_v3 RENAME TO items');
    });
    d.exec('PRAGMA foreign_keys = ON');
  }
  const addCols = (t, cols) => { const have = d.selectValues(`SELECT name FROM pragma_table_info('${t}')`); for (const [c, def] of cols) if (!have.includes(c)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  addCols('item_months', [['amount', 'REAL'], ['ref', "TEXT NOT NULL DEFAULT ''"]]);
  addCols('items', [['category', "TEXT NOT NULL DEFAULT ''"]]); // v3 -> v4
  addCols('loans', [['dir', "TEXT NOT NULL DEFAULT 'in'"]]);
  addCols('loan_payments', [['ref', "TEXT NOT NULL DEFAULT ''"]]);
  addCols('items', [['scope', "TEXT NOT NULL DEFAULT ''"], ['created_by', 'INTEGER']]); // v4 -> v5
  // v4 -> v5: payments move out of item_months and the items' paid_* columns into their own records.
  // They keep their bill's timestamp so a newer undo from another device still wins.
  if (!d.selectValue("SELECT value FROM meta WHERE key = 'payments_v5'")) {
    d.transaction(() => {
      d.exec(`INSERT OR IGNORE INTO payments (id, item_id, period, paid_on, amount, ref, scope, updated_at, dirty)
        SELECT m.item_id || '|' || m.month, m.item_id, m.month, m.paid_on, m.amount, m.ref, i.scope, i.updated_at, 1
        FROM item_months m JOIN items i ON i.id = m.item_id`);
      d.exec(`INSERT OR IGNORE INTO payments (id, item_id, period, paid_on, amount, ref, scope, updated_at, dirty)
        SELECT id || '|once', id, 'once', paid_on, paid_amount, paid_ref, scope, updated_at, 1 FROM items WHERE freq = 'once' AND paid_on IS NOT NULL`);
      d.exec("DELETE FROM item_months; UPDATE items SET paid_on = NULL, paid_amount = NULL, paid_ref = ''");
      d.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('payments_v5', '1')");
    });
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
// The app sees a bill's payments as `paid` (period -> date, or {on, amount, ref, by}) or, for one-time
// bills, paidOn/paidAmount/paidRef/paidBy, as before payments became their own records.
const payValue = p => { const v = { on: p.paid_on }; if (p.amount != null) v.amount = p.amount; if (p.ref) v.ref = p.ref; if (p.created_by != null) v.by = p.created_by; return v; };
function childMaps(d = db) {
  const byItem = {}, once = {}, byLoan = {};
  d.selectObjects('SELECT * FROM payments WHERE deleted = 0').forEach(p => {
    const v = payValue(p);
    if (p.period === 'once') once[p.item_id] = v;
    else (byItem[p.item_id] ||= {})[p.period] = Object.keys(v).length === 1 ? v.on : v;
  });
  d.selectObjects('SELECT loan_id, amount, paid_date, ref FROM loan_payments ORDER BY id').forEach(p => {
    const o = { amount: p.amount, date: p.paid_date }; if (p.ref) o.ref = p.ref;
    (byLoan[p.loan_id] ||= []).push(o);
  });
  return { byItem, once, byLoan };
}
function itemObj(r, maps) {
  const o = { id: r.id, dir: r.dir, name: r.name, amount: r.amount, freq: r.freq, note: r.note, created: r.created };
  if (r.category) o.category = r.category;
  if (r.scope) o.scope = r.scope;
  if (r.created_by != null) o.createdBy = r.created_by;
  if (r.example) o.example = true;
  if (r.freq === 'once') {
    o.dueDate = r.due_date;
    const p = maps.once[r.id];
    if (p) { o.paidOn = p.on; if (p.amount != null) o.paidAmount = p.amount; if (p.ref) o.paidRef = p.ref; if (p.by != null) o.paidBy = p.by; }
  } else {
    o.paid = maps.byItem[r.id] || {};
    if (r.freq === 'weekly' || r.freq === 'biweekly') o.dueDate = r.due_date;
    else { o.dueDay = r.due_day; o.startMonth = r.start_month; if (r.freq === 'twice') o.dueDay2 = r.due_day2; }
  }
  return o;
}
// What an item record carries when synced: the bill itself, without its payments, scope or author.
function itemData(r) {
  const o = itemObj(r, { byItem: {}, once: {} });
  delete o.paid; delete o.scope; delete o.createdBy; delete o.example;
  return o;
}
function loanObj(r, byLoan) {
  const o = { id: r.id, dir: r.dir === 'out' ? 'out' : 'in', friend: r.friend, amount: r.amount, lentDate: r.lent_date, promiseDate: r.promise_date,
    note: r.note, created: r.created, payments: byLoan[r.id] || [] };
  if (r.settled_on) o.settledOn = r.settled_on;
  if (r.example) o.example = true;
  return o;
}
function readAll(d = db) {
  const maps = childMaps(d);
  return {
    bills: d.selectObjects('SELECT * FROM items WHERE deleted = 0 ORDER BY created, id').map(r => itemObj(r, maps)),
    loans: d.selectObjects('SELECT * FROM loans WHERE deleted = 0 ORDER BY created, id').map(r => loanObj(r, maps.byLoan))
  };
}
const n = v => (v === undefined || v === '' ? null : v);
const payOf = v => typeof v === 'string' ? { on: v } : (v || {});
// withPayments: the item comes from the app (or a backup), so its paid periods are the truth for this device.
function writeItem(b, stamp = now(), dirty = 1, withPayments = true) {
  db.exec({
    sql: `INSERT INTO items (id,dir,name,amount,freq,due_day,due_day2,due_date,start_month,category,scope,created_by,note,example,created,updated_at,deleted,dirty)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
          ON CONFLICT(id) DO UPDATE SET dir=excluded.dir,name=excluded.name,amount=excluded.amount,freq=excluded.freq,
          due_day=excluded.due_day,due_day2=excluded.due_day2,due_date=excluded.due_date,start_month=excluded.start_month,
          category=excluded.category,scope=excluded.scope,created_by=COALESCE(excluded.created_by, items.created_by),
          note=excluded.note,example=excluded.example,updated_at=excluded.updated_at,deleted=0,dirty=excluded.dirty`,
    bind: [b.id, b.dir === 'in' ? 'in' : 'out', b.name || '', n(b.amount), FREQS.includes(b.freq) ? b.freq : 'monthly',
      n(b.dueDay), n(b.dueDay2), n(b.dueDate), n(b.startMonth), String(b.category || '').slice(0, 40), b.scope || '', n(b.createdBy),
      b.note || '', b.example ? 1 : 0, b.created || now(), stamp, dirty]
  });
  if (withPayments) syncPayments(b, stamp);
}
// Make the item's payment records match its paid periods: add or change what differs, delete what's gone.
function syncPayments(b, stamp) {
  const want = {};
  if (b.freq === 'once') { if (b.paidOn) want.once = { on: b.paidOn, amount: b.paidAmount, ref: b.paidRef, by: b.paidBy }; }
  else for (const [k, v] of Object.entries(b.paid || {})) { const p = payOf(v); if (p.on) want[k] = p; }
  const have = {};
  db.selectObjects('SELECT * FROM payments WHERE item_id = ?', [b.id]).forEach(r => { have[r.period] = r; });
  const scope = b.scope || '';
  for (const [period, p] of Object.entries(want)) {
    const h = have[period], amount = n(p.amount) == null ? null : Number(p.amount), ref = p.ref || '';
    if (h && !h.deleted && h.paid_on === String(p.on) && (h.amount ?? null) === amount && (h.ref || '') === ref && h.scope === scope) continue;
    db.exec({
      sql: `INSERT INTO payments (id,item_id,period,paid_on,amount,ref,scope,created_by,updated_at,deleted,dirty) VALUES (?,?,?,?,?,?,?,?,?,0,1)
            ON CONFLICT(id) DO UPDATE SET paid_on=excluded.paid_on,amount=excluded.amount,ref=excluded.ref,scope=excluded.scope,
            created_by=CASE WHEN payments.deleted = 1 THEN excluded.created_by ELSE COALESCE(payments.created_by, excluded.created_by) END,
            updated_at=excluded.updated_at,deleted=0,dirty=1`,
      bind: [b.id + '|' + period, b.id, period, String(p.on), amount, ref, scope, n(p.by), stamp]
    });
  }
  for (const [period, h] of Object.entries(have)) {
    if (!h.deleted && !want[period]) db.exec({ sql: 'UPDATE payments SET deleted = 1, dirty = 1, updated_at = ? WHERE id = ?', bind: [stamp, h.id] });
  }
}
// Bills synced before payments were separate records carry them inside. Turn those into payment records
// unless this device already knows that period (paid or undone), keeping the bill's timestamp.
function adoptLegacyPayments(b, stamp) {
  const periods = b.freq === 'once' ? (b.paidOn ? { once: { on: b.paidOn, amount: b.paidAmount, ref: b.paidRef } } : {}) : (b.paid || {});
  for (const [period, v] of Object.entries(periods)) {
    const p = payOf(v), id = b.id + '|' + period;
    if (!p.on || db.selectValue('SELECT 1 FROM payments WHERE id = ?', [id])) continue;
    db.exec({ sql: 'INSERT INTO payments (id,item_id,period,paid_on,amount,ref,scope,updated_at,deleted,dirty) VALUES (?,?,?,?,?,?,?,?,0,1)',
      bind: [id, b.id, period, String(p.on), n(p.amount), p.ref || '', b.scope || '', stamp] });
  }
}
function writePayment(c) {
  const d = c.data || {};
  db.exec({
    sql: `INSERT INTO payments (id,item_id,period,paid_on,amount,ref,scope,created_by,updated_at,deleted,dirty) VALUES (?,?,?,?,?,?,?,?,?,0,0)
          ON CONFLICT(id) DO UPDATE SET item_id=excluded.item_id,period=excluded.period,paid_on=excluded.paid_on,amount=excluded.amount,ref=excluded.ref,
          scope=excluded.scope,created_by=excluded.created_by,updated_at=excluded.updated_at,deleted=0,dirty=0`,
    bind: [c.id, String(d.itemId || ''), String(d.period || ''), String(d.on || ''), n(d.amount), d.ref || '', c.scope || '', n(c.createdBy), c.updated_at]
  });
}
function writeLoan(l, stamp = now(), dirty = 1) {
  db.exec({
    sql: `INSERT INTO loans (id,dir,friend,amount,lent_date,promise_date,settled_on,note,example,created,updated_at,deleted,dirty)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)
          ON CONFLICT(id) DO UPDATE SET dir=excluded.dir,friend=excluded.friend,amount=excluded.amount,lent_date=excluded.lent_date,
          promise_date=excluded.promise_date,settled_on=excluded.settled_on,note=excluded.note,example=excluded.example,
          updated_at=excluded.updated_at,deleted=0,dirty=excluded.dirty`,
    bind: [l.id, l.dir === 'out' ? 'out' : 'in', l.friend || '', Number(l.amount) || 0, n(l.lentDate), n(l.promiseDate), n(l.settledOn), l.note || '',
      l.example ? 1 : 0, l.created || now(), stamp, dirty]
  });
  db.exec({ sql: 'DELETE FROM loan_payments WHERE loan_id = ?', bind: [l.id] });
  for (const p of l.payments || []) {
    db.exec({ sql: 'INSERT INTO loan_payments (loan_id, amount, paid_date, ref) VALUES (?,?,?,?)', bind: [l.id, Number(p.amount) || 0, p.date || '', p.ref || ''] });
  }
}
const TABLE = { item: 'items', loan: 'loans', pay: 'payments' };
function softDelete(kind, id, stamp = now(), dirty = 1) {
  const t = TABLE[kind];
  if (kind === 'item') db.exec({ sql: 'UPDATE payments SET deleted = 1, dirty = ?, updated_at = ? WHERE item_id = ? AND deleted = 0', bind: [dirty, stamp, id] });
  else if (kind === 'loan') db.exec({ sql: 'DELETE FROM loan_payments WHERE loan_id = ?', bind: [id] });
  db.exec({ sql: `UPDATE ${t} SET deleted = 1, dirty = ?, updated_at = ? WHERE id = ?`, bind: [dirty, stamp, id] });
}
const dropExamples = () => db.exec('DELETE FROM payments WHERE item_id IN (SELECT id FROM items WHERE example = 1); DELETE FROM items WHERE example = 1; DELETE FROM loans WHERE example = 1;');
// Restoring a backup replaces this person's own entries. Household bills aren't theirs to replace, so they stay.
function replaceAll(data) {
  const stamp = now();
  db.transaction(() => {
    // Mark everything removed, then write the new set, so removals also reach your other devices.
    db.exec('DELETE FROM loan_payments');
    db.exec({ sql: "UPDATE payments SET deleted = 1, dirty = 1, updated_at = ? WHERE deleted = 0 AND scope = ''", bind: [stamp] });
    db.exec({ sql: "UPDATE items SET deleted = 1, dirty = 1, updated_at = ? WHERE deleted = 0 AND scope = ''", bind: [stamp] });
    db.exec({ sql: 'UPDATE loans SET deleted = 1, dirty = 1, updated_at = ? WHERE deleted = 0', bind: [stamp] });
    dropExamples();
    (data.bills || []).filter(b => !b.scope).forEach(b => writeItem(Object.assign({}, b, { createdBy: null }), stamp));
    (data.loans || []).forEach(l => writeLoan(l, stamp));
  });
}

/* ---------- sync with the server ---------- */
function pendingChanges() {
  const { byLoan } = childMaps();
  const out = [];
  db.selectObjects('SELECT * FROM items WHERE dirty = 1 AND example = 0').forEach(r =>
    out.push({ scope: r.scope, kind: 'item', id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.deleted ? null : itemData(r) }));
  db.selectObjects('SELECT p.* FROM payments p LEFT JOIN items i ON i.id = p.item_id WHERE p.dirty = 1 AND COALESCE(i.example, 0) = 0').forEach(p =>
    out.push({ scope: p.scope, kind: 'pay', id: p.id, updated_at: p.updated_at, deleted: !!p.deleted,
      data: p.deleted ? null : { itemId: p.item_id, period: p.period, on: p.paid_on, amount: p.amount, ref: p.ref || '' } }));
  db.selectObjects('SELECT * FROM loans WHERE dirty = 1 AND example = 0').forEach(r =>
    out.push({ scope: '', kind: 'loan', id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.deleted ? null : loanObj(r, byLoan) }));
  return out;
}
function cursors() {
  const c = getMeta('sync_cursors');
  if (c) return JSON.parse(c);
  const legacy = getMeta('sync_cursor'); // before households there was one cursor, for this person's own data
  return legacy ? { '': Number(legacy) } : {};
}
function applyRemote({ pushed = [], changes = [], cursors: next = {}, scopes = null }) {
  db.transaction(() => {
    for (const p of pushed) {
      if (TABLE[p.kind]) db.exec({ sql: `UPDATE ${TABLE[p.kind]} SET dirty = 0 WHERE id = ? AND updated_at = ?`, bind: [p.id, p.updated_at] });
    }
    for (const c of changes) {
      const t = TABLE[c.kind]; if (!t) continue;
      const local = db.selectObject(`SELECT updated_at, dirty FROM ${t} WHERE id = ?`, [c.id]);
      // A forced change is the server undoing something it refused (no permission), so it always wins.
      if (!c.force && local && local.updated_at >= c.updated_at) {
        if (local.updated_at === c.updated_at) {
          db.exec({ sql: `UPDATE ${t} SET dirty = 0 WHERE id = ?`, bind: [c.id] });
          if (c.kind !== 'loan' && c.createdBy != null) db.exec({ sql: `UPDATE ${t} SET created_by = ? WHERE id = ?`, bind: [c.createdBy, c.id] });
        }
        continue; // this device has the same or a newer version
      }
      if (c.kind === 'pay') {
        if (c.deleted) { if (local) db.exec({ sql: 'UPDATE payments SET deleted = 1, dirty = 0, updated_at = ? WHERE id = ?', bind: [c.updated_at, c.id] }); }
        else if (c.data) writePayment(c);
        continue;
      }
      if (c.deleted) {
        if (local) softDelete(c.kind, c.id, c.updated_at, 0);
        else if (c.kind === 'item') db.exec({ sql: "INSERT INTO items (id, name, scope, updated_at, deleted, dirty) VALUES (?, '', ?, ?, 1, 0)", bind: [c.id, c.scope || '', c.updated_at] });
        else db.exec({ sql: "INSERT INTO loans (id, friend, amount, updated_at, deleted, dirty) VALUES (?, '', 0, ?, 1, 0)", bind: [c.id, c.updated_at] });
      } else if (c.data) {
        const obj = Object.assign({}, c.data, { id: c.id, scope: c.scope || '', createdBy: c.createdBy }); delete obj.example;
        if (c.kind === 'item') { writeItem(obj, c.updated_at, 0, false); adoptLegacyPayments(obj, c.updated_at); }
        else writeLoan(obj, c.updated_at, 0);
      }
    }
    // Once real data exists on the server, the sample entries aren't needed on this device.
    if (changes.some(c => !c.deleted)) dropExamples();
    // Shared bills from a household this person has left (or was removed from) go away.
    if (Array.isArray(scopes)) {
      const keep = scopes.map(s => String(s.scope)).filter(Boolean);
      const not = keep.length ? ` AND scope NOT IN (${keep.map(() => '?').join(',')})` : '';
      db.exec({ sql: `DELETE FROM payments WHERE scope != ''${not}`, bind: keep });
      db.exec({ sql: `DELETE FROM items WHERE scope != ''${not}`, bind: keep });
    }
    setMeta('sync_cursors', JSON.stringify(next || {}));
  });
}
// Signing out: forget household bills (they belong to the household, not this phone) and resend everything else next time.
function resetSync() {
  db.transaction(() => {
    setMeta('sync_cursors', '{}');
    db.exec("DELETE FROM payments WHERE scope != ''; DELETE FROM items WHERE scope != '';");
    db.exec('UPDATE items SET dirty = 1 WHERE example = 0; UPDATE loans SET dirty = 1 WHERE example = 0;');
    db.exec('UPDATE payments SET dirty = 1 WHERE item_id IN (SELECT id FROM items WHERE example = 0)');
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
      else if (op === 'pending') { result = { cursors: cursors(), changes: pendingChanges() }; }
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
