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
  // Prefer BangBet's actual Vue tab container (.midtab-item) for Stats over inner <span> children
  const midtabs = [...document.querySelectorAll('.midtab-item')].filter((e) => {
    const t = (e.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const r = e.getBoundingClientRect();
    return r.width > 10 && r.height > 10 && /^stats(\s*new)?$/i.test(t);
  });
  if (midtabs.length) {
    midtabs[0].setAttribute('data-bbstats', '1');
    return true;
  }
  const nodes = [...document.querySelectorAll('button,a,div,span,li,p')].filter((e) => {
    const t = (e.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const r = e.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && t.length <= 24 &&
      /^(stats?|statistics|stats new|match stats?|team stats?|h2h|head[- ]?to[- ]?head|analysis|form|insights?|standings?)$/i.test(t);
  }).sort((a, b) => {
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
    formMetrics: { home: {}, away: {} },
    h2h: null, pct: [], probs: null, avg: {}, leagueAvg: {}, goals: null, missing: [],
  };

  // 1) HEAD TO HEAD TEAM AVERAGES (e.g. GOALS SCORED 1.75 | League 2.45, BTTS 59% | League 51%, OVER 1.5 83%, OVER 2.5 42%, TOTAL CARDS 5.33, CORNERS 8.75)
  const ta = at(/HEAD TO HEAD TEAM AVERAGES|H2H TEAM AVERAGE|TEAM AVERAGES?/);
  if (ta >= 0) {
    for (let i = ta + 1; i < Math.min(lines.length, ta + 85); i++) {
      const label = upper[i];
      if (/^(WIN PROBABILITY|PREVIOUS MEETINGS|LAST MATCHES|TEAM STATS)/.test(label)) break;
      if (!/^(GOALS SCORED|GOALS CONCEDED|TOTAL GOALS|BTTS|OVER \d+(?:\.\d+)?|UNDER \d+(?:\.\d+)?|TOTAL CARDS|CORNERS|CLEAN SHEETS?)$/.test(label)) continue;
      // Take the first numeric/percentage value immediately following the label (H2H/team average)
      // AND separately capture the "League | <value>" comparison without ever confusing the two!
      let seenLeague = false;
      for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
        if (/^(WIN PROBABILITY|PREVIOUS MEETINGS|LAST MATCHES|TEAM STATS)/.test(upper[j])) break;
        if (/^(GOALS SCORED|GOALS CONCEDED|TOTAL GOALS|BTTS|OVER \d+(?:\.\d+)?|UNDER \d+(?:\.\d+)?|TOTAL CARDS|CORNERS|CLEAN SHEETS?)$/.test(upper[j])) break;
        if (/^LEAGUE$/i.test(upper[j]) || /^LEAGUE\b/i.test(upper[j])) {
          seenLeague = true;
          const inlineLeague = /LEAGUE[^0-9-]*(-?\d+(?:\.\d+)?)\s*(%?)/i.exec(lines[j]);
          if (inlineLeague) {
            st.leagueAvg[label.toLowerCase()] = parseFloat(inlineLeague[1]);
            break;
          }
          continue;
        }
        const m = /^(-?\d+(?:\.\d+)?)\s*(%?)$/.exec(lines[j]);
        if (m) {
          const val = parseFloat(m[1]);
          if (seenLeague) {
            st.leagueAvg[label.toLowerCase()] = val;
            break;
          } else if (st.avg[label.toLowerCase()] == null) {
            st.avg[label.toLowerCase()] = val;
            if (m[2] === '%') st.pct.push({ label: label.toLowerCase(), vals: [val] });
          }
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
  //    Also extracts HT WIN %, FTS (Failed To Score %), and CS (Clean Sheet %) per team.
  const blocks = [];
  for (let i = 0; i < upper.length; i++) if (/^LAST MATCHES/.test(upper[i])) {
    const next = upper.findIndex((x, j) => j > i && (/^LAST MATCHES/.test(x) || /^TEAM STATS/.test(x)));
    const endIdx = next < 0 ? Math.min(lines.length, i + 36) : next;
    const segment = lines.slice(i + 1, endIdx);
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
    const metrics = {};
    for (let k = 0; k < segment.length; k++) {
      const up = segment[k].toUpperCase();
      const findPctNear = () => {
        const inline = /(\d+(?:\.\d+)?)\s*%/.exec(segment[k]);
        if (inline) return parseFloat(inline[1]);
        if (k + 1 < segment.length) {
          const nxt = /^(\d+(?:\.\d+)?)\s*%$/.exec(segment[k + 1]);
          if (nxt) return parseFloat(nxt[1]);
        }
        if (k > 0) {
          const prv = /^(\d+(?:\.\d+)?)\s*%$/.exec(segment[k - 1]);
          if (prv) return parseFloat(prv[1]);
        }
        return null;
      };
      if (/^HT\s*WIN\s*%?$/i.test(up)) {
        const v = findPctNear();
        if (v != null) metrics.htWinPct = v;
      } else if (/^FTS$/i.test(up) || /^FAILED\s+TO\s+SCORE/i.test(up)) {
        const v = findPctNear();
        if (v != null) metrics.ftsPct = v;
      } else if (/^CS$/i.test(up) || /^CLEAN\s+SHEETS?$/i.test(up)) {
        const v = findPctNear();
        if (v != null) metrics.csPct = v;
      }
    }
    const header = lines.slice(Math.max(0, i - 10), i).join(' ');
    blocks.push({ header, form, split, metrics });
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
    st.formMetrics = { home: h.metrics || {}, away: a ? (a.metrics || {}) : {} };
    st.teams = { home: h, away: a };
  }

  st.available = !!(st.homeForm && st.awayForm) || !!st.probs || !!st.h2h || Object.keys(st.avg).length > 0 || st.pct.length > 0 || !!st.goals;
  if (!st.probs) st.missing.push('win probability');
  if (!st.h2h) st.missing.push('previous meetings');
  if (!st.homeForm || !st.awayForm) st.missing.push('recent form');
  return st;
}

async function stats(page, ev, legacy, opts = {}) {
  const t0 = Date.now();
  const viaPhoneGateway = !!(opts && opts.viaPhoneGateway);
  // 1) Fast path: check if Gismo JSON responses (or cache) already satisfy this fixture
  let gismoSt = page.gismo ? page.gismo.assemble(ev) : null;
  let clicked = false;

  // 2) Trigger Stats tab when minimum evidence has not yet been captured.
  //    Use real pointer coordinates (page.mouse.click) on .midtab-item in addition to locator.click,
  //    because BangBet's mobile Vue header can ignore synthetic force clicks.
  const clickStatsTab = async () => {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-bbstats="1"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }).catch(() => null);
    if (rect && page.mouse && typeof page.mouse.click === 'function') {
      const okMouse = await page.mouse.click(rect.x, rect.y).then(() => true).catch(() => false);
      if (okMouse) return true;
    }
    return page.locator('[data-bbstats="1"]').first().click({ timeout: 4000, force: true }).then(() => true).catch(() => false);
  };

  if (!gismoSt || gismoSt.status !== 'complete') {
    for (let i = 0; i < 2 && !clicked; i++) {
      const marked = await page.evaluate(MARK).catch(() => false);
      if (marked) {
        clicked = await clickStatsTab();
      }
      if (!clicked) await sleep(500);
    }
  }

  // 3) Drain the full Gismo response wave (Wave 1 + Wave 2) using adaptive readiness rather than
  //    a rigid 5.5s minimum sleep: as soon as core Wave 1 + Wave 2 categories are present and
  //    Gismo traffic has gone quiet, return immediately while still giving slow fixtures full maxWaitMs.
  if (page.gismo) {
    const minWaitMs = viaPhoneGateway ? 3500 : 2200;
    const maxWaitMs = viaPhoneGateway ? 12000 : 9000;
    const quietMs = viaPhoneGateway ? 1100 : 800;
    const pollMs = 200;
    const waitStarted = Date.now();
    let retryClickDone = false;

    while (Date.now() - waitStarted < maxWaitMs) {
      await sleep(pollMs);
      gismoSt = page.gismo.assemble(ev);
      const elapsed = Date.now() - waitStarted;

      // Single bounded retry if the Stats tab did not trigger any Gismo traffic yet
      // (covers cold-load pages where the first click fired before Vue's tab handler hydrated)
      if (elapsed >= 1800 && gismoSt.responseCount === 0 && !retryClickDone) {
        retryClickDone = true;
        if (await page.evaluate(MARK).catch(() => false)) {
          clicked = await page.locator('[data-bbstats="1"]').first().click({ timeout: 3000, force: true }).then(() => true).catch(() => false) || clicked;
        }
      }

      const cats = (gismoSt && gismoSt.categories) || {};
      const hasWave2 = !!(cats.teamSeasonScoring || cats.recentMatches || cats.standings || cats.overUnder);
      if (elapsed >= minWaitMs && gismoSt.status === 'complete' && hasWave2 && page.gismo.isQuietFor(quietMs)) break;
    }

    // Final bounded drain so any in-flight response.text() / JSON.parse() completes before freezing snapshot
    await page.gismo.waitForQuiet(quietMs, 1200);
    gismoSt = page.gismo.assemble(ev);

    // If the embedded BangBet Sportradar widget iframe failed to emit Gismo responses (e.g. HTTP 403 / ORB on cloud runners),
    // fetch the exact same Sportradar Gismo JSON feeds directly from stats.fn.sportradar.com via GismoPageObserver.
    if ((!gismoSt || !gismoSt.available) && typeof page.gismo.fetchDirectForMatch === 'function') {
      const directOk = await page.gismo.fetchDirectForMatch(ev).catch(() => false);
      if (directOk) {
        gismoSt = page.gismo.assemble(ev);
        if (gismoSt && gismoSt.available) {
          gismoSt.source = 'sportradar-gismo-direct';
        }
      }
    }
  }

  if (gismoSt && gismoSt.available) {
    // Enrich with BangBet DOM fields that Gismo alone may omit (league average comparisons,
    // HT WIN % / FTS / CS form metrics, DOM win probability fallback, and below-the-fold Team Stats).
    try {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8))).catch(() => {});
      await sleep(180);
      const frames = await readFrames(page);
      const pick = best(frames);
      if (pick.score > 0) {
        const domSt = parse(pick.text, ev);
        if (domSt.probs && !gismoSt.probs) {
          gismoSt.probs = domSt.probs;
          if (gismoSt.categories) gismoSt.categories.winProbabilities = true;
          if (gismoSt.provenance) gismoSt.provenance.winProbabilities = 'bangbet-dom';
        }
        if (!gismoSt.homeForm && domSt.homeForm) gismoSt.homeForm = domSt.homeForm;
        if (!gismoSt.awayForm && domSt.awayForm) gismoSt.awayForm = domSt.awayForm;
        if (!gismoSt.homeFormSplit && domSt.homeFormSplit) gismoSt.homeFormSplit = domSt.homeFormSplit;
        if (!gismoSt.awayFormSplit && domSt.awayFormSplit) gismoSt.awayFormSplit = domSt.awayFormSplit;
        if (domSt.leagueAvg && Object.keys(domSt.leagueAvg).length) {
          gismoSt.leagueAvg = { ...(gismoSt.leagueAvg || {}), ...domSt.leagueAvg };
        }
        if (domSt.formMetrics) {
          gismoSt.formMetrics = {
            home: { ...(domSt.formMetrics.home || {}), ...((gismoSt.formMetrics && gismoSt.formMetrics.home) || {}) },
            away: { ...(domSt.formMetrics.away || {}), ...((gismoSt.formMetrics && gismoSt.formMetrics.away) || {}) },
          };
        }
        if (domSt.avg) {
          gismoSt.avg = { ...domSt.avg, ...(gismoSt.avg || {}) };
        }
      }
    } catch (_) {}
    gismoSt.tab = clicked;
    gismoSt.extractMs = Date.now() - t0;
    return gismoSt;
  }

  // 4) Fallback to visual DOM extraction only when Gismo JSON was unavailable
  let frames = [], pick = { score: -1, text: '', where: '' };
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 500 : 450);
    frames = await readFrames(page);
    pick = best(frames);
    if (pick.score >= 3) break;
  }
  let st = parse(pick.text, ev);
  if (!st.available && legacy) {
    try {
      const old = legacy(pick.text, ev);
      if (old && old.available) st = { ...old, source: 'legacy' };
    } catch (_) {}
  }
  if (!st.available && gismoSt) {
    st.status = !clicked && gismoSt.status === 'no_data_returned' ? 'request_not_triggered' : gismoSt.status;
    st.endpointsCaptured = gismoSt.endpointsCaptured;
    st.responseCount = gismoSt.responseCount;
    st.categories = gismoSt.categories;
    st.parseFailures = gismoSt.parseFailures;
    st.associationFailures = gismoSt.associationFailures;
    st.diagnostics = gismoSt.diagnostics;
  } else if (st.available) {
    st.status = 'partial';
    if (gismoSt && gismoSt.diagnostics) st.diagnostics = gismoSt.diagnostics;
  } else {
    st.status = clicked ? 'no_data_returned' : 'request_not_triggered';
  }
  st.tab = clicked;
  st.extractMs = Date.now() - t0;
  st.where = pick.where;
  st.frames = frames.map((f) => f.url.slice(0, 100) + ' visible=' + f.visible.length + ' deep=' + f.deep.length).slice(0, 8);
  st.raw = pick.text.slice(0, 1800);
  if (!st.available && savedFailure < 3) {
    savedFailure++;
    fs.writeFileSync(path.join(OUT, 'stats_fail_' + savedFailure + '.txt'),
      ['match: ' + ev.home + ' v ' + ev.away, 'url: ' + page.url(), 'tab clicked: ' + clicked, 'status: ' + st.status, ...st.frames, '', pick.text.slice(0, 6000)].join('\n'));
    await page.screenshot({ path: path.join(OUT, 'stats_fail_' + savedFailure + '.png') }).catch(() => {});
  } else if (st.available && !fs.existsSync(path.join(OUT, 'stats_ok_sample.txt'))) {
    fs.writeFileSync(path.join(OUT, 'stats_ok_sample.txt'), JSON.stringify({ ...st, raw: undefined }, null, 2) + '\n' + pick.text.slice(0, 5000));
  }
  return st;
}

module.exports = { stats, parse };
