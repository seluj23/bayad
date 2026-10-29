// Bayad reminders: a private calendar feed (iCalendar) and a daily Web Push notification.
// No dependencies: Web Push encryption (RFC 8291) and VAPID signing (RFC 8292) use Node's crypto.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BayadSchedule: Sch } = require('./public/schedule.js');

const DEFAULT_TZ = 'Asia/Manila';
// Only these push services are contacted, so a subscription can't point the server at arbitrary URLs.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const MAX_SUBS_PER_USER = 10;

const peso = n => '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function validTz(tz) { try { return !!tz && !!new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; } }
// Today's date and hour in a time zone.
function localNow(tz) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz) ? tz : DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function title(x) {
  if (x.kind === 'income') return `${x.name} expected`;
  if (x.kind === 'loan') return `${x.name} promised to pay you`;
  if (x.kind === 'debt') return `Pay back ${x.name}`;
  return `${x.name} due`;
}
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// iCalendar lines are folded at 75 bytes without splitting a UTF-8 character.
function fold(line) {
  const b = Buffer.from(line);
  if (b.length <= 75) return line;
  const out = [];
  for (let start = 0, first = true; start < b.length; first = false) {
    let end = Math.min(b.length, start + (first ? 75 : 74));
    while (end < b.length && (b[end] & 0xc0) === 0x80) end--;
    out.push((first ? '' : ' ') + b.subarray(start, end).toString());
    start = end;
  }
  return out.join('\r\n');
}

