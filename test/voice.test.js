// Quick add sentences in public/voice.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BayadVoice: V } = require('../public/voice.js');

const today = new Date(2026, 9, 30); // a Friday
const say = (text, opts) => V.parse(text, { today, ...opts });

test('monthly bill with an ordinal day', () => {
  assert.deepEqual(say('Meralco 2,500 every 5th'), { amount: 2500, dueDay: 5, category: 'utilities', name: 'Meralco' });
  assert.deepEqual(say('Rent 8000 on the 30th'), { amount: 8000, dueDay: 30, category: 'housing', name: 'Rent' });
  assert.deepEqual(say('Netflix 549 monthly due 12'), { freq: 'monthly', amount: 549, dueDay: 12, category: 'subscriptions', name: 'Netflix' });
});

test('a month and day is not read as the amount', () => {
  assert.deepEqual(say('Meralco 2500 due November 5'), { amount: 2500, dueDay: 5, category: 'utilities', name: 'Meralco' });
  assert.deepEqual(say('Electric bill ₱2,800.50 due November 5, one time'),
    { freq: 'once', amount: 2800.5, dueDate: '2026-11-05', category: 'utilities', name: 'Electric bill' });
});

test('dates that have passed this year roll over to next year', () => {
  assert.equal(say('Car insurance 12 thousand yearly March 3').dueDate, '2027-03-03');
  assert.equal(say('Tuition 25000 quarterly 10th of January').dueDate, '2027-01-10');
});

test('twice a month, with the days said or the usual paydays', () => {
  assert.deepEqual(say('Salary 15k every 15th and 30th', { dir: 'in' }),
    { freq: 'twice', amount: 15000, dueDay: 15, dueDay2: 30, category: 'salary', name: 'Salary' });
  assert.deepEqual(say('Padala kay nanay 3000 kinsenas'),
    { freq: 'twice', amount: 3000, dueDay: 15, dueDay2: 30, category: 'family', name: 'Padala kay nanay' });
});

test('a weekday means weekly, starting on its next date', () => {
  assert.deepEqual(say('Allowance 500 every friday', { dir: 'in' }),
    { freq: 'weekly', amount: 500, dueDate: '2026-10-30', category: 'allowance', name: 'Allowance' });
  assert.equal(say('Grab 300 every monday').dueDate, '2026-11-02');
});

test('relative dates', () => {
  assert.equal(say('PLDT 1699 due tomorrow, one time').dueDate, '2026-10-31');
  assert.equal(say('Load 100 in 3 days', { freq: 'once' }).dueDate, '2026-11-02');
});

test('a day alone on a dated entry picks its next date', () => {
  assert.equal(say('Water 450 on the 5th', { freq: 'once' }).dueDate, '2026-11-05');
  assert.equal(say('Water 450 on the 30th', { freq: 'once' }).dueDate, '2026-10-30');
});

test('leaves out what it did not hear', () => {
  assert.deepEqual(say('Water 450'), { amount: 450, category: 'utilities', name: 'Water' });
  assert.deepEqual(say(''), {});
});

test('the + menu tells bills, income, loans and debts apart', () => {
  const g = text => V.guess(text, { today });
  assert.deepEqual(g('Lent Juan 500, pay back by December 15'),
    { type: 'loan', dir: 'in', values: { amount: 500, promiseDate: '2026-12-15', friend: 'Juan' } });
  assert.deepEqual(g('Juan owes me 300'), { type: 'loan', dir: 'in', values: { amount: 300, friend: 'Juan' } });
  assert.deepEqual(g('Pinahiram ko si Pedro 1500 kahapon'),
    { type: 'loan', dir: 'in', values: { lentDate: '2026-10-29', amount: 1500, friend: 'Pedro' } });
  assert.deepEqual(g('I owe Maria 2,000'), { type: 'loan', dir: 'out', values: { amount: 2000, friend: 'Maria' } });
  assert.deepEqual(g('Utang ko kay Liza 800 hanggang November 15'),
    { type: 'loan', dir: 'out', values: { amount: 800, promiseDate: '2026-11-15', friend: 'Liza' } });
  assert.equal(g('Salary 15k every 15th and 30th').dir, 'in');
  assert.deepEqual(g('Meralco 2,500 every 5th'), { type: 'bill', dir: 'out', values: { amount: 2500, dueDay: 5, category: 'utilities', name: 'Meralco' } });
  assert.equal(g('Padala kay nanay 3000 kinsenas').dir, 'out');
});
