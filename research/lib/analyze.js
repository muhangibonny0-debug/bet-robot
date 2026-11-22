'use strict';
// Scoring and ranking only. It knows nothing about the website, so it can be improved on its own.
const { norm } = require('./util');
const { matchesMarketFilter } = require('./markets');

const CFG = {
  minForm: 3, // recent matches needed for each side
  minProb: { football: 0.5, basketball: 0.55, tennis: 0.55, baseball: 0.52, hockey: 0.5 },
  minOdds: 1.05,
  maxOdds: 12,
  wForm: 0.25, // how much recent form moves the market's own probability
  wH2H: 0.1, // how much head-to-head moves it
  wDraw: 0.15,
  blendShown: 0.5, // weight of probabilities shown by BangBet itself, when there are any
};

const formOf = (s) => {
  const f = String(s || '');
  const n = f.length;
  const w = (f.match(/W/g) || []).length;
  const d = (f.match(/D/g) || []).length;
  return { n, w, d, l: n - w - d, rate: n ? w / n : 0 };
};

const fact = (p, e) => (e == null ? 0 : p / e);
const pois = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * (l ** k) / f; };
const pOver = (lam, line) => { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += pois(lam, k); return 1 - c; };

function pctFor(st, re) {
  const e = (st.pct || []).find((p) => re.test(norm(p.label)));
  if (!e || !e.vals.length) return null;
  return e.vals.reduce((a, b) => a + b, 0) / e.vals.length / 100;
}

