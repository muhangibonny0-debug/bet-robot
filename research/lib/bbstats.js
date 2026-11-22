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
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(n.nodeName)) return;
    if (n.shadowRoot) visit(n.shadowRoot);
    for (const c of n.childNodes) visit(c);
  };
  visit(document.body);
  return { visible: document.body ? document.body.innerText : '', deep: parts.join('\n') };
};

const MARK = () => {
  document.querySelectorAll('[data-bbstats]').forEach((e) => e.removeAttribute('data-bbstats'));
  const nodes = [...document.querySelectorAll('button,a,div,span,li,p')].filter((e) => {
    const t = (e.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const r = e.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && t.length <= 24 &&
      /^(stats?|statistics|stats new|match stats?|team stats?|h2h|head[- ]?to[- ]?head|analysis|form|insights?|standings?)$/i.test(t);
  }).sort((a, b) => {
    // Prefer exact "Stats" / "Stats New" tab over sub-tabs
    const at = (a.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const bt = (b.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const aPri = /^stats(\s*new)?$/.test(at) ? 0 : 1;
    const bPri = /^stats(\s*new)?$/.test(bt) ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return at.length - bt.length;
  });
  if (!nodes.length) return false;
  nodes[0].setAttribute('data-bbstats', '1');
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
  for (const f of frames) for (const field of ['visible', 'deep']) {
    const text = f[field];
    const hits = (text.match(/previous meetings|win probability|last matches|head to head team averages|h2h team average|team averages?|team stats|both teams scored|both teams to score|avg goals scored|goals scored|over 1\.5/gi) || []).length;
    if ((hits > pick.score && hits > 0) || (hits === pick.score && hits > 0 && text.length > pick.text.length))
      pick = { score: hits, text, where: f.url + '#' + field };
  }
  return pick;
}

// Merge BangBet split percentage lines (e.g. ["53", "%"] -> ["53%"]) before parsing.
function normalizeLines(text) {
  const raw = String(text || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '%' && out.length && /^-?\d+(?:\.\d+)?$/.test(out[out.length - 1])) {
      out[out.length - 1] += '%';
    } else {
      out.push(raw[i]);
    }
  }
  return out;
}

function parse(text, ev) {
  const lines = normalizeLines(text);
  const upper = lines.map((x) => x.toUpperCase());
  const at = (re) => upper.findIndex((x) => re.test(x));
  const st = {
    available: false, source: 'bangbet-embedded',
    homeForm: '', awayForm: '', homeFormSplit: null, awayFormSplit: null,
    h2h: null, pct: [], probs: null, avg: {}, goals: null, missing: [],
  };

  // 1) HEAD TO HEAD TEAM AVERAGES (e.g. GOALS SCORED 1.75, BTTS 59%, OVER 1.5 83%, OVER 2.5 42%, TOTAL CARDS 5.33, CORNERS 8.75)
  const ta = at(/HEAD TO HEAD TEAM AVERAGES|H2H TEAM AVERAGE|TEAM AVERAGES?/);
  if (ta >= 0) {
    for (let i = ta + 1; i < Math.min(lines.length, ta + 70); i++) {
      const label = upper[i];
      if (/^(WIN PROBABILITY|PREVIOUS MEETINGS|LAST MATCHES|TEAM STATS)/.test(label)) break;
      if (!/^(GOALS SCORED|GOALS CONCEDED|TOTAL GOALS|BTTS|OVER \d+(?:\.\d+)?|UNDER \d+(?:\.\d+)?|TOTAL CARDS|CORNERS|CLEAN SHEETS?)$/.test(label)) continue;
      // Take the first numeric/percentage value immediately following the label (before "League | ...")
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (/^LEAGUE$/i.test(upper[j])) break;
        const m = /^(-?\d+(?:\.\d+)?)\s*(%?)$/.exec(lines[j]);
        if (m) {
          const val = parseFloat(m[1]);
          st.avg[label.toLowerCase()] = val;
          if (m[2] === '%') st.pct.push({ label: label.toLowerCase(), vals: [val] });
          break;
        }
      }
    }
  }

  // 2) WIN PROBABILITY (e.g. 53% OSA / 26% DRAW / 21% MCF)
  const wp = at(/WIN PROBABILITY/);
  if (wp >= 0) {
    const vals = [];
    for (const line of lines.slice(wp + 1, wp + 15)) {
      if (/^(PREVIOUS MEETINGS|LAST MATCHES|TEAM STATS)/.test(line.toUpperCase())) break;
      const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(line);
      if (m) vals.push(+m[1]);
      if (vals.length === 3) break;
    }
    if (vals.length === 3 && vals.reduce((a, b) => a + b, 0) > 90) {
      const sum = vals.reduce((a, b) => a + b, 0);
      st.probs = { H: vals[0] / sum, X: vals[1] / sum, A: vals[2] / sum };
    }
  }

  // 3) PREVIOUS MEETINGS (e.g. 7 / WINS / 13 / DRAW / 12 / WINS)
  const pm = at(/^PREVIOUS MEETINGS/);
  if (pm >= 0) {
    const nums = [];
    for (const line of lines.slice(pm + 1, pm + 13)) {
      if (/^(LAST MATCHES|TEAM STATS)/.test(line.toUpperCase())) break;
      const m = /^(\d+)(?:\s+(?:WINS?|DRAWS?))?$/i.exec(line);
      if (m) nums.push(+m[1]);
      if (nums.length === 3) break;
    }
    if (nums.length === 3 && nums.reduce((a, b) => a + b, 0))
      st.h2h = { n: nums.reduce((a, b) => a + b, 0), H: nums[0], X: nums[1], A: nums[2] };
  }

  // 4) TEAM STATS — supports BOTH live BangBet 3-column table (homeVal | Metric | awayVal)
  //    AND legacy stacked format (Team A -> Metric -> Val, Team B -> Metric -> Val).
  const teamAt = at(/^TEAM STATS/);
  if (teamAt >= 0) {
    st.teamStats = { home: {}, away: {} };
    const rowMetrics = [
      [/^MATCHES PLAYED$/i, 'matchesPlayed'],
      [/^WIN\s*%$/i, 'winPct'],
      [/^TOTAL GOALS$/i, 'totalGoals'],
      [/^(AVG|AVERAGE)\s+GOALS\s+SCORED$/i, 'avgGoalsFor'],
      [/^(AVG|AVERAGE)\s+GOALS\s+CONCEDED$/i, 'avgGoalsAgainst'],
      [/^(BOTH TEAMS (TO )?SCORED?|BTTS)$/i, 'btts'],
      [/^OVER\s*1\.5$/i, 'over15'],
      [/^OVER\s*2\.5$/i, 'over25'],
      [/^HT\s+OVER\s*0\.5$/i, 'htOver05'],
      [/^HT\s+OVER\s*1\.5$/i, 'htOver15'],
      [/^YELLOW CARDS$/i, 'yellowCards'],
      [/^TOTAL CARDS$/i, 'cards'],
      [/^CORNERS$/i, 'corners'],
    ];
    const numVal = (s) => {
      const m = /^(-?\d+(?:\.\d+)?)\s*(%?)$/.exec(String(s || '').trim());
      return m ? { v: parseFloat(m[1]), isPct: m[2] === '%' } : null;
    };

    // 4a) 3-column table scan (leftVal = lines[i-1], metric = lines[i], rightVal = lines[i+1])
    //     Guard: if lines[i-2] is itself a metric label, then lines[i-1] is its stacked value, not a 3-column left cell.
    let tableHits = 0;
    for (let i = teamAt + 1; i < Math.min(lines.length, teamAt + 80); i++) {
      if (/^(MARKETS|HALF|CORNER|COMBO|GOALS|MAIN)$/i.test(upper[i])) break;
      const hit = rowMetrics.find(([re]) => re.test(lines[i]));
      if (!hit) continue;
      if (i >= teamAt + 2 && rowMetrics.some(([re]) => re.test(lines[i - 2]))) continue;
      const left = i > teamAt + 1 ? numVal(lines[i - 1]) : null;
      const right = i + 1 < lines.length ? numVal(lines[i + 1]) : null;
      if (left && right) {
        st.teamStats.home[hit[1]] = left.v;
        st.teamStats.away[hit[1]] = right.v;
        tableHits++;
        if (left.isPct && right.isPct) {
          const pctLabel = hit[1] === 'htOver05' ? 'first half over 0.5'
            : (hit[1] === 'htOver15' ? 'first half over 1.5'
              : (hit[1] === 'btts' ? 'both teams to score'
                : (hit[1] === 'over15' ? 'over 1.5'
                  : (hit[1] === 'over25' ? 'over 2.5' : lines[i].toLowerCase()))));
          st.pct.push({ label: pctLabel, vals: [left.v, right.v] });
        }
      }
    }

    // 4b) Legacy stacked format fallback (when team headers appear inside TEAM STATS)
    if (tableHits === 0) {
      let active = '';
      const metricNames = [
        ['AVERAGE GOALS SCORED', 'avgGoalsFor'], ['AVG GOALS SCORED', 'avgGoalsFor'],
        ['AVERAGE GOALS CONCEDED', 'avgGoalsAgainst'], ['AVG GOALS CONCEDED', 'avgGoalsAgainst'],
        ['GOALS SCORED', 'goalsFor'], ['GOALS CONCEDED', 'goalsAgainst'],
        ['BOTH TEAMS TO SCORE', 'btts'], ['BOTH TEAMS SCORED', 'btts'], ['BTTS', 'btts'],
        ['TOTAL CARDS', 'cards'], ['YELLOW CARDS', 'yellowCards'], ['CORNERS', 'corners'],
      ];
      for (let i = teamAt + 1; i < lines.length; i++) {
        const line = upper[i];
        if (/^(LAST MATCHES|H2H TEAM AVERAGE|TEAM AVERAGES?|MARKETS)/.test(line)) break;
        const n = norm(lines[i]);
        if (n.includes(keyTok(ev.home))) { active = 'home'; continue; }
        if (n.includes(keyTok(ev.away))) { active = 'away'; continue; }
        if (!active) continue;
        const metric = metricNames.find(([label]) => line === label);
        if (!metric) continue;
        const values = [...lines[i].matchAll(/-?\d+(?:\.\d+)?\s*%?/g)].map((m) => parseFloat(m[0]));
        for (let j = i + 1; j < Math.min(lines.length, i + 5) && values.length === 0; j++) {
          if (metricNames.some(([label]) => upper[j] === label)) break;
          values.push(...[...lines[j].matchAll(/-?\d+(?:\.\d+)?\s*%?/g)].map((m) => parseFloat(m[0])));
        }
        if (values.length) st.teamStats[active][metric[1]] = values[0];
      }
    }

    const h = st.teamStats.home, a = st.teamStats.away;
    if (Number.isFinite(h.avgGoalsFor) && Number.isFinite(a.avgGoalsFor) &&
        Number.isFinite(h.avgGoalsAgainst) && Number.isFinite(a.avgGoalsAgainst)) {
      st.goals = { hFor: h.avgGoalsFor, aFor: a.avgGoalsFor, hAg: h.avgGoalsAgainst, aAg: a.avgGoalsAgainst };
    }
  }

  // 5) General percentage capture (fallback for any remaining labeled % lines)
  for (let i = 0; i < lines.length; i++) {
    const vals = [...lines[i].matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => +m[1]);
    if (!vals.length) continue;
    let label = lines[i].replace(/\d+(?:\.\d+)?\s*%/g, ' ').trim();
    if (!/[A-Za-z]{2,}/.test(label)) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (/[A-Za-z]{2,}/.test(lines[j]) && !/^(HOME|AWAY|OVERALL|ALL|LEAGUE|OSA|MCF|DRAW)$/i.test(lines[j])) {
          label = lines[j];
          break;
        }
      }
    }
    if (label && !st.pct.some((p) => norm(p.label) === norm(label))) {
      st.pct.push({ label: label.slice(0, 90), vals });
    }
  }

  // 6) LAST MATCHES (handles both 15 vertical W/D/L letters for Overall/Home/Away and inline form strings)
  const blocks = [];
  for (let i = 0; i < upper.length; i++) if (/^LAST MATCHES/.test(upper[i])) {
    const next = upper.findIndex((x, j) => j > i && (/^LAST MATCHES/.test(x) || /^TEAM STATS/.test(x) || /^HT WIN/.test(x)));
    const segment = lines.slice(i + 1, next < 0 ? Math.min(lines.length, i + 25) : next);
    const singleLetters = segment.filter((x) => /^[WDL]$/i.test(x)).map((x) => x.toUpperCase()).join('');
    let form = '';
    let split = null;
    if (singleLetters.length >= 15) {
      split = { overall: singleLetters.slice(0, 5), home: singleLetters.slice(5, 10), away: singleLetters.slice(10, 15) };
      form = split.overall;
    } else if (singleLetters.length >= 3) {
      form = singleLetters.slice(0, 5);
    } else {
      const forms = segment.join(' ').match(/(?:OVERALL|HOME|AWAY)?\s*((?:[WDL]\s*){3,10})/gi) || [];
      form = forms.map((x) => x.replace(/[^WDL]/gi, '').toUpperCase()).find((x) => x.length >= 3) || '';
    }
    const header = lines.slice(Math.max(0, i - 10), i).join(' ');
    blocks.push({ header, form, split });
    if (blocks.length === 2) break;
  }
  if (blocks.length) {
    let h = blocks[0], a = blocks[1] || null;
    const has = (v, n) => norm(v).includes(keyTok(n));
    if (a && ((has(h.header, ev.away) && !has(h.header, ev.home)) || (has(a.header, ev.home) && !has(a.header, ev.away)))) [h, a] = [a, h];
    st.homeForm = h.form.slice(0, 5);
    st.awayForm = a ? a.form.slice(0, 5) : '';
    st.homeFormSplit = h.split || null;
    st.awayFormSplit = a ? (a.split || null) : null;
    st.teams = { home: h, away: a };
  }

  st.available = !!(st.homeForm && st.awayForm) || !!st.probs || !!st.h2h || Object.keys(st.avg).length > 0 || st.pct.length > 0 || !!st.goals;
  if (!st.probs) st.missing.push('win probability');
  if (!st.h2h) st.missing.push('previous meetings');
  if (!st.homeForm || !st.awayForm) st.missing.push('recent form');
  return st;
}

