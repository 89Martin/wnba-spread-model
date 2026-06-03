/* ==========================================================================
   WNBA Matchup Bet Card  —  client logic
   - Ratings (Four Factors / power) come from data/ratings.json (refresh.ps1)
   - Schedule, logos, colors, reference line come live from ESPN
   - You enter the book + sharp lines; model returns fair odds, edge, Kelly stake
   ========================================================================== */

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard";
let RATINGS = null;       // parsed ratings.json
let CFG = { homeCourt: 2.5, marginSD: 13.5 };

/* ---------------- math helpers ---------------- */
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
function normCdf(z){ // Φ via erf approximation
  const t = 1/(1+0.2316419*Math.abs(z));
  const d = 0.3989423*Math.exp(-z*z/2);
  let p = d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
  return z>0 ? 1-p : p;
}
const americanToDecimal = a => a>0 ? 1+a/100 : 1+100/(-a);
const americanToProb    = a => a>0 ? 100/(a+100) : (-a)/((-a)+100);
function probToAmerican(p){
  p = clamp(p, 0.0001, 0.9999);
  return p>=0.5 ? Math.round(-100*p/(1-p)) : Math.round(100*(1-p)/p);
}
const fmtOdds = a => (a>0?`+${a}`:`${a}`);
const fmtSpread = s => (s>0?`+${s.toFixed(1)}`:s.toFixed(1));
const pct = x => `${(x*100).toFixed(1)}%`;
const REST_PTS = { rested:+0.7, normal:0, b2b:-1.7, "3in4":-1.0 }; // points to team margin

/* ---------------- persistence ---------------- */
const LS = {
  get:(k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d }catch{ return d } },
  set:(k,v)=>localStorage.setItem(k,JSON.stringify(v))
};
function loadSettings(){
  const s = LS.get('wnba_settings', {});
  if(s.bankroll!=null) bankrollEl.value=s.bankroll;
  if(s.kelly!=null)    kellyEl.value=s.kelly;
  if(s.unit!=null)     unitEl.value=s.unit;
  if(s.sharpW!=null)   sharpWEl.value=s.sharpW;
  if(s.edgeMin!=null)  edgeMinEl.value=s.edgeMin;
}
function saveSettings(){
  LS.set('wnba_settings',{bankroll:+bankrollEl.value,kelly:kellyEl.value,
    unit:+unitEl.value,sharpW:+sharpWEl.value,edgeMin:+edgeMinEl.value});
}

/* ---------------- DOM ---------------- */
const $=id=>document.getElementById(id);
const slate=$('slate'), datePicker=$('datePicker'), metaEl=$('ratingsMeta'), footEl=$('footMeta');
const bankrollEl=$('bankroll'), kellyEl=$('kellyFrac'), unitEl=$('unitPct'),
      sharpWEl=$('sharpW'), sharpWValEl=$('sharpWVal'), edgeMinEl=$('edgeMin');

/* ---------------- boot ---------------- */
(async function init(){
  try{
    RATINGS = await (await fetch('data/ratings.json',{cache:'no-store'})).json();
    CFG.homeCourt = RATINGS.homeCourt ?? 2.5;
    CFG.marginSD  = RATINGS.marginSD ?? 13.5;
    metaEl.textContent = `Ratings as of ${RATINGS.asOf} · ${RATINGS.season} season · HCA ${CFG.homeCourt} · σ ${CFG.marginSD}`;
  }catch(e){
    metaEl.textContent = '⚠ could not load data/ratings.json — run refresh.ps1';
  }
  loadSettings();
  const url=new URL(location.href);
  const qd=url.searchParams.get('d');
  datePicker.value = qd || todayISO();
  sharpWValEl.textContent = sharpWEl.value+'%';

  datePicker.addEventListener('change', ()=>{ syncUrl(); loadSlate(); });
  $('refreshBtn').addEventListener('click', loadSlate);
  [bankrollEl,kellyEl,unitEl,edgeMinEl].forEach(el=>el.addEventListener('input',()=>{saveSettings();recomputeAll();}));
  sharpWEl.addEventListener('input',()=>{sharpWValEl.textContent=sharpWEl.value+'%';saveSettings();recomputeAll();});

  loadSlate();
})();

