'use strict';
// Automatic BangBet / Sportradar statistics network discovery, content-based classification,
// schema-tolerant parsing, strict fixture/team UID association, wave-draining isolation,
// and structured diagnostic telemetry.
const fs = require('fs');
const path = require('path');
const { norm, keyTok } = require('./util');

const IGNORED_DOMAINS = /(googlesyndication|doubleclick|google-analytics|googletagmanager|google\.com\/pagead|google\.co\.ug\/pagead|facebook\.net|connect\.facebook|adjust\.com|adjust\.world|zendesk|zdassets|hotjar|tiktok|sentry\.io|firebaseinstallations|clarity\.ms|ads\.)/i;
const SECRET_RE = /(token|auth|key|cookie|session|secret|sig|pwd|pass)/i;

function redactUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    for (const [k] of parsed.searchParams.entries()) {
      if (SECRET_RE.test(k)) parsed.searchParams.set(k, 'REDACTED');
    }
    return parsed.toString();
  } catch (_) {
    return String(u || '').slice(0, 260);
  }
}

function schemaFingerprint(obj, depth = 0) {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) return obj.length ? `[${schemaFingerprint(obj[0], depth + 1)}]` : '[]';
  if (typeof obj !== 'object') return typeof obj;
  if (depth >= 2) return `{${Object.keys(obj).sort().slice(0, 8).join(',')}}`;
  const ks = Object.keys(obj).sort().slice(0, 12);
  return '{' + ks.map((k) => `${k}:${schemaFingerprint(obj[k], depth + 1)}`).join(',') + '}';
}

