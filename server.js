// Bayad server: serves the app and a small sync API, with Google sign-in.
// No npm dependencies — uses Node's built-in http, crypto and sqlite modules (Node 22+).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------- config ---------- */
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || '').trim();
const DEV_LOGIN = process.env.DEV_FAKE_LOGIN === '1'; // local testing only — never set in production
const SECURE = PUBLIC_URL.startsWith('https://');
const STATIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 180;
const MAX_RECORDS = Number(process.env.MAX_RECORDS_PER_USER || 5000); // bills, income and loans per account, including deleted ones
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 8); // local hour for the daily notification
const TRUST_PROXY = process.env.TRUST_PROXY !== '0'; // read the client address from X-Forwarded-For (set by Dokploy's Traefik)
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 7); // daily snapshots to keep; 0 turns them off
const REDIRECT_URI = PUBLIC_URL + '/auth/google/callback';

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('[bayad] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: sign-in is disabled, the app still works offline.');
if (!ALLOWED.length) console.warn('[bayad] ALLOWED_EMAILS not set: any Google account can sign in (each gets its own separate data).');
if (!CONTACT_EMAIL) console.warn('[bayad] CONTACT_EMAIL not set: the privacy policy and terms pages have no contact address.');
if (DEV_LOGIN) console.warn('[bayad] DEV_FAKE_LOGIN is ON. Do not use this in production.');

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bayad-server.sqlite3'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email      TEXT NOT NULL,
  created    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    TEXT NOT NULL,
  expires    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('item','loan')),
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(user_id, seq);
`);
const q = {
  userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  addUser: db.prepare('INSERT INTO users (google_sub, email, created) VALUES (?, ?, ?)'),
  setEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'), // sessions and records go with it (ON DELETE CASCADE)
  addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)'),
  session: db.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM records WHERE user_id = ?'),
  recordCount: db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?'),
  record: db.prepare('SELECT updated_at FROM records WHERE user_id = ? AND kind = ? AND id = ?'),
  upsert: db.prepare(`INSERT INTO records (user_id, kind, id, data, updated_at, deleted, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
    deleted = excluded.deleted, seq = excluded.seq`),
  since: db.prepare('SELECT kind, id, data, updated_at, deleted, seq FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 2000'),
};
q.pruneSessions.run(new Date().toISOString());
const reminders = require('./reminders')({ db, DATA_DIR, PUBLIC_URL, CONTACT_EMAIL, REMINDER_HOUR });

/* ---------- daily backups ---------- */
// A consistent copy of the database per day in BACKUP_DIR, keeping the newest BACKUP_KEEP.
// They live on the same volume, so they cover bad deletes and corruption, not a lost volume.
function backup() {
  if (BACKUP_KEEP <= 0) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `bayad-${new Date().toISOString().slice(0, 10)}.sqlite3`);
    if (fs.existsSync(file)) return;
    db.prepare('VACUUM INTO ?').run(file);
    const old = fs.readdirSync(BACKUP_DIR).filter(f => /^bayad-\d{4}-\d\d-\d\d\.sqlite3$/.test(f)).sort().slice(0, -BACKUP_KEEP);
    old.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    console.log('[bayad] backup written:', path.basename(file));
  } catch (e) { console.error('[bayad] backup failed:', e.message); }
}
backup();
setInterval(backup, 3600 * 1000).unref();

/* ---------- rate limits ---------- */
// Fixed one-minute windows, kept in memory. Fine for a single server process.
const hits = new Map();
function limited(key, max) {
  const t = Date.now();
  let h = hits.get(key);
  if (!h || h.reset <= t) { h = { n: 0, reset: t + 60000 }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (h.reset <= t) hits.delete(k); }, 60000).unref();
// Behind a reverse proxy (Dokploy's Traefik), the proxy appends the real client address last.
// Without one, clients could fake the header, so set TRUST_PROXY=0 when the app is reached directly.
function clientIp(req) {
  const xff = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || '';
}

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64url = buf => buf.toString('base64url');
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`;
}
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function redirect(res, to, extraHeaders = {}) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...extraHeaders }); res.end(); }
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse(await readBody(req, 64 * 1024) || '{}'); } catch { return null; }
}
function currentUser(req) {
  const t = cookies(req).bayad_session;
  if (!t) return null;
  return q.session.get(sha(t), new Date().toISOString()) || null;
}
function startSession(userId) {
  const token = b64url(crypto.randomBytes(32));
  const now = new Date();
  q.addSession.run(sha(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString());
  return cookie('bayad_session', token, SESSION_DAYS * 86400);
}
function loginUser(sub, email) {
  let u = q.userBySub.get(sub);
  if (!u) { const r = q.addUser.run(sub, email, new Date().toISOString()); u = { id: Number(r.lastInsertRowid) }; }
  else if (u.email !== email) q.setEmail.run(email, u.id);
  return u.id;
}

/* ---------- Google sign-in (authorization code + PKCE) ---------- */
function authStart(req, res) {
  if (!CLIENT_ID) return redirect(res, '/?sync=not_configured');
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email',
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  }).toString();
  redirect(res, url.toString(), { 'Set-Cookie': cookie('bayad_oauth', state + '.' + verifier, 600) });
}
async function authCallback(req, res, url) {
  const clear = cookie('bayad_oauth', '', 0);
  const [state, verifier] = (cookies(req).bayad_oauth || '').split('.');
  if (url.searchParams.get('error')) return redirect(res, '/?sync=cancelled', { 'Set-Cookie': clear });
  if (!state || state !== url.searchParams.get('state')) return redirect(res, '/?sync=failed', { 'Set-Cookie': clear });
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: verifier })
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) throw new Error('token exchange failed: ' + (tok.error || r.status));
    // The ID token came straight from Google over TLS, so its claims can be read directly (OpenID Connect §3.1.3.7).
    const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    const iss = claims.iss;
    if (claims.aud !== CLIENT_ID || (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') || claims.exp * 1000 < Date.now()) throw new Error('bad id token');
    if (!claims.email || claims.email_verified !== true) return redirect(res, '/?sync=unverified', { 'Set-Cookie': clear });
    const email = String(claims.email).toLowerCase();
    if (ALLOWED.length && !ALLOWED.includes(email)) return redirect(res, '/?sync=not_allowed', { 'Set-Cookie': clear });
    const sess = startSession(loginUser(claims.sub, email));
    redirect(res, '/?sync=signed_in', { 'Set-Cookie': [clear, sess] });
  } catch (e) {
    console.error('[bayad] sign-in failed:', e.message);
    redirect(res, '/?sync=failed', { 'Set-Cookie': clear });
  }
}

