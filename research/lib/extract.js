'use strict';
// statistics and markets of one opened match. Nothing is invented: what is not shown is recorded as missing.
const { sleep, norm, sameTeam, walk } = require('./util');

const STAT_TAB = /^(stats?|statistics|h2h|head ?to ?head|analysis|form|match stats?)$/i;
const MKT_TAB = /^(markets?|all markets|odds|betting|all)$/i;

const clickFirst = async (page, re) => {
  const loc = page.getByText(re);
  const n = Math.min(await loc.count().catch(() => 0), 6);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 2500 }).catch(() => {}); return true; }
  }
  return false;
};

function parseStatsText(text, ev) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = { available: false, homeForm: '', awayForm: '', h2h: null, pct: [], probs: null, goals: null };
  const runs = [];
  let run = '';
  for (const l of lines) {
    const compact = l.replace(/\s+/g, '');
    if (/^[WDL]{1,10}$/i.test(compact) && (l.length <= 1 || /^([WDL]\s?)+$/i.test(l))) run += compact.toUpperCase();
    else { if (run.length >= 3) runs.push(run.slice(-10)); run = ''; }
  }
  if (run.length >= 3) runs.push(run.slice(-10));
  // the first run is read as the home team, the second as the away team
  if (runs[0]) out.homeForm = runs[0].slice(-5);
  if (runs[1]) out.awayForm = runs[1].slice(-5);

  lines.forEach((l, i) => {
    const vals = [...l.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => parseFloat(m[1]));
    if (!vals.length) return;
    let label = l.replace(/(\d+(?:\.\d+)?)\s*%/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/[A-Za-z]{2,}/.test(label)) label = (lines[i - 1] || '') + ' ' + (lines[i + 1] || '');
    out.pct.push({ label: label.trim().slice(0, 60), vals });
  });
  const pr = (re) => { const e = out.pct.find((p) => re.test(norm(p.label))); return e ? e.vals[0] : null; };
  const ph = pr(/^(home|1)( win)?$/), pd = pr(/^(draw|x)$/), pa = pr(/^(away|2)( win)?$/);
  if (ph != null && pa != null) out.probs = { H: ph / 100, X: pd != null ? pd / 100 : 0, A: pa / 100 };

  const joined = lines.join(' ');
  const g1 = /goals?\s*scored[^\d]{0,20}(\d+(?:\.\d+)?)[^\d]{1,25}(\d+(?:\.\d+)?)/i.exec(joined);
  const g2 = /goals?\s*conceded[^\d]{0,20}(\d+(?:\.\d+)?)[^\d]{1,25}(\d+(?:\.\d+)?)/i.exec(joined);
  if (g1 && g2) out.goals = { hFor: +g1[1], aFor: +g1[2], hAg: +g2[1], aAg: +g2[2] };

  // head-to-head: score lines after the heading that name both teams
  const at = lines.findIndex((l) => /head.?to.?head|h2h/i.test(l));
  if (at >= 0) {
    const h = { n: 0, H: 0, X: 0, A: 0 };
    const hk = norm(ev.home).split(' ').filter((w) => w.length > 3)[0] || norm(ev.home);
    const ak = norm(ev.away).split(' ').filter((w) => w.length > 3)[0] || norm(ev.away);
    for (const l of lines.slice(at + 1, at + 40)) {
      const m = /(\d+)\s*[-:]\s*(\d+)/.exec(l);
      if (!m) continue;
      const t = norm(l.slice(0, m.index) + ' ' + l.slice(m.index + m[0].length));
      const ih = t.indexOf(hk), ia = t.indexOf(ak);
      if (ih < 0 || ia < 0) continue;
      const first = ih < ia ? +m[1] : +m[2];
      const second = ih < ia ? +m[2] : +m[1];
      h.n++;
      if (first > second) h.H++; else if (first < second) h.A++; else h.X++;
    }
    if (h.n) out.h2h = h;
  }
  out.available = !!(out.homeForm && out.awayForm) || out.pct.length > 0 || !!out.h2h;
  return out;
}