function candidates(ev, req) {
  const out = [];
  const st = ev.stats || {};
  const mk = ev.markets || [];
  const sport = ev.sport;
  const hF = formOf(st.homeForm);
  const aF = formOf(st.awayForm);
  const n = Math.min(hF.n, aF.n);
  if (!mk.length) { ev.rejected = 'no markets could be read for this match'; return out; }
  if (!st.available) { ev.rejected = 'no statistics could be read for this match'; return out; }
  const evidenceAvailable = n >= 2 || !!st.probs || !!(st.h2h && st.h2h.n) || (st.pct || []).length > 0 || Object.keys(st.avg || {}).length > 0;
  if (!evidenceAvailable) { ev.rejected = 'no usable form, probability, H2H or team-stat evidence'; return out; }

  const h2n = st.h2h ? st.h2h.n : 0;
  const conf = Math.min(1, n / 5) * (h2n ? 1 : 0.85);
  const facts = [];
  if (st.homeForm) facts.push(`${ev.home} recent form: ${st.homeForm}`);
  if (st.awayForm) facts.push(`${ev.away} recent form: ${st.awayForm}`);
  if (st.probs) facts.push(`BangBet win probability: ${Math.round(st.probs.H*100)}% / draw ${Math.round(st.probs.X*100)}% / ${Math.round(st.probs.A*100)}%`);
  if (h2n) facts.push(`Head-to-head (${h2n}): ${ev.home} ${st.h2h.H} wins, ${st.h2h.X} draws, ${ev.away} ${st.h2h.A} wins`);
  else facts.push('Head-to-head: no meetings found');

  const push = (m, p, why) => {
    if (!(p > 0.01 && p < 0.99) || !Number.isFinite(m.odds) || !(m.odds > 1) || m.odds >= 1000) return;
    out.push({
      evKey: ev.key, sport, league: ev.league, country: ev.country, home: ev.home, away: ev.away, ts: ev.ts, url: ev.url,
      market: m.title, outcome: m.label, odds: m.odds, bb: m.i, p, n,
      marketType: m.type, stat: m.stat, side: m.side, teamSide: m.teamSide, line: m.line, catalogId: m.catalogId,
      score: p * (0.55 + 0.45 * conf) + 0.4 * Math.max(0, p * m.odds - 1), reason: why, facts,
    });
  };

  // ---- who wins: the market's own probability, moved by form and head-to-head ----
  const win = mk.filter((m) => m.type === 'WIN');
  const H = win.find((m) => m.side === 'H');
  const X = win.find((m) => m.side === 'X');
  const A = win.find((m) => m.side === 'A');
  let P = null;
  if (H && A) {
    const inv = 1 / H.odds + 1 / A.odds + (X ? 1 / X.odds : 0);
    const pm = { H: 1 / H.odds / inv, A: 1 / A.odds / inv, X: X ? 1 / X.odds / inv : 0 };
    const fe = hF.rate - aF.rate;
    const he = h2n ? (st.h2h.H - st.h2h.A) / h2n : 0;
    let pH = pm.H * (1 + CFG.wForm * fe + CFG.wH2H * he);
    let pA = pm.A * (1 - CFG.wForm * fe - CFG.wH2H * he);
    let pX = pm.X * (1 - CFG.wDraw * Math.abs(fe));
    if (st.probs) {
      const b = CFG.blendShown;
      pH = (1 - b) * pH + b * st.probs.H;
      pA = (1 - b) * pA + b * st.probs.A;
      pX = X ? (1 - b) * pX + b * st.probs.X : 0;
    }
    const sum = pH + pA + pX;
    P = { H: pH / sum, A: pA / sum, X: pX / sum, pm };
    const why = (team, opp, tw, ow) =>
      `${team} won ${tw.w} of its last ${tw.n}; ${opp} won ${ow.w} of its last ${ow.n}.` +
      (h2n ? ` Head-to-head: ${ev.home} ${st.h2h.H}, draws ${st.h2h.X}, ${ev.away} ${st.h2h.A}.` : '') +
      ` Odds imply ${Math.round(100 * (team === ev.home ? pm.H : pm.A))}%, evidence says ${Math.round(100 * (team === ev.home ? P.H : P.A))}%.`;
    push(H, P.H, why(ev.home, ev.away, hF, aF));
    push(A, P.A, why(ev.away, ev.home, aF, hF));
    if (X && sport === 'football') push(X, P.X, `Draw rate in the market ${Math.round(100 * pm.X)}%; the sides are close in form.`);
  }

  if (sport === 'football' && P) {
    for (const m of mk.filter((x) => x.type === 'DC' && x.side)) {
      const p = m.side === '1X' ? P.H + P.X : (m.side === 'X2' ? P.A + P.X : P.H + P.A);
      push(m, p, `Double chance ${m.side}: combined chance ${Math.round(100 * p)}% from form (${st.homeForm} / ${st.awayForm}).`);
    }
  }
  if (P) {
    for (const m of mk.filter((x) => x.type === 'DNB' && x.side)) {
      const p = m.side === 'H' ? P.H / (P.H + P.A) : P.A / (P.H + P.A);
      push(m, p, `Draw no bet: ${Math.round(100 * p)}% when draws are void.`);
    }
  }

  // ---- goals: from the percentages BangBet shows, or from the averages ----
  if (sport === 'football' || sport === 'hockey') {
    const g = st.goals;
    const lamH = g ? (g.hFor + g.aAg) / 2 : null;
    const lamA = g ? (g.aFor + g.hAg) / 2 : null;
    for (const m of mk.filter((x) => x.type === 'BTTS' && x.side)) {
      let p = pctFor(st, /(btts|both teams|gg)/);
      if (p == null && lamH != null) p = (1 - Math.exp(-lamH)) * (1 - Math.exp(-lamA));
      if (p == null) continue;
      const q = m.side === 'Y' ? p : 1 - p;
      push(m, q, `Both teams to score ${m.side === 'Y' ? 'yes' : 'no'}: ${Math.round(100 * q)}% from the shown statistics.`);
    }
    for (const m of mk.filter((x) => x.type === 'OU' && x.side && x.line != null)) {
      const re = new RegExp('over\\s*' + String(m.line).replace('.', '\\s*'));
      let po = pctFor(st, re);
      if (po == null && lamH != null) po = pOver(lamH + lamA, m.line);
      if (po == null) continue;
      const q = m.side === 'O' ? po : 1 - po;
      push(m, q, `${m.side === 'O' ? 'Over' : 'Under'} ${m.line}: ${Math.round(100 * q)}% from the shown goal statistics.`);
    }
    for (const m of mk.filter((x) => x.type === 'HALF_OU' && x.side && x.line != null)) {
      const line = String(m.line).replace('.', '\\s*');
      const po = pctFor(st, new RegExp('(?:first half|1st half|half time|halftime).*over\\s*' + line + '|over\\s*' + line + '.*(?:first half|1st half|half time|halftime)'));
      if (po == null) continue;
      const q = m.side === 'O' ? po : 1 - po;
      push(m, q, `First-half ${m.side === 'O' ? 'over' : 'under'} ${m.line}: ${Math.round(100*q)}% from displayed first-half statistics.`);
    }
    for (const m of mk.filter((x) => x.type === 'STAT_OU' && x.side && x.line != null)) {
      const po = pctFor(st, new RegExp(m.stat + '.*over\\s*' + String(m.line).replace('.', '\\s*')));
      if (po == null) continue;
      const q = m.side === 'O' ? po : 1 - po;
      push(m, q, `${m.stat} ${m.side === 'O' ? 'over' : 'under'} ${m.line}: ${Math.round(100*q)}% from displayed team statistics.`);
    }
    for (const m of mk.filter((x) => x.type === 'TEAM_SCORE' && x.teamSide)) {
      if (lamH == null || lamA == null) continue;
      const lam = m.teamSide === 'H' ? lamH : lamA;
      const p = 1 - Math.exp(-lam);
      const q = m.labelSide === 'N' ? 1-p : p;
      push(m, q, `${m.teamSide === 'H' ? ev.home : ev.away} to score: estimated from displayed goals-scored average (${lam.toFixed(2)}).`);
    }
    for (const m of mk.filter((x) => x.type === 'HALF2_OU' && x.side && x.line != null)) {
      const line = String(m.line).replace('.', '\\s*');
      const po = pctFor(st, new RegExp('(?:second half|2nd half).*over\\s*' + line + '|over\\s*' + line + '.*(?:second half|2nd half)'));
      if (po == null) continue;
      const q = m.side === 'O' ? po : 1 - po;
      push(m, q, `Second-half ${m.side === 'O' ? 'over' : 'under'} ${m.line}: ${Math.round(100 * q)}% from displayed second-half statistics.`);
    }
    for (const m of mk.filter((x) => x.type === 'CLEAN_SHEET' && x.teamSide && x.side)) {
      if (lamH == null || lamA == null) continue;
      const oppLam = m.teamSide === 'H' ? lamA : lamH;
      const pClean = Math.exp(-oppLam);
      const q = m.side === 'Y' ? pClean : 1 - pClean;
      push(m, q, `${m.teamSide === 'H' ? ev.home : ev.away} clean sheet ${m.side === 'Y' ? 'yes' : 'no'}: estimated from displayed goal averages (opponent expected ${oppLam.toFixed(2)}).`);
    }
    for (const m of mk.filter((x) => x.type === 'TEAM_OU' && x.side && x.line != null)) {
      if (lamH == null || lamA == null) continue;
      const lam = m.teamSide === 'A' ? lamA : lamH;
      const po = pOver(lam, m.line);
      const q = m.side === 'O' ? po : 1-po;
      push(m, q, `${m.teamSide === 'A' ? ev.away : ev.home} team goals ${m.side === 'O' ? 'over' : 'under'} ${m.line}, estimated from its goals-scored average (${lam.toFixed(2)}).`);
    }
  } else {
    for (const m of mk.filter((x) => x.type === 'OU' && x.side && x.line != null)) {
      const po = pctFor(st, new RegExp('over\\s*' + String(m.line).replace('.', '\\s*')));
      if (po == null) continue;
      const q = m.side === 'O' ? po : 1 - po;
      push(m, q, `${m.side === 'O' ? 'Over' : 'Under'} ${m.line}: ${Math.round(100 * q)}% from the shown statistics.`);
    }
  }
  if (!out.length) {
    ev.rejected = 'no market has enough evidence';
    return out;
  }
  if (req && Array.isArray(req.markets) && req.markets.length) {
    const filtered = out.filter((c) => matchesMarketFilter(c, req.markets));
    if (!filtered.length) ev.rejected = 'no offered market matched requested market filter';
    return filtered;
  }
  return out;
}

module.exports = { candidates, CFG };
