// Bayad app: renders the ledger, talks to the database worker, and syncs with the server.
(function(){
const peso = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2});
const money = n => peso.format(Number(n)||0).replace(/\.00$/,'');
const pad = n => String(n).padStart(2,'0');
const today = () => { const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),d.getDate()); };
const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const ym = d => d.getFullYear()+'-'+pad(d.getMonth()+1);
const parseD = s => { if(!s) return null; const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
const diffDays = (a,b) => Math.round((b-a)/86400000);
const fmt = d => d.toLocaleDateString('en-PH',{weekday:'short',month:'short',day:'numeric'});
const fmtShort = d => d.toLocaleDateString('en-PH',{month:'short',day:'numeric'});
const monthName = key => { const [y,m]=key.split('-').map(Number); return new Date(y,m-1,1).toLocaleDateString('en-PH',{month:'long'}); };
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function dueIn(y,m,day){ const last=new Date(y,m+1,0).getDate(); return new Date(y,m,Math.min(day,last)); }

const S = { bills:[], loans:[], tab:'out', form:null, confirmDel:null, open:null, histMonth:null, db:null, loaded:{bills:false,loans:false}, live:false, readOnly:false };
try{ const t=localStorage.getItem('bayad-tab'); if(t==='in'||t==='out'||t==='history') S.tab=t; }catch(e){}
const dirOf = b => b.dir==='in'?'in':'out';
const plural = (n,one,many) => n+' '+(n===1?one:many);
const CHECK='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV='<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GO='<svg class="go" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

document.getElementById('today').textContent = today().toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric'});

/* ---------- status ---------- */
const MONTH_STEP={monthly:1,twice:1,quarterly:3,yearly:12};
const FREQ_SHORT={monthly:'monthly',twice:'twice a month',weekly:'weekly',biweekly:'every 2 weeks',quarterly:'every 3 months',yearly:'yearly'};
const FREQ_OPTS=[['monthly','Every month'],['twice','Twice a month'],['weekly','Every week'],['biweekly','Every 2 weeks'],['quarterly','Every 3 months'],['yearly','Every year'],['once','One time only']];
const byWeek = b => b.freq==='weekly'||b.freq==='biweekly';
const byDate = f => f==='weekly'||f==='biweekly'||f==='quarterly'||f==='yearly'||f==='once'; // set with a date picker
const payOf = v => typeof v==='string'?{on:v}:(v||{}); // a paid period is a date, or {on, amount, ref}
const owes = l => l.dir==='out';
function kindFor(diff){ return diff<0?'overdue':diff<=3?'soon':'later'; }
function dueLabel(diff){
  if(diff<0) return (-diff)+(diff===-1?' day':' days')+' overdue';
  if(diff===0) return 'Due today';
  if(diff===1) return 'Due tomorrow';
  return 'Due in '+diff+' days';
}
const occ = (b,i) => BayadSchedule.occ(b,i,today()); // shared with the server, see schedule.js
function billStatus(b){
  const t=today();
  if(b.freq==='once'){
    const d=parseD(b.dueDate)||t;
    if(b.paidOn) return {kind:'done',date:d,paidOn:b.paidOn};
    const diff=diffDays(t,d); return {kind:kindFor(diff),date:d,diff};
  }
  const paid=b.paid||{};
  for(let i=0;i<600;i++){
    const o=occ(b,i); if(paid[o.key]) continue;
    const diff=diffDays(t,o.date); return {kind:kindFor(diff),date:o.date,diff,key:o.key};
  }
  return {kind:'later',date:t,diff:0};
}
// What a payment period is called: "November", "Nov 15", "March 2027".
function periodLabel(b,key){
  if(!key) return '';
  if(byWeek(b)) return fmtShort(parseD(key));
  if(b.freq==='twice'){ const [y,m]=key.split('-').map(Number); return fmtShort(dueIn(y,m-1,Number(key.endsWith('b')?b.dueDay2:b.dueDay)||1)); }
  if(b.freq==='quarterly'||b.freq==='yearly') return monthName(key)+' '+key.slice(0,4);
  return monthName(key);
}
function freqText(b){
  if(b.freq==='monthly') return 'Every month on day '+esc(b.dueDay);
  if(b.freq==='twice') return 'Twice a month, on days '+esc(b.dueDay)+' and '+esc(b.dueDay2);
  if(b.freq==='weekly') return 'Every week';
  if(b.freq==='biweekly') return 'Every 2 weeks';
  if(b.freq==='quarterly') return 'Every 3 months';
  if(b.freq==='yearly') return 'Every year';
  return 'One time';
}
function lastPaidKey(b){ const ks=Object.keys(b.paid||{}).sort(); return ks[ks.length-1]||null; }
function loanInfo(l){
  const paid=(l.payments||[]).reduce((a,p)=>a+(Number(p.amount)||0),0);
  const remaining=Math.max(0,(Number(l.amount)||0)-paid);
  const t=today(); const pd=parseD(l.promiseDate);
  let promise=null;
  if(remaining>0 && pd){ const diff=diffDays(t,pd); promise={date:pd,diff,kind:diff<0?'overdue':diff<=3?'soon':'later'}; }
  return {paid,remaining,settled:remaining<=0,promise};
}
// Every recorded money movement, newest first. Feeds the History tab and the CSV export.
function ledger(){
  const out=[];
  S.bills.forEach(b=>{
    const dir=dirOf(b), type=dir==='in'?'Income':'Bill';
    if(b.freq==='once'){ if(b.paidOn) out.push({date:b.paidOn,dir,amount:b.paidAmount??b.amount,name:b.name,what:type,ref:b.paidRef||''}); return; }
    Object.entries(b.paid||{}).forEach(([k,v])=>{ const p=payOf(v); if(p.on) out.push({date:p.on,dir,amount:p.amount??b.amount,name:b.name,what:type+' · '+periodLabel(b,k),ref:p.ref||''}); });
  });
  S.loans.forEach(l=>{
    const o=owes(l);
    if(l.lentDate) out.push({date:l.lentDate,dir:o?'in':'out',amount:l.amount,name:l.friend,what:o?'Borrowed':'Lent',ref:''});
    (l.payments||[]).forEach(p=>out.push({date:p.date,dir:o?'out':'in',amount:p.amount,name:l.friend,what:o?'You paid back':'Paid you back',ref:p.ref||''}));
  });
  return out.filter(x=>x.date).sort((a,b)=>b.date.localeCompare(a.date));
}

/* ---------- render ---------- */
function render(){
  S.needsRender=false;
  renderSummary();
  ['out','in','history'].forEach(t=>document.getElementById('tab-'+t).setAttribute('aria-selected',S.tab===t));
  const openBills=d=>S.bills.filter(b=>dirOf(b)===d&&billStatus(b).kind!=='done').length;
  const openLoans=d=>S.loans.filter(l=>(owes(l)?'out':'in')===d&&!loanInfo(l).settled).length;
  document.getElementById('c-out').textContent=(openBills('out')+openLoans('out'))||'';
  document.getElementById('c-in').textContent=(openBills('in')+openLoans('in'))||'';
  const main=document.getElementById('main');
  main.innerHTML = S.tab==='history'?historyView():billsView(S.tab)+loansView(S.tab);
  renderSheet();
  renderNotice();
}
function renderSheet(){
  const wrap=document.getElementById('sheet'), body=document.getElementById('sheet-body');
  if(S.form){
    body.innerHTML=({bill:billForm,loan:loanForm,pay:payForm})[S.form.type]();
    if(wrap.hidden){ wrap.hidden=false; document.body.classList.add('locked'); }
    const f=body.querySelector('input'); if(f && !S.form._focused){ f.focus(); S.form._focused=true; }
  } else if(!wrap.hidden){ wrap.hidden=true; body.innerHTML=''; document.body.classList.remove('locked'); }
}
function renderSummary(){
  let od=0,odN=0,wk=0,wkN=0,inc=0,incN=0;
  S.bills.forEach(b=>{ const s=billStatus(b); if(s.kind==='done') return; const a=Number(b.amount)||0;
    if(dirOf(b)==='in'){ if(s.diff<=7){inc+=a;incN++;} return; }
    if(s.diff<0){od+=a;odN++;} else if(s.diff<=7){wk+=a;wkN++;} });
  let owed=0,ppl=new Set(),owe=0,lenders=new Set();
  S.loans.forEach(l=>{ const i=loanInfo(l); if(i.settled) return; const who=(l.friend||'').trim().toLowerCase();
    if(owes(l)){ owe+=i.remaining; lenders.add(who); } else { owed+=i.remaining; ppl.add(who); } });
  let h='';
  if(odN) h+='<button class="alertbar" data-action="tab" data-tab="out"><span>'+(od?money(od)+' overdue · '+plural(odN,'bill','bills'):plural(odN,'bill','bills')+' overdue')+'</span>'+GO+'</button>';
  h+='<div class="week"><span class="lbl">Next 7 days</span><div class="cols">'+
    '<button class="fig" data-action="tab" data-tab="out"><span class="k">To pay</span><span class="v">'+money(wk)+'</span><span class="s">'+(wkN?plural(wkN,'bill','bills'):'Nothing due')+'</span></button>'+
    '<button class="fig in" data-action="tab" data-tab="in"><span class="k">Coming in</span><span class="v">'+money(inc)+'</span><span class="s">'+(incN?plural(incN,'payment','payments'):'Nothing expected')+'</span></button></div></div>';
  h+='<button class="owed" data-action="tab" data-tab="in" data-scroll="loans-h"><span class="k">Friends owe you</span><span class="r">'+
    (ppl.size?'<span class="s">'+plural(ppl.size,'person','people')+'</span><span class="v">'+money(owed)+'</span>':'<span class="s">No open loans</span>')+GO+'</span></button>';
  if(lenders.size) h+='<button class="owed" data-action="tab" data-tab="out" data-scroll="owe-h"><span class="k">You owe</span><span class="r">'+
    '<span class="s">'+plural(lenders.size,'person','people')+'</span><span class="v out">'+money(owe)+'</span>'+GO+'</span></button>';
  document.getElementById('summary').innerHTML=h;
}
function renderNotice(){
  const n=document.getElementById('notice'); let h='';
  const ex=S.bills.some(b=>b.example)||S.loans.some(l=>l.example);
  if(S.storageError==='in_use') h+='<div class="banner err">Bayad is already open in another tab or window. Close the other one, then reload this page.</div>';
  else if(S.storageError) h+='<div class="banner err">The database couldn’t be opened, so changes won’t be kept. Turn off private browsing or update your browser, then reopen the app.</div>';
  if(ex) h+='<div class="banner"><span>Entries marked <b>Example</b> show how it works. Tap the circle to record a payment, or tap a row for more.</span><button class="btn small" data-action="clear-examples">Remove</button></div>';
  n.innerHTML=h;
}

const TXT={
  out:{h:'Bills to pay',add:'+ Add bill',item:'bill',paid:'paid',Paid:'Paid',loading:'Loading your bills…',
    empty:'<strong>No bills yet</strong>Add each bill once with when it’s due. Repeating bills roll over automatically after you mark them paid.',
    allDone:'<strong>All bills paid</strong>Nothing left to pay right now.',doneH:'Paid one-time bills'},
  in:{h:'Expected income',add:'+ Add income',item:'income',paid:'received',Paid:'Received',loading:'Loading…',
    empty:'<strong>No income added</strong>Add your salary, allowance, or other regular money coming in so you can see it next to your bills.',
    allDone:'<strong>All received</strong>Nothing else expected right now.',doneH:'Received one-time income'}
};
function inLabel(diff){
  if(diff<0) return (-diff)+(diff===-1?' day':' days')+' late';
  if(diff===0) return 'Expected today';
  if(diff===1) return 'Expected tomorrow';
  return 'Expected in '+diff+' days';
}
function billsView(dir){
  const T=TXT[dir];
  const ready=S.loaded.bills||!S.live;
  const mine=S.bills.filter(b=>dirOf(b)===dir);
  let h='<div class="bar"><h2>'+T.h+'</h2>'+(S.readOnly?'':'<button class="btn soft small" data-action="new-bill" data-dir="'+dir+'">'+T.add+'</button>')+'</div>';
  const withS=mine.map(b=>({b,s:billStatus(b)}));
  const open=withS.filter(x=>x.s.kind!=='done').sort((a,b)=>a.s.date-b.s.date);
  const done=withS.filter(x=>x.s.kind==='done').sort((a,b)=>b.s.date-a.s.date);
  h+='<div class="panel">';
  if(!ready) h+='<div class="empty">'+T.loading+'</div>';
  else if(!mine.length) h+='<div class="empty">'+T.empty+'</div>';
  else {
    h+='<ul class="list">'+open.map(x=>billRow(x.b,x.s)).join('')+'</ul>';
    if(!open.length) h+='<div class="empty">'+T.allDone+'</div>';
    if(done.length) h+='<details class="settled"><summary>'+T.doneH+' ('+done.length+')</summary><ul class="list">'+done.map(x=>billRow(x.b,x.s)).join('')+'</ul></details>';
  }
  return h+'</div>';
}
// One ledger row: a tick for the main action, a tappable summary, and details + less common actions when open.
function rowHtml(o){
  const open=S.open===o.id, id=esc(o.id);
  return '<li class="row'+(open?' open':'')+'"><div class="line">'+o.tick+
    '<button class="main" data-action="toggle" data-id="'+id+'" aria-expanded="'+open+'"><span class="top"><span class="name">'+esc(o.name)+(o.example?'<span class="tag">Example</span>':'')+'</span>'+
    '<span class="amt'+(o.inflow?' in':'')+'">'+o.amt+CHEV+'</span></span><span class="meta">'+o.meta+'</span>'+(o.extra||'')+'</button></div>'+
    (open?'<div class="more">'+(o.facts.length?'<ul class="facts">'+o.facts.map(f=>'<li>'+f+'</li>').join('')+'</ul>':'')+
      (o.paid&&o.paid.length?'<ul class="facts pays">'+o.paid.map(f=>'<li>'+f+'</li>').join('')+'</ul>':'')+
      (o.note?'<p class="note">'+esc(o.note)+'</p>':'')+(o.acts?'<div class="actions">'+o.acts+'</div>':'')+'</div>':'')+'</li>';
}
function confirmActs(id,what,action){ return '<span class="hint">Delete this '+what+'?</span><span class="spacer"></span><button class="btn small danger" data-action="'+action+'" data-id="'+id+'">Delete</button><button class="btn small" data-action="cancel-del">Keep</button>'; }
const payLine = (date,amount,ref,label) => fmtShort(parseD(date))+(label?' · '+esc(label):'')+(amount!=null&&amount!==''?' · '+money(amount):'')+(ref?' · '+esc(ref):'');
function billRow(b,s){
  const id=esc(b.id), dir=dirOf(b), T=TXT[dir], done=s.kind==='done';
  let pill;
  if(done) pill='<span class="pill done">'+T.Paid+' '+fmtShort(parseD(s.paidOn))+'</span>';
  else if(dir==='in') pill='<span class="pill '+(s.kind==='overdue'?'soon':s.kind==='soon'?'done':'later')+'">'+inLabel(s.diff)+'</span>';
  else pill='<span class="pill '+s.kind+'">'+dueLabel(s.diff)+'</span>';
  const when = done?'' : '<span>'+fmtShort(s.date)+(b.freq==='once'?'':' · '+FREQ_SHORT[b.freq])+'</span>';
  const lp=b.freq!=='once'?lastPaidKey(b):null;
  const doLabel='Mark '+(b.freq==='once'?'':periodLabel(b,s.key)+' ')+T.paid;
  let tick;
  if(S.readOnly) tick='<span class="tick'+(done?' on':'')+'">'+CHECK+'</span>';
  else if(done) tick='<button class="tick on" data-action="unpay-once" data-id="'+id+'" aria-label="Undo: '+esc(b.name)+' '+T.paid+'">'+CHECK+'</button>';
  else tick='<button class="tick'+(dir==='out'&&s.kind==='overdue'?' due':'')+'" data-action="pay-bill" data-id="'+id+'" aria-label="'+doLabel+': '+esc(b.name)+'" title="'+doLabel+'">'+CHECK+'</button>';
  const facts=[], paid=[];
  if(b.freq==='once'){
    if(done) paid.push(T.Paid+' '+payLine(b.paidOn,b.paidAmount??b.amount,b.paidRef));
    else facts.push('One time · '+fmt(s.date));
  } else {
    facts.push(freqText(b)); if(!done) facts.push('Next due '+fmt(s.date));
    Object.keys(b.paid||{}).sort().reverse().slice(0,4).forEach(k=>{ const p=payOf(b.paid[k]); if(p.on) paid.push(T.Paid+' '+payLine(p.on,p.amount??b.amount,p.ref,periodLabel(b,k))); });
  }
  let acts='';
  if(!S.readOnly){
    if(S.confirmDel===b.id) acts=confirmActs(id,T.item,'del-bill');
    else acts=(lp?'<button class="btn small" data-action="unpay-month" data-id="'+id+'">Undo '+periodLabel(b,lp)+'</button>':'')+
      '<span class="spacer"></span><button class="btn small ghost" data-action="edit-bill" data-id="'+id+'">Edit</button><button class="btn small ghost" data-action="ask-del" data-id="'+id+'">Delete</button>';
  }
  return rowHtml({id:b.id,name:b.name,example:b.example,inflow:dir==='in',amt:b.amount?money(b.amount):'—',meta:pill+when,tick,facts,paid,note:b.note,acts});
}
function billForm(){
  const f=S.form, v=f.values||{}, isIn=f.dir==='in', item=isIn?'income':'bill';
  const freq=v.freq||'monthly';
  const dayField=(id,name,label,val)=>'<div class="field"><label for="'+id+'">'+label+'</label><input id="'+id+'" name="'+name+'" type="number" inputmode="numeric" min="1" max="31" required placeholder="1–31" value="'+esc(val)+'"></div>';
  let when;
  if(freq==='monthly') when=dayField('b-day','dueDay',isIn?'Arrives on day':'Due day of the month',v.dueDay)+'<span class="hint">Day 31 falls on the last day in shorter months.</span>'+
    (f.id?'':'<label class="check"><input type="checkbox" id="b-paidnow" name="paidNow"'+(v.paidNow?' checked':'')+'> '+(isIn?'I already received this month’s':'I already paid this month’s bill')+'</label>');
  else if(freq==='twice') when='<div class="grid2">'+dayField('b-day','dueDay','First day',v.dueDay)+dayField('b-day2','dueDay2','Second day',v.dueDay2)+'</div><span class="hint">For example 15 and 30. Day 31 falls on the last day in shorter months.</span>';
  else when='<div class="field"><label for="b-date">'+(freq==='once'?(isIn?'Expected date':'Due date'):(isIn?'Next expected date':'Next due date'))+'</label><input id="b-date" name="dueDate" type="date" required value="'+esc(v.dueDate||iso(today()))+'">'+
    (freq==='once'?'':'<span class="hint">It repeats '+FREQ_SHORT[freq]+' from this date.</span>')+'</div>';
  return '<form class="editor" data-form="bill"><h3 id="sheet-h">'+(f.id?'Edit '+item:'New '+item)+'</h3>'+
  '<div class="field"><label for="b-name">'+(isIn?'Source':'Bill')+'</label><input id="b-name" name="name" required maxlength="80" placeholder="'+(isIn?'e.g. Salary, freelance, allowance':'e.g. Meralco, PLDT, rent')+'" value="'+esc(v.name)+'"></div>'+
  '<div class="grid2"><div class="field"><label for="b-amount">'+'Usual amount (₱)'+'</label><input id="b-amount" name="amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Optional" value="'+esc(v.amount)+'"></div>'+
  '<div class="field"><label for="b-freq">Repeats</label><select id="b-freq" name="freq" data-action="freq">'+FREQ_OPTS.map(([k,t])=>'<option value="'+k+'"'+(freq===k?' selected':'')+'>'+t+'</option>').join('')+'</select></div></div>'+
  when+
  '<div class="field"><label for="b-note">Note</label><textarea id="b-note" name="note" maxlength="300" placeholder="'+(isIn?'Where it comes from, which account it lands in':'Account number reminder, where you pay, etc.')+'">'+esc(v.note)+'</textarea></div>'+
  '<div class="formactions"><button type="button" class="btn" data-action="cancel-form">Cancel</button><button class="btn primary" type="submit">'+(f.id?'Save changes':'Add '+item)+'</button></div></form>';
}
// Record a payment: a bill/income period, or money towards a loan or debt.
function payForm(){
  const f=S.form, v=f.values||{};
  let title, sub, btn, max='', hint='';
  if(f.kind==='bill'){
    const b=find('bills',f.id), T=TXT[dirOf(b)];
    title=esc(b.name); sub=(b.freq==='once'?'':periodLabel(b,f.key)+' · ')+(dirOf(b)==='in'?'Record what you received':'Record what you paid'); btn='Mark '+T.paid;
  } else {
    const l=find('loans',f.id), i=loanInfo(l), o=owes(l);
    title=esc(l.friend); sub=money(i.remaining)+' left '+(o?'to pay':'to collect'); btn=o?'Save payment':'Save';
    max=' max="'+i.remaining+'"'; hint='<p class="hint">Enter less than '+money(i.remaining)+' for a partial payment.</p>';
  }
  return '<form class="editor" data-form="pay"><div><h3 id="sheet-h">'+title+'</h3><p class="hint sub">'+sub+'</p></div>'+
  '<div class="grid2"><div class="field"><label for="p-amount">Amount (₱)</label><input id="p-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01"'+max+(f.kind==='loan'?' required':' placeholder="Optional"')+' value="'+esc(v.amount)+'"></div>'+
  '<div class="field"><label for="p-date">Date</label><input id="p-date" name="date" type="date" required max="'+iso(today())+'" value="'+esc(v.date)+'"></div></div>'+hint+
  '<div class="field"><label for="p-ref">Reference or note</label><input id="p-ref" name="ref" maxlength="80" placeholder="GCash or Maya ref no., OR number…" value="'+esc(v.ref)+'"></div>'+
  '<div class="formactions"><button type="button" class="btn" data-action="cancel-form">Cancel</button><button class="btn primary" type="submit">'+btn+'</button></div></form>';
}

function loansView(dir){
  const ready=S.loaded.loans||!S.live, o=dir==='out';
  const mine=S.loans.filter(l=>(owes(l)?'out':'in')===dir);
  let h='<div class="bar gap" id="'+(o?'owe-h':'loans-h')+'"><h2>'+(o?'You owe':'Friends owe you')+'</h2>'+(S.readOnly?'':'<button class="btn soft small" data-action="new-loan" data-dir="'+dir+'">'+(o?'+ Add debt':'+ Add loan')+'</button>')+'</div>';
  const withI=mine.map(l=>({l,i:loanInfo(l)}));
  const open=withI.filter(x=>!x.i.settled).sort((a,b)=>{
    const pa=a.i.promise?a.i.promise.date:null, pb=b.i.promise?b.i.promise.date:null;
    if(pa&&pb) return pa-pb; if(pa) return -1; if(pb) return 1; return (a.l.lentDate||'').localeCompare(b.l.lentDate||'');
  });
  const done=withI.filter(x=>x.i.settled).sort((a,b)=>(b.l.settledOn||'').localeCompare(a.l.settledOn||''));
  h+='<div class="panel">';
  if(!ready) h+='<div class="empty">Loading…</div>';
  else if(!mine.length) h+=o?'<div class="empty"><strong>Nothing you owe</strong>Record money you borrowed and when you said you’d pay it back.</div>'
    :'<div class="empty"><strong>No loans recorded</strong>Log who borrowed, how much, and when they said they’d pay you back.</div>';
  else {
    h+='<ul class="list">'+open.map(x=>loanRow(x.l,x.i)).join('')+'</ul>';
    if(!open.length) h+=o?'<div class="empty"><strong>All paid off</strong>You don’t owe anyone right now.</div>':'<div class="empty"><strong>Everyone has paid you back</strong>No open loans.</div>';
    if(done.length) h+='<details class="settled"><summary>'+(o?'Paid off':'Paid back')+' ('+done.length+')</summary><ul class="list">'+done.map(x=>loanRow(x.l,x.i)).join('')+'</ul></details>';
  }
  return h+'</div>';
}
function loanRow(l,i){
  const id=esc(l.id), t=today(), o=owes(l);
  const lent=parseD(l.lentDate);
  const ago=lent?diffDays(lent,t):null;
  let pill;
  if(i.settled) pill='<span class="pill done">'+(o?'Paid off':'Paid back')+(l.settledOn?' '+fmtShort(parseD(l.settledOn)):'')+'</span>';
  else if(i.promise){
    const d=i.promise.diff;
    const txt=o?dueLabel(d):d<0?(-d)+(d===-1?' day':' days')+' past promise':d===0?'Promised today':d===1?'Promised tomorrow':'Promised in '+d+' days';
    pill='<span class="pill '+i.promise.kind+'">'+txt+'</span>';
  } else pill='<span class="pill later">'+(o?'No due date':'No payback date')+'</span>';
  const pct=Number(l.amount)?Math.min(100,Math.round(i.paid/Number(l.amount)*100)):0;
  let tick;
  if(S.readOnly||i.settled) tick='<span class="tick'+(i.settled?' on':'')+'">'+CHECK+'</span>';
  else tick='<button class="tick'+(i.promise&&i.promise.kind==='overdue'?' due':'')+'" data-action="pay-loan" data-id="'+id+'" aria-label="Record a payment: '+esc(l.friend)+'" title="Record a payment">'+CHECK+'</button>';
  const facts=[];
  if(lent) facts.push((o?'Borrowed ':'Lent ')+money(l.amount)+' on '+fmt(lent)+(ago>0?' · '+plural(ago,'day','days')+' ago':''));
  if(i.promise) facts.push((o?'Pay back by ':'Promised to pay by ')+fmt(i.promise.date));
  if(i.paid>0) facts.push(money(i.paid)+' of '+money(l.amount)+(o?' paid back':' returned'));
  const paid=(l.payments||[]).slice().reverse().slice(0,5).map(p=>(o?'You paid ':'Got ')+payLine(p.date,p.amount,p.ref));
  let acts='';
  if(!S.readOnly){
    if(S.confirmDel===l.id) acts=confirmActs(id,'record','del-loan');
    else if(!i.settled){
      acts=(o?'':'<button class="btn small" data-action="copy" data-id="'+id+'">'+(navigator.share?'Send reminder':'Copy reminder')+'</button>')+'<span class="spacer"></span><button class="btn small ghost" data-action="edit-loan" data-id="'+id+'">Edit</button><button class="btn small ghost" data-action="ask-del" data-id="'+id+'">Delete</button>';
    } else acts='<button class="btn small" data-action="reopen" data-id="'+id+'">Reopen</button><span class="spacer"></span><button class="btn small ghost" data-action="ask-del" data-id="'+id+'">Delete</button>';
  }
  const extra=!i.settled&&i.paid>0?'<span class="progress" aria-hidden="true"><span style="width:'+pct+'%"></span></span>':'';
  return rowHtml({id:l.id,name:l.friend,example:l.example,inflow:!o&&!i.settled,amt:money(i.settled?l.amount:i.remaining),
    meta:pill+(lent&&!i.settled?'<span>'+(o?'Borrowed ':'Lent ')+fmtShort(lent)+'</span>':''),extra,tick,facts,paid,note:l.note,acts});
}
function loanForm(){
  const f=S.form, v=f.values||{}, o=f.dir==='out';
  return '<form class="editor" data-form="loan"><h3 id="sheet-h">'+(f.id?(o?'Edit debt':'Edit loan'):(o?'Money you owe':'New loan'))+'</h3>'+
  '<div class="grid2"><div class="field"><label for="l-friend">'+(o?'Lender':'Friend')+'</label><input id="l-friend" name="friend" required maxlength="60" placeholder="'+(o?'Who you borrowed from':'Who borrowed')+'" value="'+esc(v.friend)+'"></div>'+
  '<div class="field"><label for="l-amount">Amount (₱)</label><input id="l-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="'+esc(v.amount)+'"></div></div>'+
  '<div class="grid2"><div class="field"><label for="l-date">'+(o?'Date borrowed':'Date lent')+'</label><input id="l-date" name="lentDate" type="date" required value="'+esc(v.lentDate||iso(today()))+'"></div>'+
  '<div class="field"><label for="l-promise">'+(o?'Pay back by':'Promised to pay by')+'</label><input id="l-promise" name="promiseDate" type="date" value="'+esc(v.promiseDate)+'"></div></div>'+
  '<div class="field"><label for="l-note">Note</label><textarea id="l-note" name="note" maxlength="300" placeholder="What it was for, GCash or cash, etc.">'+esc(v.note)+'</textarea></div>'+
  '<div class="formactions"><button type="button" class="btn" data-action="cancel-form">Cancel</button><button class="btn primary" type="submit">'+(f.id?'Save changes':(o?'Add debt':'Add loan'))+'</button></div></form>';
}

/* ---------- history ---------- */
function historyView(){
  const cur=ym(today()), key=S.histMonth||cur;
  const all=ledger(), inMonth=k=>all.filter(x=>x.date.slice(0,7)===k);
  const rows=inMonth(key);
  const [y,m]=key.split('-').map(Number), prevKey=ym(new Date(y,m-2,1)), nextKey=ym(new Date(y,m,1));
  const sum=(arr,d)=>arr.filter(x=>x.dir===d).reduce((a,x)=>a+(Number(x.amount)||0),0);
  const out=sum(rows,'out'), inn=sum(rows,'in'), prevOut=sum(inMonth(prevKey),'out'), net=inn-out;
  let cmp='&nbsp;';
  if(prevOut>0){ const pct=Math.round((out-prevOut)/prevOut*100); cmp=pct===0?'Same as '+monthName(prevKey):Math.abs(pct)+'% '+(pct>0?'more':'less')+' than '+monthName(prevKey); }
  const title=new Date(y,m-1,1).toLocaleDateString('en-PH',{month:'long',year:'numeric'});
  let h='<div class="bar"><h2>History</h2><button class="btn soft small" data-action="export-csv">Download CSV</button></div>';
  h+='<div class="panel">'+
    '<div class="monthnav"><button class="btn ghost" data-action="hist-month" data-month="'+prevKey+'" aria-label="Previous month">‹</button><b>'+title+'</b>'+
    '<button class="btn ghost" data-action="hist-month" data-month="'+nextKey+'" aria-label="Next month"'+(key>=cur?' disabled':'')+'>›</button></div>'+
    '<div class="cols totals"><div class="fig"><span class="k">Money out</span><span class="v">'+money(out)+'</span><span class="s">'+cmp+'</span></div>'+
    '<div class="fig in"><span class="k">Money in</span><span class="v">'+money(inn)+'</span><span class="s">Net '+(net<0?'−':'+')+money(Math.abs(net))+'</span></div></div>';
  if(!rows.length) h+='<div class="empty"><strong>Nothing recorded</strong>Payments you record in '+monthName(key)+' show up here.</div>';
  else h+='<ul class="list ledger">'+rows.map(x=>'<li class="lrow"><span class="d">'+fmtShort(parseD(x.date))+'</span><span class="w"><b>'+esc(x.name)+'</b><span>'+esc(x.what)+(x.ref?' · '+esc(x.ref):'')+'</span></span>'+
    '<span class="a '+x.dir+'">'+(x.dir==='in'?'+':'−')+(x.amount!=null&&x.amount!==''?money(x.amount):'—')+'</span></li>').join('')+'</ul>';
  return h+'</div>';
}
function exportCsv(){
  // Prefix cells a spreadsheet would treat as a formula.
  const cell=v=>{ let s=String(v??''); if(/^[=+\-@\t\r]/.test(s)) s="'"+s; return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const rows=[['Date','Direction','Type','Name','Amount','Reference']].concat(ledger().map(x=>[x.date,x.dir==='in'?'In':'Out',x.what,x.name,x.amount??'',x.ref]));
  downloadBlob(new Blob(['﻿'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv'}),'bayad-payments-'+iso(today())+'.csv');
  toast('Payments downloaded');
}

/* ---------- storage: SQLite database on this device ---------- */
const worker=new Worker('db-worker.js',{type:'module'});
// Leaving the page (e.g. to About inside the installed app) must free the database file. Otherwise iOS keeps
// this page suspended with the file locked, and the page you come back to can't open it.
window.addEventListener('pagehide',()=>{ try{ worker.terminate(); }catch(_){} });
window.addEventListener('pageshow',e=>{ if(e.persisted) location.reload(); });
let reqId=0; const pending=new Map();
worker.onmessage=e=>{ const {id,ok,result,error}=e.data; const p=pending.get(id); if(!p) return; pending.delete(id); ok?p.res(result):p.rej(new Error(error)); };
worker.onerror=()=>{ S.storageError='failed'; S.loaded={bills:true,loans:true}; render(); };
function call(op,arg,transfer){ return new Promise((res,rej)=>{ const id=++reqId; pending.set(id,{res,rej}); worker.postMessage({id,op,arg},transfer||[]); }); }
function dbFail(e){
  const m=String(e&&e.message||e);
  if(m.indexOf('in_use')===0){ S.storageError='in_use'; render(); return; }
  if(/full|SQLITE_FULL|quota/i.test(m)) toast('Your phone’s storage is full. Free up space and try again.');
  else toast('Couldn’t save that change. Reopen the app and try again.');
}
function examples(){
  const t=today(), cur=ym(t), at=n=>{const x=new Date(t);x.setDate(x.getDate()+n);return x;}, d=n=>iso(at(n));
  return {
    bills:[
      {id:'ex-electric',example:true,dir:'out',name:'Electric bill',amount:2800,freq:'monthly',dueDay:5,startMonth:cur,paid:{[cur]:{on:iso(t),amount:2950,ref:'GCash 4417'}},note:''},
      {id:'ex-internet',example:true,dir:'out',name:'Internet',amount:1699,freq:'monthly',dueDay:at(2).getDate(),startMonth:ym(at(2)),paid:{},note:''},
      {id:'ex-salary',example:true,dir:'in',name:'Salary',amount:15000,freq:'monthly',dueDay:at(3).getDate(),startMonth:ym(at(3)),paid:{},note:''}
    ],
    loans:[{id:'ex-loan',example:true,friend:'Marco',amount:1500,lentDate:d(-19),promiseDate:d(-4),payments:[{amount:500,date:d(-9)}],note:'For his phone repair'}]
  };
}
async function save(coll,doc){
  const local=S[coll]; const i=local.findIndex(x=>x.id===doc.id);
  if(i>=0) local[i]=doc; else local.push(doc);
  render(); S.writeSeq=(S.writeSeq||0)+1;
  try{ await call(coll==='bills'?'putItem':'putLoan',doc); scheduleSync(1500); }catch(e){ dbFail(e); }
}
async function remove(coll,id){
  S[coll]=S[coll].filter(x=>x.id!==id); render(); S.writeSeq=(S.writeSeq||0)+1;
  try{ await call(coll==='bills'?'deleteItem':'deleteLoan',id); scheduleSync(1500); }catch(e){ dbFail(e); }
}
function handleErr(e){
  if(e && e.code==='invalid_argument'){ S.readOnly=true; toast('You can view this tracker but not change it.'); render(); }
  else if(e && e.code==='quota_exceeded') toast('Storage is full. Delete some old entries and try again.');
  else toast('Couldn’t save that change. Check your connection and try again.');
}
let toastTimer;
function toast(msg,undo){
  const t=document.getElementById('toast');
  t.innerHTML='<span>'+esc(msg)+'</span>'+(undo?'<button type="button" id="undo">Undo</button>':'');
  t.hidden=false; clearTimeout(toastTimer);
  if(undo) document.getElementById('undo').onclick=()=>{ t.hidden=true; undo(); };
  toastTimer=setTimeout(()=>{t.hidden=true},undo?6000:3500);
}
const find=(coll,id)=>S[coll].find(x=>x.id===id);
const clone=o=>JSON.parse(JSON.stringify(o));

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]'); if(!el || el.tagName==='SELECT') return;
  const a=el.dataset.action, id=el.dataset.id;
  if(a==='tab'){
    if(S.tab!==el.dataset.tab){ S.tab=el.dataset.tab; S.form=null; S.confirmDel=null; S.open=null; try{localStorage.setItem('bayad-tab',S.tab)}catch(_){} render(); }
    const to=document.getElementById(el.dataset.scroll||(el.closest('.summary')?'main':''));
    if(to) to.scrollIntoView({behavior:'smooth',block:'start'});
    return;
  }
  if(a==='toggle'){ S.open=S.open===id?null:id; S.confirmDel=null; render(); return; }
  if(a==='goto-settings'){ document.getElementById('settings').scrollIntoView({behavior:'smooth',block:'start'}); return; }
  if(a==='hist-month'){ S.histMonth=el.dataset.month; render(); return; }
  if(a==='export-csv'){ exportCsv(); return; }
  if(a==='new-bill'){ S.form={type:'bill',dir:el.dataset.dir||'out',values:{freq:'monthly'}}; render(); return; }
  if(a==='new-loan'){ S.form={type:'loan',dir:el.dataset.dir||'in',values:{}}; render(); return; }
  if(a==='edit-bill'){
    const b=find('bills',id), v=clone(b);
    if(b.freq!=='once' && byDate(b.freq)) v.dueDate=iso(billStatus(b).date); // edit from the next due date
    S.form={type:'bill',dir:dirOf(b),id,values:v}; render(); return;
  }
  if(a==='edit-loan'){ const l=find('loans',id); S.form={type:'loan',dir:owes(l)?'out':'in',id,values:clone(l)}; render(); return; }
  if(a==='cancel-form'){ S.form=null; render(); return; }
  if(a==='ask-del'){ S.confirmDel=id; render(); return; }
  if(a==='cancel-del'){ S.confirmDel=null; render(); return; }
  if(a==='del-bill'){ S.confirmDel=null; remove('bills',id); toast('Deleted'); return; }
  if(a==='del-loan'){ S.confirmDel=null; remove('loans',id); toast('Record deleted'); return; }
  if(a==='pay-bill'){
    const b=find('bills',id), s=billStatus(b);
    S.form={type:'pay',kind:'bill',id,key:s.key,values:{amount:b.amount??'',date:iso(today()),ref:''},_focused:b.amount!=null}; render(); return;
  }
  if(a==='pay-loan'){
    const l=find('loans',id), i=loanInfo(l);
    S.form={type:'pay',kind:'loan',id,values:{amount:i.remaining,date:iso(today()),ref:''},_focused:true}; render(); return;
  }
  if(a==='unpay-once'){ const b=clone(find('bills',id)); delete b.paidOn; delete b.paidAmount; delete b.paidRef; save('bills',b); return; }
  if(a==='unpay-month'){ const b=clone(find('bills',id)); const k=lastPaidKey(b); if(k){ delete b.paid[k]; save('bills',b); toast(periodLabel(b,k)+' marked un'+TXT[dirOf(b)].paid); } return; }
  if(a==='reopen'){ const l=clone(find('loans',id)); l.payments=[]; delete l.settledOn; save('loans',l); return; }
  if(a==='copy'){
    const l=find('loans',id), i=loanInfo(l); const lent=parseD(l.lentDate);
    const msg='Hi '+(l.friend||'').trim()+'! Friendly reminder about the '+money(i.remaining)+' I lent you'+(lent?' on '+lent.toLocaleDateString('en-PH',{month:'long',day:'numeric'}):'')+'. Let me know when you can send it. Thanks!';
    const copy=()=>{ try{ navigator.clipboard.writeText(msg).then(()=>toast('Reminder message copied'),()=>fallbackCopy(msg)); }catch(_){ fallbackCopy(msg); } };
    // On phones this opens the share sheet (Messenger, Viber, SMS…); elsewhere it copies the message.
    if(navigator.share) navigator.share({text:msg}).catch(e=>{ if(!e||e.name!=='AbortError') copy(); });
    else copy();
    return;
  }
  if(a==='clear-examples'){
    S.bills.filter(b=>b.example).forEach(b=>remove('bills',b.id));
    S.loans.filter(l=>l.example).forEach(l=>remove('loans',l.id));
    toast('Examples removed'); return;
  }
});
function fallbackCopy(msg){
  const t=document.getElementById('toast');
  t.innerHTML='<span style="user-select:all">'+esc(msg)+'</span>'; t.hidden=false; clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{t.hidden=true},10000);
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && S.form){ S.form=null; render(); } });
document.addEventListener('change',e=>{
  if(e.target.id==='b-freq' && S.form){ S.form.values=Object.assign(readForm(e.target.form),{freq:e.target.value}); S.form._focused=true; render(); }
});
function readForm(form){ const o={}; new FormData(form).forEach((v,k)=>o[k]=v); return o; }
const clampDay = x => Math.min(31,Math.max(1,parseInt(x,10)||1));
document.addEventListener('submit',e=>{
  const form=e.target; e.preventDefault();
  const kind=form.dataset.form;
  if(kind==='bill'){
    const v=readForm(form); const f=S.form;
    const base=f.id?clone(find('bills',f.id)):{id:uid(),created:new Date().toISOString(),paid:{}};
    base.dir=f.dir||'out'; base.name=v.name.trim(); base.amount=v.amount===''?null:Number(v.amount); base.freq=v.freq; base.note=(v.note||'').trim();
    delete base.dueDay; delete base.dueDay2; delete base.dueDate;
    if(base.freq==='monthly'||base.freq==='twice'){
      base.dueDay=clampDay(v.dueDay);
      if(base.freq==='twice'){ const d2=clampDay(v.dueDay2); base.dueDay2=Math.max(base.dueDay,d2); base.dueDay=Math.min(base.dueDay,d2); }
      if(!base.startMonth) base.startMonth=ym(today());
      base.paid=base.paid||{};
      if(!f.id && v.paidNow && base.freq==='monthly') base.paid[ym(today())]=iso(today());
    } else if(base.freq==='quarterly'||base.freq==='yearly'){
      const d=parseD(v.dueDate)||today(); base.startMonth=ym(d); base.dueDay=d.getDate(); base.paid=base.paid||{};
    } else { base.dueDate=v.dueDate; if(base.freq!=='once') base.paid=base.paid||{}; }
    delete base.example;
    const nm=base.dir==='in'?'Income':'Bill';
    S.form=null; save('bills',base); toast(f.id?nm+' updated':nm+' added');
  } else if(kind==='loan'){
    const v=readForm(form); const f=S.form;
    const base=f.id?clone(find('loans',f.id)):{id:uid(),created:new Date().toISOString(),payments:[]};
    base.dir=f.dir==='out'?'out':'in';
    base.friend=v.friend.trim(); base.amount=Number(v.amount); base.lentDate=v.lentDate; base.promiseDate=v.promiseDate||null; base.note=(v.note||'').trim();
    delete base.example;
    const i=loanInfo(base); if(i.settled && !base.settledOn) base.settledOn=iso(today()); if(!i.settled) delete base.settledOn;
    S.form=null; save('loans',base); toast((base.dir==='out'?'Debt':'Loan')+(f.id?' updated':' added'));
  } else if(kind==='pay'){
    const v=readForm(form), f=S.form, amt=v.amount===''?null:Number(v.amount), date=v.date||iso(today()), ref=(v.ref||'').trim();
    if(f.kind==='bill'){
      const prev=find('bills',f.id), b=clone(prev), pw=TXT[dirOf(b)].paid;
      if(b.freq==='once'){
        b.paidOn=date;
        if(amt!=null) b.paidAmount=amt; else delete b.paidAmount;
        if(ref) b.paidRef=ref; else delete b.paidRef;
      } else {
        b.paid=Object.assign({},b.paid||{});
        b.paid[f.key]=amt==null&&!ref?date:Object.assign({on:date},amt!=null?{amount:amt}:{},ref?{ref}:{});
      }
      S.form=null; save('bills',b);
      toast((b.freq==='once'?'':periodLabel(b,f.key)+' ')+b.name+' marked '+pw,()=>save('bills',clone(prev)));
    } else {
      if(!(amt>0)) return;
      const prev=find('loans',f.id), l=clone(prev), o=owes(l);
      l.payments=(l.payments||[]).concat([Object.assign({amount:amt,date},ref?{ref}:{})]);
      const i=loanInfo(l); if(i.settled) l.settledOn=date;
      S.form=null; save('loans',l);
      toast(i.settled?(o?'Paid off '+l.friend:l.friend+' paid you back in full'):money(amt)+(o?' paid to ':' received from ')+l.friend,()=>save('loans',clone(prev)));
    }
  }
});