function extractMatchIdFromUrl(url) {
  const s = decodeURIComponent(String(url || ''));
  const m = s.match(/sr:match:(\d+)/i) || s.match(/matchId=(\d+)/i) || s.match(/\/(?:match_info|match_markets|match_timeline|stats_match_tableslice)\/(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function parseGismoPath(url) {
  const m = String(url || '').match(/\/gismo\/([^/?#]+)((?:\/[^/?#]+)*)/i);
  if (!m) return null;
  const endpoint = m[1].toLowerCase();
  const args = (m[2] || '').split('/').filter(Boolean);
  return { endpoint, args, pattern: `/gismo/${endpoint}` };
}

// Content-based classification: evaluates actual payload structure and domain context
// instead of relying purely on URL strings.
function classifyEndpoint(url, body) {
  const p = parseGismoPath(url);
  if (p) {
    const doc = Array.isArray(body && body.doc) && body.doc.length ? body.doc[0] : null;
    const evName = String((doc && doc.event) || p.endpoint || '').toLowerCase();
    const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : null;

    if (evName === 'exception' || (data && data._doc === 'exception')) {
      return {
        category: 'api_exception',
        bucket: 'api_exception',
        endpoint: p.endpoint,
        args: p.args,
        pattern: p.pattern,
        data,
        valid: false,
        exception: {
          code: data && data.code != null ? data.code : null,
          message: (data && (data.message || data.name)) || 'Sportradar exception',
        },
      };
    }

    let category = 'unknown_gismo';
    if (evName === 'match_info' || p.endpoint === 'match_info') category = 'match_info';
    else if (evName.includes('teamscoringconceding') || p.endpoint.includes('teamscoringconceding')) category = 'team_scoring_conceding';
    else if (evName.includes('versusrecent') || p.endpoint.includes('versusrecent')) category = 'head_to_head';
    else if (evName.includes('team_lastx') || p.endpoint.includes('team_lastx')) category = 'team_recent_matches';
    else if (evName.includes('season_overunder') || p.endpoint.includes('season_overunder')) category = 'season_over_under';
    else if (evName.includes('season_tables') || evName.includes('tableslice') || evName.includes('dynamictable') || p.endpoint.includes('tables')) category = 'season_standings';
    else if (evName.includes('disciplinary') || p.endpoint.includes('disciplinary')) category = 'team_disciplinary';
    else if (evName.includes('uniqueteamstats') || p.endpoint.includes('uniqueteamstats')) category = 'season_team_stats';
    else if (evName === 'match_markets' || p.endpoint === 'match_markets') category = 'match_markets';
    else if (evName.includes('timeline') || evName.includes('detailsextended')) category = 'match_timeline';
    else if (evName.includes('formtable') || p.endpoint.includes('formtable')) category = 'season_formtable';
    else if (evName.includes('usuallineup') || p.endpoint.includes('usuallineup')) category = 'team_usual_lineup';
    else if (evName.includes('seasonofficials') || p.endpoint.includes('seasonofficials')) category = 'team_officials';
    else if (evName.includes('funfacts') || evName.includes('bettingstimulation') || evName.includes('phrases')) category = 'match_insights';
    else if (evName.includes('fixtures') || p.endpoint.includes('fixtures') || evName.includes('season_meta') || evName.includes('cup_brackets') || evName.includes('positionhistory')) category = 'season_context';

    const valid = !!(data && Object.keys(data).length > 0);
    const isCoreStat = [
      'match_info', 'team_scoring_conceding', 'head_to_head', 'team_recent_matches',
      'season_over_under', 'season_standings', 'team_disciplinary', 'season_team_stats',
      'match_markets', 'season_formtable', 'team_usual_lineup', 'match_insights',
    ].includes(category);

    return {
      category,
      bucket: isCoreStat ? 'genuine_statistics' : (category === 'unknown_gismo' ? 'unknown_potentially_relevant' : 'supporting_gismo'),
      endpoint: evName || p.endpoint,
      args: p.args,
      pattern: p.pattern,
      data,
      valid,
      schema: data ? schemaFingerprint(data) : null,
    };
  }

  // Non-Gismo classification by actual content & host
  let host = '';
  let pathname = '';
  try {
    const u = new URL(String(url || ''));
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch (_) {
    return { category: 'ignored', bucket: 'ignored', endpoint: '', args: [], pattern: '', data: null, valid: false };
  }

  if (IGNORED_DOMAINS.test(url)) {
    return { category: 'ignored', bucket: 'ads_or_tracking', endpoint: '', args: [], pattern: '', data: null, valid: false };
  }

  if (/licensing/i.test(pathname) && /akamaized|sportradar/i.test(host)) {
    return {
      category: 'widget_licensing',
      bucket: 'widget_control',
      endpoint: 'licensing',
      args: [],
      pattern: `${host}/licensing`,
      data: body,
      valid: !!(body && (body.valid === true || body.text)),
    };
  }

  // Inspect non-Gismo JSON payloads for genuine statistical content vs promo/config/markets
  if (body && typeof body === 'object') {
    const pattern = `${host}${pathname.replace(/\/\d+/g, '/{id}')}`;
    // Known BangBet non-stat endpoints (markets, listings, community copy-bet recommendations, config)
    if (/\/api\/bet\/(match\/list|match\/odds|market\/displaySportMarket|record\/predictions|record\/betsNum|bonus|operation|activity|message|sport\/list|sport\/producer|reward|sportJackpot|casinoJackpot|match\/aiMatchSwitch)/i.test(pathname)) {
      return { category: 'ignored', bucket: 'site_api_non_stats', endpoint: pathname, args: [], pattern, data: null, valid: false };
    }
    if (/casino-api\.bangbet\.com/i.test(host) || /translations\/[a-z]{2}\.json$/i.test(pathname)) {
      return { category: 'ignored', bucket: 'site_config_or_i18n', endpoint: pathname, args: [], pattern, data: null, valid: false };
    }
    const sample = JSON.stringify(body).slice(0, 12000);
    const hasStatTerms = /(goalsscored|goalsconceded|bothteamsscored|cleansheets|yellowcards|redcards|corner_kicks|shots_on_goal|ball_possession|tablerows|head.?to.?head|h2h|win.?prob)/i.test(sample);
    if (hasStatTerms) {
      return {
        category: 'unknown_non_gismo_stats',
        bucket: 'unknown_potentially_relevant',
        endpoint: pathname,
        args: [],
        pattern,
        data: body,
        valid: true,
        schema: schemaFingerprint(body),
      };
    }
  }

  return { category: 'ignored', bucket: 'ignored', endpoint: '', args: [], pattern: '', data: null, valid: false };
}

class GismoCache {
  constructor() {
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.discoveredPatterns = new Map(); // pattern -> { category, bucket, count, usefulCount }
    this.unknownPatterns = new Map(); // pattern -> { count, schema, sampleUrl }
  }

  recordPattern(pattern, category, useful, bucket = 'genuine_statistics') {
    if (!pattern) return;
    const cur = this.discoveredPatterns.get(pattern) || { category, bucket, count: 0, usefulCount: 0 };
    cur.count++;
    if (useful) cur.usefulCount++;
    this.discoveredPatterns.set(pattern, cur);
  }

  recordUnknown(pattern, schema, url) {
    if (!pattern) return;
    const cur = this.unknownPatterns.get(pattern) || { count: 0, schema: schema || '', sampleUrl: redactUrl(url) };
    cur.count++;
    this.unknownPatterns.set(pattern, cur);
  }

  set(key, value, ttlMs = 30 * 60 * 1000) {
    if (!key || value == null) return;
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.evictions++;
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  peek(key) {
    const entry = this.map.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.value;
  }

  summary() {
    const patterns = {};
    for (const [k, v] of this.discoveredPatterns.entries()) patterns[k] = v;
    const unknown = {};
    for (const [k, v] of this.unknownPatterns.entries()) unknown[k] = v;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      discoveredPatterns: patterns,
      unknownPatterns: unknown,
    };
  }
}

function numOf(obj, key = 'total') {
  if (typeof obj === 'number' && Number.isFinite(obj)) return obj;
  if (obj && typeof obj === 'object' && obj[key] != null && Number.isFinite(Number(obj[key]))) return Number(obj[key]);
  return null;
}

function parseScoringConceding(data) {
  if (!data || !data.team || !data.stats) return null;
  const uid = Number(data.team._id || data.team.uid || 0);
  const st = data.stats;
  const matches = numOf(st.totalmatches, 'total') || 0;
  const homeMatches = numOf(st.totalmatches, 'home') || 0;
  const awayMatches = numOf(st.totalmatches, 'away') || 0;
  const wins = numOf(st.totalwins, 'total');
  const sc = st.scoring || {};
  const co = st.conceding || {};
  const goalsFor = numOf(sc.goalsscored, 'total');
  const goalsForHome = numOf(sc.goalsscored, 'home');
  const goalsForAway = numOf(sc.goalsscored, 'away');
  const goalsAg = numOf(co.goalsconceded, 'total');
  const goalsAgHome = numOf(co.goalsconceded, 'home');
  const goalsAgAway = numOf(co.goalsconceded, 'away');
  const avgFor = numOf(sc.goalsscoredaverage, 'total') ?? (matches > 0 && goalsFor != null ? +(goalsFor / matches).toFixed(2) : null);
  const avgAg = numOf(co.goalsconcededaverage, 'total') ?? (matches > 0 && goalsAg != null ? +(goalsAg / matches).toFixed(2) : null);
  const avgForHome = numOf(sc.goalsscoredaverage, 'home') ?? (homeMatches > 0 && goalsForHome != null ? +(goalsForHome / homeMatches).toFixed(2) : null);
  const avgForAway = numOf(sc.goalsscoredaverage, 'away') ?? (awayMatches > 0 && goalsForAway != null ? +(goalsForAway / awayMatches).toFixed(2) : null);
  const avgAgHome = numOf(co.goalsconcededaverage, 'home') ?? (homeMatches > 0 && goalsAgHome != null ? +(goalsAgHome / homeMatches).toFixed(2) : null);
  const avgAgAway = numOf(co.goalsconcededaverage, 'away') ?? (awayMatches > 0 && goalsAgAway != null ? +(goalsAgAway / awayMatches).toFixed(2) : null);
  const bttsCount = numOf(sc.bothteamsscored, 'total');
  const bttsPct = matches > 0 && bttsCount != null ? Math.round((bttsCount / matches) * 100) : null;
  const htScoreCount = numOf(sc.scoringathalftime, 'total');
  const htScorePct = matches > 0 && htScoreCount != null ? Math.round((htScoreCount / matches) * 100) : null;
  const ftsCount = numOf(sc.failedtoscore, 'total');
  const ftsHome = numOf(sc.failedtoscore, 'home');
  const ftsAway = numOf(sc.failedtoscore, 'away');
  const ftsPct = matches > 0 && ftsCount != null ? Math.round((ftsCount / matches) * 100) : null;
  const csCount = numOf(co.cleansheets, 'total') ?? numOf(co.clean_sheets, 'total');
  const csHome = numOf(co.cleansheets, 'home') ?? numOf(co.clean_sheets, 'home');
  const csAway = numOf(co.cleansheets, 'away') ?? numOf(co.clean_sheets, 'away');
  const csPct = matches > 0 && csCount != null ? Math.round((csCount / matches) * 100) : null;
  const htWinsCount = numOf(st.halftimewins, 'total') ?? numOf(st.htwins, 'total') ?? null;
  const htWinPct = matches > 0 && htWinsCount != null ? Math.round((htWinsCount / matches) * 100) : null;

  return {
    uid,
    name: data.team.mediumname || data.team.name || '',
    matches, homeMatches, awayMatches, wins,
    goalsFor, goalsForHome, goalsForAway,
    goalsAg, goalsAgHome, goalsAgAway,
    avgFor, avgAg, avgForHome, avgForAway, avgAgHome, avgAgAway,
    bttsPct, htScorePct, htWinPct,
    failedToScore: ftsCount,
    failedToScoreHome: ftsHome,
    failedToScoreAway: ftsAway,
    failedToScorePct: ftsPct,
    cleanSheets: csCount,
    cleanSheetsHome: csHome,
    cleanSheetsAway: csAway,
    cleanSheetPct: csPct,
    schemaVersion: 'sportradar_teamscoringconceding_v1',
  };
}

function parseRecentMatches(data, teamUid) {
  if (!data || !Array.isArray(data.matches)) return null;
  const uid = Number((data.team && (data.team._id || data.team.uid)) || teamUid || 0);
  if (!uid) return null;
  const overall = [];
  const homeOnly = [];
  const awayOnly = [];
  const history = [];
  let ov15 = 0, ov25 = 0, btts = 0, scoredSum = 0, concededSum = 0, counted = 0;
  let halfCount = 0, p1ForSum = 0, p1AgSum = 0, p2ForSum = 0, p2AgSum = 0;
  let p1Wins = 0, p2Wins = 0, eitherHalfWins = 0;

  for (const m of data.matches) {
    if (!m || !m.teams || !m.result) continue;
    const hUid = Number((m.teams.home && (m.teams.home.uid || m.teams.home._id)) || 0);
    const aUid = Number((m.teams.away && (m.teams.away.uid || m.teams.away._id)) || 0);
    const rh = m.result.home;
    const ra = m.result.away;
    if (typeof rh !== 'number' || typeof ra !== 'number') continue;
    const isHome = hUid === uid;
    const isAway = aUid === uid;
    if (!isHome && !isAway) continue;
    const gf = isHome ? rh : ra;
    const ga = isHome ? ra : rh;
    const letter = gf > ga ? 'W' : (gf < ga ? 'L' : 'D');
    const matchSeasonId = Number(m._seasonid || m.seasonid || 0);
    overall.push(letter);
    if (isHome) homeOnly.push(letter);
    else awayOnly.push(letter);

    // Extract genuine 1H / 2H period scores when Sportradar periods.p1 is present (never fabricated)
    let p1gf = null, p1ga = null, p2gf = null, p2ga = null;
    const p1 = m.periods && m.periods.p1;
    if (p1 && typeof p1.home === 'number' && typeof p1.away === 'number' && rh >= p1.home && ra >= p1.away) {
      const h1 = p1.home, a1 = p1.away;
      const h2 = rh - h1, a2 = ra - a1;
      p1gf = isHome ? h1 : a1;
      p1ga = isHome ? a1 : h1;
      p2gf = isHome ? h2 : a2;
      p2ga = isHome ? a2 : h2;
      if (halfCount < 10) {
        halfCount++;
        p1ForSum += p1gf;
        p1AgSum += p1ga;
        p2ForSum += p2gf;
        p2AgSum += p2ga;
        if (p1gf > p1ga) p1Wins++;
        if (p2gf > p2ga) p2Wins++;
        if (p1gf > p1ga || p2gf > p2ga) eitherHalfWins++;
      }
    }

    if (counted < 10) {
      counted++;
      scoredSum += gf;
      concededSum += ga;
      if (gf + ga >= 2) ov15++;
      if (gf + ga >= 3) ov25++;
      if (gf > 0 && ga > 0) btts++;
    }
    if (history.length < 25) {
      history.push({
        matchId: Number(m._id || 0),
        seasonId: matchSeasonId,
        date: (m._dt && m._dt.date) || '',
        uts: (m._dt && m._dt.uts) || 0,
        home: (m.teams.home && (m.teams.home.mediumname || m.teams.home.name)) || '',
        away: (m.teams.away && (m.teams.away.mediumname || m.teams.away.name)) || '',
        score: `${rh}-${ra}`,
        goalsFor: gf,
        goalsAgainst: ga,
        p1GoalsFor: p1gf,
        p1GoalsAgainst: p1ga,
        p2GoalsFor: p2gf,
        p2GoalsAgainst: p2ga,
        role: isHome ? 'home' : 'away',
        result: letter,
      });
    }
  }
  if (!overall.length) return null;
  const halfStats = halfCount > 0 ? {
    sampleSize: halfCount,
    p1AvgFor: +(p1ForSum / halfCount).toFixed(2),
    p1AvgAg: +(p1AgSum / halfCount).toFixed(2),
    p2AvgFor: +(p2ForSum / halfCount).toFixed(2),
    p2AvgAg: +(p2AgSum / halfCount).toFixed(2),
    p1Wins,
    p2Wins,
    eitherHalfWins,
    p1WinRate: +(p1Wins / halfCount).toFixed(3),
    p2WinRate: +(p2Wins / halfCount).toFixed(3),
    eitherHalfWinRate: +(eitherHalfWins / halfCount).toFixed(3),
  } : null;
  return {
    uid,
    form: overall.slice(0, 5).join(''),
    split: {
      overall: overall.slice(0, 5).join(''),
      home: homeOnly.slice(0, 5).join(''),
      away: awayOnly.slice(0, 5).join(''),
      overallCount: Math.min(5, overall.length),
      homeCount: Math.min(5, homeOnly.length),
      awayCount: Math.min(5, awayOnly.length),
    },
    sampleSize: counted,
    avgFor: counted ? +(scoredSum / counted).toFixed(2) : null,
    avgAg: counted ? +(concededSum / counted).toFixed(2) : null,
    ov15Pct: counted ? Math.round((ov15 / counted) * 100) : null,
    ov25Pct: counted ? Math.round((ov25 / counted) * 100) : null,
    bttsPct: counted ? Math.round((btts / counted) * 100) : null,
    halfStats,
    matches: history,
    schemaVersion: 'sportradar_team_lastx_v1',
  };
}

// Compute competition-scoped form (overall, home, away) strictly from matches belonging to `seasonId`.
// Never mixes domestic league/cup matches into an international/target competition's form.
function filterCompetitionForm(recentParsed, seasonId) {
  if (!recentParsed || !Array.isArray(recentParsed.matches) || !seasonId) return null;
  const compMatches = recentParsed.matches.filter((m) => Number(m.seasonId) === Number(seasonId));
  if (!compMatches.length) return null;
  const overall = compMatches.map((m) => m.result);
  const homeOnly = compMatches.filter((m) => m.role === 'home').map((m) => m.result);
  const awayOnly = compMatches.filter((m) => m.role === 'away').map((m) => m.result);
  return {
    seasonId: Number(seasonId),
    context: 'competition_specific',
    overall: overall.slice(0, 5).join(''),
    home: homeOnly.slice(0, 5).join(''),
    away: awayOnly.slice(0, 5).join(''),
    sampleSize: overall.length,
    homeSampleSize: homeOnly.length,
    awaySampleSize: awayOnly.length,
  };
}

function parseH2H(data, homeUid, awayUid) {
  if (!data || !homeUid || !awayUid) return null;
  // Valid versusrecent response where teams have never previously played
  if (!Array.isArray(data.matches)) {
    if (Array.isArray(data.upcomingmatches) || data.teams || data.next) {
      return { n: 0, H: 0, X: 0, A: 0, meetings: [], noPriorMeetings: true };
    }
    return null;
  }
  let H = 0, X = 0, A = 0;
  let totalGoalsSum = 0, homeGoalsSum = 0, awayGoalsSum = 0;
  let bttsCount = 0, ov15Count = 0, ov25Count = 0;
  const meetings = [];
  for (const m of data.matches) {
    if (!m || !m.teams || !m.result) continue;
    const mh = Number((m.teams.home && (m.teams.home.uid || m.teams.home._id)) || 0);
    const ma = Number((m.teams.away && (m.teams.away.uid || m.teams.away._id)) || 0);
    const rh = m.result.home;
    const ra = m.result.away;
    if (typeof rh !== 'number' || typeof ra !== 'number') continue;
    const sameOrder = mh === homeUid && ma === awayUid;
    const flipped = mh === awayUid && ma === homeUid;
    if (!sameOrder && !flipped) continue;
    const homeGoals = sameOrder ? rh : ra;
    const awayGoals = sameOrder ? ra : rh;
    const tot = homeGoals + awayGoals;
    totalGoalsSum += tot;
    homeGoalsSum += homeGoals;
    awayGoalsSum += awayGoals;
    if (homeGoals > 0 && awayGoals > 0) bttsCount++;
    if (tot >= 2) ov15Count++;
    if (tot >= 3) ov25Count++;
    if (homeGoals > awayGoals) H++;
    else if (awayGoals > homeGoals) A++;
    else X++;
    if (meetings.length < 10) {
      meetings.push({
        matchId: Number(m._id || 0),
        date: (m._dt && m._dt.date) || '',
        home: (m.teams.home && m.teams.home.name) || '',
        away: (m.teams.away && m.teams.away.name) || '',
        score: `${rh}-${ra}`,
        homeGoals,
        awayGoals,
        totalGoals: tot,
      });
    }
  }
  const n = H + X + A;
  if (!n) return { n: 0, H: 0, X: 0, A: 0, meetings: [], noPriorMeetings: true };
  return {
    n, H, X, A,
    avgGoals: +(totalGoalsSum / n).toFixed(2),
    homeGoalsAvg: +(homeGoalsSum / n).toFixed(2),
    awayGoalsAvg: +(awayGoalsSum / n).toFixed(2),
    bttsPct: Math.round((bttsCount / n) * 100),
    over15Pct: Math.round((ov15Count / n) * 100),
    over25Pct: Math.round((ov25Count / n) * 100),
    meetings,
    noPriorMeetings: false,
  };
}

function parseStandings(data, homeUid, awayUid) {
  if (!data) return null;
  const tables = Array.isArray(data.tables)
    ? data.tables
    : (Array.isArray(data.tablerows) ? [data] : (data.season && Array.isArray(data.season.tables) ? data.season.tables : []));
  let homeRow = null, awayRow = null;
  for (const tb of tables) {
    const rows = Array.isArray(tb && tb.tablerows) ? tb.tablerows : [];
    for (const r of rows) {
      const uid = Number((r && r.team && (r.team.uid || r.team._id)) || 0);
      if (uid === homeUid && !homeRow) {
        homeRow = { pos: r.pos, pts: r.points, played: r.total, win: r.win, draw: r.draw, loss: r.loss, gf: r.goalsfor, ga: r.goalsagainst };
      }
      if (uid === awayUid && !awayRow) {
        awayRow = { pos: r.pos, pts: r.points, played: r.total, win: r.win, draw: r.draw, loss: r.loss, gf: r.goalsfor, ga: r.goalsagainst };
      }
    }
  }
  if (!homeRow && !awayRow) return null;
  return { home: homeRow, away: awayRow };
}

// Schema-tolerant parser for Sportradar stats_season_overunder/{seasonId}.
// Handles BOTH live nested schema (`t.total.ft["1.5"] = { over, under }`, `p1`, `p2`, `home`, `away`,
// `goalsscored`, `conceded`, `winrate`) AND legacy flat schema (`t.over` / `t.overs`).
function parseSeasonOverUnder(data, homeUid, awayUid) {
  if (!data || !data.stats || typeof data.stats !== 'object') return null;

  const parseLineMap = (lineObj) => {
    if (!lineObj || typeof lineObj !== 'object') return null;
    const out = {};
    for (const [line, counts] of Object.entries(lineObj)) {
      if (counts && typeof counts === 'object' && typeof counts.over === 'number' && typeof counts.under === 'number') {
        const denom = counts.over + counts.under;
        if (denom > 0) {
          out[line] = {
            over: counts.over,
            under: counts.under,
            matches: denom,
            overPct: Math.round((counts.over / denom) * 100),
            underPct: Math.round((counts.under / denom) * 100),
          };
        }
      }
    }
    return Object.keys(out).length ? out : null;
  };

  const extractTeam = (uid) => {
    const t = data.stats[String(uid)];
    if (!t || typeof t !== 'object') return null;

    // Schema V2 (verified live Sportradar schema): t.total.ft / p1 / p2 + t.home + t.away
    const ftTotal = parseLineMap(t.total && t.total.ft);
    const p1Total = parseLineMap(t.total && t.total.p1);
    const p2Total = parseLineMap(t.total && t.total.p2);
    const ftHome = parseLineMap(t.home && t.home.ft);
    const ftAway = parseLineMap(t.away && t.away.ft);
    if (ftTotal || p1Total || p2Total) {
      const pct = {};
      if (ftTotal) {
        for (const [k, v] of Object.entries(ftTotal)) pct[k] = v.overPct;
      }
      return {
        uid,
        schemaVersion: 'sportradar_overunder_v2',
        matches: typeof t.matches === 'number' ? t.matches : (ftTotal && Object.values(ftTotal)[0] ? Object.values(ftTotal)[0].matches : 0),
        homeMatches: typeof t.homematches === 'number' ? t.homematches : null,
        awayMatches: typeof t.awaymatches === 'number' ? t.awaymatches : null,
        ft: ftTotal,
        p1: p1Total,
        p2: p2Total,
        homeFt: ftHome,
        awayFt: ftAway,
        pct, // quick lookup: { "0.5": 75, "1.5": 50, "2.5": 50, ... }
        goalsScoredFt: t.goalsscored && t.goalsscored.ft ? {
          total: numOf(t.goalsscored.ft, 'total'),
          average: numOf(t.goalsscored.ft, 'average'),
          atLeastOne: numOf(t.goalsscored.ft, 'atleastonegoal'),
          matches: numOf(t.goalsscored.ft, 'matches'),
        } : null,
        goalsScoredP1: t.goalsscored && t.goalsscored.p1 ? {
          total: numOf(t.goalsscored.p1, 'total'),
          average: numOf(t.goalsscored.p1, 'average'),
          matches: numOf(t.goalsscored.p1, 'matches'),
        } : null,
        goalsScoredP2: t.goalsscored && t.goalsscored.p2 ? {
          total: numOf(t.goalsscored.p2, 'total'),
          average: numOf(t.goalsscored.p2, 'average'),
          matches: numOf(t.goalsscored.p2, 'matches'),
        } : null,
        concededFt: t.conceded && t.conceded.ft ? {
          total: numOf(t.conceded.ft, 'total'),
          average: numOf(t.conceded.ft, 'average'),
          cleanSheets: numOf(t.conceded.ft, 'cleansheets'),
          matches: numOf(t.conceded.ft, 'matches'),
        } : null,
        concededP1: t.conceded && t.conceded.p1 ? {
          total: numOf(t.conceded.p1, 'total'),
          average: numOf(t.conceded.p1, 'average'),
          matches: numOf(t.conceded.p1, 'matches'),
        } : null,
        concededP2: t.conceded && t.conceded.p2 ? {
          total: numOf(t.conceded.p2, 'total'),
          average: numOf(t.conceded.p2, 'average'),
          matches: numOf(t.conceded.p2, 'matches'),
        } : null,
        winRateFt: t.winrate && t.winrate.ft ? numOf(t.winrate.ft, 'average') : null,
        htWinPct: t.winrate && t.winrate.p1 ? (() => {
          const v = numOf(t.winrate.p1, 'average');
          if (v == null) return null;
          return v <= 1 ? Math.round(v * 100) : Math.round(v);
        })() : null,
        failedToScore: t.goalsscored && t.goalsscored.ft && t.goalsscored.ft.matches != null && t.goalsscored.ft.atleastonegoal != null
          ? Math.max(0, Number(t.goalsscored.ft.matches) - Number(t.goalsscored.ft.atleastonegoal))
          : null,
      };
    }

    // Legacy fallback schema: t.over / t.overs
    const total = numOf(t.total, 'total') || numOf(t.matches, 'total') || 0;
    const over = t.over || t.overs || null;
    if (over && typeof over === 'object' && total > 0) {
      const pct = {};
      for (const [k, v] of Object.entries(over)) {
        const c = numOf(v, 'total');
        if (c != null) pct[k] = Math.round((c / total) * 100);
      }
      if (Object.keys(pct).length) {
        return { uid, schemaVersion: 'sportradar_overunder_legacy', matches: total, pct, ft: null, p1: null, p2: null };
      }
    }
    return null;
  };

  const h = extractTeam(homeUid);
  const a = extractTeam(awayUid);
  if (!h && !a) {
    return {
      parsed: false,
      reason: `team_uids_not_in_overunder_stats_or_unrecognized_schema (${homeUid}/${awayUid})`,
      schema: schemaFingerprint(data),
    };
  }
  return { parsed: true, values: data.values || {}, home: h, away: a };
}

// Parser for Sportradar stats_season_uniqueteamstats/{seasonId}
// Supplies corners, shots on/off target, blocked shots, cards, fouls/freekicks, offsides, possession, clean sheets.
function parseUniqueTeamStats(data, homeUid, awayUid) {
  const pool = data && data.stats && data.stats.uniqueteams;
  if (!pool || typeof pool !== 'object') return null;
  const extract = (uid) => {
    const t = pool[String(uid)];
    if (!t || typeof t !== 'object') return null;
    const avg = (k) => (t[k] && typeof t[k].average === 'number' && Number.isFinite(t[k].average) ? t[k].average : null);
    const tot = (k) => (t[k] && typeof t[k].total === 'number' && Number.isFinite(t[k].total) ? t[k].total : null);
    const mp = (t.matches && typeof t.matches.matches === 'number') ? t.matches.matches : (t.matches && typeof t.matches.total === 'number' ? t.matches.total : null);
    const parsed = {
      uid,
      name: (t.uniqueteam && (t.uniqueteam.mediumname || t.uniqueteam.name)) || '',
      matches: mp,
      cornersAvg: avg('corner_kicks'),
      cornersTotal: tot('corner_kicks'),
      shotsOnGoalAvg: avg('shots_on_goal'),
      shotsOffGoalAvg: avg('shots_off_goal'),
      shotsBlockedAvg: avg('shots_blocked'),
      cardsAvg: avg('cards_given'),
      yellowCardsAvg: avg('yellow_cards'),
      redCardsAvg: avg('red_cards'),
      freekicksAvg: avg('freekicks'),
      offsidesAvg: avg('offside'),
      possessionAvg: avg('ball_possession'),
      goalsScoredAvg: avg('goals_scored'),
      goalsConcededAvg: avg('goals_conceded'),
      cleanSheetAvg: avg('clean_sheet'),
      schemaVersion: 'sportradar_uniqueteamstats_v1',
    };
    const hasAnyMetric = [parsed.cornersAvg, parsed.shotsOnGoalAvg, parsed.cardsAvg, parsed.possessionAvg, parsed.goalsScoredAvg].some((v) => v != null);
    return hasAnyMetric ? parsed : null;
  };
  const h = extract(homeUid);
  const a = extract(awayUid);
  if (!h && !a) return null;
  return { home: h, away: a };
}

// Parser for Sportradar gismo/match_markets/{matchId} statistical model probabilities
// (independent of BangBet's live betting market extraction in extract.js).
function parseMatchMarketsProbabilities(data, expectedMatchId) {
  if (!data || !Array.isArray(data.markets)) return null;
  let probs = null;
  const extra = {};
  for (const m of data.markets) {
    if (!m || !Array.isArray(m.outcomes)) continue;
    if (expectedMatchId && m._matchId && Number(m._matchId) !== Number(expectedMatchId)) continue;
    const mid = Number(m._marketId || 0);
    const name = String(m.name || '').toLowerCase();
    if (mid === 1 || name === '1x2') {
      const o1 = m.outcomes.find((o) => o._id === 'sr:outcome:1' || /competitor1/i.test(o.name || ''));
      const ox = m.outcomes.find((o) => o._id === 'sr:outcome:2' || /draw/i.test(o.name || ''));
      const o2 = m.outcomes.find((o) => o._id === 'sr:outcome:3' || /competitor2/i.test(o.name || ''));
      if (o1 && o2 && typeof o1.probability === 'number' && typeof o2.probability === 'number') {
        const pH = o1.probability;
        const pX = ox && typeof ox.probability === 'number' ? ox.probability : 0;
        const pA = o2.probability;
        const sum = pH + pX + pA;
        if (sum > 0.5) probs = { H: +(pH / sum).toFixed(4), X: +(pX / sum).toFixed(4), A: +(pA / sum).toFixed(4) };
      }
    } else if (mid === 10 || name === 'double chance') {
      extra.doubleChance = m.outcomes.map((o) => ({ name: o.name, p: o.probability != null ? +o.probability.toFixed(4) : null }));
    } else if (mid === 60 || name === '1st half - 1x2') {
      extra.firstHalf1x2 = m.outcomes.map((o) => ({ name: o.name, p: o.probability != null ? +o.probability.toFixed(4) : null }));
    }
  }
  if (!probs && !Object.keys(extra).length) return null;
  return { probs, extra, schemaVersion: 'sportradar_match_markets_prob_v1' };
}

function parseDisciplinary(data) {
  if (!data || !data.team || !data.stats) return null;
  return {
    uid: Number(data.team._id || data.team.uid || 0),
    matches: numOf(data.stats.totalmatches, 'total'),
    yellowAvg: numOf(data.stats.yellowcardsaverage, 'total'),
    redAvg: numOf(data.stats.redcardsaverage, 'total'),
    yellowRedAvg: numOf(data.stats.yellowredcardsaverage, 'total'),
    penaltiesAgainstAvg: numOf(data.stats.penaltiesawardedagainstaverage, 'total'),
    schemaVersion: 'sportradar_disciplinary_v1',
  };
}

// Per-page network observer bound to a shared GismoCache.
// Tracks pending async body reads, capture-token fixture isolation, failures, and unknown endpoints.
class GismoPageObserver {
  constructor(page, cache, opts = {}) {
    this.page = page;
    this.cache = cache || new GismoCache();
    this.saveEvidenceDir = opts.saveEvidenceDir || '';
    this.activeMatchId = 0;
    this.records = [];
    this.startedAt = 0;
    this.captureToken = 0;
    this.pendingResponses = new Set();
    this.lastGismoResponseAt = 0;
    this._resetTelemetry();

    this._handler = (res) => {
      const url = res.url();
      if (IGNORED_DOMAINS.test(url)) return;
      const isGismo = /\/gismo\//i.test(url);
      const isLicensing = /licensing/i.test(url) && /akamaized|sportradar/i.test(url);
      const isCandidateApi = isGismo || isLicensing || (/bangbet\.com\/api\//i.test(url) && !/casino-api/i.test(url));
      if (!isCandidateApi) return;

      if (isGismo) this.lastGismoResponseAt = Date.now();
      const token = this.captureToken;
      const task = this._onResponse(res, token, isGismo, isLicensing);
      this.pendingResponses.add(task);
      task.then(() => this.pendingResponses.delete(task), () => this.pendingResponses.delete(task));
    };

    this._failHandler = (req) => {
      const url = req.url();
      if (!/\/gismo\/|sportradar|akamaized.*(licensing|gismo|sir)/i.test(url)) return;
      this.telemetry.failedRequests.push({
        url: redactUrl(url),
        isGismo: /\/gismo\//i.test(url),
        errorText: req.failure() ? req.failure().errorText : 'failed',
        at: Date.now(),
      });
    };

    page.on('response', this._handler);
    if (typeof page.on === 'function') {
      try { page.on('requestfailed', this._failHandler); } catch (_) {}
    }
  }

  _resetTelemetry() {
    this.seenUrls = new Set();
    this.telemetry = {
      responsesObserved: 0,
      gismoResponsesReceived: 0,
      bodiesRead: 0,
      bodyReadFailures: 0,
      jsonParsed: 0,
      jsonParseFailures: 0,
      relevantStatResponses: 0,
      duplicateResponses: 0,
      lateDiscarded: 0,
      licensingStatus: 'not_observed', // ok | failed | not_observed
      httpErrors: [],
      failedRequests: [],
      bodyErrors: [],
      parseErrors: [],
      apiExceptions: [],
      unknownRelevant: [],
    };
  }

  beginFixture(ev) {
    this.activeMatchId = extractMatchIdFromUrl(ev && ev.url) || Number(ev && ev.matchId) || 0;
    this.records = [];
    this.startedAt = Date.now();
    this.captureToken++;
    this.lastGismoResponseAt = 0;
    this._resetTelemetry();
  }

  isQuietFor(ms = 1400) {
    return this.pendingResponses.size === 0 &&
      (!this.lastGismoResponseAt || Date.now() - this.lastGismoResponseAt >= ms);
  }

  async waitForQuiet(quietMs = 1400, maxWaitMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      if (this.isQuietFor(quietMs)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.pendingResponses.size === 0;
  }

  detach() {
    try { this.page.off('response', this._handler); } catch (_) {}
    try { this.page.off('requestfailed', this._failHandler); } catch (_) {}
  }

  async _onResponse(res, captureToken = this.captureToken, isGismo = false, isLicensing = false) {
    const url = res.url();
    if (IGNORED_DOMAINS.test(url)) return;
    const status = res.status();
    if (captureToken === this.captureToken) {
      this.telemetry.responsesObserved++;
      if (isGismo) this.telemetry.gismoResponsesReceived++;
    }

    if (status < 200 || status >= 300) {
      if (captureToken === this.captureToken) {
        if (isLicensing) this.telemetry.licensingStatus = `http_${status}`;
        if (isGismo || isLicensing) {
          this.telemetry.httpErrors.push({ url: redactUrl(url), status, isGismo });
        }
      }
      return;
    }

    const ct = ((res.headers && res.headers()['content-type']) || '').toLowerCase();
    if (ct && !ct.includes('json') && !ct.includes('javascript') && !ct.includes('text/plain')) return;

    const t0 = Date.now();
    let txt = '';
    try {
      txt = await res.text();
    } catch (e) {
      if (captureToken === this.captureToken) {
        this.telemetry.bodyReadFailures++;
        this.telemetry.bodyErrors.push({ url: redactUrl(url), error: e.message });
      }
      return;
    }
    if (!txt || txt.length > 4e6) return;
    if (captureToken === this.captureToken) this.telemetry.bodiesRead++;

    let body;
    try {
      body = JSON.parse(txt);
    } catch (e) {
      if (captureToken === this.captureToken) {
        this.telemetry.jsonParseFailures++;
        this.telemetry.parseErrors.push({ url: redactUrl(url), error: 'invalid_json: ' + e.message });
      }
      return;
    }
    if (captureToken === this.captureToken) this.telemetry.jsonParsed++;

    // Strictly reject late responses from previous fixture
    if (captureToken !== this.captureToken) {
      this.telemetry.lateDiscarded++;
      return;
    }

    const cls = classifyEndpoint(url, body);
    if (cls.category === 'widget_licensing') {
      this.telemetry.licensingStatus = cls.valid ? 'ok' : 'invalid';
      return;
    }
    if (cls.category === 'api_exception') {
      this.telemetry.apiExceptions.push({ pattern: cls.pattern, ...cls.exception });
      this.cache.recordPattern(cls.pattern, 'api_exception', false, 'api_exception');
      return;
    }
    if (cls.category === 'ignored') return;

    // Deduplicate identical URL deliveries inside the same fixture
    const normUrlKey = url.split('?')[0];
    if (this.seenUrls.has(normUrlKey)) {
      this.telemetry.duplicateResponses++;
    } else {
      this.seenUrls.add(normUrlKey);
    }

    this.cache.recordPattern(cls.pattern, cls.category, cls.valid, cls.bucket);

    if (cls.bucket === 'unknown_potentially_relevant') {
      this.cache.recordUnknown(cls.pattern, cls.schema, url);
      this.telemetry.unknownRelevant.push({
        pattern: cls.pattern,
        category: cls.category,
        schema: cls.schema,
        bytes: txt.length,
      });
    }

    if (!cls.valid) return;
    if (cls.bucket === 'genuine_statistics') this.telemetry.relevantStatResponses++;

    // Optional bounded raw evidence archiving (secrets redacted)
    if (this.saveEvidenceDir && this.activeMatchId && txt.length <= 500000) {
      try {
        const dir = path.join(this.saveEvidenceDir, `match_${this.activeMatchId}`);
        fs.mkdirSync(dir, { recursive: true });
        const safe = `${String(this.records.length + 1).padStart(2, '0')}_${cls.category}_${cls.endpoint.replace(/[^a-z0-9_]/gi, '_')}.json`;
        fs.writeFileSync(path.join(dir, safe), txt);
      } catch (_) {}
    }

    const rec = {
      url: redactUrl(url),
      category: cls.category,
      bucket: cls.bucket,
      endpoint: cls.endpoint,
      args: cls.args,
      pattern: cls.pattern,
      schema: cls.schema,
      data: cls.data,
      bytes: txt.length,
      at: t0,
      elapsedMs: this.startedAt ? t0 - this.startedAt : 0,
    };
    this.records.push(rec);
    this._storeInCache(rec);
  }

  _ingestDirectBody(url, body, captureToken = this.captureToken) {
    if (captureToken !== this.captureToken || !body || typeof body !== 'object') return false;
    const t0 = Date.now();
    this.telemetry.responsesObserved++;
    this.telemetry.gismoResponsesReceived++;
    this.telemetry.bodiesRead++;
    this.telemetry.jsonParsed++;

    const cls = classifyEndpoint(url, body);
    if (cls.category === 'api_exception') {
      this.telemetry.apiExceptions.push({ pattern: cls.pattern, ...cls.exception });
      this.cache.recordPattern(cls.pattern, 'api_exception', false, 'api_exception');
      return false;
    }
    if (cls.category === 'ignored' || !cls.valid) return false;
    if (cls.bucket === 'genuine_statistics') this.telemetry.relevantStatResponses++;

    const normUrlKey = url.split('?')[0];
    if (!this.seenUrls.has(normUrlKey)) this.seenUrls.add(normUrlKey);
    this.cache.recordPattern(cls.pattern, cls.category, cls.valid, cls.bucket);

    const rec = {
      url: redactUrl(url),
      category: cls.category,
      bucket: cls.bucket,
      endpoint: cls.endpoint,
      args: cls.args,
      pattern: cls.pattern,
      schema: cls.schema,
      data: cls.data,
      bytes: JSON.stringify(body).length,
      at: t0,
      elapsedMs: this.startedAt ? t0 - this.startedAt : 0,
    };
    this.records.push(rec);
    this._storeInCache(rec);
    return true;
  }

  // Direct read-only fetch against Sportradar's public stats.fn.sportradar.com Gismo endpoints
  // when the embedded BangBet widget iframe (sportcenter.sir.sportradar.com/luckybus) fails to boot
  // (e.g. HTTP 403 / ORB on cloud runners). Reuses the exact same GismoCache and parser pipeline.
  async fetchDirectForMatch(ev, opts = {}) {
    const fetchFn = opts.fetch || global.fetch;
    if (typeof fetchFn !== 'function') return false;
    const mid = Number((ev && ev.matchId) || extractMatchIdFromUrl(ev && ev.url) || this.activeMatchId || 0);
    if (!mid) return false;
    const token = this.captureToken;
    const base = 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo';
    const timeoutMs = Number(opts.timeoutMs) || 8000;
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    };

    const getOne = async (relPath) => {
      const url = `${base}/${relPath}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(url, { method: 'GET', headers, signal: ctrl.signal });
        if (!res.ok) {
          if (token === this.captureToken) {
            this.telemetry.httpErrors.push({ url: redactUrl(url), status: res.status, isGismo: true });
          }
          return null;
        }
        const body = await res.json();
        this._ingestDirectBody(url, body, token);
        return body;
      } catch (e) {
        if (token === this.captureToken) {
          this.telemetry.failedRequests.push({
            url: redactUrl(url),
            isGismo: true,
            errorText: String(e && e.message ? e.message : e),
            at: Date.now(),
          });
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // Wave 1: match_info + match_markets (win probabilities)
    let mi = this.cache.get(`match_info:${mid}`);
    const w1 = [];
    if (!mi) w1.push(getOne(`match_info/${mid}`));
    if (!this.cache.get(`match_probs:${mid}`)) w1.push(getOne(`match_markets/${mid}`));
    if (w1.length) await Promise.all(w1);

    mi = this.cache.get(`match_info:${mid}`);
    const match = mi && mi.match;
    if (!match || !match.teams) return false;

    const seasonId = match._seasonid || 0;
    const homeUid = Number((match.teams.home && (match.teams.home.uid || match.teams.home._id)) || 0);
    const awayUid = Number((match.teams.away && (match.teams.away.uid || match.teams.away._id)) || 0);

    // Wave 2: team form, H2H, standings, over/under, unique team stats, scoring/conceding, disciplinary (cached per team/season)
    const w2 = [];
    if (homeUid && !this.cache.get(`team_lastx:${homeUid}`)) w2.push(getOne(`stats_team_lastx/${homeUid}`));
    if (awayUid && !this.cache.get(`team_lastx:${awayUid}`)) w2.push(getOne(`stats_team_lastx/${awayUid}`));
    if (homeUid && awayUid) {
      const h2hKey = `h2h:${Math.min(homeUid, awayUid)}:${Math.max(homeUid, awayUid)}`;
      if (!this.cache.get(h2hKey)) w2.push(getOne(`stats_team_versusrecent/${homeUid}/${awayUid}`));
    }
    if (seasonId) {
      if (!this.cache.get(`season_tables:${seasonId}`)) w2.push(getOne(`stats_season_tables/${seasonId}`));
      if (!this.cache.get(`season_ou:${seasonId}`)) w2.push(getOne(`stats_season_overunder/${seasonId}`));
      if (!this.cache.get(`season_uniqueteamstats:${seasonId}`)) w2.push(getOne(`stats_season_uniqueteamstats/${seasonId}`));
      if (homeUid && !this.cache.get(`season_scoring:${seasonId}:${homeUid}`)) w2.push(getOne(`stats_season_teamscoringconceding/${seasonId}/${homeUid}`));
      if (awayUid && !this.cache.get(`season_scoring:${seasonId}:${awayUid}`)) w2.push(getOne(`stats_season_teamscoringconceding/${seasonId}/${awayUid}`));
      if (homeUid && !this.cache.get(`team_disc:${seasonId}:${homeUid}`)) w2.push(getOne(`stats_season_teamdisciplinary/${seasonId}/${homeUid}`));
      if (awayUid && !this.cache.get(`team_disc:${seasonId}:${awayUid}`)) w2.push(getOne(`stats_season_teamdisciplinary/${seasonId}/${awayUid}`));
    }
    if (w2.length) await Promise.all(w2);
    return true;
  }

  _storeInCache(rec) {
    const { category, args, data } = rec;
    if (category === 'match_info' && data.match && data.match._id) {
      this.cache.set(`match_info:${data.match._id}`, data, 30 * 60 * 1000);
    } else if (category === 'match_markets') {
      const mid = Number(args[0] || (data.markets && data.markets[0] && data.markets[0]._matchId) || 0);
      const parsed = parseMatchMarketsProbabilities(data, mid);
      if (mid && parsed) this.cache.set(`match_probs:${mid}`, parsed, 30 * 60 * 1000);
    } else if (category === 'team_scoring_conceding' && args.length >= 2) {
      const seasonId = args[0];
      const uid = Number((data.team && data.team._id) || args[1] || 0);
      const parsed = parseScoringConceding(data);
      if (seasonId && uid && parsed) this.cache.set(`season_scoring:${seasonId}:${uid}`, parsed, 30 * 60 * 1000);
    } else if (category === 'team_recent_matches') {
      const uid = Number((data.team && data.team._id) || args[0] || 0);
      const parsed = parseRecentMatches(data, uid);
      if (uid && parsed) this.cache.set(`team_lastx:${uid}`, parsed, 15 * 60 * 1000);
    } else if (category === 'head_to_head' && args.length >= 2) {
      const a = Number(args[0]), b = Number(args[1]);
      if (a && b) {
        const key = `h2h:${Math.min(a, b)}:${Math.max(a, b)}`;
        this.cache.set(key, data, 30 * 60 * 1000);
      }
    } else if (category === 'season_over_under' && args.length >= 1) {
      this.cache.set(`season_ou:${args[0]}`, data, 30 * 60 * 1000);
    } else if (category === 'season_standings') {
      const sid = (data && (data.seasonid || data._id)) || args[0];
      if (sid) this.cache.set(`season_tables:${sid}`, data, 30 * 60 * 1000);
    } else if (category === 'team_disciplinary' && args.length >= 2) {
      const parsed = parseDisciplinary(data);
      if (parsed && parsed.uid) this.cache.set(`team_disc:${args[0]}:${parsed.uid}`, parsed, 30 * 60 * 1000);
    } else if (category === 'season_team_stats' && args.length >= 1) {
      const sid = (data && data.season && data.season._id) || args[0];
      if (sid) this.cache.set(`season_uniqueteamstats:${sid}`, data, 30 * 60 * 1000);
    }
  }

  // Strictly associates captured + cached statistics with `ev` by explicit fixtureId & team UIDs.
  // Never assigns teams by arrival order and never invents missing values.
  assemble(ev) {
    const fixtureId = this.activeMatchId || extractMatchIdFromUrl(ev && ev.url) || Number(ev && ev.matchId) || 0;
    const parseFailures = [];
    const associationFailures = [];
    const out = {
      available: false,
      status: 'unavailable', // complete | partial | captured_unparsed | no_data_returned | request_failed | body_read_failed | parse_failed | association_failed | unavailable
      source: 'bangbet-gismo',
      fixtureId,
      seasonId: 0,
      competition: (ev && ev.league) || '',
      country: (ev && ev.country) || '',
      homeTeam: null,
      awayTeam: null,
      homeForm: '',
      awayForm: '',
      homeFormSplit: null,
      awayFormSplit: null,
      h2h: null,
      h2hStatus: 'not_captured', // verified | no_prior_meetings | not_captured
      standings: null,
      goals: null,
      pct: [],
      probs: null,
      modelProbabilities: null,
      avg: {},
      disciplinary: null,
      seasonOverUnder: null,
      advancedStats: null,
      previousMatches: { home: [], away: [] },
      categories: {
        teamIdentity: false,
        competition: false,
        teamSeasonScoring: false,
        recentMatches: false,
        headToHead: false,
        standings: false,
        overUnder: false,
        disciplinary: false,
        seasonTeamStats: false,
        winProbabilities: false,
      },
      provenance: {},
      endpointsCaptured: [...new Set(this.records.map((r) => r.pattern))],
      responseCount: this.records.length,
      captureMs: this.startedAt ? Date.now() - this.startedAt : 0,
      missing: [],
      parseFailures,
      associationFailures,
      diagnostics: {
        ...this.telemetry,
        pendingAtAssembly: this.pendingResponses.size,
      },
    };

    // 1) Resolve authoritative match_info strictly by fixtureId
    let mi = null;
    if (fixtureId) {
      const rec = this.records.find((r) => r.category === 'match_info' && Number(r.data && r.data.match && r.data.match._id) === fixtureId);
      mi = rec ? rec.data : this.cache.get(`match_info:${fixtureId}`);
    } else {
      const rec = this.records.find((r) => r.category === 'match_info');
      mi = rec ? rec.data : null;
    }

    if (!mi || !mi.match || !mi.match.teams || !mi.match.teams.home || !mi.match.teams.away) {
      out.missing.push('match_info');
      if (this.telemetry.failedRequests.some((f) => f.isGismo) || this.telemetry.httpErrors.some((e) => e.isGismo)) {
        out.status = 'request_failed';
      } else if (this.telemetry.bodyReadFailures > 0 && this.telemetry.bodiesRead === 0) {
        out.status = 'body_read_failed';
      } else if (this.telemetry.jsonParseFailures > 0 && this.telemetry.jsonParsed === 0) {
        out.status = 'parse_failed';
      } else if (this.telemetry.gismoResponsesReceived > 0 && this.records.length === 0) {
        out.status = 'captured_unparsed';
      } else if (this.telemetry.gismoResponsesReceived === 0) {
        out.status = 'no_data_returned';
      }
      return out;
    }

    const m = mi.match;
    if (fixtureId && Number(m._id) !== fixtureId) {
      out.status = 'association_failed';
      out.missing.push('fixture_id_mismatch');
      associationFailures.push(`match_info._id=${m._id} !== expected fixtureId=${fixtureId}`);
      return out;
    }

    const homeUid = Number(m.teams.home.uid || m.teams.home._id || 0);
    const awayUid = Number(m.teams.away.uid || m.teams.away._id || 0);
    const homeName = m.teams.home.mediumname || m.teams.home.name || '';
    const awayName = m.teams.away.mediumname || m.teams.away.name || '';
    const seasonId = Number(m._seasonid || (mi.season && mi.season._id) || 0);

    if (ev && ev.home && ev.away && homeName && awayName) {
      const hn = norm(homeName), an = norm(awayName);
      const eh = keyTok(ev.home), ea = keyTok(ev.away);
      const okHome = !eh || hn.includes(eh) || norm(ev.home).includes(keyTok(homeName));
      const okAway = !ea || an.includes(ea) || norm(ev.away).includes(keyTok(awayName));
      if (!okHome && !okAway) {
        out.status = 'association_failed';
        out.missing.push('team_name_mismatch');
        associationFailures.push(`expected "${ev.home} vs ${ev.away}", got "${homeName} vs ${awayName}"`);
        return out;
      }
    }

    out.fixtureId = Number(m._id || fixtureId);
    out.seasonId = seasonId;
    out.competitionId = Number((mi.tournament && (mi.tournament._id || mi.tournament.uid)) || m._tid || 0);
    out.stage = (mi.tournament && mi.tournament.seasontypename) || (mi.season && mi.season.name) || '';
    out.homeTeam = { uid: homeUid, name: homeName };
    out.awayTeam = { uid: awayUid, name: awayName };
    out.categories.teamIdentity = !!(homeUid && awayUid);
    out.provenance.teamIdentity = '/gismo/match_info';

    if (mi.tournament && mi.tournament.name) {
      out.competition = mi.tournament.name;
      out.categories.competition = true;
      out.provenance.competition = '/gismo/match_info';
    }
    if (mi.realcategory && mi.realcategory.name) {
      out.country = mi.realcategory.name;
    }
    out.competitionContext = {
      competitionId: out.competitionId,
      seasonId: out.seasonId,
      competition: out.competition,
      stage: out.stage,
      country: out.country,
    };

    // 2) Provider-supplied prematch win probabilities from match_markets/{matchId}
    // Explicitly recorded as providerEstimate — NEVER conflated with BetRobot's own modelProbability.
    if (out.fixtureId) {
      const mp = this.cache.get(`match_probs:${out.fixtureId}`);
      if (mp && mp.probs) {
        out.probs = mp.probs;
        out.modelProbabilities = mp.extra;
        out.providerEstimate = {
          winProbabilities: mp.probs,
          extra: mp.extra,
          predictedScore: null, // Sportradar match_markets does not supply a predicted exact scoreline
          source: 'sportradar-match_markets',
        };
        out.categories.winProbabilities = true;
        out.provenance.winProbabilities = '/gismo/match_markets';
      } else {
        out.missing.push('win_probabilities');
      }
    }

    // 3) Team-season scoring & conceding (strictly by seasonId + exact homeUid/awayUid)
    const hSc = seasonId && homeUid ? this.cache.get(`season_scoring:${seasonId}:${homeUid}`) : null;
    const aSc = seasonId && awayUid ? this.cache.get(`season_scoring:${seasonId}:${awayUid}`) : null;
    if (hSc && aSc && hSc.avgFor != null && aSc.avgFor != null && hSc.avgAg != null && aSc.avgAg != null) {
      out.goals = { hFor: hSc.avgFor, aFor: aSc.avgFor, hAg: hSc.avgAg, aAg: aSc.avgAg };
      out.teamStats = { home: hSc, away: aSc };
      out.categories.teamSeasonScoring = true;
      out.provenance.teamSeasonScoring = '/gismo/stats_season_teamscoringconceding';
      if (hSc.bttsPct != null && aSc.bttsPct != null) {
        out.pct.push({ label: 'both teams to score', vals: [hSc.bttsPct, aSc.bttsPct], source: 'season_scoring' });
      }
      if (hSc.htScorePct != null && aSc.htScorePct != null) {
        out.pct.push({ label: 'first half over 0.5', vals: [hSc.htScorePct, aSc.htScorePct], source: 'season_scoring' });
      }
    } else {
      out.missing.push('team_season_scoring');
    }

    // 4) Season Over/Under (FT + 1H + 2H + Home/Away splits) — schema-tolerant!
    if (seasonId && homeUid && awayUid) {
      const ouRaw = this.cache.get(`season_ou:${seasonId}`);
      if (ouRaw) {
        const ou = parseSeasonOverUnder(ouRaw, homeUid, awayUid);
        if (ou && ou.parsed) {
          out.seasonOverUnder = { values: ou.values, home: ou.home, away: ou.away };
          out.categories.overUnder = true;
          out.provenance.overUnder = '/gismo/stats_season_overunder';
          // Populate goal averages fallback if team_season_scoring has not arrived yet
          if (!out.goals && ou.home && ou.away && ou.home.goalsScoredFt && ou.away.goalsScoredFt && ou.home.concededFt && ou.away.concededFt) {
            const hFor = ou.home.goalsScoredFt.average;
            const aFor = ou.away.goalsScoredFt.average;
            const hAg = ou.home.concededFt.average;
            const aAg = ou.away.concededFt.average;
            if (hFor != null && aFor != null && hAg != null && aAg != null) {
              out.goals = { hFor, aFor, hAg, aAg };
              out.provenance.goals = '/gismo/stats_season_overunder';
            }
          }
          // Populate genuine 1H/2H scoring averages if Sportradar overunder supplied p1/p2 splits
          if (ou.home && ou.away && ou.home.goalsScoredP1 && ou.away.goalsScoredP1 && ou.home.concededP1 && ou.away.concededP1 &&
              ou.home.goalsScoredP2 && ou.away.goalsScoredP2 && ou.home.concededP2 && ou.away.concededP2) {
            const p1HFor = ou.home.goalsScoredP1.average;
            const p1AFor = ou.away.goalsScoredP1.average;
            const p1HAg = ou.home.concededP1.average;
            const p1AAg = ou.away.concededP1.average;
            const p2HFor = ou.home.goalsScoredP2.average;
            const p2AFor = ou.away.goalsScoredP2.average;
            const p2HAg = ou.home.concededP2.average;
            const p2AAg = ou.away.concededP2.average;
            if ([p1HFor, p1AFor, p1HAg, p1AAg, p2HFor, p2AFor, p2HAg, p2AAg].every((v) => typeof v === 'number' && Number.isFinite(v))) {
              out.goals = { ...(out.goals || {}), p1HFor, p1AFor, p1HAg, p1AAg, p2HFor, p2AFor, p2HAg, p2AAg };
              out.provenance.halfStats = '/gismo/stats_season_overunder (p1/p2)';
            }
          }
          // Add ALL available season FT, 1H, 2H Over/Under percentages dynamically (no hardcoded line list)
          if (ou.home && ou.away) {
            const availLines = Object.keys(ou.home.pct || {}).filter((line) => typeof (ou.away.pct || {})[line] === 'number');
            for (const line of availLines) {
              const hv = ou.home.pct[line];
              const av = ou.away.pct[line];
              if (typeof hv === 'number' && typeof av === 'number') {
                out.pct.push({ label: `over ${line}`, vals: [hv, av], source: 'season_overunder', sampleSize: Math.min(ou.home.matches || 0, ou.away.matches || 0) });
              }
            }
            for (const line of Object.keys(ou.home.p1 || {})) {
              if (ou.home.p1[line] && ou.away.p1 && ou.away.p1[line]) {
                const lbl = `first half over ${line}`;
                if (!out.pct.some((p) => p.label === lbl)) {
                  out.pct.push({ label: lbl, vals: [ou.home.p1[line].overPct, ou.away.p1[line].overPct], source: 'season_overunder', sampleSize: Math.min(ou.home.matches || 0, ou.away.matches || 0) });
                }
              }
            }
            for (const line of Object.keys(ou.home.p2 || {})) {
              if (ou.home.p2[line] && ou.away.p2 && ou.away.p2[line]) {
                const lbl = `second half over ${line}`;
                if (!out.pct.some((p) => p.label === lbl)) {
                  out.pct.push({ label: lbl, vals: [ou.home.p2[line].overPct, ou.away.p2[line].overPct], source: 'season_overunder', sampleSize: Math.min(ou.home.matches || 0, ou.away.matches || 0) });
                }
              }
            }
          }
        } else {
          out.missing.push('over_under');
          parseFailures.push({
            endpoint: '/gismo/stats_season_overunder',
            category: 'overUnder',
            reason: (ou && ou.reason) || 'parseSeasonOverUnder_returned_null',
            schema: (ou && ou.schema) || schemaFingerprint(ouRaw),
          });
        }
      } else {
        out.missing.push('over_under');
      }
    }

    // 5) Recent matches & form (strictly by exact homeUid / awayUid)
    // Explicitly separates competition-specific form (matching seasonId) from all-competitions form
    // and preserves exact per-team sample sizes (never assuming equal counts).
    const hRec = homeUid ? this.cache.get(`team_lastx:${homeUid}`) : null;
    const aRec = awayUid ? this.cache.get(`team_lastx:${awayUid}`) : null;
    if (hRec && aRec) {
      const hCompForm = filterCompetitionForm(hRec, seasonId);
      const aCompForm = filterCompetitionForm(aRec, seasonId);
      out.competitionForm = {
        seasonId,
        home: hCompForm,
        away: aCompForm,
      };
      out.allCompetitionsForm = {
        home: { overall: hRec.form, split: hRec.split, sampleSize: hRec.sampleSize },
        away: { overall: aRec.form, split: aRec.split, sampleSize: aRec.sampleSize },
      };
      // Prefer competition-specific form when available (even with unequal sample sizes like 5 vs 4),
      // falling back to all-competitions form only when competition-specific form is absent.
      out.homeForm = (hCompForm && hCompForm.overall) ? hCompForm.overall : hRec.form;
      out.awayForm = (aCompForm && aCompForm.overall) ? aCompForm.overall : aRec.form;
      out.homeFormContext = (hCompForm && hCompForm.overall) ? 'competition_specific' : 'all_competitions';
      out.awayFormContext = (aCompForm && aCompForm.overall) ? 'competition_specific' : 'all_competitions';
      out.homeFormSampleSize = (hCompForm && hCompForm.overall) ? hCompForm.sampleSize : hRec.sampleSize;
      out.awayFormSampleSize = (aCompForm && aCompForm.overall) ? aCompForm.sampleSize : aRec.sampleSize;
      out.homeFormSplit = (hCompForm && hCompForm.overall)
        ? { overall: hCompForm.overall, home: hCompForm.home, away: hCompForm.away, overallCount: hCompForm.sampleSize, homeCount: hCompForm.homeSampleSize, awayCount: hCompForm.awaySampleSize }
        : hRec.split;
      out.awayFormSplit = (aCompForm && aCompForm.overall)
        ? { overall: aCompForm.overall, home: aCompForm.home, away: aCompForm.away, overallCount: aCompForm.sampleSize, homeCount: aCompForm.homeSampleSize, awayCount: aCompForm.awaySampleSize }
        : aRec.split;
      out.previousMatches = { home: hRec.matches, away: aRec.matches };
      out.categories.recentMatches = true;
      out.provenance.recentMatches = '/gismo/stats_team_lastxextended';
      if (!out.goals && hRec.avgFor != null && aRec.avgFor != null && hRec.avgAg != null && aRec.avgAg != null) {
        out.goals = { hFor: hRec.avgFor, aFor: aRec.avgFor, hAg: hRec.avgAg, aAg: aRec.avgAg };
        out.provenance.goals = '/gismo/stats_team_lastxextended';
      }
      // Attach genuine 1H/2H scoring & half-win stats ONLY when real period scores were parsed (never fabricated)
      if (hRec.halfStats || aRec.halfStats) {
        out.halfStats = { home: hRec.halfStats || null, away: aRec.halfStats || null };
        if (hRec.halfStats && aRec.halfStats && hRec.halfStats.sampleSize >= 2 && aRec.halfStats.sampleSize >= 2) {
          out.goals = out.goals || {};
          if (out.goals.p1HFor == null) out.goals.p1HFor = hRec.halfStats.p1AvgFor;
          if (out.goals.p1AAg == null) out.goals.p1AAg = aRec.halfStats.p1AvgAg;
          if (out.goals.p1AFor == null) out.goals.p1AFor = aRec.halfStats.p1AvgFor;
          if (out.goals.p1HAg == null) out.goals.p1HAg = hRec.halfStats.p1AvgAg;
          if (out.goals.p2HFor == null) out.goals.p2HFor = hRec.halfStats.p2AvgFor;
          if (out.goals.p2AAg == null) out.goals.p2AAg = aRec.halfStats.p2AvgAg;
          if (out.goals.p2AFor == null) out.goals.p2AFor = aRec.halfStats.p2AvgFor;
          if (out.goals.p2HAg == null) out.goals.p2HAg = hRec.halfStats.p2AvgAg;
          out.provenance.halfStats = '/gismo/stats_team_lastxextended (periods.p1)';
        }
      }
      if (hRec.ov15Pct != null && aRec.ov15Pct != null && !out.pct.some((p) => p.label === 'over 1.5')) {
        out.pct.push({ label: 'over 1.5', vals: [hRec.ov15Pct, aRec.ov15Pct], source: 'recent_matches', sampleSize: Math.min(hRec.sampleSize || 0, aRec.sampleSize || 0), context: 'all_competitions' });
      }
      if (hRec.ov25Pct != null && aRec.ov25Pct != null && !out.pct.some((p) => p.label === 'over 2.5')) {
        out.pct.push({ label: 'over 2.5', vals: [hRec.ov25Pct, aRec.ov25Pct], source: 'recent_matches', sampleSize: Math.min(hRec.sampleSize || 0, aRec.sampleSize || 0), context: 'all_competitions' });
      }
      if (hRec.bttsPct != null && aRec.bttsPct != null && !out.pct.some((p) => p.label === 'both teams to score')) {
        out.pct.push({ label: 'both teams to score', vals: [hRec.bttsPct, aRec.bttsPct], source: 'recent_matches', sampleSize: Math.min(hRec.sampleSize || 0, aRec.sampleSize || 0), context: 'all_competitions' });
      }
    } else {
      out.missing.push('recent_matches');
    }

    // 6) Head-to-head (distinguish verified meetings vs verified zero-prior-meetings vs not captured)
    if (homeUid && awayUid) {
      const h2hRaw = this.cache.get(`h2h:${Math.min(homeUid, awayUid)}:${Math.max(homeUid, awayUid)}`);
      if (h2hRaw) {
        const h2h = parseH2H(h2hRaw, homeUid, awayUid);
        if (h2h && h2h.n > 0) {
          out.h2h = {
            n: h2h.n, H: h2h.H, X: h2h.X, A: h2h.A,
            avgGoals: h2h.avgGoals,
            homeGoalsAvg: h2h.homeGoalsAvg,
            awayGoalsAvg: h2h.awayGoalsAvg,
            bttsPct: h2h.bttsPct,
            over15Pct: h2h.over15Pct,
            over25Pct: h2h.over25Pct,
          };
          out.h2hMeetings = h2h.meetings;
          out.h2hStatus = 'verified';
          out.categories.headToHead = true;
          out.provenance.headToHead = '/gismo/stats_team_versusrecent';
        } else if (h2h && h2h.noPriorMeetings) {
          out.h2hStatus = 'no_prior_meetings';
          out.provenance.headToHead = '/gismo/stats_team_versusrecent (0 prior meetings)';
          out.missing.push('head_to_head_no_prior_meetings');
        } else {
          out.missing.push('head_to_head');
          parseFailures.push({ endpoint: '/gismo/stats_team_versusrecent', category: 'headToHead', reason: 'unrecognized_h2h_schema', schema: schemaFingerprint(h2hRaw) });
        }
      } else {
        out.missing.push('head_to_head');
      }
    }

    // 7) Competition standings (strictly by seasonId + homeUid/awayUid)
    if (seasonId && homeUid && awayUid) {
      const tblRaw = this.cache.get(`season_tables:${seasonId}`);
      if (tblRaw) {
        const st = parseStandings(tblRaw, homeUid, awayUid);
        if (st) {
          out.standings = st;
          out.categories.standings = true;
          out.provenance.standings = '/gismo/stats_season_tables';
        } else {
          out.missing.push('standings');
          parseFailures.push({ endpoint: '/gismo/stats_season_tables', category: 'standings', reason: `teams_${homeUid}_${awayUid}_not_in_table`, schema: schemaFingerprint(tblRaw) });
        }
      } else {
        out.missing.push('standings');
      }
    }

    // 8) Season Unique Team Stats (corners, shots, possession, cards, clean sheets, offsides)
    if (seasonId && homeUid && awayUid) {
      const uRaw = this.cache.get(`season_uniqueteamstats:${seasonId}`);
      if (uRaw) {
        const adv = parseUniqueTeamStats(uRaw, homeUid, awayUid);
        if (adv) {
          out.advancedStats = adv;
          out.categories.seasonTeamStats = true;
          out.provenance.seasonTeamStats = '/gismo/stats_season_uniqueteamstats';
          if (adv.home && adv.away) {
            if (adv.home.cornersAvg != null && adv.away.cornersAvg != null) {
              out.avg.corners = +(adv.home.cornersAvg + adv.away.cornersAvg).toFixed(2);
            }
            if (adv.home.cardsAvg != null && adv.away.cardsAvg != null) {
              out.avg['total cards'] = +(adv.home.cardsAvg + adv.away.cardsAvg).toFixed(2);
            }
            if (adv.home.shotsOnGoalAvg != null && adv.away.shotsOnGoalAvg != null) {
              out.avg['shots on target'] = +(adv.home.shotsOnGoalAvg + adv.away.shotsOnGoalAvg).toFixed(2);
            }
          }
        } else {
          out.missing.push('season_team_stats');
          parseFailures.push({ endpoint: '/gismo/stats_season_uniqueteamstats', category: 'seasonTeamStats', reason: `teams_${homeUid}_${awayUid}_not_in_uniqueteamstats`, schema: schemaFingerprint(uRaw) });
        }
      } else {
        out.missing.push('season_team_stats');
      }
    }

    // 9) Disciplinary (cards & penalties)
    if (seasonId && homeUid && awayUid) {
      const hd = this.cache.get(`team_disc:${seasonId}:${homeUid}`);
      const ad = this.cache.get(`team_disc:${seasonId}:${awayUid}`);
      if (hd || ad) {
        out.disciplinary = { home: hd, away: ad };
        out.categories.disciplinary = true;
        out.provenance.disciplinary = '/gismo/stats_season_teamdisciplinary';
        if (hd && ad && hd.yellowAvg != null && ad.yellowAvg != null && out.avg['total cards'] == null) {
          out.avg['total cards'] = +(hd.yellowAvg + ad.yellowAvg).toFixed(2);
        }
      } else {
        out.missing.push('disciplinary');
      }
    }

    // Determine explicit status: NEVER label partial data as complete.
    // "complete" requires teamIdentity + recentMatches + (teamSeasonScoring OR overUnder) + (headToHead OR standings OR h2hStatus === 'no_prior_meetings').
    const hasIdentity = out.categories.teamIdentity;
    const hasScoring = out.categories.teamSeasonScoring || out.categories.overUnder;
    const hasRecent = out.categories.recentMatches;
    const hasContext = out.categories.headToHead || out.categories.standings || out.h2hStatus === 'no_prior_meetings';

    if (hasIdentity && hasScoring && hasRecent && hasContext) {
      out.available = true;
      out.status = 'complete';
    } else if (hasIdentity && (hasScoring || hasRecent || hasContext || out.categories.winProbabilities || out.categories.seasonTeamStats)) {
      out.available = true;
      out.status = 'partial';
    } else if (this.records.length > 0) {
      out.available = false;
      out.status = 'captured_unparsed';
    } else {
      out.available = false;
      out.status = 'unavailable';
    }
    return out;
  }
}

module.exports = {
  GismoCache,
  GismoPageObserver,
  classifyEndpoint,
  extractMatchIdFromUrl,
  schemaFingerprint,
  redactUrl,
  parseScoringConceding,
  parseRecentMatches,
  filterCompetitionForm,
  parseH2H,
  parseStandings,
  parseSeasonOverUnder,
  parseUniqueTeamStats,
  parseMatchMarketsProbabilities,
  parseDisciplinary,
};
