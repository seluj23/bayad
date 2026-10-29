// A server database from before households (records keyed by user) is moved into per-person scopes on start.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('old server database is migrated and still syncs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayad-mig-'));
  const old = new DatabaseSync(path.join(dir, 'bayad-server.sqlite3'));
  old.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created TEXT NOT NULL, expires TEXT NOT NULL);
    CREATE TABLE records (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('item','loan')),
      id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (user_id, kind, id));
    INSERT INTO users VALUES (1, 'dev:old@test.com', 'old@test.com', 'x');
    INSERT INTO records VALUES (1, 'item', 'rent', '{"name":"Rent","paid":{"2026-10":"2026-10-01"}}', '2026-10-01T00:00:00.000Z', 0, 7);`);
  old.close();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, PUBLIC_URL: `http://127.0.0.1:${port}`, DEV_FAKE_LOGIN: '1', TRUST_PROXY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); }); server.on('exit', c => reject(new Error('exit ' + c))); });
    const r = await fetch(`http://127.0.0.1:${port}/auth/dev?email=old@test.com`, { redirect: 'manual' });
    const cookie = r.headers.getSetCookie()[0].split(';')[0];
    const j = await (await fetch(`http://127.0.0.1:${port}/api/sync`, { method: 'POST', headers: { Cookie: cookie, 'X-Bayad': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ cursors: {}, changes: [] }) })).json();
    assert.deepEqual(j.changes.map(c => [c.scope, c.kind, c.id, c.data.name, c.createdBy]), [['', 'item', 'rent', 'Rent', 1]]);
    assert.equal(j.cursors[''], 7, 'sequence numbers carry over, so phones don\'t download everything again');
  } finally { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