// results found in the site's own JSON: recent matches of each team and meetings between them
function mergeJson(st, bodies, ev) {
  const rec = [];
  for (const b of bodies) {
    walk(b, (o) => {
      const ks = Object.keys(o);
      const kH = ks.find((k) => /^(home|hometeam|home_team|homename|hometeamname)$/i.test(k));
      const kA = ks.find((k) => /^(away|awayteam|away_team|awayname|awayteamname)$/i.test(k));
      const sH = ks.find((k) => /^(homescore|home_score|hscore|homegoals)$/i.test(k));
      const sA = ks.find((k) => /^(awayscore|away_score|ascore|awaygoals)$/i.test(k));
      if (!kH || !kA || !sH || !sA) return;
      const nm = (v) => (typeof v === 'string' ? v : (v && (v.name || v.title)) || '');
      const d = ks.find((k) => /(date|time|start)/i.test(k));
      rec.push({ h: nm(o[kH]), a: nm(o[kA]), x: Number(o[sH]), y: Number(o[sA]), t: d ? Date.parse(o[d]) || 0 : 0 });
    });
  }
  if (!rec.length) return;
  rec.sort((p, q) => q.t - p.t);
  const letters = (team) => rec.filter((r) => sameTeam(r.h, team) || sameTeam(r.a, team)).slice(0, 5).map((r) => {
    const home = sameTeam(r.h, team);
    const gf = home ? r.x : r.y;
    const ga = home ? r.y : r.x;
    return gf > ga ? 'W' : (gf === ga ? 'D' : 'L');
  }).reverse().join('');
  if (!st.homeForm) st.homeForm = letters(ev.home);
  if (!st.awayForm) st.awayForm = letters(ev.away);
  if (!st.h2h) {
    const m = rec.filter((r) => (sameTeam(r.h, ev.home) && sameTeam(r.a, ev.away)) || (sameTeam(r.h, ev.away) && sameTeam(r.a, ev.home))).slice(0, 5);
    if (m.length) {
      const h = { n: m.length, H: 0, X: 0, A: 0 };
      for (const r of m) {
        const hh = sameTeam(r.h, ev.home);
        const gf = hh ? r.x : r.y;
        const ga = hh ? r.y : r.x;
        if (gf > ga) h.H++; else if (gf < ga) h.A++; else h.X++;
      }
      st.h2h = h;
    }
  }
  st.available = !!(st.homeForm && st.awayForm) || st.pct.length > 0 || !!st.h2h;
}

async function stats(page, ev) {
  const mark = page.net.length;
  const clicked = await clickFirst(page, STAT_TAB);
  await sleep(2200);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, innerHeight)).catch(() => {}); await sleep(500); }
  const text = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 9000)).catch(() => '');
  const st = parseStatsText(text, ev);
  mergeJson(st, page.net.slice(mark).map((r) => r.body), ev);
  st.tab = clicked;
  st.raw = text.slice(0, 1800);
  return st;
}

async function openMarkets(page) { await clickFirst(page, MKT_TAB); await sleep(1200); }

async function expandAll(page) {
  for (let r = 0; r < 3; r++) {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[aria-expanded="false"]')).slice(0, 80);
      els.forEach((e) => { try { e.click(); } catch (x) { /* ignore */ } });
    }).catch(() => {});
    await sleep(700);
  }
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 0.9))).catch(() => {}); await sleep(450); }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// every price on the page with the title of its market and its label; elements are tagged for clicking
const MKT_JS = () => {
  const priceRe = /^(.*?)(\d{1,3}\.\d{2})$/;
  const cells = [];
  for (const el of document.querySelectorAll('div,span,button,li,a')) {
    if (el.children.length > 3) continue;
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 70) continue;
    const m = t.match(priceRe);
    if (!m) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 24 || b.height < 18) continue;
    cells.push({ el, label: m[1].trim(), odds: parseFloat(m[2]), t });
  }
  const keep = cells.filter((c) => !cells.some((o) => o !== c && o.el.contains(c.el) && o.t === c.t));
  const out = [];
  keep.forEach((c, i) => {
    c.el.setAttribute('data-bb', String(i));
    let g = c.el.parentElement;
    let title = '';
    let gi = -1;
    for (let up = 0; g && up < 6; up++, g = g.parentElement) {
      const inside = keep.filter((o) => g.contains(o.el));
      if (inside.length >= 2 && inside.length <= 60) {
        const texts = new Set(inside.flatMap((o) => [o.t, o.label, String(o.odds)]));
        const line = (g.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)
          .find((s) => !texts.has(s) && !/^\d{1,3}\.\d{2}$/.test(s) && s.length < 80);
        if (line) { title = line; gi = inside.indexOf(c); break; }
      }
    }
    out.push({ i, title, label: c.label, odds: c.odds, pos: gi });
  });
  return out;
};

function marketsFromNet(net) {
  const out = [];
  for (const r of net) {
    walk(r.body, (o) => {
      const name = typeof (o.name || o.title || o.marketName) === 'string' ? (o.name || o.title || o.marketName) : '';
      const arr = o.outcomes || o.selections || o.options || o.odds;
      if (!name || !Array.isArray(arr) || arr.length < 2) return;
      for (const x of arr) {
        if (!x || typeof x !== 'object') continue;
        const label = x.name || x.label || x.title || '';
        const price = Number(x.odds || x.price || x.odd || x.value);
        if (typeof label === 'string' && price > 1 && price < 1000) out.push({ i: -1, title: name, label, odds: price, pos: -1 });
      }
    });
  }
  return out;
}

