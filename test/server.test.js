// End-to-end checks against a real server process with a throwaway data folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayad-srv-'));
const PORT = 40000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, PUBLIC_URL: base, DEV_FAKE_LOGIN: '1', MAX_RECORDS_PER_USER: '2', CONTACT_EMAIL: 'me@example.com', TRUST_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email) {
  const r = await fetch(`${base}/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return r.headers.getSetCookie().find(c => c.startsWith('bayad_session=')).split(';')[0];
}
const api = (cookie, p, body) => fetch(base + p, { method: 'POST', headers: { Cookie: cookie, 'X-Bayad': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const change = (id, data, at = '2026-10-30T00:00:00.000Z') => ({ kind: 'item', id, updated_at: at, data });

test('health check and security headers', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('strict-transport-security'), null, 'HSTS only over https');
});

test('the app page has no inline scripts (the CSP would block them)', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /<script>(?!<\/script>)/);
  assert.match(html, /<script src="app.js"><\/script>/);
});

test('public pages fill in the site and contact', async () => {
  for (const p of ['/about', '/privacy', '/terms']) {
    const html = await (await fetch(base + p)).text();
    assert.doesNotMatch(html, /\{\{/, p);
    assert.match(html, /mailto:me@example\.com/, p);
    assert.match(html, /class="back" href="\/">Back to app/, p);
  }
});

test('the API refuses requests without the app header or a session', async () => {
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'X-Bayad': '1' } })).status, 401);
});

test('sync round trip, newest change wins, storage cap', async () => {
  const a = await login('sync@test.com');
  let j = await (await api(a, '/api/sync', { since: 0, changes: [change('x', { name: 'Rent' }), change('y', { name: 'Water' }), change('z', { name: 'Gas' })] })).json();
  assert.equal(j.accepted, 2);
  assert.equal(j.full, true);
  assert.deepEqual(j.rejected, [{ kind: 'item', id: 'z' }], 'over the cap is reported, not silently dropped');
  j = await (await api(a, '/api/sync', { since: 0, changes: [change('x', { name: 'Old' }, '2026-01-01T00:00:00.000Z')] })).json();
  assert.equal(j.accepted, 0, 'an older change does not overwrite a newer one');
  const b = await login('sync@test.com'); // a second device
  j = await (await api(b, '/api/sync', { since: 0, changes: [] })).json();
  assert.deepEqual(j.changes.map(c => c.data.name).sort(), ['Rent', 'Water']);
});

test('calendar link and feed', async () => {
  const a = await login('cal@test.com');
  await api(a, '/api/sync', { since: 0, changes: [change('m', { name: 'Meralco', dir: 'out', amount: 2800, freq: 'once', dueDate: '2099-01-05' })] });
  const { url } = await (await api(a, '/api/calendar', { tz: 'Asia/Manila' })).json();
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/calendar/);
  assert.equal((await fetch(`${base}/cal/not-a-real-token-at-all-xyz.ics`)).status, 404);
});

test('deleting an account removes its data and calendar', async () => {
  const a = await login('gone@test.com');
  await api(a, '/api/sync', { since: 0, changes: [change('g', { name: 'Gone' })] });
  const { url } = await (await api(a, '/api/calendar', {})).json();
  assert.equal((await api(a, '/api/delete-account')).status, 200);
  assert.equal((await api(a, '/api/sync', { since: 0, changes: [] })).status, 401);
  assert.equal((await fetch(url)).status, 404);
  const again = await login('gone@test.com');
  const j = await (await api(again, '/api/sync', { since: 0, changes: [] })).json();
  assert.deepEqual(j.changes, [], 'signing in again starts empty');
});

test('sign-in is rate limited', async () => {
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status);
  assert.ok(codes.includes(429));
  assert.ok(codes.indexOf(429) <= 30);
});
