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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, PUBLIC_URL: base, DEV_FAKE_LOGIN: '1', MAX_RECORDS_PER_USER: '4', CONTACT_EMAIL: 'me@example.com', TRUST_PROXY: '0' },
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
  let j = await (await api(a, '/api/sync', { since: 0, changes: ['x', 'y', 'w', 'v', 'z'].map((id, i) => change(id, { name: ['Rent', 'Water', 'Gas', 'Phone', 'Over'][i] })) })).json();
  assert.equal(j.accepted, 4);
  assert.equal(j.full, true);
  assert.deepEqual(j.rejected, [{ scope: '', kind: 'item', id: 'z', reason: 'full' }], 'over the cap is reported, not silently dropped');
  j = await (await api(a, '/api/sync', { since: 0, changes: [change('x', { name: 'Old' }, '2026-01-01T00:00:00.000Z')] })).json();
  assert.equal(j.accepted, 0, 'an older change does not overwrite a newer one');
  const b = await login('sync@test.com'); // a second device
  j = await (await api(b, '/api/sync', { since: 0, changes: [] })).json();
  assert.deepEqual(j.changes.map(c => c.data.name).sort(), ['Gas', 'Phone', 'Rent', 'Water']);
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


/* ---------- households ---------- */
const sync = async (cookie, cursors, changes = []) => (await api(cookie, '/api/sync', { cursors, changes })).json();
async function joinWith(cookie, url) {
  const r = await fetch(url, { redirect: 'manual' });
  const join = r.headers.getSetCookie().find(c => c.startsWith('bayad_join=')).split(';')[0];
  return api(`${cookie}; ${join}`, '/api/household/join');
}

test('households: invite, roles, shared bills and payments', async () => {
  const owner = await login('owner@house.test'), mem = await login('mem@house.test'), view = await login('view@house.test');
  let r = await (await api(owner, '/api/household', { name: '  Vivas   family ' })).json();
  assert.equal(r.household.name, 'Vivas family');
  assert.equal(r.household.role, 'owner');
  const scope = r.household.scope;
  assert.equal((await api(mem, '/api/household/invite', { role: 'member' })).status, 403, 'only the owner invites');

  const memberLink = (await (await api(owner, '/api/household/invite', { role: 'member' })).json()).url;
  const viewerLink = (await (await api(owner, '/api/household/invite', { role: 'viewer' })).json()).url;
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: mem + '; ' + (await fetch(memberLink, { redirect: 'manual' })).headers.getSetCookie()[0].split(';')[0] } })).json();
  assert.deepEqual(me.invite, { household: 'Vivas family', role: 'member', from: 'owner@house.test' }, 'the app can show who invited them');
  assert.equal((await joinWith(mem, memberLink)).status, 200);
  assert.equal((await joinWith(view, memberLink)).status, 400, 'an invite works once');
  assert.equal((await joinWith(view, viewerLink)).status, 200);
  const info = (await (await fetch(`${base}/api/household`, { headers: { Cookie: owner } })).json()).household;
  assert.deepEqual(info.members.map(m => [m.email, m.role]), [['owner@house.test', 'owner'], ['mem@house.test', 'member'], ['view@house.test', 'viewer']]);

  // The owner shares a bill; everyone sees it.
  const bill = { ...change('condo', { name: 'Condo dues', amount: 3000 }), scope };
  r = await sync(owner, { '': 0, [scope]: 0 }, [bill]);
  assert.deepEqual(r.scopes.map(s => [s.scope, s.role]), [['', 'owner'], [scope, 'owner']]);
  r = await sync(view, { '': 0, [scope]: 0 });
  assert.deepEqual(r.changes.filter(c => c.scope === scope).map(c => c.data.name), ['Condo dues']);

  // A member records a payment: it carries who did it.
  const pay = { scope, kind: 'pay', id: 'condo|2026-11', updated_at: '2026-11-01T00:00:00.000Z', data: { itemId: 'condo', period: '2026-11', on: '2026-11-01', amount: 3150, ref: 'GCash 1' } };
  r = await sync(mem, {}, [pay]);
  assert.equal(r.accepted, 1);
  const memId = info.members[1].id;
  r = await sync(owner, { '': 0, [scope]: 0 });
  assert.equal(r.changes.find(c => c.kind === 'pay').createdBy, memId);

  // A viewer can't change anything; the server sends its copy back.
  r = await sync(view, {}, [{ ...change('condo', { name: 'Hacked' }, '2026-12-01T00:00:00.000Z'), scope }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  assert.equal(r.changes.find(c => c.force).data.name, 'Condo dues');
  // A member can edit, but can't delete what the owner added. The owner can.
  r = await sync(mem, {}, [{ ...change('condo', { name: 'Condo dues (Nov)' }, '2026-12-02T00:00:00.000Z'), scope }]);
  assert.equal(r.accepted, 1);
  r = await sync(mem, {}, [{ scope, kind: 'item', id: 'condo', updated_at: '2026-12-03T00:00:00.000Z', deleted: true }]);
  assert.equal(r.rejected[0].reason, 'forbidden');
  r = await sync(mem, {}, [{ ...change('mine', { name: 'Groceries' }), scope }]);
  r = await sync(mem, {}, [{ scope, kind: 'item', id: 'mine', updated_at: '2026-12-03T00:00:00.000Z', deleted: true }]);
  assert.equal(r.accepted, 1, 'members can delete what they added');
  r = await sync(owner, {}, [{ scope, kind: 'item', id: 'condo', updated_at: '2026-12-04T00:00:00.000Z', deleted: true }]);
  assert.equal(r.accepted, 1, 'the owner can delete anything');
  // Loans stay personal.
  r = await sync(mem, {}, [{ scope, kind: 'loan', id: 'l1', updated_at: '2026-12-01T00:00:00.000Z', data: { friend: 'X', amount: 1 } }]);
  assert.equal(r.rejected[0].reason, 'forbidden');

  // Removing someone takes the household out of their sync.
  assert.equal((await api(mem, '/api/household/remove', { userId: info.members[2].id })).status, 403);
  assert.equal((await api(owner, '/api/household/remove', { userId: info.members[2].id })).status, 200);
  r = await sync(view, { '': 0, [scope]: 0 });
  assert.deepEqual(r.scopes.map(s => s.scope), ['']);
  // The owner leaving hands the household to the member.
  assert.equal((await api(owner, '/api/household/leave')).status, 200);
  const after = (await (await fetch(`${base}/api/household`, { headers: { Cookie: mem } })).json()).household;
  assert.deepEqual(after.members.map(m => [m.email, m.role]), [['mem@house.test', 'owner']]);
  // The last one out removes the household and its shared bills.
  assert.equal((await api(mem, '/api/household/leave')).status, 200);
  assert.equal((await (await fetch(`${base}/api/household`, { headers: { Cookie: mem } })).json()).household, null);
});

test('apps from before households still sync their own data', async () => {
  const a = await login('legacy@test.com');
  const j = await (await api(a, '/api/sync', { since: 0, changes: [change('old', { name: 'Old app bill' })] })).json();
  assert.equal(j.accepted, 1);
  assert.equal(typeof j.cursor, 'number');
  assert.ok(j.changes.every(c => c.scope === ''));
});

// Last, because it uses up this address's sign-in allowance for the minute.
test('sign-in is rate limited', async () => {
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status);
  assert.ok(codes.includes(429));
  assert.ok(codes.indexOf(429) <= 30);
});
