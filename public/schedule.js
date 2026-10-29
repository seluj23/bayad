// Bayad due dates, shared by the app (index.html) and the server (reminders.js) so both agree.
// Dates are calendar days held in Date objects; only their year, month and day are used.
(function (root) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const ym = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
  const parseD = s => { if (!s) return null; const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const diffDays = (a, b) => Math.round((b - a) / 86400000);
  function dueIn(y, m, day) { const last = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, last)); }
  const MONTH_STEP = { monthly: 1, twice: 1, quarterly: 3, yearly: 12 };
  const byWeek = b => b.freq === 'weekly' || b.freq === 'biweekly';

  // The i-th due date of a repeating entry, and the key its payment is stored under.
  function occ(b, i, today) {
    if (byWeek(b)) { const d = parseD(b.dueDate) || new Date(today); d.setDate(d.getDate() + i * (b.freq === 'weekly' ? 7 : 14)); return { key: iso(d), date: d }; }
    const [sy, sm] = (b.startMonth || ym(today)).split('-').map(Number), start = sy * 12 + (sm - 1);
    if (b.freq === 'twice') {
      const idx = start + Math.floor(i / 2), yy = Math.floor(idx / 12), mm = idx % 12, second = i % 2 === 1;
      return { key: yy + '-' + pad(mm + 1) + '-' + (second ? 'b' : 'a'), date: dueIn(yy, mm, Number(second ? b.dueDay2 : b.dueDay) || 1) };
    }
    const idx = start + i * (MONTH_STEP[b.freq] || 1), yy = Math.floor(idx / 12), mm = idx % 12;
    return { key: yy + '-' + pad(mm + 1), date: dueIn(yy, mm, Number(b.dueDay) || 1) };
  }

  // Unpaid due dates of a bill or income entry between `from` and `until`, at most `max`.
  function unpaid(b, today, from, until, max) {
    if (b.freq === 'once') {
      const d = parseD(b.dueDate);
      return !b.paidOn && d && d >= from && d <= until ? [{ key: null, date: d }] : [];
    }
    const out = [], paid = b.paid || {};
    for (let i = 0; i < 2000 && out.length < max; i++) {
      const o = occ(b, i, today);
      if (o.date > until) break;
      if (o.date >= from && !paid[o.key]) out.push(o);
    }
    return out;
  }

  root.BayadSchedule = { pad, iso, ym, parseD, diffDays, dueIn, occ, unpaid };
})(typeof module !== 'undefined' ? module.exports : self);