render();

/* ---------- start ---------- */
S.live=true; render();
(async function(){
  try{
    const r=await call('init');
    S.dbMode=r.mode;
    if(r.empty && !r.migrated){
      let old=null; try{ old=JSON.parse(localStorage.getItem('bayad-data-v1')||'null'); }catch(_){}
      const hasOld=old && ((old.bills||[]).length || (old.loans||[]).length);
      const d=await call('replaceAll',Object.assign(hasOld?{bills:old.bills||[],loans:old.loans||[]}:examples(),{markMigrated:true}));
      S.bills=d.bills; S.loans=d.loans;
      if(hasOld){ try{ localStorage.removeItem('bayad-data-v1'); }catch(_){} toast('Your entries were moved into the new database'); }
    } else { S.bills=r.bills; S.loans=r.loans; }
    const info=document.getElementById('dbinfo');
    if(info) info.textContent=r.mode==='opfs'?'Database: SQLite, saved in this app’s private storage.':'Database: SQLite, saved in browser storage (this browser has no file storage).';
  }catch(e){ dbFail(e); if(!S.storageError) S.storageError='failed'; }
  S.loaded={bills:true,loans:true}; render();
  if(S.afterLoad) S.afterLoad();
})();

/* ---------- sync with your server ---------- */
const SYNC={available:false,signedIn:false,email:null,busy:false,last:null,err:null,timer:null};
try{ const c=JSON.parse(localStorage.getItem('bayad-sync')||'null'); if(c){ Object.assign(SYNC,{available:!!c.available,signedIn:!!c.signedIn,email:c.email||null,last:c.last?new Date(c.last):null}); } }catch(_){}
function rememberSync(){ try{ localStorage.setItem('bayad-sync',JSON.stringify({available:SYNC.available,signedIn:SYNC.signedIn,email:SYNC.email,last:SYNC.last&&SYNC.last.toISOString()})); }catch(_){} }
function ago(d){ if(!d) return ''; const s=Math.round((Date.now()-d.getTime())/1000); if(s<45) return 'just now'; const m=Math.round(s/60); if(m<60) return m+' min ago'; const h=Math.round(m/60); if(h<24) return h+(h===1?' hour ago':' hours ago'); return d.toLocaleDateString('en-PH',{month:'short',day:'numeric'}); }
async function checkAccount(){
  try{
    const r=await fetch('/api/me',{cache:'no-store',credentials:'same-origin'});
    if(!r.ok || !(r.headers.get('content-type')||'').includes('application/json')) throw new Error('no api');
    const j=await r.json();
    SYNC.available=!!j.configured; SYNC.signedIn=!!j.signedIn; SYNC.email=j.email||null; rememberSync();
  }catch(_){ /* offline or no server: keep what we knew */ }
  renderSync();
}
function applyData(d){
  S.bills=d.bills; S.loans=d.loans;
  if(S.form||S.confirmDel){ S.needsRender=true; renderSummary(); } else render();
}
function scheduleSync(ms){ clearTimeout(SYNC.timer); if(SYNC.signedIn) SYNC.timer=setTimeout(syncNow,ms); }
async function syncNow(){
  if(!SYNC.signedIn || SYNC.busy || !navigator.onLine || S.storageError || !S.loaded.bills) return;
  SYNC.busy=true; SYNC.err=null; renderSync();
  try{
    let more=true, rounds=0;
    while(more && rounds++<20){
      const p=await call('pending');
      const r=await fetch('/api/sync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Bayad':'1'},body:JSON.stringify({since:p.cursor,changes:p.changes})});
      if(r.status===401){ SYNC.signedIn=false; rememberSync(); try{ await call('resetSync'); }catch(_){} toast('You were signed out. Sign in again to keep syncing.'); break; }
      if(!r.ok) throw new Error('http '+r.status);
      const j=await r.json();
      const before=S.writeSeq||0;
      // Changes the server turned away (account full) stay queued on this device.
      const rejected=new Set((j.rejected||[]).map(c=>c.kind+':'+c.id));
      if(j.full && !SYNC.fullWarned){ SYNC.fullWarned=true; toast('Your synced storage is full, so new entries stay on this phone only. Delete old entries to make room.'); }
      let d=await call('applyRemote',{pushed:p.changes.filter(c=>!rejected.has(c.kind+':'+c.id)).map(c=>({kind:c.kind,id:c.id,updated_at:c.updated_at})),changes:j.changes,cursor:j.cursor});
      if((S.writeSeq||0)!==before) d=await call('readAll');
      applyData(d);
      more=!!j.more || (p.changes.length>0 && (await call('pending')).changes.length>0 && rounds<3);
      if(!j.more) SYNC.last=new Date();
    }
    rememberSync();
  }catch(e){ SYNC.err='failed'; }
  SYNC.busy=false; renderSync();
}
async function signOut(){
  await disablePush(true);
  try{ await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'X-Bayad':'1'}}); }catch(_){}
  try{ await call('resetSync'); }catch(_){}
  SYNC.signedIn=false; SYNC.email=null; SYNC.last=null; rememberSync(); renderSync();
  toast('Signed out. Your entries stay on this phone.');
}
async function deleteAccount(){
  if(SYNC.busy) return;
  SYNC.busy=true; renderSync();
  let r=null;
  try{ r=await fetch('/api/delete-account',{method:'POST',credentials:'same-origin',headers:{'X-Bayad':'1'}}); }catch(_){}
  if(!r || !r.ok){
    SYNC.busy=false;
    if(r && r.status===401){ SYNC.signedIn=false; SYNC.confirmDelete=false; rememberSync(); renderSync(); toast('You’re signed out. Sign in again, then delete your account.'); }
    else { renderSync(); toast('Couldn’t delete your account. Check your connection and try again.'); }
    return;
  }
  const erase=SYNC.eraseLocal;
  pushSub().then(s=>s&&s.unsubscribe()).catch(()=>{}); REM.pushOn=false; REM.cal=null; REM.calOpen=false;
  try{
    if(erase){ const d=await call('replaceAll',{bills:[],loans:[]}); S.bills=d.bills; S.loans=d.loans; render(); }
    await call('resetSync');
  }catch(_){}
  Object.assign(SYNC,{busy:false,signedIn:false,email:null,last:null,confirmDelete:false,eraseLocal:false}); rememberSync(); renderSync();
  toast(erase?'Account deleted, and this phone was erased.':'Account deleted. Your entries stay on this phone.');
}
/* ---------- reminders: notifications and calendar ---------- */
const REM={pushOn:false,cal:null,calOpen:false,busy:false};
const pushSupported=()=>'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const tzName=()=>{ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||''; }catch(_){ return ''; } };
const post=(path,body)=>fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Bayad':'1'},body:JSON.stringify(body||{})});
const b64u=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function pushSub(){ if(!pushSupported()) return null; try{ return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); }catch(_){ return null; } }
async function checkPush(){
  const s=await pushSub();
  REM.pushOn=!!s && Notification.permission==='granted';
  // Re-register so the server has this device's current time zone and the right account.
  if(REM.pushOn && SYNC.signedIn && navigator.onLine) post('/api/push/subscribe',{subscription:s.toJSON(),tz:tzName()}).catch(()=>{});
  renderSync();
}
async function enablePush(){
  if(REM.busy) return; REM.busy=true; renderSync();
  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted') throw new Error(perm==='denied'?'blocked':'dismissed');
    const {key}=await (await fetch('/api/push/key',{cache:'no-store'})).json();
    const reg=await navigator.serviceWorker.ready;
    const s=await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(key)});
    if(!(await post('/api/push/subscribe',{subscription:s.toJSON(),tz:tzName()})).ok) throw new Error('server');
    REM.pushOn=true; toast('Reminders on. You’ll get one at 8 AM when something is due.');
  }catch(e){
    toast(e.message==='blocked'?'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.'
      :e.message==='dismissed'?'Notifications weren’t turned on.':'Couldn’t turn on reminders. Try again.');
  }
  REM.busy=false; renderSync();
}
async function disablePush(silent){
  const s=await pushSub();
  if(s){ try{ await post('/api/push/unsubscribe',{endpoint:s.endpoint}); }catch(_){} try{ await s.unsubscribe(); }catch(_){} }
  REM.pushOn=false; renderSync();
  if(!silent) toast('Reminders off on this device.');
}
async function openCalendar(reset){
  REM.busy=true; renderSync();
  try{
    const r=await post('/api/calendar',{tz:tzName(),reset:!!reset}); if(!r.ok) throw 0;
    REM.cal=(await r.json()).url; REM.calOpen=true;
    if(reset) toast('New calendar link made. The old one no longer works.');
  }catch(_){ toast('Couldn’t get your calendar link. Try again.'); }
  REM.busy=false; renderSync();
}
function remindersHtml(off){
  const dis=off||REM.busy?' disabled':'';
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent), installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  let push;
  if(!pushSupported()) push='<p class="hint">'+(ios&&!installed?'On iPhone, add Bayad to your Home Screen and open it from there to get notifications.':'This browser can’t show notifications. The calendar works everywhere.')+'</p>';
  else if(REM.pushOn) push='<div class="inline"><button class="btn small" data-action="push-test"'+dis+'>Send a test</button><button class="btn small ghost" data-action="push-off"'+dis+'>Turn off</button></div>';
  else push='<div class="inline"><button class="btn small soft" data-action="push-on"'+dis+'>Turn on notifications</button></div>'+
    (Notification.permission==='denied'?'<p class="hint">Notifications are blocked for this site in your browser or phone settings.</p>':'');
  const webcal=REM.cal?REM.cal.replace(/^https?:/,'webcal:'):'';
  const cal=REM.calOpen&&REM.cal
    ? '<div class="inline"><a class="btn small soft" href="https://calendar.google.com/calendar/r?cid='+encodeURIComponent(webcal)+'" target="_blank" rel="noopener">Google Calendar</a>'+
      '<a class="btn small soft" href="'+esc(webcal)+'">Apple or Outlook</a><button class="btn small" data-action="cal-copy">Copy link</button></div>'+
      '<p class="hint">Calendars refresh every few hours, so a bill you just paid can show for a while. Anyone with this link can see your due dates. <button class="linkbtn" data-action="cal-reset"'+dis+'>Make a new link</button></p>'
    : '<div class="inline"><button class="btn small soft" data-action="cal-open"'+dis+'>Add to my calendar</button></div>';
  return '<div class="remind"><b>Reminders</b>'+
    '<div class="rem"><span class="rem-h">Notifications'+(REM.pushOn?' <span class="on">On</span>':'')+'</span><span class="hint">One message at 8 AM when a bill or payment is due today or tomorrow, or a bill is overdue.</span>'+push+'</div>'+
    '<div class="rem"><span class="rem-h">Calendar</span><span class="hint">Your due dates in Google Calendar, Apple Calendar or Outlook, with a reminder the day before.</span>'+cal+'</div></div>';
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action^="push-"],[data-action^="cal-"]'); if(!el) return;
  const a=el.dataset.action;
  if(a==='push-on') enablePush();
  else if(a==='push-off') disablePush();
  else if(a==='push-test') post('/api/push/test').then(r=>r.json()).then(j=>toast(j.sent?'Test sent. It should arrive in a few seconds.':'Couldn’t send a test. Turn notifications off and on again.'),()=>toast('Couldn’t send a test. Check your connection.'));
  else if(a==='cal-open') openCalendar(false);
  else if(a==='cal-reset') openCalendar(true);
  else if(a==='cal-copy'){ try{ navigator.clipboard.writeText(REM.cal).then(()=>toast('Calendar link copied'),()=>fallbackCopy(REM.cal)); }catch(_){ fallbackCopy(REM.cal); } }
});
function renderSync(){
  const box=document.getElementById('syncbox');
  if(box){
    if(!SYNC.available){ box.hidden=true; }
    else{
      box.hidden=false;
      const off=!navigator.onLine;
      box.innerHTML = SYNC.signedIn
        ? '<div class="acct"><span class="avatar" aria-hidden="true">'+esc((SYNC.email||'?')[0])+'</span><div><b>'+esc(SYNC.email||'')+'</b><span class="hint">'+(SYNC.busy?'Syncing…':SYNC.err?'Last sync failed; it will retry.':SYNC.last?'Last synced '+ago(SYNC.last)+'.':'Not synced yet.')+'</span></div></div>'+
          (SYNC.confirmDelete
            ? '<div class="confirm" role="alert"><b>Delete your account?</b><p>Your account and every synced entry are removed from the server for good. Other devices are signed out. This can’t be undone.</p>'+
              '<label class="check"><input type="checkbox" id="erase-local"'+(SYNC.eraseLocal?' checked':'')+'> Also erase the entries on this phone</label>'+
              '<div class="inline"><button class="btn danger-fill" data-action="delete-account"'+(off||SYNC.busy?' disabled':'')+'>'+(SYNC.busy?'Deleting…':'Delete account')+'</button><button class="btn" data-action="cancel-delete-account">Cancel</button></div></div>'
            : '<div class="inline"><button class="btn" data-action="sync-now"'+(off||SYNC.busy?' disabled':'')+'>Sync now</button><button class="btn ghost" data-action="sign-out"'+(off?' disabled':'')+'>Sign out</button>'+
              '<span class="spacer"></span><button class="btn ghost danger" data-action="ask-delete-account"'+(off?' disabled':'')+'>Delete account</button></div>'+remindersHtml(off))
        :'<p>Sign in to keep your entries in sync across your phone and other devices. They’re stored on this app’s server.</p>'+
          (off?'<p class="hint">Connect to the internet to sign in.</p>':'<div class="inline"><a class="btn primary" href="/auth/google">Sign in with Google</a></div>'+
          '<p class="hint">By signing in you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.</p>');
    }
  }
  netStatus();
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action="sync-now"],[data-action="sign-out"],[data-action$="delete-account"]'); if(!el) return;
  const a=el.dataset.action;
  if(a==='sync-now') syncNow();
  else if(a==='sign-out') signOut();
  else if(a==='ask-delete-account'){ SYNC.confirmDelete=true; SYNC.eraseLocal=false; renderSync(); }
  else if(a==='cancel-delete-account'){ SYNC.confirmDelete=false; renderSync(); }
  else if(a==='delete-account') deleteAccount();
});
document.addEventListener('change',e=>{ if(e.target.id==='erase-local') SYNC.eraseLocal=e.target.checked; });
(function(){
  const msg={signed_in:'Signed in. Syncing your entries…',cancelled:'Sign-in cancelled.',failed:'Sign-in didn’t work. Try again.',
    not_allowed:'That Google account isn’t allowed on this server.',unverified:'That Google account’s email isn’t verified.',not_configured:'Sync isn’t set up on the server yet.'};
  const k=new URLSearchParams(location.search).get('sync');
  if(k){ if(msg[k]) setTimeout(()=>toast(msg[k]),300); history.replaceState(null,'',location.pathname); }
})();
window.addEventListener('online',()=>{ checkAccount().then(()=>syncNow()); });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') syncNow(); });
setInterval(()=>{ if(document.visibilityState==='visible') syncNow(); renderSync(); },60000);
S.afterLoad=()=>{ checkAccount().then(()=>{ syncNow(); if(SYNC.signedIn) checkPush(); }); };

