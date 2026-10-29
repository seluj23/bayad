// Bayad households: people who share bills. Each person is in at most one household.
// Roles: owner (everything, plus invites and members), member (add, edit, pay; delete own entries), viewer (read only).
'use strict';
const crypto = require('node:crypto');

const INVITE_DAYS = 7;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

module.exports = function households({ db, PUBLIC_URL }) {
  db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  joined       TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS members_one_household ON members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  token_hash   TEXT PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('member','viewer')),
  created_by   INTEGER NOT NULL,
  expires      TEXT NOT NULL
);`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map(r => r.name);
  if (!cols.includes('notify_household')) db.exec('ALTER TABLE users ADD COLUMN notify_household INTEGER NOT NULL DEFAULT 1');

  const q = {
    membership: db.prepare('SELECT m.household_id AS id, m.role, h.name FROM members m JOIN households h ON h.id = m.household_id WHERE m.user_id = ?'),
    members: db.prepare(`SELECT m.user_id AS id, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.joined`),
    addHousehold: db.prepare('INSERT INTO households (name, created) VALUES (?, ?)'),
    rename: db.prepare('UPDATE households SET name = ? WHERE id = ?'),
    dropHousehold: db.prepare('DELETE FROM households WHERE id = ?'),
    addMember: db.prepare('INSERT INTO members (household_id, user_id, role, joined) VALUES (?, ?, ?, ?)'),
    setRole: db.prepare('UPDATE members SET role = ? WHERE household_id = ? AND user_id = ?'),
    dropMember: db.prepare('DELETE FROM members WHERE household_id = ? AND user_id = ?'),
    successor: db.prepare(`SELECT user_id FROM members WHERE household_id = ? AND user_id != ?
      ORDER BY CASE role WHEN 'member' THEN 0 ELSE 1 END, joined LIMIT 1`),
    addInvite: db.prepare('INSERT INTO invites (token_hash, household_id, role, created_by, expires) VALUES (?, ?, ?, ?, ?)'),
    invite: db.prepare(`SELECT i.household_id, i.role, h.name, u.email AS from_email FROM invites i
      JOIN households h ON h.id = i.household_id LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ? AND i.expires > ?`),
    dropInvite: db.prepare('DELETE FROM invites WHERE token_hash = ?'),
    pruneInvites: db.prepare('DELETE FROM invites WHERE expires <= ?'),
    dropScope: db.prepare('DELETE FROM records WHERE scope = ?'),
    notify: db.prepare('SELECT notify_household AS on_ FROM users WHERE id = ?'),
    setNotify: db.prepare('UPDATE users SET notify_household = ? WHERE id = ?'),
    notifyTargets: db.prepare(`SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ? AND m.user_id != ? AND u.notify_household = 1`),
  };
  q.pruneInvites.run(new Date().toISOString());
  const now = () => new Date().toISOString();
  const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 60);

  function membership(userId) { return q.membership.get(userId) || null; }
  // Everything a person can sync: their own records ('' to the app) and their household's ('h:<id>').
  function scopesFor(userId) {
    const out = [{ scope: 'u:' + userId, client: '', role: 'owner', shared: false }];
    const m = membership(userId);
    if (m) out.push({ scope: 'h:' + m.id, client: 'h:' + m.id, role: m.role, shared: true, householdId: m.id });
    return out;
  }
  function info(userId) {
    const m = membership(userId);
    if (!m) return null;
    return { id: m.id, scope: 'h:' + m.id, name: m.name, role: m.role, notify: !!(q.notify.get(userId) || {}).on_,
      members: q.members.all(m.id).map(x => ({ id: x.id, email: x.email, role: x.role })) };
  }
  function create(userId, name) {
    if (membership(userId)) return 'already_member';
    const n = cleanName(name);
    if (!n) return 'name_required';
    db.exec('BEGIN');
    try {
      const id = Number(q.addHousehold.run(n, now()).lastInsertRowid);
      q.addMember.run(id, userId, 'owner', now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return null;
  }
  function rename(userId, name) {
    const m = membership(userId), n = cleanName(name);
    if (!m || m.role !== 'owner') return 'forbidden';
    if (!n) return 'name_required';
    q.rename.run(n, m.id);
    return null;
  }
  function invite(userId, role) {
    const m = membership(userId);
    if (!m || m.role !== 'owner') return { error: 'forbidden' };
    if (role !== 'member' && role !== 'viewer') return { error: 'bad_role' };
    const token = crypto.randomBytes(24).toString('base64url');
    q.addInvite.run(sha(token), m.id, role, userId, new Date(Date.now() + INVITE_DAYS * 864e5).toISOString());
    return { url: `${PUBLIC_URL}/join/${token}`, days: INVITE_DAYS };
  }
  function inviteInfo(token) {
    if (!token) return null;
    const i = q.invite.get(sha(token), now());
    return i ? { household: i.name, role: i.role, from: i.from_email || '' } : null;
  }
  function join(userId, token) {
    const i = token && q.invite.get(sha(token), now());
    if (!i) return 'invalid_invite';
    const m = membership(userId);
    if (m) return m.id === i.household_id ? null : 'already_member';
    db.exec('BEGIN');
    try { q.addMember.run(i.household_id, userId, i.role, now()); q.dropInvite.run(sha(token)); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return null;
  }
  // The owner can make someone a member or viewer, or hand over ownership (the old owner becomes a member).
  function setRole(userId, targetId, role) {
    const m = membership(userId), t = membership(targetId);
    if (!m || m.role !== 'owner' || !t || t.id !== m.id || targetId === userId) return 'forbidden';
    if (!['owner', 'member', 'viewer'].includes(role)) return 'bad_role';
    db.exec('BEGIN');
    try {
      q.setRole.run(role, m.id, targetId);
      if (role === 'owner') q.setRole.run('member', m.id, userId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return null;
  }
  function remove(userId, targetId) {
    const m = membership(userId), t = membership(targetId);
    if (!m || m.role !== 'owner' || !t || t.id !== m.id || targetId === userId) return 'forbidden';
    q.dropMember.run(m.id, targetId);
    return null;
  }
  // Leaving keeps the shared bills with the household. An owner hands over to the longest-standing member;
  // the last person to leave takes the household and its shared bills with them.
  function leave(userId) {
    const m = membership(userId);
    if (!m) return null;
    db.exec('BEGIN');
    try {
      if (m.role === 'owner') {
        const next = q.successor.get(m.id, userId);
        if (next) q.setRole.run('owner', m.id, next.user_id);
      }
      q.dropMember.run(m.id, userId);
      if (!q.members.all(m.id).length) { q.dropScope.run('h:' + m.id); q.dropHousehold.run(m.id); }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return null;
  }
  function setNotify(userId, on) { q.setNotify.run(on ? 1 : 0, userId); }
  function notifyTargets(householdId, exceptUserId) { return q.notifyTargets.all(householdId, exceptUserId).map(r => r.user_id); }

  return { membership, scopesFor, info, create, rename, invite, inviteInfo, join, setRole, remove, leave, setNotify, notifyTargets };
};
