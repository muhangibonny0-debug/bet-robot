'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const ALIAS = { man: 'manchester', utd: 'united', spurs: 'tottenham', wolves: 'wolverhampton', nottm: 'nottingham',
  psg: 'paris', gladbach: 'monchengladbach', ath: 'athletic', atl: 'atletico' };
const FILL = new Set(['fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'bk', 'if', 'club', 'cd', 'ud', 'sv', 'the', 'de', 'ac', 'as', 'cp', 'ca']);
const SOFT = new Set(['united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'hotspur', 'county', 'athletic', 'sporting', 'real']);
const toks = (s) => norm(s).split(' ').filter((w) => w && !FILL.has(w)).map((w) => ALIAS[w] || w);
const tm = (a, b) => a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b)) ||
  (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));

// "Man City" = "Manchester City", but "Manchester United" is not "Manchester City"
function sameTeam(a, b) {
  let x = toks(a);
  let y = toks(b);
  if (!x.length || !y.length) return false;
  if (x.length > y.length) [x, y] = [y, x];
  if (y.length - x.length > 1) return false;
  const used = new Set();
  for (const w of x) {
    const i = y.findIndex((v, k) => !used.has(k) && tm(w, v));
    if (i < 0) return false;
    used.add(i);
  }
  if (y.length === x.length) return true;
  const extra = y.find((_, k) => !used.has(k));
  return SOFT.has(extra);
}

// the most distinctive word of a team name
function keyTok(s) {
  const t = toks(s).sort((a, b) => b.length - a.length);
  return t.find((w) => w.length >= 4) || t[0] || norm(s);
}

function walk(o, fn, d = 0) {
  if (o == null || d > 9) return;
  if (Array.isArray(o)) { for (const x of o.slice(0, 600)) walk(x, fn, d + 1); return; }
  if (typeof o === 'object') { fn(o); for (const k of Object.keys(o)) walk(o[k], fn, d + 1); }
}

const pool = async (items, n, fn) => {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: n }, run));
};

module.exports = { sleep, norm, sameTeam, keyTok, walk, pool, toks };
