'use strict';
// statistics and markets of one opened match. Nothing is invented: what is not shown is recorded as missing.
const { sleep, norm, sameTeam, walk } = require('./util');
const { catalogFor } = require('./markets');
const approvedMarkets = require('./approved_markets');
const sportMarkets = require('./sport_markets');

function matchMarketForEvent(title, label, ev) {
  const sp = String((ev && ev.sport) || 'football').toLowerCase();
  if (sp === 'football') return approvedMarkets.matchApprovedMarket(title, label, ev);
  return sportMarkets.matchSportMarket(sp, title, label, ev);
}

const STAT_TAB = /^(stats?|statistics|h2h|head ?to ?head|analysis|form|match stats?)$/i;
const MKT_TAB = /^(markets?|all markets|odds|betting|all)$/i;

const clickFirst = async (page, re) => {
  const loc = page.getByText(re);
  const n = Math.min(await loc.count().catch(() => 0), 8);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      const ok = await el.click({ timeout: 3500, force: true }).then(() => true).catch(() => false);
      if (ok) return true;
    }
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

async function openMarkets(page) {
  // BangBet match pages land on Markets by default; check for ANY visible decimal odds buttons
  // rather than assuming a specific market heading like "1x2" must exist.
  const alreadyVisible = await page.evaluate(() => {
    const priceRe = /^\d{1,3}\.\d{2}$/;
    let count = 0;
    for (const el of document.querySelectorAll('div,span,button')) {
      if (el.children.length > 2) continue;
      const t = (el.innerText || '').trim();
      if (priceRe.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 24 && r.height >= 18) count++;
        if (count >= 2) return true;
      }
    }
    return false;
  }).catch(() => false);
  if (!alreadyVisible) {
    await clickFirst(page, MKT_TAB);
    await sleep(900);
  }
  // Expand any collapsed market sections cleanly (bounded to visible toggles)
  await page.evaluate(() => {
    document.querySelectorAll('[aria-expanded="false"]').forEach((e) => {
      try { e.click(); } catch (_) {}
    });
  }).catch(() => {});
  await sleep(250);
}

async function expandAll(page) {
  for (let r = 0; r < 2; r++) {
    const expanded = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
      els.forEach((e) => { try { e.click(); } catch (x) { /* ignore */ } });
      return els.length;
    }).catch(() => 0);
    if (!expanded) break;
    await sleep(220);
  }
  // Follow the market list to its real end without unnecessary fixed sleeps.
  let still = 0;
  let steps = 0;
  while (still < 2 && steps < 18) {
    steps++;
    const moved = await page.evaluate(() => {
      const scrollables = Array.from(document.querySelectorAll('*'))
        .filter((e) => e.scrollHeight > e.clientHeight + 80)
        .sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = scrollables[0];
      let moved = false;
      if (target) {
        const before = target.scrollTop;
        target.scrollTop = Math.min(target.scrollHeight, before + Math.max(600, target.clientHeight * 0.95));
        moved = target.scrollTop > before;
      }
      const y = window.scrollY;
      window.scrollBy(0, Math.round(innerHeight * 0.95));
      return moved || window.scrollY > y;
    }).catch(() => false);
    await sleep(moved ? 180 : 220);
    still = moved ? 0 : still + 1;
  }
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { if (e.scrollTop > 0) e.scrollTop = 0; }); }).catch(() => {});
}

