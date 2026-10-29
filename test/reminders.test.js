// reminders.js: push encryption and signing, the daily digest, and the calendar feed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BayadSchedule: S } = require('../public/schedule.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayad-rem-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys = ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE records (scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, created_by INTEGER, updated_by INTEGER, PRIMARY KEY (scope, kind, id));`);
const H = require('../households.js')({ db, PUBLIC_URL: 'https://bayad.example.com' });
const R = require('../reminders.js')({ db, households: H, DATA_DIR: dir, PUBLIC_URL: 'https://bayad.example.com', CONTACT_EMAIL: 'me@example.com' });
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

test('a push message decrypts on the receiving side (RFC 8291)', () => {
  const ua = crypto.createECDH('prime256v1'), uaPub = ua.generateKeys(), auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'Bayad reminder', body: 'Meralco due · ₱2,800 · tomorrow' });
  const enc = R._test.encrypt(msg, uaPub.toString('base64url'), auth.toString('base64url'));
  const salt = enc.subarray(0, 16), idlen = enc[20], asPub = enc.subarray(21, 21 + idlen), ct = enc.subarray(21 + idlen);
  assert.equal(enc.readUInt32BE(16), 4096);
  const ikm = hmac(hmac(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const dec = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16),
    hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  dec.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]);
  assert.equal(plain[plain.length - 1], 2); // last-record delimiter
  assert.equal(plain.subarray(0, -1).toString(), msg);
});

test('the VAPID token is signed by the advertised key', () => {
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(R._test.vapidAuth('https://fcm.googleapis.com/fcm/send/abc'));
  assert.equal(k, R.publicKey);
  const [h, c, sig] = jwt.split('.'), pub = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
});

test('only real push services are contacted', () => {
  for (const ok of ['https://fcm.googleapis.com/x', 'https://web.push.apple.com/x', 'https://updates.push.services.mozilla.com/x', 'https://wns2-par02p.notify.windows.com/x']) assert.ok(R._test.pushHostOk(ok), ok);
  for (const bad of ['https://evil.com/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://localhost/x', 'not a url']) assert.ok(!R._test.pushHostOk(bad), bad);
});

test('subscriptions are validated', () => {
  db.prepare("INSERT INTO users (id, google_sub, email, created) VALUES (9, 'sub9', 'x@y.z', 'x')").run();
  const keys = { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.equal(R.subscribe(9, { subscription: { endpoint: 'https://evil.com/x', keys } }), 'bad_endpoint');
  assert.equal(R.subscribe(9, { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: keys.auth } } }), 'bad_keys');
  assert.equal(R.subscribe(9, { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys }, tz: 'Asia/Manila' }), null);
});

// Data relative to "today" in Manila, where the digest is computed.
const t = S.parseD(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()));
const day = n => { const d = new Date(t); d.setDate(d.getDate() + n); return d; };
db.prepare("INSERT INTO users (id, google_sub, email, created) VALUES (1, 'sub1', 'a@b.c', 'x')").run();
const put = (kind, id, data, scope = 'u:1') => db.prepare('INSERT INTO records (scope, kind, id, data, updated_at, seq) VALUES (?, ?, ?, ?, ?, 1)').run(scope, kind, id, JSON.stringify(data), 'x');
put('item', 'meralco', { name: 'Meralco', dir: 'out', amount: 2800, freq: 'monthly', dueDay: day(1).getDate(), startMonth: S.ym(day(1)), paid: {} });
put('item', 'rent', { name: 'Rent, unit 4B', dir: 'out', amount: 12000, freq: 'once', dueDate: S.iso(day(-3)) });
put('item', 'water', { name: 'Water', dir: 'out', amount: 400, freq: 'once', dueDate: S.iso(t) });
put('pay', 'water|once', { itemId: 'water', period: 'once', on: S.iso(t), amount: 400 }); // paid, as a separate payment record
put('item', 'legacy', { name: 'Old style', dir: 'out', amount: 100, freq: 'once', dueDate: S.iso(t), paidOn: S.iso(t) }); // paid, the old way
// A household bill shows up for its members.
db.prepare("INSERT INTO users (id, google_sub, email, created) VALUES (2, 'sub2', 'ana@b.c', 'x')").run();
assert.equal(H.create(2, 'Vivas family'), null);
const inv = H.invite(2, 'member');
assert.equal(H.join(1, inv.url.split('/join/')[1]), null);
put('item', 'condo', { name: 'Condo dues', dir: 'out', amount: 3000, freq: 'once', dueDate: S.iso(day(1)) }, 'h:' + H.membership(1).id);
put('item', 'tip', { name: 'Late income', dir: 'in', amount: 100, freq: 'once', dueDate: S.iso(day(-2)) });
put('loan', 'ely', { friend: 'Tita Ely', dir: 'out', amount: 5000, promiseDate: S.iso(t), payments: [{ amount: 2000, date: S.iso(t) }] });

test('the daily digest lists what is due, overdue bills and debts, not paid or late income', () => {
  const d = R._test.digest(1, 'Asia/Manila');
  assert.match(d.body, /Meralco due · ₱2,800 · tomorrow/);
  assert.match(d.body, /Rent, unit 4B due · ₱12,000 · 3 days overdue/);
  assert.match(d.body, /Pay back Tita Ely · ₱3,000 · today/);
  assert.match(d.body, /Condo dues due · ₱3,000 · tomorrow/);
  assert.doesNotMatch(d.body, /Water|Late income|Old style/);
  assert.equal(d.title, 'Bayad: 3 coming up, 1 overdue');
});

test('the calendar feed is valid iCalendar and its link can be reset', () => {
  const url = R.calendarUrl(1, 'Asia/Manila'), token = u => u.split('/cal/')[1].replace('.ics', '');
  assert.match(url, /^https:\/\/bayad\.example\.com\/cal\/[A-Za-z0-9_-]{32}\.ics$/);
  assert.equal(R.calendarUrl(1, 'Asia/Manila'), url, 'same link until reset');
  const ics = R.calendar(token(url));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Rent\\, unit 4B due · ₱12\\,000/);
  assert.match(ics, /TRIGGER:-PT15H/);
  assert.doesNotMatch(ics, /Water/);
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines folded at 75 bytes');
  const fresh = R.calendarUrl(1, null, true);
  assert.notEqual(fresh, url);
  assert.equal(R.calendar(token(url)), null, 'old link stops working');
  H.leave(1);
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(R.calendar(token(fresh)), null, 'deleted account has no feed');
});
