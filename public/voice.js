// Bayad quick add: turns a spoken or typed sentence like "Meralco 2,500 every 5th" into bill form fields.
// Works offline: plain pattern matching, no speech service. Shared by the app and the tests.
(function (root) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const ORD = '(\\d{1,2})(?:st|nd|rd|th)?';
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  // First match wins, so the longer phrases come first.
  const FREQS = [
    ['twice', /\b(twice a month|two times a month|kinsenas|semi-?monthly)\b/],
    ['biweekly', /\b(every (?:2|two|other) weeks?|bi-?weekly|fortnightly)\b/],
    ['quarterly', /\b(every (?:3|three) months|quarterly)\b/],
    ['yearly', /\b(every year|yearly|annually|annual|once a year|taon-taon)\b/],
    ['weekly', /\b(every week|weekly|each week|linggo-linggo)\b/],
    ['monthly', /\b(every month|monthly|each month|a month|per month|buwan-buwan|kada buwan)\b/],
    ['once', /\b(one[- ]time(?: only)?|once|just this once)\b/]
  ];

  const CATS = {
    out: [
      ['utilities', /\b(meralco|electric(?:ity)?|kuryente|water|maynilad|manila water|tubig|gas tank|lpg)\b/],
      ['housing', /\b(rent|upa|condo|apartment|mortgage|amortization|association dues|hoa)\b/],
      ['internet', /\b(internet|wi-?fi|pldt|globe|smart|converge|dito|sky|phone|postpaid|load|fiber)\b/],
      ['subscriptions', /\b(netflix|spotify|youtube|disney|icloud|hbo|prime video|viu|subscription|google one|chatgpt)\b/],
      ['credit', /\b(credit card|card|loan|home credit|billease|atome|sss loan|pag-?ibig loan|bdo|bpi|metrobank|unionbank|security bank|rcbc)\b/],
      ['insurance', /\b(insurance|philhealth|sun life|pru ?life|axa|hmo|maxicare|intellicare|sss|pag-?ibig)\b/],
      ['transport', /\b(fuel|gasoline|diesel|grab|parking|toll|rfid|autosweep|easytrip|car|motor|jeep|fare)\b/],
      ['food', /\b(groceries|grocery|food|palengke|rice|bigas)\b/],
      ['education', /\b(tuition|school|matrikula|books|baon ng anak)\b/],
      ['health', /\b(medicine|gamot|doctor|hospital|check-?up|dentist|vitamins)\b/],
      ['family', /\b(padala|family|nanay|tatay|mama|papa|parents|lola|lolo)\b/]
    ],
    in: [
      ['salary', /\b(salary|sweldo|suweldo|payroll|payday|pay day|paycheck|sahod)\b/],
      ['business', /\b(freelance|business|client|sideline|commission|online selling|negosyo)\b/],
      ['allowance', /\b(allowance|baon)\b/],
      ['remittance', /\b(remittance|padala|ofw)\b/]
    ]
  };

  // Words that carry no meaning for the name once dates and amounts are taken out.
  const FILLER = /\b(add|new|my|our|the|a|an|is|of|for|on|at|due|every|each|pay|paid|by|and|amount|around|about|php|pesos?|piso|tuwing|kada|sa|ng|ang|day|date|next|starting|from|to|it'?s|its|i)\b/gi;

  function mod(n, m) { return ((n % m) + m) % m; }
  function nextMonthDay(today, m, d) {
    let y = today.getFullYear(), date = new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
    if (date < today) { y++; date = new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate())); }
    return date;
  }
  function nextDayOfMonth(today, d) {
    const y = today.getFullYear(), m = today.getMonth();
    let date = new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
    if (date < today) date = new Date(y, m + 1, Math.min(d, new Date(y, m + 2, 0).getDate()));
    return date;
  }

  // text: what was said. opts.today: a Date (time ignored). opts.dir: 'out' or 'in'. opts.freq: the form's current frequency.
  // Returns only the fields it found, ready to merge into the bill form's values.
  function parse(text, opts = {}) {
    const t0 = opts.today || new Date(), today = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
    const out = {};
    let s = ' ' + String(text || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ') + ' ';
    const take = re => { const m = s.match(re); if (m) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); return m; };
    const lower = () => s.toLowerCase();

    for (const [f, re] of FREQS) { const m = lower().match(re); if (m) { out.freq = f; s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); break; } }
    
    // Dates, before amounts, so "November 5" is not read as 5 pesos.
    let date = null, day = null, day2 = null, m;
    if ((m = take(new RegExp('\\b' + MONTH_RE + ' ' + ORD + '\\b', 'i')))) date = nextMonthDay(today, MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]);
    else if ((m = take(new RegExp('\\b' + ORD + ' (?:of )?' + MONTH_RE + '\\b', 'i')))) date = nextMonthDay(today, MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]);
    else if ((m = take(/\b(today|ngayon)\b/i))) date = new Date(today);
    else if ((m = take(/\b(tomorrow|bukas)\b/i))) date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    else if ((m = take(new RegExp('\\b(?:in )?(\\d+|' + Object.keys(WORDS).join('|') + ') days?\\b', 'i')))) {
      const n = WORDS[m[1].toLowerCase()] || +m[1]; date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    } else if ((m = take(new RegExp('\\b(' + DAYS.join('|') + ')s?\\b', 'i')))) {
      date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mod(DAYS.indexOf(m[1].toLowerCase()) - today.getDay(), 7));
      if (!out.freq) out.freq = 'weekly';
    }
    if (!date) {
      if ((m = take(/\b(\d{1,2})(?:st|nd|rd|th)? (?:and|&|at) (?:the )?(\d{1,2})(?:st|nd|rd|th)?\b/i)) && +m[1] <= 31 && +m[2] <= 31) { day = +m[1]; day2 = +m[2]; if (!out.freq) out.freq = 'twice'; }
      else if ((m = take(/\b(\d{1,2})(st|nd|rd|th)\b/i)) || (m = take(/\b(?:on|due|day|every|tuwing|kada)(?: the| on| on the| day)? (\d{1,2})\b(?![.,]?\d)/i))) day = +m[1];
      if (day && day > 31) day = null;
    }

    // Amount: "2,500", "₱2500.50", "2.5k", "3 thousand".
    s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
    if ((m = take(/(?:₱|php ?|p)?(\d+(?:\.\d+)?) ?(k|thousand|libo)\b/i))) out.amount = Math.round(+m[1] * 1000 * 100) / 100;
    else if ((m = take(/(?:₱|php ?)?\b(\d+(?:\.\d{1,2})?)\b(?: ?(?:pesos?|php|piso))?/i))) out.amount = +m[1];

    const f = out.freq || opts.freq || 'monthly';
    if (f === 'monthly' || f === 'twice') {
      if (date) day = date.getDate();
      if (f === 'twice' && !day) { day = 15; day2 = 30; } // the usual paydays
      if (day) out.dueDay = day;
      if (f === 'twice' && day2) out.dueDay2 = day2;
    } else if (date || day) {
      out.dueDate = iso(date || nextDayOfMonth(today, day));
    }

    const cats = CATS[opts.dir === 'in' ? 'in' : 'out'], full = String(text || '').toLowerCase();
    for (const [k, re] of cats) if (re.test(full)) { out.category = k; break; }

    const name = s.replace(FILLER, ' ').replace(/[^\p{L}\p{N}&'\- ]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[-']+|[-']+$/g, '');
    if (name) out.name = name.charAt(0).toUpperCase() + name.slice(1);
    return out;
  }

  // Which form a sentence belongs to. Loans are checked first: "Juan owes me 500" is not a bill.
  const LENT = /\b(lent|loaned|lend|pinahiram(?: ko)?(?: si| kay)?|owes me|owe me|borrowed from me|hiniram ni|utang ni|may utang sa akin)\b/i;
  const OWE = /\b(i owe|owe|borrowed(?: from)?|hiniram ko(?: kay)?|utang ko(?: kay| sa)?|nangutang ako(?: kay| sa)?|nangutang)\b/i;
  const INCOME = /\b(income|salary|sweldo|suweldo|sahod|payroll|payday|pay day|paycheck|freelance|commission|sideline|negosyo|allowance|baon|remittance|ofw|received?|kita)\b/i;
  const FRIEND_FILLER = /\b(si|kay|ni|from|to|me|ko|back|akin|mo|until|hanggang|owes?|ako|need|needs|return|ibabalik|babayaran)\b/gi;

  // A sentence from the + button: { type: 'bill' | 'loan', dir: 'out' | 'in', values } for the form it opens.
  function guess(text, opts = {}) {
    const t0 = opts.today || new Date(), today = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
    let s = String(text || '');
    const lent = s.match(LENT), owe = !lent && s.match(OWE);
    if (lent || owe) {
      s = s.replace(lent ? LENT : OWE, ' ');
      const values = {};
      const y = s.match(/\b(yesterday|kahapon)\b/i);
      if (y) { s = s.replace(y[0], ' '); values.lentDate = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)); }
      const p = parse(s, { today, freq: 'once' });
      if (p.amount != null) values.amount = p.amount;
      if (p.dueDate) values.promiseDate = p.dueDate;
      const friend = (p.name || '').replace(FRIEND_FILLER, ' ').replace(/\s+/g, ' ').trim();
      if (friend) values.friend = friend.charAt(0).toUpperCase() + friend.slice(1);
      return { type: 'loan', dir: lent ? 'in' : 'out', values };
    }
    const dir = INCOME.test(s) ? 'in' : 'out';
    return { type: 'bill', dir, values: parse(s, { today, dir }) };
  }

  root.BayadVoice = { parse, guess };
})(typeof module !== 'undefined' ? module.exports : self);
