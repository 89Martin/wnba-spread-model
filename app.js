/* ==========================================================================
   WNBA Matchup Bet Card  —  client logic
   - Ratings (Four Factors / power) come from data/ratings.json (refresh.ps1)
   - Schedule, logos, colors, reference line come live from ESPN
   - You enter best-offer + sharp lines (both sides); the app shows your
     MODEL edge vs the SHARP-validated (de-vigged) edge, and sizes the bet on
     a model/sharp blend you control with the "Model trust" slider.
   ========================================================================== */

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard";
let RATINGS = null;
let CFG = { homeCourt: 2.0, marginSD: 12.6 };

/* ---------------- math helpers ---------------- */
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
function normCdf(z){ // Φ
  const t = 1/(1+0.2316419*Math.abs(z));
  const d = 0.3989423*Math.exp(-z*z/2);
  let p = d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
  return z>0 ? 1-p : p;
}
function invNorm(p){ // Φ⁻¹ (Acklam)
  if(p<=0) return -1e9; if(p>=1) return 1e9;
  const a=[-3.969683028665376e1,2.209460984245205e2,-2.759285104469687e2,1.383577518672690e2,-3.066479806614716e1,2.506628277459239e0];
  const b=[-5.447609879822406e1,1.615858368580409e2,-1.556989798598866e2,6.680131188771972e1,-1.328068155288572e1];
  const c=[-7.784894002430293e-3,-3.223964580411365e-1,-2.400758277161838e0,-2.549732539343734e0,4.374664141464968e0,2.938163982698783e0];
  const d=[7.784695709041462e-3,3.224671290700398e-1,2.445134137142996e0,3.754408661907416e0];
  const pl=0.02425, ph=1-pl; let q,r;
  if(p<pl){ q=Math.sqrt(-2*Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if(p<=ph){ q=p-0.5; r=q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  q=Math.sqrt(-2*Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
const americanToDecimal = a => a>0 ? 1+a/100 : 1+100/(-a);
const americanToProb    = a => a>0 ? 100/(a+100) : (-a)/((-a)+100);
function probToAmerican(p){ p=clamp(p,0.0001,0.9999); return p>=0.5 ? Math.round(-100*p/(1-p)) : Math.round(100*(1-p)/p); }
const fmtOdds = a => (a>0?`+${a}`:`${a}`);
const fmtSpread = s => (s>0?`+${s.toFixed(1)}`:s.toFixed(1));
const pct = x => `${(x*100).toFixed(1)}%`;
const sgn = x => (x>=0?'+':'')+x.toFixed(1);
const sgnp = x => (x>=0?'+':'')+(x*100).toFixed(1)+'%';
const REST_PTS = { rested:+0.7, normal:0, b2b:-1.7, "3in4":-1.0 };

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
  if(s.trust!=null)    trustEl.value=s.trust;
  if(s.edgeMin!=null)  edgeMinEl.value=s.edgeMin;
}
function saveSettings(){
  LS.set('wnba_settings',{bankroll:+bankrollEl.value,kelly:kellyEl.value,
    unit:+unitEl.value,trust:+trustEl.value,edgeMin:+edgeMinEl.value});
}

/* ---------------- DOM ---------------- */
const $=id=>document.getElementById(id);
const slate=$('slate'), datePicker=$('datePicker'), metaEl=$('ratingsMeta'), footEl=$('footMeta');
const bankrollEl=$('bankroll'), kellyEl=$('kellyFrac'), unitEl=$('unitPct'),
      trustEl=$('trustW'), trustValEl=$('trustWVal'), edgeMinEl=$('edgeMin');

/* ---------------- boot ---------------- */
(async function init(){
  try{
    RATINGS = await (await fetch('data/ratings.json',{cache:'no-store'})).json();
    CFG.homeCourt = RATINGS.homeCourt ?? 2.0;
    CFG.marginSD  = RATINGS.marginSD ?? 12.6;
    metaEl.textContent = `Ratings as of ${RATINGS.asOf} · ${RATINGS.season} season · HCA ${CFG.homeCourt} · σ ${CFG.marginSD}`;
  }catch(e){ metaEl.textContent = '⚠ could not load data/ratings.json — run refresh.ps1'; }
  loadSettings();
  const url=new URL(location.href);
  datePicker.value = url.searchParams.get('d') || todayISO();
  trustValEl.textContent = trustEl.value+'%';

  datePicker.addEventListener('change', ()=>{ syncUrl(); loadSlate(); });
  $('refreshBtn').addEventListener('click', loadSlate);
  [bankrollEl,kellyEl,unitEl,edgeMinEl].forEach(el=>el.addEventListener('input',()=>{saveSettings();recomputeAll();}));
  trustEl.addEventListener('input',()=>{trustValEl.textContent=trustEl.value+'%';saveSettings();recomputeAll();});

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
function sameLocalDay(isoTs, dayISO){ const d=new Date(isoTs); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10)===dayISO; }
async function buildRestMap(iso){
  const map={}; const base=new Date(iso+'T12:00:00');
  for(let back=1;back<=3;back++){
    const d=new Date(base); d.setDate(d.getDate()-back); const ds=d.toISOString().slice(0,10);
    try{ const data=await (await fetch(`${ESPN}?dates=${espnDate(ds)}&limit=100`)).json();
      (data.events||[]).forEach(e=>{ if(!sameLocalDay(e.date,ds)) return;
        e.competitions[0].competitors.forEach(c=>{ const ab=c.team.abbreviation; if(map[ab]==null) map[ab]=back; }); });
    }catch{}
  }
  return map;
}
function restState(d){ if(d==null) return 'rested'; if(d<=1) return 'b2b'; if(d===2) return '3in4'; return 'rested'; }

/* ---------------- reference line ---------------- */
function parseEspnLine(ev, homeAbbr){
  try{ const o=ev.competitions[0].odds?.[0]; if(!o) return {};
    let homeSpread=null;
    if(o.details){ const m=o.details.trim().match(/^([A-Z]{2,4})\s+(-?\d+(\.\d+)?)/); if(m){ const fav=m[1],num=parseFloat(m[2]); homeSpread=(fav===homeAbbr)?num:-num; } }
    if(homeSpread==null && typeof o.spread==='number') homeSpread=o.spread;
    return { homeSpread };
  }catch{ return {}; }
}
function teamRec(abbr){ return RATINGS?.teams?.[abbr] || null; }

/* ---------------- card rendering ---------------- */
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
  const homec=(hr?.color)||'#26304a', awayc=(ar?.color)||'#26304a';
  const logoH=(hr?.logo)||home.team.logo, logoA=(ar?.logo)||away.team.logo;

  const card=document.createElement('div');
  card.className='card'; card.dataset.gid=gid; card.dataset.iso=iso; card.dataset.home=ha; card.dataset.away=aa;
  card.style.setProperty('--homec',homec); card.style.setProperty('--awayc',awayc);

  const ff = hr&&ar ? `
    <div class="factors">
      <div class="h"></div><div class="h">${aa}</div><div class="h">${ha}</div>
      ${ffRow('eFG%', ar.efg, hr.efg, true)}
      ${ffRow('TOV%', ar.tovPct, hr.tovPct, false)}
      ${ffRow('OREB%',ar.orebPct,hr.orebPct, true)}
      ${ffRow('Pace', ar.pace/100, hr.pace/100, true)}
      ${ffRaw('Net/100', ar.netRtg, hr.netRtg)}
    </div>`:'';

  card.innerHTML=`
    <div class="matchup">
      <div class="statusbadge">${status}</div>
      <div class="team">
        <img src="${logoA||''}" alt="${aa}" onerror="this.style.visibility='hidden'"/>
        <div class="nm">${away.team.shortDisplayName}</div><div class="pw">pwr ${ar?ar.power.toFixed(1):'–'}</div>
      </div>
      <div class="vs"><span class="at">@</span><span class="time">${tip}</span></div>
      <div class="team">
        <img src="${logoH||''}" alt="${ha}" onerror="this.style.visibility='hidden'"/>
        <div class="nm">${home.team.shortDisplayName}</div><div class="pw">pwr ${hr?hr.power.toFixed(1):'–'}</div>
      </div>
    </div>

    <div class="modelstrip">
      <div class="m"><span class="muted">Model line</span><b data-f="modelLine">–</b></div>
      <div class="m"><span class="muted">Proj margin</span><b data-f="projMargin">–</b></div>
      <div class="m"><span class="muted">Sharp line</span><b data-f="sharpLine">–</b></div>
    </div>
    ${ff}

    <div class="entry">
      <div class="row"><span class="rl"></span><span class="colh">${aa} (away)</span><span class="colh">${ha} (home)</span></div>
      <div class="row">
        <span class="rl">Offer spr</span>
        <input data-i="bookAway" inputmode="decimal" placeholder="+/-" value="${saved.bookAway ?? (ref.homeSpread!=null?(-ref.homeSpread):'')}">
        <input data-i="bookHome" inputmode="decimal" placeholder="+/-" value="${saved.bookHome ?? (ref.homeSpread ?? '')}">
      </div>
      <div class="row">
        <span class="rl">Offer price</span>
        <input data-i="priceAway" inputmode="numeric" placeholder="-110" value="${saved.priceAway ?? -110}">
        <input data-i="priceHome" inputmode="numeric" placeholder="-110" value="${saved.priceHome ?? -110}">
      </div>
      <div class="row sharp">
        <span class="rl">Sharp price</span>
        <input data-i="sPriceAway" inputmode="numeric" placeholder="-110" value="${saved.sPriceAway ?? ''}">
        <input data-i="sPriceHome" inputmode="numeric" placeholder="-110" value="${saved.sPriceHome ?? ''}">
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
      <div class="fairline" data-f="note"></div>
      <div class="metrics">
        <div class="b"><div class="k">Model edge</div><div class="vv" data-f="medge">–</div></div>
        <div class="b sharpb"><div class="k">Sharp edge</div><div class="vv" data-f="sedge">–</div></div>
        <div class="b"><div class="k">Mkt pts</div><div class="vv" data-f="mkt">–</div></div>
        <div class="b"><div class="k">Bet win%</div><div class="vv" data-f="winp">–</div></div>
      </div>
      <div class="stake">
        <span class="muted">Stake</span>
        <span><b data-f="stake">$0</b> &nbsp;·&nbsp; <span data-f="units" class="muted">0.0u</span> &nbsp;·&nbsp; EV <span data-f="ev" class="muted">0%</span></span>
      </div>
    </div>`;

  card.querySelectorAll('[data-i]').forEach(el=>el.addEventListener('input',()=>{ mirrorSpreads(card,el); persistCard(card); compute(card); }));
  return card;
}

function ffRow(label, av, hv, higherGood){
  const aBetter = higherGood ? av>hv : av<hv;
  return `<div class="lab">${label}</div><div class="v edge ${aBetter?'pos':''}">${pct(av)}</div><div class="v edge ${!aBetter?'pos':''}">${pct(hv)}</div>`;
}
function ffRaw(label, av, hv){
  const aBetter = av>hv;
  return `<div class="lab">${label}</div><div class="v edge ${aBetter?'pos':''}">${av.toFixed(1)}</div><div class="v edge ${!aBetter?'pos':''}">${hv.toFixed(1)}</div>`;
}
function restSelect(key,val){
  const opts=[['rested','Rested'],['normal','Normal'],['3in4','3-in-4'],['b2b','B2B']];
  return `<select data-i="${key}">${opts.map(o=>`<option value="${o[0]}" ${o[0]===val?'selected':''}>${o[1]}</option>`).join('')}</select>`;
}
function mirrorSpreads(card,el){
  const k=el.dataset.i, v=parseFloat(el.value); if(isNaN(v)) return;
  const set=(name,val)=>{ const t=card.querySelector(`[data-i="${name}"]`); if(t&&document.activeElement!==t) t.value=(val>0?`+${val}`:`${val}`); };
  if(k==='bookHome') set('bookAway',-v);  if(k==='bookAway') set('bookHome',-v);
}
function persistCard(card){ const o={}; card.querySelectorAll('[data-i]').forEach(el=>o[el.dataset.i]=el.value); LS.set(`wnba_odds_${card.dataset.iso}_${card.dataset.gid}`,o); }

/* ---------------- the model ---------------- */
function recomputeAll(){ document.querySelectorAll('.card').forEach(compute); }

// cover prob of a side given expected home margin mu.  home: win if margin > -number; away: win if margin < number
const coverProb = (mu, number, isHome, sd) => isHome ? 1-normCdf((-number-mu)/sd) : normCdf((number-mu)/sd);

function compute(card){
  const hr=teamRec(card.dataset.home), ar=teamRec(card.dataset.away);
  const g=s=>card.querySelector(`[data-f="${s}"]`);
  const inp=n=>card.querySelector(`[data-i="${n}"]`);
  const num=n=>{ const v=parseFloat(inp(n)?.value); return isNaN(v)?null:v; };
  const clearOut=msg=>{ g('side').textContent=msg; g('pill').className='pill pass'; g('pill').textContent='—';
    ['medge','sedge','mkt','winp'].forEach(k=>g(k).textContent='–'); g('note').textContent='';
    g('stake').textContent='$0'; g('units').textContent='0.0u'; g('ev').textContent='0%'; };
  if(!hr||!ar){ clearOut('no rating for one team'); return; }
  const sd=CFG.marginSD;

  // ---- model expected home margin ----
  const injH=num('injHome')||0, injA=num('injAway')||0;
  const restH=REST_PTS[inp('restHome')?.value]||0, restA=REST_PTS[inp('restAway')?.value]||0;
  const muModel = (hr.power-ar.power) + CFG.homeCourt - injH + injA + (restH-restA);
  g('modelLine').textContent = fmtSpread(-muModel);
  g('projMargin').textContent = muModel>0?`${hr.short} by ${muModel.toFixed(1)}`:`${ar.short} by ${(-muModel).toFixed(1)}`;

  // ---- need an offer line to evaluate ----
  const bookHome=num('bookHome');
  if(bookHome==null){ clearOut('enter an offer line'); g('sharpLine').textContent='—'; return; }
  const bookAway = num('bookAway') ?? -bookHome;
  const priceH=num('priceHome') ?? -110, priceA=num('priceAway') ?? -110;
  const trust=clamp((+trustEl.value)/100,0,1);     // weight on the MODEL

  // ---- sharp true line: de-vig the two sharp prices AT your offer line ----
  const sPriceH=num('sPriceHome'), sPriceA=num('sPriceAway');
  let muSharp=null;
  if(sPriceH!=null && sPriceA!=null){
    const ipH=americanToProb(sPriceH), ipA=americanToProb(sPriceA);
    const nvH=ipH/(ipH+ipA);                       // de-vigged sharp prob HOME covers the offer line
    muSharp = -bookHome + sd*invNorm(nvH);          // implied true home margin
    g('sharpLine').textContent = fmtSpread(-muSharp);
  } else { g('sharpLine').textContent='—'; }

  // evaluate both sides
  const sides=[
    {abbr:card.dataset.home, isHome:true,  number:bookHome, price:priceH},
    {abbr:card.dataset.away, isHome:false, number:bookAway, price:priceA}
  ].map(s=>{
    const be=americanToProb(s.price);
    const pModel=coverProb(muModel,s.number,s.isHome,sd);
    const pSharp=muSharp!=null?coverProb(muSharp,s.number,s.isHome,sd):null;
    const pBet=pSharp!=null?(trust*pModel+(1-trust)*pSharp):pModel;
    const mkt=muSharp!=null?(s.isHome? s.number+muSharp : s.number-muSharp):null;
    return {...s, be, pModel, pSharp, pBet,
      mEdge:pModel-be, sEdge:(pSharp!=null?pSharp-be:null), betEdge:pBet-be, mkt};
  });

  // pick the side with the best size-able edge
  const pick = sides.reduce((a,b)=>b.betEdge>a.betEdge?b:a);
  const dec=americanToDecimal(pick.price), b=dec-1;
  const ev=pick.pBet*b-(1-pick.pBet);
  let kf=Math.max(0,(b*pick.pBet-(1-pick.pBet))/b)*(+kellyEl.value);
  const bankroll=+bankrollEl.value||0;
  const stake=kf*bankroll;
  const unitDollar=bankroll*((+unitEl.value||1)/100);
  const units=unitDollar>0?stake/unitDollar:0;

  g('side').textContent=`${pick.abbr} ${fmtSpread(pick.number)} (${fmtOdds(pick.price)})`;
  g('medge').textContent=sgnp(pick.mEdge); g('medge').className='vv '+(pick.mEdge>0?'pos':'neg');
  if(pick.sEdge!=null){ g('sedge').textContent=sgnp(pick.sEdge); g('sedge').className='vv '+(pick.sEdge>0?'pos':'neg'); }
  else { g('sedge').textContent='—'; g('sedge').className='vv muted'; }
  g('mkt').textContent = pick.mkt!=null? sgn(pick.mkt) : '—';
  g('mkt').className='vv '+(pick.mkt>0?'pos':(pick.mkt<0?'neg':'muted'));
  g('winp').textContent=pct(pick.pBet);
  g('stake').textContent='$'+stake.toFixed(0);
  g('units').textContent=units.toFixed(1)+'u';
  g('ev').textContent=sgnp(ev); g('ev').className='muted '+(ev>0?'pos':'neg');

  // fair-odds line: model fair vs sharp fair vs the price you get
  const noteBits=[`Model fair <b>${fmtOdds(probToAmerican(pick.pModel))}</b>`];
  if(pick.pSharp!=null) noteBits.push(`Sharp fair <b>${fmtOdds(probToAmerican(pick.pSharp))}</b>`);
  noteBits.push(`you get <b>${fmtOdds(pick.price)}</b>`);
  g('note').innerHTML=noteBits.join(' · ');

  // verdict keyed off the SIZE-able edge (sharp-validated when sharp present)
  const edgeMin=(+edgeMinEl.value||3)/100;
  const pill=g('pill'); card.classList.remove('rec');
  const overconf = pick.sEdge!=null && (pick.mEdge-pick.sEdge)>=0.04;
  if(pick.betEdge>=edgeMin && ev>0){ pill.className='pill bet'; pill.textContent='BET'; card.classList.add('rec'); }
  else if(pick.betEdge>=edgeMin/2 && ev>0){ pill.className='pill lean'; pill.textContent='LEAN'; }
  else { pill.className='pill pass'; pill.textContent='PASS'; }
  if(overconf && pick.betEdge>0) g('note').innerHTML += ` &nbsp;<span class="warnflag">⚠ model hot vs sharp</span>`;
}