async function stats(page, ev, legacy) {
  let clicked = false;
  for (let i = 0; i < 3 && !clicked; i++) {
    const marked = await page.evaluate(MARK).catch(() => false);
    if (marked) {
      clicked = await page.locator('[data-bbstats="1"]').first().click({ timeout: 4500, force: true }).then(() => true).catch(() => false);
    }
    if (!clicked) await sleep(800);
  }
  let frames = [], pick = { score: -1, text: '', where: '' };
  // Wait up to ~8 seconds for Sportradar/BangBet async stats widget to finish loading,
  // returning early as soon as rich stats (score >= 3) appear.
  for (let i = 0; i < 11; i++) {
    await sleep(i === 0 ? 800 : 750);
    frames = await readFrames(page);
    pick = best(frames);
    if (pick.score >= 3) break;
    if (i === 2 && pick.score <= 0) {
      // Re-click Stats in case the first click landed before Vue attached the tab listener
      if (await page.evaluate(MARK).catch(() => false)) {
        await page.locator('[data-bbstats="1"]').first().click({ timeout: 3000, force: true }).catch(() => {});
      }
      await page.getByText(/^h2h$/i).first().click({ timeout: 1500, force: true }).catch(() => {});
    } else if (i === 2) {
      await page.getByText(/^h2h$/i).first().click({ timeout: 1500, force: true }).catch(() => {});
    }
    if (i === 5) {
      await page.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 0.55))).catch(() => {});
    }
  }
  let st = parse(pick.text, ev);
  if (!st.available && legacy) {
    try {
      const old = legacy(pick.text, ev);
      if (old && old.available) st = { ...old, source: 'legacy' };
    } catch (_) {}
  }
  st.tab = clicked;
  st.where = pick.where;
  st.frames = frames.map((f) => f.url.slice(0, 100) + ' visible=' + f.visible.length + ' deep=' + f.deep.length).slice(0, 8);
  st.raw = pick.text.slice(0, 1800);
  if (!st.available && savedFailure < 3) {
    savedFailure++;
    fs.writeFileSync(path.join(OUT, 'stats_fail_' + savedFailure + '.txt'),
      ['match: ' + ev.home + ' v ' + ev.away, 'url: ' + page.url(), 'tab clicked: ' + clicked, ...st.frames, '', pick.text.slice(0, 6000)].join('\n'));
    await page.screenshot({ path: path.join(OUT, 'stats_fail_' + savedFailure + '.png') }).catch(() => {});
  } else if (st.available && !fs.existsSync(path.join(OUT, 'stats_ok_sample.txt'))) {
    fs.writeFileSync(path.join(OUT, 'stats_ok_sample.txt'), JSON.stringify({ ...st, raw: undefined }, null, 2) + '\n' + pick.text.slice(0, 5000));
  }
  return st;
}

module.exports = { stats, parse };