/* ---------- sync ---------- */
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
function sync(user, body) {
  const since = Number.isInteger(body.since) && body.since >= 0 ? body.since : 0;
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
  let accepted = 0, full = false;
  const rejected = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    let seq = q.maxSeq.get(user.id).m;
    let count = q.recordCount.get(user.id).n;
    for (const c of changes) {
      if (!c || (c.kind !== 'item' && c.kind !== 'loan')) continue;
      if (typeof c.id !== 'string' || !c.id || c.id.length > 100) continue;
      if (typeof c.updated_at !== 'string' || !ISO.test(c.updated_at)) continue;
      const data = JSON.stringify(c.deleted ? {} : (c.data && typeof c.data === 'object' ? c.data : {}));
      if (data.length > 65536) continue;
      const cur = q.record.get(user.id, c.kind, c.id);
      if (cur && cur.updated_at >= c.updated_at) continue; // newer (or same) version already stored
      if (!cur) { if (count >= MAX_RECORDS) { full = true; rejected.push({ kind: c.kind, id: c.id }); continue; } count++; }
      q.upsert.run(user.id, c.kind, c.id, data, c.updated_at, c.deleted ? 1 : 0, ++seq);
      accepted++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const rows = q.since.all(user.id, since);
  return {
    accepted,
    full,
    rejected,
    cursor: rows.length ? rows[rows.length - 1].seq : Math.max(since, 0),
    more: rows.length === 2000,
    changes: rows.map(r => ({ kind: r.kind, id: r.id, data: r.deleted ? null : JSON.parse(r.data), updated_at: r.updated_at, deleted: !!r.deleted }))
  };
}

/* ---------- security headers ---------- */
// Scripts only from this site ('wasm-unsafe-eval' lets the SQLite WebAssembly start). Styles allow inline
// because the page uses <style> and a few style="" attributes. Fonts come from Google Fonts, which the
// service worker also fetches, hence connect-src.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "img-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8' };

// Public pages linked from the Google sign-in consent screen. {{SITE}} and {{CONTACT}} are filled in from config.
const PAGES = { '/about': 'about.html', '/privacy': 'privacy.html', '/terms': 'terms.html' };
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function servePage(req, res, name) {
  fs.readFile(path.join(STATIC_DIR, name), 'utf8', (err, html) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const contact = CONTACT_EMAIL ? `<a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a>` : 'the person who runs this site';
    const body = html.replaceAll('{{SITE}}', esc(new URL(PUBLIC_URL).host)).replaceAll('{{CONTACT}}', contact);
    send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  });
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file);
    const cache = rel.startsWith('/icons/') ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- router ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;
  securityHeaders(res);
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    const ip = clientIp(req);
    if (p.startsWith('/auth/') && limited('auth:' + ip, 30)) return send(res, 429, 'Too many sign-in attempts. Wait a minute and try again.', { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    if (p.startsWith('/api/') && limited('api:' + ip, 300)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    if (p.startsWith('/cal/') && req.method === 'GET') {
      if (limited('cal:' + ip, 60)) return send(res, 429, 'Too many requests', { 'Content-Type': 'text/plain' });
      const m = /^\/cal\/([A-Za-z0-9_-]{20,64})\.ics$/.exec(p);
      const body = m && reminders.calendar(m[1]);
      if (!body) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return send(res, 200, body, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=900' });
    }
    if (p === '/auth/google' && req.method === 'GET') return authStart(req, res);
    if (p === '/auth/google/callback' && req.method === 'GET') return await authCallback(req, res, url);
    if (p === '/auth/dev' && DEV_LOGIN) {
      const email = (url.searchParams.get('email') || 'dev@example.com').toLowerCase();
      return redirect(res, '/?sync=signed_in', { 'Set-Cookie': startSession(loginUser('dev:' + email, email)) });
    }
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-bayad'] !== '1') return send(res, 403, { error: 'forbidden' });
      if (p === '/api/me' && req.method === 'GET') {
        const u = currentUser(req);
        return send(res, 200, { configured: !!CLIENT_ID || DEV_LOGIN, signedIn: !!u, email: u ? u.email : null });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        const t = cookies(req).bayad_session; if (t) q.dropSession.run(sha(t));
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('bayad_session', '', 0) });
      }
      if (p === '/api/push/key' && req.method === 'GET') return send(res, 200, { key: reminders.publicKey });
      if (p === '/api/calendar' || p.startsWith('/api/push/')) {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'signed_out' });
        const body = await readJson(req);
        if (!body) return send(res, 400, { error: 'bad_request' });
        if (p === '/api/calendar' && req.method === 'POST') return send(res, 200, { url: reminders.calendarUrl(u.id, body.tz, !!body.reset) });
        if (p === '/api/push/subscribe' && req.method === 'POST') {
          const err = reminders.subscribe(u.id, body);
          return err ? send(res, 400, { error: err }) : send(res, 200, { ok: true });
        }
        if (p === '/api/push/unsubscribe' && req.method === 'POST') { reminders.unsubscribe(u.id, body.endpoint); return send(res, 200, { ok: true }); }
        if (p === '/api/push/test' && req.method === 'POST') return send(res, 200, { sent: await reminders.test(u.id) });
        return send(res, 404, { error: 'not_found' });
      }
      if (p === '/api/delete-account' && req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'signed_out' });
        q.deleteUser.run(u.id);
        console.log('[bayad] account deleted: user', u.id);
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('bayad_session', '', 0) });
      }
      if (p === '/api/sync' && req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'signed_out' });
        if (limited('sync:' + u.id, 120)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
        let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, e.status || 400, { error: 'bad_request' }); }
        return send(res, 200, sync(u, body));
      }
      return send(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const page = PAGES[p.replace(/\.html$|\/$/, '')];
    if (page) return servePage(req, res, page);
    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[bayad]', e);
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
  }
});
server.listen(PORT, () => console.log(`[bayad] listening on :${PORT} (public URL ${PUBLIC_URL})`));
reminders.start();