function netStatus(){
  const el=document.getElementById('netstatus');
  const off=!navigator.onLine;
  let txt='Saved on this device', warn=off;
  if(off) txt=SYNC.signedIn?'Offline · will sync later':'Offline · saved on this device';
  else if(SYNC.signedIn){
    if(SYNC.busy) txt='Syncing…';
    else if(SYNC.err){ txt='Sync failed · will retry'; warn=true; }
    else if(SYNC.last) txt='Synced '+ago(SYNC.last);
    else txt='Signed in · not synced yet';
  }
  el.classList.toggle('off',warn); el.textContent=txt;
}
window.addEventListener('online',netStatus); window.addEventListener('offline',netStatus); netStatus();

/* backup */
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-action="export"],[data-action="export-json"],[data-action="install"]'); if(!el) return;
  const act=el.dataset.action;
  if(act==='export'){
    try{ const bytes=await call('export'); downloadBlob(new Blob([bytes],{type:'application/vnd.sqlite3'}),'bayad-'+iso(today())+'.sqlite'); toast('Database downloaded'); }
    catch(err){ toast('Couldn’t create the backup. Try again.'); }
  } else if(act==='export-json'){
    downloadBlob(new Blob([JSON.stringify({app:'bayad',v:1,exported:new Date().toISOString(),bills:S.bills,loans:S.loans},null,2)],{type:'application/json'}),'bayad-backup-'+iso(today())+'.json');
    toast('Backup downloaded');
  } else if(act==='install' && deferredPrompt){
    deferredPrompt.prompt(); deferredPrompt.userChoice.finally(()=>{ deferredPrompt=null; document.getElementById('installrow').hidden=true; });
  }
});
document.getElementById('importfile').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  const isJson=/\.json$/i.test(f.name)||f.type==='application/json';
  r.onload=async()=>{
    const prev=await call('export').catch(()=>null);
    try{
      let d;
      if(isJson){
        const j=JSON.parse(r.result);
        if(!Array.isArray(j.bills)||!Array.isArray(j.loans)) throw new Error('shape');
        d=await call('replaceAll',{bills:j.bills,loans:j.loans});
      } else {
        d=await call('importFile',r.result,[r.result]);
      }
      S.bills=d.bills; S.loans=d.loans; render();
      toast('Backup restored ('+d.bills.length+' bills/income, '+d.loans.length+' loans)', prev?async()=>{ const u=await call('importFile',prev.buffer,[prev.buffer]); S.bills=u.bills; S.loans=u.loans; render(); }:null);
    }catch(_){ toast('That file isn’t a Bayad backup. Choose a bayad-….sqlite or bayad-backup-….json file.'); }
    e.target.value='';
  };
  if(isJson) r.readAsText(f); else r.readAsArrayBuffer(f);
});

/* install + offline */
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredPrompt=e; document.getElementById('installrow').hidden=false; });
window.addEventListener('appinstalled',()=>{ document.getElementById('installrow').hidden=true; toast('Bayad installed'); });
const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
if(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) document.getElementById('iosinstall').hidden=false;
if(navigator.storage && navigator.storage.persist){ navigator.storage.persist().catch(()=>{}); }
if('serviceWorker' in navigator){ window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }); }

setInterval(()=>{ const d=iso(today()); if(d!==S._day){ S._day=d; render(); } },60000);
S._day=iso(today());
})();
