'use strict';
// Free public ESPN Soccer statistics fallback (zero API key, zero cost).
// Used ONLY when BangBet's embedded Sportradar/Gismo statistics are unavailable or blocked (e.g. HTTP 403 on cloud runners).
// Never fabricates statistics, never substitutes unrelated matches, and records honest provenance and missing fields.

const { sameTeam } = require('./util');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SCOREBOARD_CACHE = new Map();
const SCHEDULE_CACHE = new Map();
const SUMMARY_CACHE = new Map();

function formatYmd(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchJson(url, opts = {}) {
  const fetchFn = opts.fetch || global.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch unavailable');
  const timeoutMs = Number(opts.timeoutMs) || 12000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message ? e.message : e), data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function getScoreboardEventsForSingleDay(ymd, opts = {}) {
  if (!opts.bypassCache && SCOREBOARD_CACHE.has(ymd)) return SCOREBOARD_CACHE.get(ymd);
  const url = `${ESPN_BASE}/all/scoreboard?dates=${ymd}`;
  const res = await fetchJson(url, opts);
  const events = (res.ok && res.data && Array.isArray(res.data.events)) ? res.data.events : [];
  if (!opts.bypassCache) SCOREBOARD_CACHE.set(ymd, events);
  return events;
}

async function getScoreboardEventsForDate(tsMs, opts = {}) {
  const baseMs = Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now();
  // ESPN soccer/all/scoreboard accepts single-date ?dates=YYYYMMDD (hyphenated ranges return 0).
  // Query kickoff day plus +/- 1 day to avoid UTC/local timezone boundary misses, caching each day once.
  const days = [formatYmd(baseMs), formatYmd(baseMs - 86400000), formatYmd(baseMs + 86400000)];
  const lists = await Promise.all(days.map((ymd) => getScoreboardEventsForSingleDay(ymd, opts)));
  const seen = new Set();
  const out = [];
  for (const arr of lists) {
    for (const e of arr) {
      const id = String((e && e.id) || '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(e);
    }
  }
  return out;
}

function findMatchingEspnEvent(events, ev) {
  if (!Array.isArray(events) || !ev || !ev.home || !ev.away) return null;
  for (const item of events) {
    const comp = item && Array.isArray(item.competitions) ? item.competitions[0] : null;
    const comps = comp && Array.isArray(comp.competitors) ? comp.competitors : [];
    const h = comps.find((c) => c && c.homeAway === 'home');
    const a = comps.find((c) => c && c.homeAway === 'away');
    if (!h || !a || !h.team || !a.team) continue;
    const hNames = [h.team.displayName, h.team.shortDisplayName, h.team.name].filter(Boolean);
    const aNames = [a.team.displayName, a.team.shortDisplayName, a.team.name].filter(Boolean);
    const homeOk = hNames.some((n) => sameTeam(n, ev.home));
    const awayOk = aNames.some((n) => sameTeam(n, ev.away));
    if (homeOk && awayOk) {
      const slug = 'all';
      return {
        espnEventId: String(item.id || ''),
        slug,
        leagueName: (item.league && item.league.name) || (item.season && item.season.slug) || '',
        homeTeamId: String(h.team.id || ''),
        awayTeamId: String(a.team.id || ''),
        homeTeamName: String(h.team.displayName || ev.home),
        awayTeamName: String(a.team.displayName || ev.away),
        homeFormRaw: String(h.form || '').toUpperCase().replace(/[^WDL]/g, ''),
        awayFormRaw: String(a.form || '').toUpperCase().replace(/[^WDL]/g, ''),
        date: item.date || null,
      };
    }
  }
  return null;
}

function parseCompletedScheduleMatches(scheduleData, teamId) {
  const rawEvents = (scheduleData && Array.isArray(scheduleData.events)) ? scheduleData.events : [];
  const out = [];
  for (const e of rawEvents) {
    const comp = e && Array.isArray(e.competitions) ? e.competitions[0] : null;
    if (!comp || !comp.status || !comp.status.type || comp.status.type.completed !== true) continue;
    const comps = Array.isArray(comp.competitors) ? comp.competitors : [];
    const me = comps.find((c) => c && c.team && String(c.team.id) === String(teamId));
    const opp = comps.find((c) => c && c.team && String(c.team.id) !== String(teamId));
    if (!me || !opp) continue;
    const gf = Number(me.score && (me.score.value ?? me.score.displayValue));
    const ga = Number(opp.score && (opp.score.value ?? opp.score.displayValue));
    if (!Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) continue;
    const ts = Date.parse(e.date || comp.date || '') || 0;
    const isHome = me.homeAway === 'home';
    const result = gf > ga ? 'W' : (gf === ga ? 'D' : 'L');
    out.push({ ts, isHome, gf, ga, total: gf + ga, result });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function parseLastFiveFallback(summaryData, teamId) {
  const groups = (summaryData && Array.isArray(summaryData.lastFiveGames)) ? summaryData.lastFiveGames : [];
  const grp = groups.find((g) => g && g.team && String(g.team.id) === String(teamId));
  if (!grp || !Array.isArray(grp.events)) return [];
  const out = [];
  for (const e of grp.events) {
    const isHome = String(e.homeTeamId) === String(teamId);
    const hScore = Number(e.homeTeamScore);
    const aScore = Number(e.awayTeamScore);
    if (!Number.isFinite(hScore) || !Number.isFinite(aScore)) continue;
    const gf = isHome ? hScore : aScore;
    const ga = isHome ? aScore : hScore;
    const ts = Date.parse(e.gameDate || '') || 0;
    const result = gf > ga ? 'W' : (gf === ga ? 'D' : 'L');
    out.push({ ts, isHome, gf, ga, total: gf + ga, result });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function summarizeTeamMatches(matches, fallbackForm = '') {
  const list = Array.isArray(matches) ? matches : [];
  const n = list.length;
  const homeList = list.filter((m) => m.isHome);
  const awayList = list.filter((m) => !m.isHome);

  const formOfList = (arr) => arr.slice(-5).map((m) => m.result).join('');
  const overallForm = n ? formOfList(list) : String(fallbackForm || '').slice(-5);
  const homeForm = homeList.length ? formOfList(homeList) : null;
  const awayForm = awayList.length ? formOfList(awayList) : null;

  if (!n) {
    return {
      matches: 0,
      formSplit: {
        overall: overallForm || null,
        overallCount: overallForm ? overallForm.length : 0,
        home: null,
        homeCount: 0,
        away: null,
        awayCount: 0,
      },
      teamStats: null,
      formMetrics: {},
    };
  }

  let wins = 0, draws = 0, losses = 0, gfSum = 0, gaSum = 0;
  let over15 = 0, over25 = 0, btts = 0, cs = 0, fts = 0;
  for (const m of list) {
    if (m.result === 'W') wins++;
    else if (m.result === 'D') draws++;
    else losses++;
    gfSum += m.gf;
    gaSum += m.ga;
    if (m.total >= 2) over15++;
    if (m.total >= 3) over25++;
    if (m.gf > 0 && m.ga > 0) btts++;
    if (m.ga === 0) cs++;
    if (m.gf === 0) fts++;
  }

  const avg = (sum, cnt) => (cnt > 0 ? Math.round((sum / cnt) * 100) / 100 : null);
  const pct = (cnt, tot) => (tot > 0 ? Math.round((cnt / tot) * 100) : null);

  const hGf = homeList.reduce((s, m) => s + m.gf, 0);
  const hGa = homeList.reduce((s, m) => s + m.ga, 0);
  const aGf = awayList.reduce((s, m) => s + m.gf, 0);
  const aGa = awayList.reduce((s, m) => s + m.ga, 0);

  return {
    matches: n,
    formSplit: {
      overall: overallForm || null,
      overallCount: overallForm ? overallForm.length : 0,
      home: homeForm,
      homeCount: homeList.length,
      away: awayForm,
      awayCount: awayList.length,
    },
    teamStats: {
      matches: n,
      wins,
      draws,
      losses,
      winPct: pct(wins, n),
      goalsFor: gfSum,
      goalsAgainst: gaSum,
      avgFor: avg(gfSum, n),
      avgAg: avg(gaSum, n),
      homeMatches: homeList.length,
      avgForHome: avg(hGf, homeList.length),
      avgAgHome: avg(hGa, homeList.length),
      awayMatches: awayList.length,
      avgForAway: avg(aGf, awayList.length),
      avgAgAway: avg(aGa, awayList.length),
      over15: pct(over15, n),
      over25: pct(over25, n),
      bttsPct: pct(btts, n),
      cleanSheetPct: pct(cs, n),
      failedToScorePct: pct(fts, n),
    },
    formMetrics: {
      csPct: pct(cs, n),
      ftsPct: pct(fts, n),
    },
  };
}

function parseStandingsEntry(summaryData, teamId, teamName) {
  const groups = (summaryData && summaryData.standings && Array.isArray(summaryData.standings.groups))
    ? summaryData.standings.groups
    : [];
  for (const g of groups) {
    const entries = (g && g.standings && Array.isArray(g.standings.entries)) ? g.standings.entries : [];
    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      const t = entry && entry.team;
      const idMatch = t && teamId && String(t.id) === String(teamId);
      const nameMatch = t && teamName && [t.displayName, t.shortDisplayName, t.name].filter(Boolean).some((n) => sameTeam(n, teamName));
      if (!idMatch && !nameMatch) continue;
      const statMap = {};
      for (const s of (entry.stats || [])) {
        if (s && s.name != null && s.value != null && Number.isFinite(Number(s.value))) {
          statMap[s.name] = Number(s.value);
        }
      }
      const pos = statMap.rank ?? (idx + 1);
      return {
        pos,
        played: statMap.gamesPlayed ?? null,
        pts: statMap.points ?? null,
        win: statMap.wins ?? null,
        draw: statMap.ties ?? null,
        loss: statMap.losses ?? null,
        gf: statMap.pointsFor ?? null,
        ga: statMap.pointsAgainst ?? null,
      };
    }
  }
  return null;
}

function parseH2H(summaryData, homeTeamId, awayTeamId) {
  const groups = (summaryData && Array.isArray(summaryData.headToHeadGames)) ? summaryData.headToHeadGames : [];
  const meetings = [];
  const seen = new Set();
  for (const g of groups) {
    for (const e of (g && Array.isArray(g.events) ? g.events : [])) {
      const id = String(e.id || `${e.gameDate}-${e.score}`);
      if (seen.has(id)) continue;
      seen.add(id);
      const hId = String(e.homeTeamId || '');
      const aId = String(e.awayTeamId || '');
      const hs = Number(e.homeTeamScore);
      const as = Number(e.awayTeamScore);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      let homeGoals = null;
      let awayGoals = null;
      if (hId === String(homeTeamId) && aId === String(awayTeamId)) {
        homeGoals = hs; awayGoals = as;
      } else if (hId === String(awayTeamId) && aId === String(homeTeamId)) {
        homeGoals = as; awayGoals = hs;
      } else {
        continue;
      }
      meetings.push({
        date: e.gameDate || '',
        homeGoals,
        awayGoals,
        totalGoals: homeGoals + awayGoals,
      });
    }
  }
  if (!meetings.length) return { h2h: null, h2hMeetings: [] };
  let H = 0, X = 0, A = 0, totalGoals = 0, btts = 0, o15 = 0, o25 = 0;
  for (const m of meetings) {
    if (m.homeGoals > m.awayGoals) H++;
    else if (m.homeGoals < m.awayGoals) A++;
    else X++;
    totalGoals += m.totalGoals;
    if (m.homeGoals > 0 && m.awayGoals > 0) btts++;
    if (m.totalGoals >= 2) o15++;
    if (m.totalGoals >= 3) o25++;
  }
  const n = meetings.length;
  return {
    h2h: {
      n,
      H,
      X,
      A,
      avgGoals: Math.round((totalGoals / n) * 100) / 100,
      bttsPct: Math.round((btts / n) * 100),
      over15Pct: Math.round((o15 / n) * 100),
      over25Pct: Math.round((o25 / n) * 100),
    },
    h2hMeetings: meetings.slice(0, 10),
  };
}

async function fetchEspnStatsForFixture(ev, opts = {}) {
  const t0 = Date.now();
  if (!ev || String(ev.sport || 'football').toLowerCase() !== 'football') {
    return null;
  }
  const events = await getScoreboardEventsForDate(ev.ts, opts);
  const match = findMatchingEspnEvent(events, ev);
  if (!match || !match.espnEventId || !match.slug) {
    return null;
  }

  const sumKey = `${match.slug}:${match.espnEventId}`;
  const hKey = `${match.slug}:${match.homeTeamId}`;
  const aKey = `${match.slug}:${match.awayTeamId}`;

  const [sumRes, homeSchedRes, awaySchedRes] = await Promise.all([
    (!opts.bypassCache && SUMMARY_CACHE.has(sumKey))
      ? Promise.resolve({ ok: true, data: SUMMARY_CACHE.get(sumKey) })
      : fetchJson(`${ESPN_BASE}/${match.slug}/summary?event=${match.espnEventId}`, opts),
    match.homeTeamId
      ? ((!opts.bypassCache && SCHEDULE_CACHE.has(hKey))
          ? Promise.resolve({ ok: true, data: SCHEDULE_CACHE.get(hKey) })
          : fetchJson(`${ESPN_BASE}/${match.slug}/teams/${match.homeTeamId}/schedule`, opts))
      : Promise.resolve({ ok: false, data: null }),
    match.awayTeamId
      ? ((!opts.bypassCache && SCHEDULE_CACHE.has(aKey))
          ? Promise.resolve({ ok: true, data: SCHEDULE_CACHE.get(aKey) })
          : fetchJson(`${ESPN_BASE}/${match.slug}/teams/${match.awayTeamId}/schedule`, opts))
      : Promise.resolve({ ok: false, data: null }),
  ]);

  if (sumRes.ok && sumRes.data && !opts.bypassCache) SUMMARY_CACHE.set(sumKey, sumRes.data);
  if (homeSchedRes.ok && homeSchedRes.data && !opts.bypassCache) SCHEDULE_CACHE.set(hKey, homeSchedRes.data);
  if (awaySchedRes.ok && awaySchedRes.data && !opts.bypassCache) SCHEDULE_CACHE.set(aKey, awaySchedRes.data);

  const summaryData = sumRes.ok ? sumRes.data : null;
  let homeMatches = parseCompletedScheduleMatches(homeSchedRes.data, match.homeTeamId);
  let awayMatches = parseCompletedScheduleMatches(awaySchedRes.data, match.awayTeamId);
  if (!homeMatches.length && summaryData) homeMatches = parseLastFiveFallback(summaryData, match.homeTeamId);
  if (!awayMatches.length && summaryData) awayMatches = parseLastFiveFallback(summaryData, match.awayTeamId);

  const homeSum = summarizeTeamMatches(homeMatches, match.homeFormRaw);
  const awaySum = summarizeTeamMatches(awayMatches, match.awayFormRaw);

  const homeStanding = summaryData ? parseStandingsEntry(summaryData, match.homeTeamId, match.homeTeamName) : null;
  const awayStanding = summaryData ? parseStandingsEntry(summaryData, match.awayTeamId, match.awayTeamName) : null;
  const { h2h, h2hMeetings } = summaryData ? parseH2H(summaryData, match.homeTeamId, match.awayTeamId) : { h2h: null, h2hMeetings: [] };

  const hasForm = !!(homeSum.formSplit.overall && awaySum.formSplit.overall);
  const hasGoals = !!(homeSum.teamStats && awaySum.teamStats);
  if (!hasForm && !hasGoals) return null;

  const pct = [];
  if (hasGoals) {
    pct.push({ label: 'Over 1.5', vals: [homeSum.teamStats.over15, awaySum.teamStats.over15] });
    pct.push({ label: 'Over 2.5', vals: [homeSum.teamStats.over25, awaySum.teamStats.over25] });
    pct.push({ label: 'Both Teams Scored', vals: [homeSum.teamStats.bttsPct, awaySum.teamStats.bttsPct] });
  }

  const categories = {
    teamIdentity: true,
    competition: Boolean(match.leagueName || ev.league),
    teamSeasonScoring: hasGoals,
    recentMatches: hasForm,
    headToHead: Boolean(h2h && h2h.n > 0),
    standings: Boolean(homeStanding && awayStanding),
    overUnder: hasGoals,
    disciplinary: false,
    seasonTeamStats: false,
    winProbabilities: false,
  };

  return {
    available: true,
    status: (hasForm && hasGoals && (homeStanding || awayStanding)) ? 'complete' : 'partial',
    source: 'espn-public-soccer',
    fixtureId: ev.matchId || match.espnEventId,
    espnEventId: match.espnEventId,
    competition: match.leagueName || ev.league || '',
    country: ev.country || '',
    homeTeam: { id: match.homeTeamId, name: match.homeTeamName },
    awayTeam: { id: match.awayTeamId, name: match.awayTeamName },
    homeForm: homeSum.formSplit.overall || '',
    awayForm: awaySum.formSplit.overall || '',
    homeFormSampleSize: homeSum.formSplit.overallCount,
    awayFormSampleSize: awaySum.formSplit.overallCount,
    homeFormSplit: homeSum.formSplit,
    awayFormSplit: awaySum.formSplit,
    formMetrics: {
      home: homeSum.formMetrics,
      away: awaySum.formMetrics,
    },
    goals: hasGoals ? {
      hFor: homeSum.teamStats.avgFor,
      aFor: awaySum.teamStats.avgFor,
      hAg: homeSum.teamStats.avgAg,
      aAg: awaySum.teamStats.avgAg,
    } : null,
    teamStats: {
      home: homeSum.teamStats || {},
      away: awaySum.teamStats || {},
    },
    standings: (homeStanding || awayStanding) ? {
      home: homeStanding,
      away: awayStanding,
    } : null,
    h2h,
    h2hStatus: h2h ? 'verified' : 'not_captured',
    h2hMeetings,
    probs: null,
    pct,
    categories,
    provenance: {
      teamIdentity: 'espn-public-soccer',
      competition: 'espn-public-soccer',
      teamSeasonScoring: hasGoals ? 'espn-public-soccer' : 'missing',
      recentMatches: hasForm ? 'espn-public-soccer' : 'missing',
      headToHead: h2h ? 'espn-public-soccer' : 'missing',
      standings: (homeStanding && awayStanding) ? 'espn-public-soccer' : 'missing',
      overUnder: hasGoals ? 'espn-public-soccer' : 'missing',
      winProbabilities: 'missing',
      disciplinary: 'missing',
      seasonTeamStats: 'missing',
    },
    endpointsCaptured: [
      `espn:${match.slug}/scoreboard`,
      ...(sumRes.ok ? [`espn:${match.slug}/summary`] : []),
      ...(homeSchedRes.ok ? [`espn:${match.slug}/teams/${match.homeTeamId}/schedule`] : []),
      ...(awaySchedRes.ok ? [`espn:${match.slug}/teams/${match.awayTeamId}/schedule`] : []),
    ],
    responseCount: [sumRes.ok, homeSchedRes.ok, awaySchedRes.ok].filter(Boolean).length + 1,
    extractMs: Date.now() - t0,
  };
}

function clearCaches() {
  SCOREBOARD_CACHE.clear();
  SCHEDULE_CACHE.clear();
  SUMMARY_CACHE.clear();
}

module.exports = {
  fetchEspnStatsForFixture,
  findMatchingEspnEvent,
  parseCompletedScheduleMatches,
  summarizeTeamMatches,
  parseStandingsEntry,
  parseH2H,
  clearCaches,
};
