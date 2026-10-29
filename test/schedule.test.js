// Due-date rules in public/schedule.js, shared by the app and the server.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BayadSchedule: S } = require('../public/schedule.js');

const today = S.parseD('2026-10-30');
const dates = (b, n) => Array.from({ length: n }, (_, i) => S.occ(b, i, today)).map(o => `${o.key}=${S.iso(o.date)}`);

test('monthly: day 31 falls on the last day of shorter months', () => {
  assert.deepEqual(dates({ freq: 'monthly', dueDay: 31, startMonth: '2027-01' }, 3),
    ['2027-01=2027-01-31', '2027-02=2027-02-28', '2027-03=2027-03-31']);
});

test('twice a month: two slots per month, in order', () => {
  assert.deepEqual(dates({ freq: 'twice', dueDay: 15, dueDay2: 30, startMonth: '2027-02' }, 4),
    ['2027-02-a=2027-02-15', '2027-02-b=2027-02-28', '2027-03-a=2027-03-15', '2027-03-b=2027-03-30']);
});

test('weekly and every 2 weeks count from the first due date', () => {
  assert.deepEqual(dates({ freq: 'weekly', dueDate: '2026-12-29' }, 2), ['2026-12-29=2026-12-29', '2027-01-05=2027-01-05']);
  assert.deepEqual(dates({ freq: 'biweekly', dueDate: '2026-11-01' }, 2), ['2026-11-01=2026-11-01', '2026-11-15=2026-11-15']);
});

test('quarterly and yearly step 3 and 12 months', () => {
  assert.deepEqual(dates({ freq: 'quarterly', dueDay: 10, startMonth: '2026-11' }, 3), ['2026-11=2026-11-10', '2027-02=2027-02-10', '2027-05=2027-05-10']);
  assert.deepEqual(dates({ freq: 'yearly', dueDay: 29, startMonth: '2027-02' }, 2), ['2027-02=2027-02-28', '2028-02=2028-02-29']);
});

test('unpaid skips paid periods, respects the window and the limit', () => {
  const bill = { freq: 'monthly', dueDay: 5, startMonth: '2026-09', paid: { '2026-09': '2026-09-04', '2026-10': { on: '2026-10-05', amount: 2950, ref: 'GCash 1' } } };
  const due = S.unpaid(bill, today, S.parseD('2026-01-01'), S.parseD('2027-01-31'), 10).map(o => o.key);
  assert.deepEqual(due, ['2026-11', '2026-12', '2027-01']);
  assert.equal(S.unpaid(bill, today, S.parseD('2026-01-01'), S.parseD('2027-01-31'), 1).length, 1);
  assert.deepEqual(S.unpaid(bill, today, S.parseD('2026-12-01'), S.parseD('2027-01-31'), 10).map(o => o.key), ['2026-12', '2027-01']);
});

test('one-time entries are due once until paid', () => {
  const window = [today, S.parseD('2026-01-01'), S.parseD('2027-12-31'), 10];
  assert.equal(S.unpaid({ freq: 'once', dueDate: '2026-11-02' }, ...window).length, 1);
  assert.equal(S.unpaid({ freq: 'once', dueDate: '2026-11-02', paidOn: '2026-11-01' }, ...window).length, 0);
  assert.equal(S.unpaid({ freq: 'once', dueDate: '2028-01-01' }, ...window).length, 0);
});

test('an old weekly bill does not run out of iterations before reaching today', () => {
  const due = S.unpaid({ freq: 'weekly', dueDate: '2020-01-06', paid: {} }, today, today, S.parseD('2026-11-30'), 10);
  assert.ok(due.length >= 4 && due.every(o => o.date >= today));
});