function classify(title, label, ev) {
  const t = norm(title);
  const l = norm(label);
  const side = () => {
    if (/^(1|home)$/.test(l)) return 'H';
    if (/^(2|away)$/.test(l)) return 'A';
    if (/^(x|draw)$/.test(l)) return 'X';
    if (sameTeam(label, ev.home) || (norm(ev.home) && l.includes(norm(ev.home)))) return 'H';
    if (sameTeam(label, ev.away) || (norm(ev.away) && l.includes(norm(ev.away)))) return 'A';
    return '';
  };
  const ouEarly = /(over|under)\\s*([0-9]+(?:\\.[0-9]+)?)/.exec(l);
  const tlEarly = /(over|under)/.test(l) ? /([0-9]+(?:\\.[0-9]+)?)/.exec(t) : null;
  const lineEarly = ouEarly ? parseFloat(ouEarly[2]) : (tlEarly ? parseFloat(tlEarly[1]) : null);
  const dirEarly = ouEarly ? ouEarly[1] : (/over/.test(l) ? 'over' : 'under');
  if (/(first half|1st half|half time|halftime)/.test(t) && lineEarly != null) return { type: 'HALF_OU', side: dirEarly === 'over' ? 'O' : 'U', line: lineEarly };
  if (/(corner|card|booking)/.test(t) && lineEarly != null) return { type: 'STAT_OU', stat: /(corner)/.test(t) ? 'corner' : 'card', side: dirEarly === 'over' ? 'O' : 'U', line: lineEarly };
  if (/(team total|team goals|home team goals|away team goals)/.test(t) && lineEarly != null) return { type: 'TEAM_OU', teamSide: /away team/.test(t) ? 'A' : 'H', side: dirEarly === 'over' ? 'O' : 'U', line: lineEarly };
  if (/to score/.test(t) && /^(yes|no)$/.test(l)) return { type: 'TEAM_SCORE', teamSide: /away/.test(t) ? 'A' : 'H', labelSide: l === 'no' ? 'N' : 'Y' };
  if (/win either half|to win a half|to win any half/.test(t)) return { type: 'WIN_HALF', side: side() };
  if (/(half|1st|2nd|first|second|corner|card|booking|penalt|offside|player|scorer|exact|correct|margin|handicap|quarter|set |inning|period)/.test(t)) return { type: 'OTHER' };
  if (/double chance/.test(t)) {
    const s = l.replace(/\s/g, '');
    return { type: 'DC', side: s === '1x' || /homeordraw/.test(s) ? '1X' : (s === 'x2' || /draworaway/.test(s) ? 'X2' : (s === '12' || /homeoraway/.test(s) ? '12' : '')) };
  }
  if (/draw no bet/.test(t)) return { type: 'DNB', side: side() };
  if (/(both teams to score|btts|gg ng)/.test(t)) return { type: 'BTTS', side: /^(yes|gg)$/.test(l) ? 'Y' : (/^(no|ng)$/.test(l) ? 'N' : '') };
  const ou = /(over|under)\s*([0-9]+(?:\.[0-9]+)?)/.exec(l);
  const tl = /(over|under)/.test(l) ? /([0-9]+(?:\.[0-9]+)?)/.exec(t) : null;
  if ((ou || tl) && /(total|over|under|goals|points|runs)/.test(t)) {
    const homeWord = norm(ev.home).split(' ').some((w) => w.length > 3 && t.includes(w));
    const awayWord = norm(ev.away).split(' ').some((w) => w.length > 3 && t.includes(w));
    if (homeWord || awayWord) return { type: 'OTHER' };
    const o = ou ? ou[1] : (/over/.test(l) ? 'over' : 'under');
    const line = ou ? parseFloat(ou[2]) : parseFloat(tl[1]);
    return { type: 'OU', side: o === 'over' ? 'O' : 'U', line };
  }
  if (/(1x2|match result|match winner|moneyline|full time result|to win|^result$|^winner$|^full time$|regular time)/.test(t)) return { type: 'WIN', side: side() };
  return { type: 'OTHER' };
}

async function markets(page, ev) {
  await openMarkets(page);
  await expandAll(page);
  const dom = await page.evaluate(MKT_JS).catch(() => []);
  let list = dom;
  // a price without a label (columns 1 X 2): the label comes from its position in the group
  const groups = new Map();
  for (const m of list) { if (!groups.has(m.title)) groups.set(m.title, []); groups.get(m.title).push(m); }
  for (const [, g] of groups) {
    if (g.every((m) => !m.label) || g.some((m) => !m.label)) {
      const names = g.length === 3 ? ['1', 'X', '2'] : (g.length === 2 ? ['1', '2'] : []);
      g.forEach((m, k) => { if (!m.label) m.label = names[k] || `option ${k + 1}`; });
    }
  }
  if (!list.length) list = marketsFromNet(page.net);
  return list.filter((m) => m.title).map((m) => ({ ...m, ...classify(m.title, m.label, ev) }));
}

module.exports = {
  stats: (page, ev) => require('./bbstats').stats(page, ev, parseStatsText),
  markets, openMarkets, classify, parseStatsText,
};