module.exports = function reminders({ db, DATA_DIR, PUBLIC_URL, CONTACT_EMAIL, REMINDER_HOUR = 8 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh   TEXT NOT NULL,
    auth     TEXT NOT NULL,
    tz       TEXT NOT NULL,
    created  TEXT NOT NULL,
    last_day TEXT
  )`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map(r => r.name);
  if (!cols.includes('cal_token')) db.exec('ALTER TABLE users ADD COLUMN cal_token TEXT');
  if (!cols.includes('tz')) db.exec('ALTER TABLE users ADD COLUMN tz TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_cal_token ON users(cal_token)');
  const q = {
    records: db.prepare('SELECT kind, id, data FROM records WHERE user_id = ? AND deleted = 0'),
    userByToken: db.prepare('SELECT id, tz FROM users WHERE cal_token = ?'),
    calToken: db.prepare('SELECT cal_token FROM users WHERE id = ?'),
    setCal: db.prepare('UPDATE users SET cal_token = ?, tz = COALESCE(?, tz) WHERE id = ?'),
    sub: db.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?'),
    addSub: db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, tz, created) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz`),
    subCount: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?'),
    dropSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
    dropUserSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
    userSubs: db.prepare('SELECT * FROM push_subs WHERE user_id = ?'),
    allSubs: db.prepare('SELECT * FROM push_subs'),
    markSent: db.prepare('UPDATE push_subs SET last_day = ? WHERE endpoint = ?'),
  };

  /* ---------- what's due ---------- */
  function dues(userId, today, from, until) {
    const out = [];
    for (const r of q.records.all(userId)) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (r.kind === 'item') {
        for (const o of Sch.unpaid(d, today, from, until, 24)) {
          out.push({ uid: `item-${r.id}-${o.key || 'once'}`, date: o.date, kind: d.dir === 'in' ? 'income' : 'bill', name: d.name || 'Bill', amount: d.amount });
        }
      } else {
        const left = (Number(d.amount) || 0) - (d.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
        const pd = Sch.parseD(d.promiseDate);
        if (left > 0 && pd && pd >= from && pd <= until) out.push({ uid: `loan-${r.id}-${d.promiseDate}`, date: pd, kind: d.dir === 'out' ? 'debt' : 'loan', name: d.friend || 'Someone', amount: left });
      }
    }
    return out.sort((a, b) => a.date - b.date);
  }

  /* ---------- calendar feed ---------- */
  function calendarUrl(userId, tz, reset) {
    let tok = (q.calToken.get(userId) || {}).cal_token;
    if (!tok || reset) tok = crypto.randomBytes(24).toString('base64url');
    q.setCal.run(tok, validTz(tz) ? tz : null, userId);
    return `${PUBLIC_URL}/cal/${tok}.ics`;
  }
  function calendar(token) {
    const u = q.userByToken.get(token);
    if (!u) return null;
    const tz = validTz(u.tz) ? u.tz : DEFAULT_TZ, t = Sch.parseD(localNow(tz).day);
    const host = new URL(PUBLIC_URL).host, stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const day = d => Sch.iso(d).replace(/-/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bayad//Bayad Tracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Bayad', 'X-WR-CALDESC:' + icsText('Bills, income and loans from Bayad'), 'X-WR-TIMEZONE:' + tz,
      'REFRESH-INTERVAL;VALUE=DURATION:PT4H', 'X-PUBLISHED-TTL:PT4H'];
    for (const x of dues(u.id, t, addDays(t, -31), addDays(t, 366)).slice(0, 500)) {
      const summary = title(x) + (x.amount ? ' · ' + peso(x.amount) : '');
      lines.push('BEGIN:VEVENT', `UID:${x.uid}@${host}`, 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + day(x.date), 'DTEND;VALUE=DATE:' + day(addDays(x.date, 1)),
        'SUMMARY:' + icsText(summary), 'DESCRIPTION:' + icsText('Mark it paid in Bayad: ' + PUBLIC_URL), 'URL:' + PUBLIC_URL, 'TRANSP:TRANSPARENT',
        // All-day events start at midnight, so this alarm is 9 AM the day before.
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(summary), 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  /* ---------- Web Push ---------- */
  // The server's VAPID key pair, made on first start and kept on the data volume.
  const keyFile = path.join(DATA_DIR, 'vapid.json');
  let jwk;
  try { jwk = JSON.parse(fs.readFileSync(keyFile, 'utf8')); }
  catch {
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    fs.writeFileSync(keyFile, JSON.stringify(jwk), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const subject = CONTACT_EMAIL ? 'mailto:' + CONTACT_EMAIL : PUBLIC_URL;

  function vapidAuth(endpoint) {
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `vapid t=${unsigned}.${sig}, k=${publicKey.toString('base64url')}`;
  }
  // aes128gcm content encoding for one push message (RFC 8291 section 3.4).
  function encrypt(payload, p256dh, authSecret) {
    const ua = Buffer.from(p256dh, 'base64url'), auth = Buffer.from(authSecret, 'base64url');
    const ecdh = crypto.createECDH('prime256v1'), as = ecdh.generateKeys(), shared = ecdh.computeSecret(ua);
    const salt = crypto.randomBytes(16);
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = as.length;
    return Buffer.concat([header, as, body]);
  }
  async function send(sub, message) {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidAuth(sub.endpoint) },
      body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth),
    });
    if (r.status === 404 || r.status === 410) q.dropSub.run(sub.endpoint); // the browser unsubscribed
    else if (!r.ok) console.error('[bayad] push rejected:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  }
  function pushHostOk(endpoint) {
    try { const u = new URL(endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); }
    catch { return false; }
  }
  function subscribe(userId, body) {
    const s = body && body.subscription, keys = s && s.keys;
    if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !pushHostOk(s.endpoint)) return 'bad_endpoint';
    if (!keys || !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth || '')) return 'bad_keys';
    const existing = q.sub.get(s.endpoint);
    if ((!existing || existing.user_id !== userId) && q.subCount.get(userId).n >= MAX_SUBS_PER_USER) return 'too_many';
    q.addSub.run(s.endpoint, userId, keys.p256dh, keys.auth, validTz(body.tz) ? body.tz : DEFAULT_TZ, new Date().toISOString());
    return null;
  }
  function unsubscribe(userId, endpoint) { q.dropUserSub.run(String(endpoint || ''), userId); }
  async function test(userId) {
    let sent = 0;
    for (const s of q.userSubs.all(userId)) {
      if (await send(s, { title: 'Bayad reminders are on', body: `You'll get one at ${REMINDER_HOUR} AM when a bill or payment is due.`, url: '/', tag: 'bayad-test' }).catch(() => false)) sent++;
    }
    return sent;
  }

  // One message per device per day: what's due today or tomorrow, and bills or debts that are overdue.
  function digest(userId, tz) {
    const t = Sch.parseD(localNow(tz).day);
    const list = dues(userId, t, addDays(t, -30), addDays(t, 1)).filter(x => x.date >= t || x.kind === 'bill' || x.kind === 'debt');
    if (!list.length) return null;
    const when = x => { const n = Sch.diffDays(t, x.date); return n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : 'tomorrow'; };
    const line = x => `${title(x)}${x.amount ? ' · ' + peso(x.amount) : ''} · ${when(x)}`;
    const overdue = list.filter(x => x.date < t).length, soon = list.length - overdue;
    const head = list.length === 1 ? 'Bayad reminder' : 'Bayad: ' + [soon && `${soon} coming up`, overdue && `${overdue} overdue`].filter(Boolean).join(', ');
    const lines = list.slice(0, 5).map(line);
    if (list.length > 5) lines.push(`+${list.length - 5} more`);
    return { title: head, body: lines.join('\n'), url: '/', tag: 'bayad-daily' };
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const s of q.allSubs.all()) {
        const { day, hour } = localNow(s.tz);
        if (hour < REMINDER_HOUR || s.last_day === day) continue;
        q.markSent.run(day, s.endpoint); // once a day, even if sending fails
        const msg = digest(s.user_id, s.tz);
        if (msg) await send(s, msg).catch(e => console.error('[bayad] push failed:', e.message));
      }
    } finally { running = false; }
  }
  function start() { setTimeout(tick, 15000).unref(); setInterval(tick, 10 * 60 * 1000).unref(); }

  return { calendar, calendarUrl, publicKey: publicKey.toString('base64url'), subscribe, unsubscribe, test, start,
    _test: { encrypt, vapidAuth, digest, tick, pushHostOk } };
};
