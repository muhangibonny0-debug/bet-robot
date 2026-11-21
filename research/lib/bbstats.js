'use strict';
// BangBet match statistics reader: inspect the main document, embedded frames and open shadow roots.
const fs = require('fs');
const path = require('path');
const { sleep, norm, keyTok } = require('./util');
const OUT = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
let savedFailure = 0;

const TEXT_JS = () => {
  const parts = [];
  const visit = (n) => {
    if (!n) return;
    if (n.nodeType === 3) { const t = (n.nodeValue || '').trim(); if (t) parts.push(t); return; }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    if (['SCRIPT','STYLE','NOSCRIPT'].includes(n.nodeName)) return;
    if (n.shadowRoot) visit(n.shadowRoot);
    for (const c of n.childNodes) visit(c);
  };
  visit(document.body);
  return { visible: document.body ? document.body.innerText : '', deep: parts.join('\n') };
};
const MARK = () => {
  document.querySelectorAll('[data-bbstats]').forEach(e => e.removeAttribute('data-bbstats'));
  const nodes = [...document.querySelectorAll('button,a,div,span,li,p')].filter(e => {
    const t = (e.innerText || '').trim().toLowerCase();
    const r = e.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.top < 750 && ['stats','statistics','stats new'].includes(t);
  }).sort((a,b) => (a.innerText || '').length - (b.innerText || '').length);
  if (!nodes.length) return false;
  nodes[0].setAttribute('data-bbstats','1');
  return true;
};
async function readFrames(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(TEXT_JS);
      out.push({ url: frame.url(), visible: t.visible || '', deep: t.deep || '' });
    } catch (_) {}
  }
  return out;
}
function best(frames) {
  let pick = { score: -1, text: '', where: '' };
  for (const f of frames) for (const field of ['visible','deep']) {
    const text = f[field];
    const hits = (text.match(/previous meetings|win probability|last matches|team averages|team stats|h2h/gi) || []).length;
    if (hits > pick.score || (hits === pick.score && hits > 0 && text.length > pick.text.length))
      pick = { score: hits, text, where: f.url + '#' + field };
  }
  return pick;
}
function parse(text, ev) {
  const lines = String(text || '').replace(/\r/g,'').split('\n').map(x => x.trim()).filter(Boolean);
  const upper = lines.map(x => x.toUpperCase());
  const at = re => upper.findIndex(x => re.test(x));
  const st = { available:false, source:'bangbet-embedded', homeForm:'', awayForm:'', h2h:null, pct:[], probs:null, avg:{}, missing:[] };
  const wp = at(/WIN PROBABILITY/);
  if (wp >= 0) {
    const vals = [];
    for (const line of lines.slice(wp+1, wp+15)) {
      const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(line);
      if (m) vals.push(+m[1]);
      if (vals.length === 3) break;
    }
    if (vals.length === 3 && vals.reduce((a,b)=>a+b,0) > 90) {
      const sum = vals.reduce((a,b)=>a+b,0);
      st.probs = { H:vals[0]/sum, X:vals[1]/sum, A:vals[2]/sum };
    }
  }
  const pm = at(/^PREVIOUS MEETINGS/);
  if (pm >= 0) {
    const nums = [];
    for (const line of lines.slice(pm+1, pm+13)) {
      const m = /^(\d+)(?:\s+(?:WINS?|DRAWS?))?$/i.exec(line);
      if (m) nums.push(+m[1]);
      if (nums.length === 3) break;
    }
    if (nums.length === 3 && nums.reduce((a,b)=>a+b,0))
      st.h2h = { n:nums.reduce((a,b)=>a+b,0), H:nums[0], X:nums[1], A:nums[2] };
  }
  const ta = at(/TEAM AVERAGES/);
  if (ta >= 0) {
    for (let i=ta+1;i<Math.min(lines.length,ta+70);i++) {
      const label = upper[i];
      if (/^(WIN PROBABILITY|PREVIOUS MEETINGS|LAST MATCHES|TEAM STATS)/.test(label)) break;
      if (!/^(GOALS SCORED|GOALS CONCEDED|TOTAL GOALS|BTTS|OVER \d+(?:\.\d+)?|UNDER \d+(?:\.\d+)?|TOTAL CARDS|CORNERS|CLEAN SHEETS?)$/.test(label)) continue;
      const v = lines.slice(i+1,i+5).find(x => /^-?\d+(?:\.\d+)?\s*%?$/.test(x));
      if (v != null) st.avg[label.toLowerCase()] = parseFloat(v);
    }
  }
  const blocks = [];
  for (let i=0;i<upper.length;i++) if (/^LAST MATCHES/.test(upper[i])) {
    const next = upper.findIndex((x,j)=>j>i && (/^LAST MATCHES/.test(x)||/^TEAM STATS/.test(x)));
    const segment = lines.slice(i+1,next<0?lines.length:next);
    const forms = segment.join(' ').match(/(?:OVERALL|HOME|AWAY)?\s*((?:[WDL]\s*){3,10})/gi) || [];
    const form = forms.map(x=>x.replace(/[^WDL]/gi,'').toUpperCase()).find(x=>x.length>=3) || '';
    const header = lines.slice(Math.max(0,i-8),i).join(' ');
    blocks.push({ header, form });
    if (blocks.length===2) break;
  }
  if (blocks.length) {
    let h=blocks[0], a=blocks[1] || null;
    const has=(v,n)=>norm(v).includes(keyTok(n));
    if (a && ((has(h.header,ev.away)&&!has(h.header,ev.home)) || (has(a.header,ev.home)&&!has(a.header,ev.away)))) [h,a]=[a,h];
    st.homeForm=h.form.slice(0,5); st.awayForm=a ? a.form.slice(0,5) : '';
    st.teams={home:h,away:a};
  }
  st.available=!!(st.homeForm&&st.awayForm)||!!st.probs||!!st.h2h||Object.keys(st.avg).length>0;
  if (!st.probs) st.missing.push('win probability');
  if (!st.h2h) st.missing.push('previous meetings');
  if (!st.homeForm||!st.awayForm) st.missing.push('recent form');
  return st;
}
async function stats(page, ev, legacy) {
  let clicked=false;
  for(let i=0;i<2&&!clicked;i++){
    const marked=await page.evaluate(MARK).catch(()=>false);
    if(marked) clicked=await page.locator('[data-bbstats="1"]').first().click({timeout:4000}).then(()=>true).catch(()=>false);
    if(!clicked) await sleep(900);
  }
  let frames=[], pick={score:-1,text:'',where:''};
  for(let i=0;i<8;i++){
    await sleep(i===0?1800:1200);
    frames=await readFrames(page); pick=best(frames);
    if(pick.score>=2) break;
    if(i===3) await page.getByText(/^h2h$/i).first().click({timeout:1500}).catch(()=>{});
    await page.evaluate(()=>window.scrollBy(0,Math.round(innerHeight*.75))).catch(()=>{});
  }
  let st=parse(pick.text,ev);
  if(!st.available&&legacy){ try { const old=legacy(pick.text,ev); if(old&&old.available) st={...old,source:'legacy'}; } catch(_){} }
  st.tab=clicked; st.where=pick.where;
  st.frames=frames.map(f=>f.url.slice(0,100)+' visible='+f.visible.length+' deep='+f.deep.length).slice(0,8);
  st.raw=pick.text.slice(0,1800);
  if(!st.available&&savedFailure<3){
    savedFailure++;
    fs.writeFileSync(path.join(OUT,'stats_fail_'+savedFailure+'.txt'),
      ['match: '+ev.home+' v '+ev.away,'url: '+page.url(),'tab clicked: '+clicked,...st.frames,'',pick.text.slice(0,6000)].join('\n'));
    await page.screenshot({path:path.join(OUT,'stats_fail_'+savedFailure+'.png')}).catch(()=>{});
  } else if(st.available&&!fs.existsSync(path.join(OUT,'stats_ok_sample.txt'))){
    fs.writeFileSync(path.join(OUT,'stats_ok_sample.txt'),JSON.stringify({...st,raw:undefined},null,2)+'\n'+pick.text.slice(0,5000));
  }
  return st;
}
module.exports={stats,parse};
