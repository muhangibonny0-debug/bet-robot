'use strict';
// Automatic BangBet / Sportradar Gismo JSON network discovery, classification,
// strict fixture/team ID association, and TTL-bounded session caching.
const { norm, keyTok } = require('./util');

const IGNORED_DOMAINS = /(googlesyndication|doubleclick|google-analytics|googletagmanager|facebook\.net|adjust\.com|zendesk|zdassets|hotjar|tiktok|sentry\.io|ads\.)/i;

function extractMatchIdFromUrl(url) {
  const s = decodeURIComponent(String(url || ''));
  const m = s.match(/sr:match:(\d+)/i) || s.match(/matchId=(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function parseGismoPath(url) {
  const m = String(url || '').match(/\/gismo\/([^/?#]+)((?:\/[^/?#]+)*)/i);
  if (!m) return null;
  const endpoint = m[1].toLowerCase();
  const args = (m[2] || '').split('/').filter(Boolean);
  return { endpoint, args, pattern: `/gismo/${endpoint}` };
}

function classifyEndpoint(url, body) {
  const p = parseGismoPath(url);
  if (!p) return { category: 'ignored', endpoint: '', args: [], pattern: '' };
  const doc = Array.isArray(body && body.doc) && body.doc.length ? body.doc[0] : null;
  const evName = String((doc && doc.event) || p.endpoint || '').toLowerCase();
  const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : null;

  let category = 'other_gismo';
  if (evName === 'match_info' || p.endpoint === 'match_info') category = 'match_info';
  else if (evName.includes('teamscoringconceding') || p.endpoint.includes('teamscoringconceding')) category = 'team_scoring_conceding';
  else if (evName.includes('versusrecent') || p.endpoint.includes('versusrecent')) category = 'head_to_head';
  else if (evName.includes('team_lastx') || p.endpoint.includes('team_lastx')) category = 'team_recent_matches';
  else if (evName.includes('season_overunder') || p.endpoint.includes('season_overunder')) category = 'season_over_under';
  else if (evName.includes('season_tables') || evName.includes('tableslice') || p.endpoint.includes('tables')) category = 'season_standings';
  else if (evName.includes('disciplinary') || p.endpoint.includes('disciplinary')) category = 'team_disciplinary';
  else if (evName.includes('uniqueteamstats') || p.endpoint.includes('uniqueteamstats')) category = 'season_team_stats';
  else if (evName.includes('timeline') || evName.includes('detailsextended')) category = 'match_timeline';
  else if (evName === 'match_markets' || p.endpoint === 'match_markets') category = 'match_markets';
  else if (evName.includes('fixtures') || p.endpoint.includes('fixtures')) category = 'season_fixtures';

  const valid = !!(data && Object.keys(data).length > 0);
  return { category, endpoint: evName || p.endpoint, args: p.args, pattern: p.pattern, data, valid };
}

class GismoCache {
  constructor() {
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.discoveredPatterns = new Map(); // pattern -> { category, count, usefulCount }
  }

  recordPattern(pattern, category, useful) {
    if (!pattern) return;
    const cur = this.discoveredPatterns.get(pattern) || { category, count: 0, usefulCount: 0 };
    cur.count++;
    if (useful) cur.usefulCount++;
    this.discoveredPatterns.set(pattern, cur);
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
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      discoveredPatterns: patterns,
    };
  }
}

// Extract numeric average helper from Sportradar { total, home, away } objects
function numOf(obj, key = 'total') {
  if (typeof obj === 'number' && Number.isFinite(obj)) return obj;
  if (obj && typeof obj === 'object' && Number.isFinite(Number(obj[key]))) return Number(obj[key]);
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
  const bttsCount = numOf(sc.bothteamsscored, 'total');
  const bttsPct = matches > 0 && bttsCount != null ? Math.round((bttsCount / matches) * 100) : null;
  const htScoreCount = numOf(sc.scoringathalftime, 'total');
  const htScorePct = matches > 0 && htScoreCount != null ? Math.round((htScoreCount / matches) * 100) : null;
  const ftsCount = numOf(sc.failedtoscore, 'total');
  const csCount = numOf(co.cleansheets, 'total') ?? numOf(co.clean_sheets, 'total');

  return {
    uid,
    name: data.team.mediumname || data.team.name || '',
    matches, homeMatches, awayMatches, wins,
    goalsFor, goalsForHome, goalsForAway,
    goalsAg, goalsAgHome, goalsAgAway,
    avgFor, avgAg, bttsPct, htScorePct,
    failedToScore: ftsCount,
    cleanSheets: csCount,
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
    overall.push(letter);
    if (isHome) homeOnly.push(letter);
    else awayOnly.push(letter);
    if (counted < 10) {
      counted++;
      scoredSum += gf;
      concededSum += ga;
      if (gf + ga >= 2) ov15++;
      if (gf + ga >= 3) ov25++;
      if (gf > 0 && ga > 0) btts++;
    }
    if (history.length < 10) {
      history.push({
        matchId: Number(m._id || 0),
        date: (m._dt && m._dt.date) || '',
        uts: (m._dt && m._dt.uts) || 0,
        home: (m.teams.home && (m.teams.home.mediumname || m.teams.home.name)) || '',
        away: (m.teams.away && (m.teams.away.mediumname || m.teams.away.name)) || '',
        score: `${rh}-${ra}`,
        role: isHome ? 'home' : 'away',
        result: letter,
      });
    }
  }
  if (!overall.length) return null;
  return {
    uid,
    form: overall.slice(0, 5).join(''),
    split: {
      overall: overall.slice(0, 5).join(''),
      home: homeOnly.slice(0, 5).join(''),
      away: awayOnly.slice(0, 5).join(''),
    },
    sampleSize: counted,
    avgFor: counted ? +(scoredSum / counted).toFixed(2) : null,
    avgAg: counted ? +(concededSum / counted).toFixed(2) : null,
    ov15Pct: counted ? Math.round((ov15 / counted) * 100) : null,
    ov25Pct: counted ? Math.round((ov25 / counted) * 100) : null,
    bttsPct: counted ? Math.round((btts / counted) * 100) : null,
    matches: history,
  };
}

function parseH2H(data, homeUid, awayUid) {
  if (!data || !Array.isArray(data.matches) || !homeUid || !awayUid) return null;
  let H = 0, X = 0, A = 0;
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
      });
    }
  }
  const n = H + X + A;
  if (!n) return null;
  return { n, H, X, A, meetings };
}

function parseStandings(data, homeUid, awayUid) {
  if (!data) return null;
  const tables = Array.isArray(data.tables) ? data.tables : (Array.isArray(data.tablerows) ? [data] : []);
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

function parseSeasonOverUnder(data, homeUid, awayUid) {
  if (!data || !data.stats || typeof data.stats !== 'object') return null;
  const extractTeam = (uid) => {
    const t = data.stats[String(uid)];
    if (!t) return null;
    const out = {};
    const total = numOf(t.total, 'total') || numOf(t.matches, 'total') || 0;
    const over = t.over || t.overs || null;
    if (over && typeof over === 'object' && total > 0) {
      for (const [k, v] of Object.entries(over)) {
        const c = numOf(v, 'total');
        if (c != null) out[k] = Math.round((c / total) * 100);
      }
    }
    return Object.keys(out).length ? out : null;
  };
  const h = extractTeam(homeUid);
  const a = extractTeam(awayUid);
  if (!h && !a) return null;
  return { values: data.values || {}, home: h, away: a };
}

function parseDisciplinary(data) {
  if (!data || !data.team || !data.stats) return null;
  return {
    uid: Number(data.team._id || data.team.uid || 0),
    yellowAvg: numOf(data.stats.yellowcardsaverage, 'total'),
    redAvg: numOf(data.stats.redcardsaverage, 'total'),
  };
}

// Per-page Gismo network observer bound to a shared GismoCache
class GismoPageObserver {
  constructor(page, cache) {
    this.page = page;
    this.cache = cache || new GismoCache();
    this.activeMatchId = 0;
    this.records = []; // captured for active fixture
    this.startedAt = 0;
    this._handler = (res) => this._onResponse(res);
    page.on('response', this._handler);
  }

  beginFixture(ev) {
    this.activeMatchId = extractMatchIdFromUrl(ev && ev.url) || Number(ev && ev.matchId) || 0;
    this.records = [];
    this.startedAt = Date.now();
  }

  detach() {
    try { this.page.off('response', this._handler); } catch (_) {}
  }

  async _onResponse(res) {
    const url = res.url();
    if (!/\/gismo\//i.test(url) || IGNORED_DOMAINS.test(url)) return;
    const status = res.status();
    if (status < 200 || status >= 300) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct && !ct.includes('json') && !ct.includes('javascript') && !ct.includes('text/plain')) return;
    const t0 = Date.now();
    let body;
    try {
      const txt = await res.text();
      if (!txt || txt.length > 4e6) return;
      body = JSON.parse(txt);
    } catch (_) {
      return;
    }
    const cls = classifyEndpoint(url, body);
    if (cls.category === 'ignored') return;
    this.cache.recordPattern(cls.pattern, cls.category, cls.valid);
    if (!cls.valid) return;

    const rec = {
      url,
      category: cls.category,
      endpoint: cls.endpoint,
      args: cls.args,
      pattern: cls.pattern,
      data: cls.data,
      at: t0,
      elapsedMs: this.startedAt ? t0 - this.startedAt : 0,
    };
    this.records.push(rec);
    this._storeInCache(rec);
  }

  _storeInCache(rec) {
    const { category, args, data } = rec;
    if (category === 'match_info' && data.match && data.match._id) {
      this.cache.set(`match_info:${data.match._id}`, data, 30 * 60 * 1000);
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
    }
  }

  // Strictly associates captured + cached Gismo data with `ev` by explicit fixtureId & team UIDs.
  // Never assigns teams by arrival order.
  assemble(ev) {
    const fixtureId = this.activeMatchId || extractMatchIdFromUrl(ev && ev.url) || Number(ev && ev.matchId) || 0;
    const out = {
      available: false,
      status: 'unavailable', // complete | partial | unavailable | association_failed
      source: 'bangbet-gismo',
      fixtureId,
      seasonId: 0,
      competition: ev.league || '',
      country: ev.country || '',
      homeTeam: null,
      awayTeam: null,
      homeForm: '',
      awayForm: '',
      homeFormSplit: null,
      awayFormSplit: null,
      h2h: null,
      standings: null,
      goals: null,
      pct: [],
      probs: null,
      avg: {},
      disciplinary: null,
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
      },
      endpointsCaptured: [...new Set(this.records.map((r) => r.pattern))],
      responseCount: this.records.length,
      captureMs: this.startedAt ? Date.now() - this.startedAt : 0,
      missing: [],
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
      return out;
    }

    const m = mi.match;
    if (fixtureId && Number(m._id) !== fixtureId) {
      out.status = 'association_failed';
      out.missing.push('fixture_id_mismatch');
      return out;
    }

    const homeUid = Number(m.teams.home.uid || m.teams.home._id || 0);
    const awayUid = Number(m.teams.away.uid || m.teams.away._id || 0);
    const homeName = m.teams.home.mediumname || m.teams.home.name || '';
    const awayName = m.teams.away.mediumname || m.teams.away.name || '';
    const seasonId = Number(m._seasonid || (mi.season && mi.season._id) || 0);

    // Cross-check team names against expected fixture when available to reject mismatched responses
    if (ev.home && ev.away && homeName && awayName) {
      const hn = norm(homeName), an = norm(awayName);
      const eh = keyTok(ev.home), ea = keyTok(ev.away);
      const okHome = !eh || hn.includes(eh) || norm(ev.home).includes(keyTok(homeName));
      const okAway = !ea || an.includes(ea) || norm(ev.away).includes(keyTok(awayName));
      if (!okHome && !okAway) {
        out.status = 'association_failed';
        out.missing.push('team_name_mismatch');
        return out;
      }
    }

    out.fixtureId = Number(m._id || fixtureId);
    out.seasonId = seasonId;
    out.homeTeam = { uid: homeUid, name: homeName };
    out.awayTeam = { uid: awayUid, name: awayName };
    out.categories.teamIdentity = !!(homeUid && awayUid);

    if (mi.tournament && mi.tournament.name) {
      out.competition = mi.tournament.name;
      out.categories.competition = true;
    }
    if (mi.realcategory && mi.realcategory.name) {
      out.country = mi.realcategory.name;
    }

    // 2) Team-season scoring & conceding (strictly by seasonId + exact homeUid/awayUid)
    const hSc = seasonId && homeUid ? this.cache.get(`season_scoring:${seasonId}:${homeUid}`) : null;
    const aSc = seasonId && awayUid ? this.cache.get(`season_scoring:${seasonId}:${awayUid}`) : null;
    if (hSc && aSc && hSc.avgFor != null && aSc.avgFor != null && hSc.avgAg != null && aSc.avgAg != null) {
      out.goals = { hFor: hSc.avgFor, aFor: aSc.avgFor, hAg: hSc.avgAg, aAg: aSc.avgAg };
      out.teamStats = { home: hSc, away: aSc };
      out.categories.teamSeasonScoring = true;
      if (hSc.bttsPct != null && aSc.bttsPct != null) {
        out.pct.push({ label: 'both teams to score', vals: [hSc.bttsPct, aSc.bttsPct] });
      }
      if (hSc.htScorePct != null && aSc.htScorePct != null) {
        out.pct.push({ label: 'first half over 0.5', vals: [hSc.htScorePct, aSc.htScorePct] });
      }
    } else {
      out.missing.push('team_season_scoring');
    }

    // 3) Recent matches & form (strictly by exact homeUid / awayUid)
    const hRec = homeUid ? this.cache.get(`team_lastx:${homeUid}`) : null;
    const aRec = awayUid ? this.cache.get(`team_lastx:${awayUid}`) : null;
    if (hRec && aRec) {
      out.homeForm = hRec.form;
      out.awayForm = aRec.form;
      out.homeFormSplit = hRec.split;
      out.awayFormSplit = aRec.split;
      out.previousMatches = { home: hRec.matches, away: aRec.matches };
      out.categories.recentMatches = true;
      if (!out.goals && hRec.avgFor != null && aRec.avgFor != null && hRec.avgAg != null && aRec.avgAg != null) {
        out.goals = { hFor: hRec.avgFor, aFor: aRec.avgFor, hAg: hRec.avgAg, aAg: aRec.avgAg };
      }
      if (hRec.ov15Pct != null && aRec.ov15Pct != null) {
        out.pct.push({ label: 'over 1.5', vals: [hRec.ov15Pct, aRec.ov15Pct] });
      }
      if (hRec.ov25Pct != null && aRec.ov25Pct != null) {
        out.pct.push({ label: 'over 2.5', vals: [hRec.ov25Pct, aRec.ov25Pct] });
      }
      if (hRec.bttsPct != null && aRec.bttsPct != null && !out.pct.some((p) => p.label === 'both teams to score')) {
        out.pct.push({ label: 'both teams to score', vals: [hRec.bttsPct, aRec.bttsPct] });
      }
    } else {
      out.missing.push('recent_matches');
    }

    // 4) Head-to-head (strictly by homeUid + awayUid pair)
    if (homeUid && awayUid) {
      const h2hRaw = this.cache.get(`h2h:${Math.min(homeUid, awayUid)}:${Math.max(homeUid, awayUid)}`);
      const h2h = parseH2H(h2hRaw, homeUid, awayUid);
      if (h2h) {
        out.h2h = { n: h2h.n, H: h2h.H, X: h2h.X, A: h2h.A };
        out.h2hMeetings = h2h.meetings;
        out.categories.headToHead = true;
      } else {
        out.missing.push('head_to_head');
      }
    }

    // 5) Competition standings (strictly by seasonId + homeUid/awayUid)
    if (seasonId && homeUid && awayUid) {
      const tblRaw = this.cache.get(`season_tables:${seasonId}`);
      const st = parseStandings(tblRaw, homeUid, awayUid);
      if (st) {
        out.standings = st;
        out.categories.standings = true;
      } else {
        out.missing.push('standings');
      }
    }

    // 6) Season Over/Under
    if (seasonId && homeUid && awayUid) {
      const ouRaw = this.cache.get(`season_ou:${seasonId}`);
      const ou = parseSeasonOverUnder(ouRaw, homeUid, awayUid);
      if (ou) {
        out.seasonOverUnder = ou;
        out.categories.overUnder = true;
      }
    }

    // 7) Disciplinary (cards)
    if (seasonId && homeUid && awayUid) {
      const hd = this.cache.get(`team_disc:${seasonId}:${homeUid}`);
      const ad = this.cache.get(`team_disc:${seasonId}:${awayUid}`);
      if (hd || ad) {
        out.disciplinary = { home: hd, away: ad };
        out.categories.disciplinary = true;
        if (hd && ad && hd.yellowAvg != null && ad.yellowAvg != null) {
          out.avg['total cards'] = +(hd.yellowAvg + ad.yellowAvg).toFixed(2);
        }
      }
    }

    // Determine explicit status: complete vs partial vs unavailable
    const hasCore = out.categories.teamIdentity && (out.categories.teamSeasonScoring || out.categories.recentMatches);
    const richCount = [
      out.categories.teamSeasonScoring,
      out.categories.recentMatches,
      out.categories.headToHead,
      out.categories.standings,
    ].filter(Boolean).length;

    if (hasCore && richCount >= 2) {
      out.available = true;
      out.status = 'complete';
    } else if (hasCore || out.categories.headToHead || out.categories.standings) {
      out.available = true;
      out.status = 'partial';
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
  parseScoringConceding,
  parseRecentMatches,
  parseH2H,
  parseStandings,
  parseSeasonOverUnder,
  parseDisciplinary,
};