const todayISO=()=>{ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
function syncUrl(){ const u=new URL(location.href); u.searchParams.set('d',datePicker.value); history.replaceState(null,'',u); }
const espnDate = iso => iso.replaceAll('-','');

/* ---------------- slate loading ---------------- */
async function loadSlate(){
  syncUrl();
  slate.innerHTML='<div class="loading">Loading slate…</div>';
  const iso=datePicker.value;
  try{
    const data = await (await fetch(`${ESPN}?dates=${espnDate(iso)}&limit=100`)).json();
    const games = (data.events||[]).filter(e=>sameLocalDay(e.date,iso));
    const rest = await buildRestMap(iso);
    if(!games.length){ slate.innerHTML=`<div class="empty">No WNBA games on ${iso}.</div>`; return; }
    slate.innerHTML='';
    games.sort((a,b)=>new Date(a.date)-new Date(b.date));
    games.forEach(ev=>slate.appendChild(renderCard(ev,iso,rest)));
    footEl.textContent=`${games.length} game${games.length>1?'s':''} · ${iso}`;
    recomputeAll();
  }catch(e){
    slate.innerHTML=`<div class="empty">Couldn't reach ESPN. Check connection.<br><small>${e.message}</small></div>`;
  }
}
function sameLocalDay(isoTs, dayISO){
  const d=new Date(isoTs); d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
  return d.toISOString().slice(0,10)===dayISO;
}
// rest: who played in the previous 3 days -> days since last game
async function buildRestMap(iso){
  const map={};
  const base=new Date(iso+'T12:00:00');
  for(let back=1;back<=3;back++){
    const d=new Date(base); d.setDate(d.getDate()-back);
    const ds=d.toISOString().slice(0,10);
    try{
      const data=await (await fetch(`${ESPN}?dates=${espnDate(ds)}&limit=100`)).json();
      (data.events||[]).forEach(e=>{
        if(!sameLocalDay(e.date,ds)) return;
        e.competitions[0].competitors.forEach(c=>{
          const ab=c.team.abbreviation;
          if(map[ab]==null) map[ab]=back; // nearest prior game
        });
      });
    }catch{}
  }
  return map;
}
function restState(daysAgo){
  if(daysAgo==null) return 'rested';
  if(daysAgo<=1) return 'b2b';
  if(daysAgo===2) return '3in4';
  return daysAgo>=3 ? 'rested':'normal';
}

/* ---------------- reference line parsing ---------------- */
function parseEspnLine(ev, homeAbbr){
  try{
    const o=ev.competitions[0].odds?.[0]; if(!o) return {};
    let homeSpread=null;
    if(o.details){ // e.g. "NY -8.5"
      const m=o.details.trim().match(/^([A-Z]{2,4})\s+(-?\d+(\.\d+)?)/);
      if(m){ const fav=m[1], num=parseFloat(m[2]); homeSpread = (fav===homeAbbr)? num : -num; }
    }
    if(homeSpread==null && typeof o.spread==='number') homeSpread=o.spread;
    return { homeSpread, ou:o.overUnder };
  }catch{ return {}; }
}

/* ---------------- card rendering ---------------- */
function teamRec(abbr){ return RATINGS?.teams?.[abbr] || null; }

function renderCard(ev,iso,restMap){
  const comp=ev.competitions[0];
  const home=comp.competitors.find(c=>c.homeAway==='home');
  const away=comp.competitors.find(c=>c.homeAway==='away');
  const ha=home.team.abbreviation, aa=away.team.abbreviation;
  const hr=teamRec(ha), ar=teamRec(aa);
  const ref=parseEspnLine(ev,ha);
  const gid=ev.id;
  const saved=LS.get(`wnba_odds_${iso}_${gid}`,{});
  const restH=restState(restMap[ha]), restA=restState(restMap[aa]);
  const tip=new Date(ev.date).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  const status=ev.status?.type?.shortDetail||'';

  const homec=(hr?.color)||home.team.color&&('#'+home.team.color)||'#26304a';
  const awayc=(ar?.color)||away.team.color&&('#'+away.team.color)||'#26304a';
  const logoH=(hr?.logo)||home.team.logo, logoA=(ar?.logo)||away.team.logo;

  const card=document.createElement('div');
  card.className='card'; card.dataset.gid=gid; card.dataset.iso=iso;
  card.dataset.home=ha; card.dataset.away=aa;
  card.style.setProperty('--homec',homec); card.style.setProperty('--awayc',awayc);

  const ff = hr&&ar ? `
    <div class="factors">
      <div class="h"></div><div class="h">${aa}</div><div class="h">${ha}</div>
      ${ffRow('eFG%', ar.efg, hr.efg, true)}
      ${ffRow('TOV%', ar.tovPct, hr.tovPct, false)}
      ${ffRow('OREB%',ar.orebPct,hr.orebPct, true)}
      ${ffRow('Pace', ar.pace/100, hr.pace/100, true, v=>(v*100).toFixed(1))}
      ${ffRow('Net/100', (ar.netRtg+50)/100,(hr.netRtg+50)/100,true, (v,raw,which)=> (which==='a'?ar.netRtg:hr.netRtg).toFixed(1))}
    </div>`:'';

  card.innerHTML=`
    <div class="matchup">
      <div class="statusbadge">${status}</div>
      <div class="team">
        <img src="${logoA||''}" alt="${aa}" onerror="this.style.visibility='hidden'"/>
        <div class="nm">${away.team.shortDisplayName}</div>
        <div class="pw">pwr ${ar?ar.power.toFixed(1):'–'}</div>
      </div>
      <div class="vs"><span class="at">@</span><span class="time">${tip}</span></div>
      <div class="team">
        <img src="${logoH||''}" alt="${ha}" onerror="this.style.visibility='hidden'"/>
        <div class="nm">${home.team.shortDisplayName}</div>
        <div class="pw">pwr ${hr?hr.power.toFixed(1):'–'}</div>
      </div>
    </div>

    <div class="modelstrip">
      <div class="m"><span class="muted">Model line</span><b data-f="modelLine">–</b></div>
      <div class="m"><span class="muted">Proj. margin</span><b data-f="projMargin">–</b></div>
      <div class="m"><span class="muted">Blended line</span><b data-f="blendLine">–</b></div>
    </div>
    ${ff}

    <div class="entry">
      <div class="row"><span class="rl"></span><span class="colh">${aa} (away)</span><span class="colh">${ha} (home)</span></div>
      <div class="row">
        <span class="rl">Book spr</span>
        <input data-i="bookAway" inputmode="decimal" placeholder="+/-" value="${saved.bookAway ?? (ref.homeSpread!=null?(-ref.homeSpread):'')}">
        <input data-i="bookHome" inputmode="decimal" placeholder="+/-" value="${saved.bookHome ?? (ref.homeSpread ?? '')}">
      </div>
      <div class="row">
        <span class="rl">Price</span>
        <input data-i="priceAway" inputmode="numeric" placeholder="-110" value="${saved.priceAway ?? -110}">
        <input data-i="priceHome" inputmode="numeric" placeholder="-110" value="${saved.priceHome ?? -110}">
      </div>
      <div class="row">
        <span class="rl">Sharp spr</span>
        <input data-i="sharpAway" inputmode="decimal" placeholder="opt." value="${saved.sharpAway ?? ''}">
        <input data-i="sharpHome" inputmode="decimal" placeholder="opt." value="${saved.sharpHome ?? ''}">
      </div>
      <div class="row">
        <span class="rl">Injury ±</span>
        <input data-i="injAway" inputmode="decimal" placeholder="0" value="${saved.injAway ?? ''}">
        <input data-i="injHome" inputmode="decimal" placeholder="0" value="${saved.injHome ?? ''}">
      </div>
      <div class="row">
        <span class="rl">Rest</span>
        ${restSelect('restAway', saved.restAway ?? restA)}
        ${restSelect('restHome', saved.restHome ?? restH)}
      </div>
    </div>

    <div class="rec-box">
      <div class="verdict">
        <span class="sidetxt" data-f="side">—</span>
        <span class="pill pass" data-f="pill">PASS</span>
      </div>
      <div class="metrics">
        <div class="b"><div class="k">Model fair</div><div class="vv" data-f="fair">–</div></div>
        <div class="b"><div class="k">Win %</div><div class="vv" data-f="winp">–</div></div>
        <div class="b"><div class="k">Edge</div><div class="vv" data-f="edge">–</div></div>
        <div class="b"><div class="k">Spr value</div><div class="vv" data-f="spv">–</div></div>
      </div>
      <div class="stake">
        <span class="muted">Stake (¼-Kelly default)</span>
        <span><b data-f="stake">$0</b> &nbsp;·&nbsp; <span data-f="units" class="muted">0.0u</span> &nbsp;·&nbsp; EV <span data-f="ev" class="muted">0%</span></span>
      </div>
    </div>`;

  // wire inputs
  card.querySelectorAll('[data-i]').forEach(el=>{
    el.addEventListener('input',()=>{ mirrorSpreads(card,el); persistCard(card); compute(card); });
  });
  return card;
}

function ffRow(label, av, hv, higherGood, fmt){
  const f = fmt || (v=>pct(v));
  const aBetter = higherGood ? av>hv : av<hv;
  const aCls = aBetter?'pos':'', hCls = !aBetter?'pos':'';
  const aTxt = fmt? fmt(av,av,'a') : pct(av);
  const hTxt = fmt? fmt(hv,hv,'h') : pct(hv);
  return `<div class="lab">${label}</div><div class="v edge ${aCls}">${aTxt}</div><div class="v edge ${hCls}">${hTxt}</div>`;
}
function restSelect(key,val){
  const opts=[['rested','Rested'],['normal','Normal'],['3in4','3-in-4'],['b2b','B2B']];
  return `<select data-i="${key}">${opts.map(o=>`<option value="${o[0]}" ${o[0]===val?'selected':''}>${o[1]}</option>`).join('')}</select>`;
}
function mirrorSpreads(card,el){ // keep away/home spreads mirrored
  const k=el.dataset.i, v=parseFloat(el.value);
  if(isNaN(v)) return;
  const set=(name,val)=>{ const t=card.querySelector(`[data-i="${name}"]`); if(t&&document.activeElement!==t) t.value=(val>0?`+${val}`:`${val}`); };
  if(k==='bookHome') set('bookAway',-v);
  if(k==='bookAway') set('bookHome',-v);
  if(k==='sharpHome') set('sharpAway',-v);
  if(k==='sharpAway') set('sharpHome',-v);
}
function persistCard(card){
  const o={}; card.querySelectorAll('[data-i]').forEach(el=>o[el.dataset.i]=el.value);
  LS.set(`wnba_odds_${card.dataset.iso}_${card.dataset.gid}`,o);
}

/* ---------------- the model ---------------- */
function recomputeAll(){ document.querySelectorAll('.card').forEach(compute); }

function compute(card){
  const hr=teamRec(card.dataset.home), ar=teamRec(card.dataset.away);
  const g=sel=>card.querySelector(`[data-f="${sel}"]`);
  const inp=name=>card.querySelector(`[data-i="${name}"]`);
  const num=name=>{ const v=parseFloat(inp(name)?.value); return isNaN(v)?null:v; };
  if(!hr||!ar){ g('side').textContent='no rating for one team'; return; }

  // base projected home margin
  const injH=num('injHome')||0, injA=num('injAway')||0;
  const restH=REST_PTS[inp('restHome')?.value]||0, restA=REST_PTS[inp('restAway')?.value]||0;
  let M = (hr.power - ar.power) + CFG.homeCourt - injH + injA + (restH - restA);

  // sharp blend (tempers model overconfidence)
  const w = clamp((+sharpWEl.value)/100,0,1); // weight ON SHARP
  const sharpHome = num('sharpHome');
  let projMargin = M;
  if(sharpHome!=null){ const sharpMargin=-sharpHome; projMargin = (1-w)*M + w*sharpMargin; }

  const sd=CFG.marginSD;
  g('modelLine').textContent = fmtSpread(-M);
  g('projMargin').textContent= (M>0?`${hr.short} by ${M.toFixed(1)}`:`${ar.short} by ${(-M).toFixed(1)}`);
  g('blendLine').textContent = sharpHome!=null? fmtSpread(-projMargin) : '—';

  // book lines
  const bookHome=num('bookHome');
  if(bookHome==null){ // no line yet
    g('side').textContent='enter a book line'; g('pill').className='pill pass'; g('pill').textContent='—';
    ['fair','winp','edge','spv'].forEach(k=>g(k).textContent='–');
    g('stake').textContent='$0'; g('units').textContent='0.0u'; g('ev').textContent='0%';
    return;
  }
  const bookAway = num('bookAway') ?? -bookHome;
  const priceHome=num('priceHome') ?? -110, priceAway=num('priceAway') ?? -110;

  // cover probs at the book line, using blended margin
  const lineHomeMustWinBy = -bookHome;              // home covers if margin > this
  const pHome = 1-normCdf((lineHomeMustWinBy - projMargin)/sd);
  const pAway = 1-pHome;

  // no-vig market probs from the two prices
  const ipH=americanToProb(priceHome), ipA=americanToProb(priceAway);
  const sum=ipH+ipA; const nvH=ipH/sum, nvA=ipA/sum;

  // choose model's side
  const homeSide = pHome>=pAway;
  const p   = homeSide?pHome:pAway;
  const nv  = homeSide?nvH:nvA;
  const price = homeSide?priceHome:priceAway;
  const sideAbbr = homeSide?card.dataset.home:card.dataset.away;
  const sideSpread = homeSide?bookHome:bookAway;
  // points of edge: home cushion = projMargin - (number home must win by) = projMargin + bookHome
  const valueHome = projMargin + bookHome;
  const valuePts = homeSide ? valueHome : -valueHome;

  const dec=americanToDecimal(price), b=dec-1;
  const edge = p - nv;                       // probability edge vs no-vig market
  const ev = p*b - (1-p);                    // per $1
  let kf=(b*p-(1-p))/b; kf=Math.max(0,kf);   // full Kelly fraction of bankroll
  const kelly = kf * (+kellyEl.value);
  const bankroll=+bankrollEl.value||0;
  const stake = kelly*bankroll;
  const unitDollar = bankroll*((+unitEl.value||1)/100);
  const units = unitDollar>0? stake/unitDollar : 0;

  g('side').textContent = `${sideAbbr} ${fmtSpread(sideSpread)} (${fmtOdds(price)})`;
  g('fair').textContent = fmtOdds(probToAmerican(p));
  g('winp').textContent = pct(p);
  g('edge').textContent = (edge>=0?'+':'')+(edge*100).toFixed(1)+'%';
  g('edge').className='vv '+(edge>0?'pos':'neg');
  g('spv').textContent  = (valuePts>=0?'+':'')+valuePts.toFixed(1);
  g('spv').className='vv '+(valuePts>0?'pos':'neg');
  g('stake').textContent= '$'+stake.toFixed(0);
  g('units').textContent= units.toFixed(1)+'u';
  g('ev').textContent   = (ev>=0?'+':'')+(ev*100).toFixed(1)+'%';
  g('ev').className = 'muted '+(ev>0?'pos':'neg');

  // verdict
  const edgeMin=(+edgeMinEl.value||3)/100;
  const pill=g('pill');
  if(edge>=edgeMin && ev>0){ pill.className='pill bet'; pill.textContent='BET'; card.classList.add('rec'); }
  else if(edge>=edgeMin/2 && ev>0){ pill.className='pill lean'; pill.textContent='LEAN'; card.classList.remove('rec'); }
  else { pill.className='pill pass'; pill.textContent='PASS'; card.classList.remove('rec'); }
}