// every price on the page with the title of its market and its label; elements are tagged for clicking.
// Handles both inline-label buttons ("1 1.81", "1X 1.22") and BangBet table rows ("0.5 | 1.06 | 12.00" under "over | under").
const MKT_JS = () => {
  const priceRe = /^(.*?)(\d{1,3}\.\d{2})$/;
  const lineRe = /^[+-]?\d+(?:\.\d+)?$|^\d+:\d+$/;
  const cells = [];
  for (const el of document.querySelectorAll('div,span,button,li,a')) {
    if (el.children.length > 3) continue;
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 70) continue;
    const m = t.match(priceRe);
    if (!m) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 24 || b.height < 18) continue;
    cells.push({ el, label: m[1].trim(), odds: parseFloat(m[2]), t, x: b.left + b.width / 2, y: b.top + b.height / 2 });
  }
  // Drop any ancestor container that wraps another matched price cell (prevents parent-container duplicates)
  const keep = cells.filter((c) => !cells.some((o) => o !== c && c.el.contains(o.el)));
  const out = [];
  keep.forEach((c, i) => {
    c.el.setAttribute('data-bb', String(i));
    let g = c.el.parentElement;
    let title = '';
    let gi = -1;
    let label = c.label;
    for (let up = 0; g && up < 10; up++, g = g.parentElement) {
      const inside = keep.filter((o) => g.contains(o.el));
      if (inside.length >= 2 && inside.length <= 60) {
        const texts = new Set(inside.flatMap((o) => [o.t, o.label, String(o.odds), o.odds.toFixed(2)]));
        const gLines = (g.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const head = gLines.find((s) =>
          !texts.has(s) && !/^\d{1,3}\.\d{2}$/.test(s) && !lineRe.test(s) &&
          !/^(over|under|home|draw|away|bet assist|yes|no|1|x|2)$/i.test(s) && s.length < 80);
        if (head) {
          title = head;
          gi = inside.indexOf(c);
          // For table-layout markets (e.g. Total / Liverpool FC total / Asian Handicap) where price cells have no inline label,
          // resolve column header ("over"/"under"/"home"/"draw"/"away") + row line ("0.5"/"1.5"/"2.5"/"-0.5") by geometry.
          if (!label) {
            const sameRow = inside.filter((o) => Math.abs(o.y - c.y) < 18).sort((a, b) => a.x - b.x);
            const colIdx = sameRow.indexOf(c);
            const colHeads = gLines.filter((s) => /^(over|under|home|draw|away)$/i.test(s));
            // Check up to 4 ancestor levels for the row's line label (e.g. "0.5", "1.5", "2.5")
            let rowLine = '';
            let rp = c.el.parentElement;
            for (let rUp = 0; rp && rUp < 5 && !rowLine; rUp++, rp = rp.parentElement) {
              const rowTokens = (rp.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
              rowLine = rowTokens.find((s) => lineRe.test(s) && !/^\d{1,3}\.\d{2}$/.test(s)) || '';
            }
            if (colHeads.length === sameRow.length && colIdx >= 0) {
              const colName = colHeads[colIdx];
              label = rowLine ? `${colName} ${rowLine}` : colName;
            } else if (rowLine && sameRow.length === 2 && /total|over|under|goal|corner|card/i.test(head)) {
              label = `${colIdx === 0 ? 'over' : 'under'} ${rowLine}`;
            } else if (rowLine && sameRow.length === 2 && /handicap/i.test(head)) {
              label = `${colIdx === 0 ? 'home' : 'away'} ${rowLine}`;
            } else if (rowLine && sameRow.length === 3 && /handicap/i.test(head)) {
              label = `${['home', 'draw', 'away'][colIdx] || ''} ${rowLine}`.trim();
            }
          }
          break;
        }
      }
    }
    out.push({ i, title, label, odds: c.odds, pos: gi });
  });
  return out;
};

function parseBangbetOddsApi(net, ev = {}) {
  const out = [];
  if (!Array.isArray(net) || !net.length) return out;
  const seen = new Set();
  for (const r of net) {
    if (!r || !r.body) continue;
    const url = String(r.url || '');
    const isOddsEndpoint = /\/api\/bet\/match\/odds/i.test(url);
    const data = r.body.data || r.body;
    const marketList = Array.isArray(data && data.marketList) ? data.marketList : null;
    if (marketList && (isOddsEndpoint || marketList.some((g) => Array.isArray(g && g.markets)))) {
      // If event matchId is known, verify response matches it when available
      const respId = String((data && (data.id || data.eventId)) || '');
      const evId = String((ev && (ev.matchId || ev.eventId)) || '');
      if (respId && evId && !respId.includes(evId) && !evId.includes(respId)) {
        const respH = String((data && data.homeTeamName) || '');
        const respA = String((data && data.awayTeamName) || '');
        if (respH && respA && ev.home && ev.away && (!sameTeam(respH, ev.home) || !sameTeam(respA, ev.away))) {
          continue;
        }
      }
      for (const group of marketList) {
        if (!group || typeof group !== 'object') continue;
        const groups = Array.isArray(group.groups) ? group.groups.filter((g) => typeof g === 'string') : [];
        const subMarkets = Array.isArray(group.markets) ? group.markets : (Array.isArray(group.outcomes) ? [group] : []);
        for (const m of subMarkets) {
          if (!m || typeof m !== 'object') continue;
          if (m.active === false || m.marketActive === false) continue;
          if (m.marketStatus && !/active/i.test(String(m.marketStatus))) continue;
          const title = String(m.name || m.marketName || group.name || '').trim();
          if (!title) continue;
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
          for (const o of outcomes) {
            if (!o || typeof o !== 'object') continue;
            if (o.active === false || o.outcomeActive === false || o.marketActive === false || o.matchActive === false) continue;
            const label = String(o.desc || o.name || o.label || o.title || '').trim();
            const price = Number(o.odds || o.price || o.odd || o.value);
            if (!label || !Number.isFinite(price) || price <= 1 || price >= 1000) continue;
            const key = `${norm(title)}|${norm(label)}|${price.toFixed(2)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              i: -1,
              title,
              label,
              odds: price,
              pos: -1,
              source: 'bangbet_odds_api',
              marketGroups: groups.length ? groups : ['All'],
              specifiers: String(m.specifiers || ''),
            });
          }
        }
      }
    }
  }
  return out;
}

function marketsFromNet(net, ev = {}) {
  const apiList = parseBangbetOddsApi(net, ev);
  if (apiList.length) return apiList;
  const out = [];
  for (const r of (net || [])) {
    walk(r.body, (o) => {
      const name = typeof (o.name || o.title || o.marketName) === 'string' ? (o.name || o.title || o.marketName) : '';
      const arr = o.outcomes || o.selections || o.options || o.odds;
      if (!name || !Array.isArray(arr) || arr.length < 2) return;
      for (const x of arr) {
        if (!x || typeof x !== 'object') continue;
        if (x.active === false || x.outcomeActive === false) continue;
        const label = x.desc || x.name || x.label || x.title || '';
        const price = Number(x.odds || x.price || x.odd || x.value);
        if (typeof label === 'string' && label.trim() && price > 1 && price < 1000) {
          out.push({ i: -1, title: name, label: label.trim(), odds: price, pos: -1, source: 'net_generic' });
        }
      }
    });
  }
  return out;
}

// Switch BangBet's match-page horizontal market category tab (e.g. "All", "Goals", "Corner", "Half", "Main")
// using real Playwright interaction (Swiper.js on mobile ignores some synthetic DOM clicks) and verify
// that `.active-slide` genuinely switched to the requested tab.
async function switchMarketTab(page, tabName) {
  const target = String(tabName || '').trim().toLowerCase();
  if (!target) return false;
  const isAlreadyActive = async () => page.evaluate((wanted) => {
    const a = document.querySelector('.active-slide');
    return !!(a && (a.innerText || '').trim().toLowerCase() === wanted);
  }, target).catch(() => false);

  try {
    if (await isAlreadyActive()) return true;
    // Tag the exact matching swiper slide/title so Playwright can click it cleanly
    const targetRect = await page.evaluate((wanted) => {
      document.querySelectorAll('[data-bb-tab="1"]').forEach((n) => n.removeAttribute('data-bb-tab'));
      const candidates = [...document.querySelectorAll('.swiper-slide, .swiper-title')];
      for (const el of candidates) {
        const txt = (el.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (txt !== wanted) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 14 || r.height > 80 || r.top < 100 || r.top > 520) continue;
        el.scrollIntoView({ inline: 'center', block: 'nearest' });
        el.setAttribute('data-bb-tab', '1');
        const r2 = el.getBoundingClientRect();
        return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, w: r2.width, h: r2.height };
      }
      return null;
    }, target).catch(() => null);
    if (!targetRect) return false;

    const loc = page.locator('[data-bb-tab="1"]').first();
    await loc.click({ timeout: 3500, force: true }).catch(() => {});
    await sleep(700);
    if (!(await isAlreadyActive()) && page.mouse && typeof page.mouse.click === 'function') {
      await page.mouse.click(targetRect.x, targetRect.y).catch(() => {});
      await sleep(700);
    }
    if (!(await isAlreadyActive())) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-bb-tab="1"]');
        if (el) el.click();
      }).catch(() => {});
      await sleep(700);
    }
    const switched = await isAlreadyActive();
    if (!switched) return false;

    await sleep(400);
    await page.evaluate(() => {
      document.querySelectorAll('[aria-expanded="false"]').forEach((e) => {
        try { e.click(); } catch (_) {}
      });
    }).catch(() => {});
    await sleep(300);
    return true;
  } catch (_) {
    return false;
  }
}

function preferredMarketTabsForLeg(leg) {
  const id = (leg && leg.approvedMarketId) || '';
  if (id === 'team_total' || id === 'team_total_over_0_5' || id === 'btts_no' || id === 'to_score_in_both_halves_no') return ['Goals', 'All'];
  if (id === 'corner_1x2') return ['Corner', 'All'];
  if (id === 'to_win_either_half' || id === 'first_half_total_over_0_5' || id === 'second_half_total_over_0_5' || id === 'first_half_double_chance' || id === 'highest_scoring_half_second') return ['Half', 'All'];
  if (id === 'asian_handicap_plus_0_5' || id === 'asian_handicap_plus_1' || id === 'draw_no_bet') return ['Main', 'All'];
  if (id === 'any_team_to_win') return ['All'];
  return ['All', 'Main'];
}

async function switchMarketTabForLeg(page, leg) {
  const tabsToTry = preferredMarketTabsForLeg(leg);
  for (const tab of tabsToTry) {
    const ok = await switchMarketTab(page, tab);
    if (ok) return tab;
  }
  return '';
}

function classify(title, label, ev) {
  const t = norm(title);
  const l = norm(label);
  const wrap = (res) => {
    const cat = catalogFor(res);
    return cat ? { ...res, catalogId: cat.id, catalogName: cat.name } : res;
  };
  const side = () => {
    if (/^(1|home)$/.test(l)) return 'H';
    if (/^(2|away)$/.test(l)) return 'A';
    if (/^(x|draw)$/.test(l)) return 'X';
    if (sameTeam(label, ev.home) || (norm(ev.home) && l.includes(norm(ev.home)))) return 'H';
    if (sameTeam(label, ev.away) || (norm(ev.away) && l.includes(norm(ev.away)))) return 'A';
    return '';
  };
  const teamSide = () => norm(ev.away).split(' ').some(w => w.length > 3 && t.includes(w)) ? 'A' : 'H';
  // Parse decimal lines from raw lowercase text before norm() strips decimal points ("0.5" -> "0 5").
  const rawTitle = String(title || '').toLowerCase();
  const rawLabel = String(label || '').toLowerCase();
  const ou = /(over|under)\s*([0-9]+(?:\.[0-9]+)?)/.exec(rawLabel);
  const tl = /(over|under)/.test(rawLabel) ? /([0-9]+(?:\.[0-9]+)?)/.exec(rawTitle) : null;
  const line = ou ? parseFloat(ou[2]) : (tl ? parseFloat(tl[1]) : null);
  const direction = ou ? ou[1] : (/over/.test(l) ? 'over' : 'under');

  if (/(first half|1st half|half time|halftime)/.test(t) && line != null && !/(corner|card|booking)/.test(t))
    return wrap({ type: 'HALF_OU', side: direction === 'over' ? 'O' : 'U', line });
  if (/(second half|2nd half)/.test(t) && line != null && !/(corner|card|booking)/.test(t))
    return wrap({ type: 'HALF2_OU', side: direction === 'over' ? 'O' : 'U', line });
  if (/(corner|card|booking|shot|offside|foul)/.test(t) && line != null) {
    const stat = /corner/.test(t) ? 'corner' : (/card|booking/.test(t) ? 'card' : (/shot/.test(t) ? 'shot' : (/offside/.test(t) ? 'offside' : 'foul')));
    return wrap({ type: 'STAT_OU', stat, side: direction === 'over' ? 'O' : 'U', line });
  }
  if (/(clean sheet)/.test(t) && /^(yes|no)$/.test(l))
    return wrap({ type: 'CLEAN_SHEET', teamSide: /\baway\b/.test(t) ? 'A' : (/\bhome\b/.test(t) ? 'H' : teamSide()), side: l === 'no' ? 'N' : 'Y' });
  if (/(win to nil)/.test(t))
    return wrap({ type: 'WIN_TO_NIL', teamSide: /\baway\b/.test(t) ? 'A' : (/\bhome\b/.test(t) ? 'H' : teamSide()), side: /^(no)$/.test(l) ? 'N' : 'Y' });
  if (/(team total|team goals|home team goals|away team goals|total home|total away)/.test(t) && line != null)
    return wrap({ type: 'TEAM_OU', teamSide: /\baway\b/.test(t) ? 'A' : (/\bhome\b/.test(t) ? 'H' : teamSide()), side: direction === 'over' ? 'O' : 'U', line });
  if (/to score/.test(t) && /^(yes|no)$/.test(l) && !/both teams/.test(t))
    return wrap({ type: 'TEAM_SCORE', teamSide: /\baway\b/.test(t) ? 'A' : (/\bhome\b/.test(t) ? 'H' : teamSide()), labelSide: l === 'no' ? 'N' : 'Y' });
  if (/win either half|to win a half|to win any half/.test(t))
    return wrap({ type: 'WIN_HALF', side: side() });
  if (/win both halves/.test(t))
    return wrap({ type: 'WIN_BOTH_HALVES', side: side() });
  if (/double chance/.test(t) && /(both teams|btts|gg)/.test(t))
    return wrap({ type: 'DC_BTTS' });
  if (/double chance/.test(t) && (ou || tl || /over|under/.test(t)))
    return wrap({ type: 'DC_OU', line });
  if (/(1x2|result|winner)/.test(t) && /(both teams|btts|gg)/.test(t))
    return wrap({ type: 'BTTS_RESULT' });
  if (/(1x2|result|winner)/.test(t) && (ou || tl))
    return wrap({ type: 'RESULT_OU', line });
  if (/(half time full time|halftime fulltime|ht ft)/.test(t))
    return wrap({ type: 'HT_FT' });
  if (/(first half|1st half|half time|halftime)/.test(t) && /(both teams|btts|gg)/.test(t))
    return wrap({ type: 'HALF_BTTS', side: /^(yes|gg)$/.test(l) ? 'Y' : (/^(no|ng)$/.test(l) ? 'N' : '') });
  if (/(second half|2nd half)/.test(t) && /(both teams|btts|gg)/.test(t))
    return wrap({ type: 'HALF2_BTTS', side: /^(yes|gg)$/.test(l) ? 'Y' : (/^(no|ng)$/.test(l) ? 'N' : '') });
  if (/(first half|1st half|half time|halftime)/.test(t) && /(1x2|result|winner)/.test(t))
    return wrap({ type: 'HALF_WIN', side: side() });
  if (/(second half|2nd half)/.test(t) && /(1x2|result|winner)/.test(t))
    return wrap({ type: 'HALF2_WIN', side: side() });
  if (/(odd even|odd\/even)/.test(t))
    return wrap({ type: 'ODD_EVEN', side: /odd/.test(l) ? 'O' : (/even/.test(l) ? 'E' : '') });
  if (/highest scoring half/.test(t))
    return wrap({ type: 'HIGHEST_HALF' });
  if (/(asian handicap|handicap|spread|puck line|run line)/.test(t))
    return wrap({ type: /european|3 way|3-way/.test(t) ? 'EU_HANDICAP' : 'HANDICAP', side: side() });
  if (/(first team to score|1st goal)/.test(t))
    return wrap({ type: 'FIRST_TO_SCORE', side: side() });
  if (/(last team to score|last goal)/.test(t))
    return wrap({ type: 'LAST_TO_SCORE', side: side() });
  if (/(multi goals|multigoals|goal range|goals range)/.test(t))
    return wrap({ type: 'MULTI_GOALS' });
  if (/(exact goals|exact total goals)/.test(t))
    return wrap({ type: 'EXACT_GOALS' });
  if (/correct score/.test(t))
    return wrap({ type: 'CORRECT_SCORE' });
  if (/red card/.test(t))
    return wrap({ type: 'RED_CARD' });
  if (/penalt/.test(t))
    return wrap({ type: 'PENALTY' });
  if (/(half|1st|2nd|first|second|corner|card|booking|offside|player|scorer|exact|margin|quarter|set |inning|period)/.test(t))
    return { type: 'OTHER' };
  if (/double chance/.test(t)) {
    const s = l.replace(/\s/g, '');
    return wrap({ type: 'DC', side: s === '1x' || /homeordraw/.test(s) ? '1X' : (s === 'x2' || /draworaway/.test(s) ? 'X2' : (s === '12' || /homeoraway/.test(s) ? '12' : '')) });
  }
  if (/draw no bet/.test(t)) return wrap({ type: 'DNB', side: side() });
  if (/(both teams to score|btts|gg ng)/.test(t)) return wrap({ type: 'BTTS', side: /^(yes|gg)$/.test(l) ? 'Y' : (/^(no|ng)$/.test(l) ? 'N' : '') });
  if ((ou || tl) && /(total|over|under|goals|points|runs|games)/.test(t)) {
    const homeWord = norm(ev.home).split(' ').some((w) => w.length > 3 && t.includes(w));
    const awayWord = norm(ev.away).split(' ').some((w) => w.length > 3 && t.includes(w));
    if (homeWord || awayWord) return wrap({ type: 'TEAM_OU', teamSide: awayWord ? 'A' : 'H', side: direction === 'over' ? 'O' : 'U', line });
    return wrap({ type: 'OU', side: direction === 'over' ? 'O' : 'U', line });
  }
  if (/\b[123]up\b|\b1x2\s*[123]up\b/.test(t))
    return { type: 'WIN_UP', side: side() };
  if (/(1x2|match result|match winner|moneyline|full time result|to win|^result$|^winner$|^full time$|regular time)/.test(t))
    return wrap({ type: 'WIN', side: side() });
  return { type: 'OTHER' };
}

async function markets(page, ev, opts = {}) {
  await openMarkets(page);
  // Read currently displayed DOM markets first (getting real clickable data-bb indices).
  const dom = await page.evaluate(MKT_JS).catch(() => []);
  let list = Array.isArray(dom) ? dom : [];
  // a price without a label (columns 1 X 2): the label comes from its position in the group
  const groups = new Map();
  for (const m of list) { if (!groups.has(m.title)) groups.set(m.title, []); groups.get(m.title).push(m); }
  for (const [, g] of groups) {
    if (g.every((m) => !m.label) || g.some((m) => !m.label)) {
      const names = g.length === 3 ? ['1', 'X', '2'] : (g.length === 2 ? ['1', '2'] : []);
      g.forEach((m, k) => { if (!m.label) m.label = names[k] || `option ${k + 1}`; });
    }
  }
  // Merge BangBet's live /api/bet/match/odds JSON markets (already received on page load, zero extra clicks!)
  // so approved markets living on non-default tabs (Goals/Corner/All: Team Total, To Win Either Half,
  // Any Team To Win, Corner 1X2) are accurately discovered and evaluated during research.
  if (!opts.domOnly && Array.isArray(page.net) && page.net.length) {
    const netMarkets = marketsFromNet(page.net, ev);
    if (netMarkets.length) {
      if (!list.length) {
        list = netMarkets;
      } else {
        const domKeys = new Set();
        for (const dm of list) {
          const dap = matchMarketForEvent(dm.title, dm.label, ev);
          if (dap && dap.approved) {
            domKeys.add(`ap:${dap.approvedMarketId}:${dap.canonicalOutcome}`);
          }
          domKeys.add(`raw:${norm(dm.title)}|${norm(dm.label)}`);
        }
        for (const nm of netMarkets) {
          const nap = matchMarketForEvent(nm.title, nm.label, ev);
          const apKey = nap && nap.approved ? `ap:${nap.approvedMarketId}:${nap.canonicalOutcome}` : '';
          const rawKey = `raw:${norm(nm.title)}|${norm(nm.label)}`;
          if ((apKey && domKeys.has(apKey)) || domKeys.has(rawKey)) continue;
          if (apKey) domKeys.add(apKey);
          domKeys.add(rawKey);
          list.push(nm);
        }
      }
    }
  }
  return list
    .filter((m) => m.title && Number.isFinite(m.odds) && m.odds > 1 && m.odds < 1000 && !/suspend|lock/i.test(`${m.title} ${m.label}`))
    .map((m) => {
      const legacyCls = classify(m.title, m.label, ev);
      const ap = matchMarketForEvent(m.title, m.label, ev);
      return {
        ...m,
        ...legacyCls,
        approved: !!ap.approved,
        approvedMarketId: ap.approved ? ap.approvedMarketId : '',
        approvedMarketName: ap.approved ? ap.marketName : '',
        canonicalOutcome: ap.approved ? ap.canonicalOutcome : '',
      };
    });
}

module.exports = {
  stats: (page, ev, opts) => require('./bbstats').stats(page, ev, parseStatsText, opts),
  markets, openMarkets, expandAll, switchMarketTab, switchMarketTabForLeg, preferredMarketTabsForLeg, parseBangbetOddsApi, marketsFromNet, classify, parseStatsText,
};
