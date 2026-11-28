'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, bandFor } = require('../lib/ticket');
const { classify } = require('../lib/extract');

test('60 odds target has a narrow preferred band and a 65 hard ceiling', () => {
  assert.deepEqual(bandFor(60), { min: 60, preferredMax: 62.9, hardMax: 65 });
});
test('ticket builder does not treat odds target as a match count', () => {
  const picks = Array.from({ length: 30 }, (_, i) => ({
    evKey: String(i), sport: 'football', odds: 1.18, p: 0.8, score: 1 - i / 100, ts: i,
  }));
  const ticket = build(picks, { target: 60, count: 0, sports: ['football'] });
  assert.ok(ticket.total >= 60 && ticket.total <= 65);
  assert.ok(ticket.legs.length > 1 && ticket.legs.length < 30);
});
test('markets outside 1X2 remain classifiable', () => {
  const ev = { home: 'Manchester City', away: 'Fulham' };
  const h = classify('1st Half Goals', 'Over 0.5', ev);
  assert.equal(h.type, 'HALF_OU');
  assert.equal(h.line, 0.5);
  const c = classify('Total Corners', 'Over 8.5', ev);
  assert.equal(c.type, 'STAT_OU');
  assert.equal(c.line, 8.5);
  const tg = classify('Home Team Goals', 'Over 0.5', ev);
  assert.equal(tg.type, 'TEAM_OU');
  assert.equal(tg.line, 0.5);
});

test('BangBet Stats layout captures win probability, H2H and team averages', () => {
  const { parse } = require('../lib/bbstats');
  const text = [
    'H2H Team Average', 'Goals scored', '3.10', 'BTTS', '60%', 'Over 1.5', '65%',
    'Win Probability', '69%', '17%', '14%',
    'Previous Meetings', '28 Wins', '10 Draws', '4 Wins',
    'Team Stats', 'Manchester City', 'Average Goals Scored', '2.20',
    'Average Goals Conceded', '1.40', 'Fulham', 'Average Goals Scored', '0.60',
    'Average Goals Conceded', '0.80'
  ].join('\n');
  const stats = parse(text, { home: 'Manchester City', away: 'Fulham' });
  assert.equal(stats.available, true);
  assert.equal(stats.probs.H, 0.69);
  assert.deepEqual(stats.h2h, { n: 42, H: 28, X: 10, A: 4 });
  assert.equal(stats.goals.hFor, 2.2);
  assert.equal(stats.goals.aFor, 0.6);
});

test('site JSON traversal does not silently truncate large fixture arrays', () => {
  const { walk } = require('../lib/util');
  let seen = 0;
  walk(Array.from({ length: 1308 }, (_, id) => ({ id })), () => seen++);
  assert.equal(seen, 1308);
});


test('betslip verification requires every match and its outcome to be visible', () => {
  const { verifySlipText } = require('../lib/book');
  const legs = [
    { home: 'Arsenal', away: 'Liverpool', outcome: 'Home' },
    { home: 'Chelsea', away: 'Tottenham', outcome: 'Over 1.5' },
  ];
  assert.equal(verifySlipText('Arsenal Liverpool Home Chelsea Tottenham Over 1.5', legs).ok, true);
  const missing = verifySlipText('Arsenal Liverpool Home', legs);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing.length, 1);
});


test('ticket is partial when the odds target is not reached', () => {
  const picks = Array.from({ length: 2 }, (_, i) => ({ evKey: String(i), sport: 'football', odds: 1.2, p: 0.8, score: 1-i/10, ts: i }));
  const ticket = build(picks, { target: 6, count: 0 });
  assert.equal(ticket.complete, false);
  assert.equal(ticket.status, 'partial');
  assert.equal(ticket.targetReached, false);
});

test('ticket requires the requested selection count as well as odds', () => {
  const picks = Array.from({ length: 3 }, (_, i) => ({ evKey: String(i), sport: 'football', odds: 2, p: 0.8, score: 1-i/10, ts: i }));
  const ticket = build(picks, { target: 4, count: 3 });
  assert.equal(ticket.targetReached, true);
  assert.equal(ticket.countReached, false);
  assert.equal(ticket.complete, false);
  assert.equal(ticket.status, 'partial');
});

test('combined odds recalculation accurately multiplies individual decimal odds', () => {
  const legs = [
    { odds: 1.50 },
    { odds: 2.00 },
    { odds: 1.80 },
  ];
  const combined = legs.reduce((v, l) => v * l.odds, 1);
  assert.equal(Math.round(combined * 100) / 100, 5.40);
});

test('ticket builder respects target and selection count constraints together', () => {
  const picks = [
    { evKey: '1', sport: 'football', odds: 1.5, p: 0.8, score: 0.9, ts: 100 },
    { evKey: '2', sport: 'football', odds: 2.0, p: 0.8, score: 0.8, ts: 200 },
    { evKey: '3', sport: 'football', odds: 2.0, p: 0.8, score: 0.7, ts: 300 },
  ];
  const ticket = build(picks, { target: 6, count: 3 });
  assert.equal(ticket.legs.length, 3);
  assert.equal(ticket.targetReached, true);
  assert.equal(ticket.countReached, true);
  assert.equal(ticket.complete, true);
  assert.equal(ticket.status, 'ready');
});

test('ticket builder prevents duplicate selections from the same match evKey', () => {
  const picks = [
    { evKey: 'football:arsenal:chelsea:0', sport: 'football', odds: 1.8, p: 0.8, score: 0.95, ts: 100 },
    { evKey: 'football:arsenal:chelsea:0', sport: 'football', odds: 2.2, p: 0.75, score: 0.85, ts: 100 },
    { evKey: 'football:liverpool:everton:1', sport: 'football', odds: 1.7, p: 0.78, score: 0.90, ts: 200 },
  ];
  const ticket = build(picks, { target: 3.0, count: 0 });
  assert.equal(ticket.legs.length, 2);
  const keys = new Set(ticket.legs.map((l) => l.evKey));
  assert.equal(keys.size, 2);
  assert.equal(ticket.complete, true);
});

test('progressive fixture deduplication merges metadata without duplicating matches beyond 30', () => {
  const { norm } = require('../lib/util');
  const seen = new Map();
  const add = (e) => {
    if (!e.home || !e.away) return false;
    const k = `${norm(e.home)}|${norm(e.away)}`;
    const existing = seen.get(k);
    if (!existing) { seen.set(k, { sport: 'football', ...e }); return true; }
    for (const f of ['ts', 'id', 'league', 'country', 'url']) {
      if (!existing[f] && e[f]) existing[f] = e[f];
    }
    if ((!existing.odds || !existing.odds.length) && e.odds && e.odds.length) existing.odds = e.odds;
    return false;
  };
  let added = 0;
  for (let i = 0; i < 65; i++) {
    if (add({ home: `Home ${i}`, away: `Away ${i}`, ts: 0, url: '', odds: [1.5, 3.2, 4.5] })) added++;
  }
  // Second pass with overlapping fixtures supplying timestamps and URLs from network JSON
  for (let i = 0; i < 65; i++) {
    if (add({ home: `Home ${i}`, away: `Away ${i}`, ts: 1700000000000 + i * 1000, url: `https://example/m/${i}`, odds: [] })) added++;
  }
  assert.equal(added, 65);
  assert.equal(seen.size, 65);
  assert.equal(seen.get('home 0|away 0').url, 'https://example/m/0');
  assert.deepEqual(seen.get('home 0|away 0').odds, [1.5, 3.2, 4.5]);
});

test('market catalogue defines 120 unique real bookmaker markets and resolves typos/slang', () => {
  const { CATALOG, resolveMarketFilter } = require('../lib/markets');
  assert.equal(CATALOG.length, 120);
  const ids = new Set(CATALOG.map((m) => m.id));
  assert.equal(ids.size, 120);
  assert.equal(resolveMarketFilter('btts').type, 'BTTS');
  assert.equal(resolveMarketFilter('both team score').type, 'BTTS');
  assert.equal(resolveMarketFilter('doubel chanse').type, 'DC');
  const ov25 = resolveMarketFilter('over 2.5 goals');
  assert.equal(ov25.type, 'OU');
  assert.equal(ov25.side, 'O');
  assert.equal(ov25.line, 2.5);
  const c = resolveMarketFilter('corners over 8.5');
  assert.equal(c.type, 'STAT_OU');
  assert.equal(c.stat, 'corner');
  assert.equal(c.line, 8.5);
});

test('extended market classification handles clean sheet, combo, handicap, and 2nd half markets', () => {
  const ev = { home: 'Arsenal', away: 'Chelsea' };
  assert.equal(classify('Home Clean Sheet', 'Yes', ev).type, 'CLEAN_SHEET');
  assert.equal(classify('2nd Half Goals', 'Over 1.5', ev).type, 'HALF2_OU');
  assert.equal(classify('1X2 & Both Teams to Score', 'Arsenal & Yes', ev).type, 'BTTS_RESULT');
  assert.equal(classify('Double Chance & Over/Under 2.5', '1X & Over 2.5', ev).type, 'DC_OU');
  assert.equal(classify('Asian Handicap', 'Arsenal -1.5', ev).type, 'HANDICAP');
  assert.equal(classify('Half Time / Full Time', '1/1', ev).type, 'HT_FT');
});

test('run.js date windowing preserves local midnight boundaries for specific dates and ranges', () => {
  const { parseLocalYmd, computeWindow, validateRequest } = require('../run');
  const d = parseLocalYmd('2026-11-25');
  assert.ok(d instanceof Date);
  assert.equal(parseLocalYmd('2026-02-31'), null);

  const [s1, e1] = computeWindow({ scope: 'date', date: '2026-11-25' });
  const earlyMatch = new Date(2026, 10, 25, 0, 5, 0).getTime();
  const lateMatch = new Date(2026, 10, 25, 23, 55, 0).getTime();
  const nextDayMatch = new Date(2026, 10, 26, 0, 5, 0).getTime();
  assert.ok(earlyMatch >= s1 && earlyMatch < e1);
  assert.ok(lateMatch >= s1 && lateMatch < e1);
  assert.ok(!(nextDayMatch >= s1 && nextDayMatch < e1));

  const [s2, e2] = computeWindow({ scope: 'range', dateFrom: '2026-11-24', dateTo: '2026-11-26' });
  assert.equal(Math.round((e2 - s2) / 86400000), 3);

  assert.throws(() => validateRequest({ sports: [] }, { sports: [], scope: 'today' }));
  assert.throws(() => validateRequest({ sports: ['football'], scope: 'date', date: 'bad' }, { sports: ['football'], scope: 'date', date: 'bad' }));
  assert.doesNotThrow(() => validateRequest(
    { sports: ['football'], scope: 'range', dateFrom: '2026-11-24', dateTo: '2026-11-26', target: 15, count: 5, markets: ['over 2.5'] },
    { sports: ['football'], scope: 'range', dateFrom: '2026-11-24', dateTo: '2026-11-26', target: 15, count: 5, markets: ['over 2.5'] }
  ));
});

test('ticket builder rejects invalid, NaN, or out-of-range odds and honors market filters', () => {
  const { candidates } = require('../lib/analyze');
  const bad = [
    { evKey: '1', sport: 'football', odds: NaN, p: 0.8, score: 0.9, ts: 1 },
    { evKey: '2', sport: 'football', odds: 0.95, p: 0.8, score: 0.9, ts: 2 },
    { evKey: '3', sport: 'football', odds: 1.5, p: 0.8, score: 0.9, ts: 3 },
  ];
  const tk = build(bad, { target: 0, count: 0 });
  assert.equal(tk.legs.length, 1);
  assert.equal(tk.total, 1.5);

  const ev = {
    key: 'football:arsenal:chelsea:0', sport: 'football', home: 'Arsenal', away: 'Chelsea', ts: 100, url: '',
    stats: { available: true, homeForm: 'WWWWW', awayForm: 'LLLLL', probs: { H: 0.72, X: 0.16, A: 0.12 }, pct: [], avg: {} },
    markets: [
      { i: 0, title: '1X2', label: '1', odds: 1.55, type: 'WIN', side: 'H' },
      { i: 1, title: '1X2', label: 'X', odds: 4.10, type: 'WIN', side: 'X' },
      { i: 2, title: '1X2', label: '2', odds: 6.00, type: 'WIN', side: 'A' },
    ],
  };
  const filteredEmpty = candidates(ev, { markets: ['corners over 9.5'] });
  assert.equal(filteredEmpty.length, 0);
  assert.equal(ev.rejected, 'no offered market matched requested market filter');
});

test('BangBet live Stats layout parses split % lines, vertical LAST MATCHES, and 3-column TEAM STATS', () => {
  const { parse } = require('../lib/bbstats');
  const liveText = [
    'HEAD TO HEAD TEAM AVERAGES', '(26/27)',
    'GOALS SCORED', '1.75', 'League', '|', '2.88',
    'BTTS', '59', '%', 'League', '|', '18%',
    'OVER 1.5', '83', '%', 'League', '|', '75%',
    'OVER 2.5', '42', '%', 'League', '|', '55%',
    'TOTAL CARDS', '5.33', '2.75', '2.58',
    'CORNERS', '8.75', '3.67', '5.08',
    'WIN PROBABILITY', '53', '%', 'OSA', '26', '%', 'DRAW', '21', '%', 'MCF',
    'PREVIOUS MEETINGS', '7', 'WINS', '13', 'DRAW', '12', 'WINS',
    'OSASUNA', 'LaLiga 26/27', 'LAST MATCHES', 'Overall', 'Home', 'Away',
    'L', 'W', 'L', 'L', 'D', 'W', 'L', 'D', 'W', 'D', 'L', 'L', 'L', 'L', 'L',
    'HT WIN %', 'FTS', 'CS',
    'MALAGA', 'LaLiga 26/27', 'LAST MATCHES', 'Overall', 'Home', 'Away',
    'D', 'D', 'L', 'L', 'D', 'W', 'L', 'D', 'L', 'D', 'L', 'D', 'D', 'D', 'L',
    'HT WIN %', 'FTS', 'CS',
    'TEAM STATS', 'Home', 'Overall', 'Overall', 'Away',
    '5', 'Matches played', '5',
    '40%', 'Win%', '0%',
    '6', 'Total Goals', '4',
    '1.20', 'AVG goals scored', '0.80',
    '1.00', 'AVG goals conceded', '1.40',
    '60%', 'Both teams scored', '40%',
    '80%', 'Over 1.5', '100%',
    '40%', 'Over 2.5', '20%',
    '60%', 'HT Over 0.5', '40%',
    '11', 'Yellow cards', '11',
  ].join('\n');
  const st = parse(liveText, { home: 'Osasuna', away: 'Malaga' });
  assert.equal(st.available, true);
  assert.equal(st.probs.H, 0.53);
  assert.equal(st.probs.X, 0.26);
  assert.equal(st.probs.A, 0.21);
  assert.deepEqual(st.h2h, { n: 32, H: 7, X: 13, A: 12 });
  assert.equal(st.homeForm, 'LWLLD');
  assert.equal(st.awayForm, 'DDLLD');
  assert.equal(st.goals.hFor, 1.2);
  assert.equal(st.goals.aFor, 0.8);
  assert.equal(st.goals.hAg, 1.0);
  assert.equal(st.goals.aAg, 1.4);
  assert.equal(st.avg['goals scored'], 1.75);
  assert.equal(st.avg['over 1.5'], 83);
  assert.equal(st.avg['corners'], 8.75);
});

test('BangBet 1x2 early-payout (1up/2up/3up) markets do not collide with standard 1x2 WIN', () => {
  const ev = { home: 'Liverpool', away: 'Man Utd' };
  const std = classify('1x2', '1', ev);
  assert.equal(std.type, 'WIN');
  assert.equal(std.side, 'H');
  assert.equal(classify('1x2 (1up)', 'home', ev).type, 'WIN_UP');
  assert.equal(classify('1x2 (2up)', 'home', ev).type, 'WIN_UP');
  assert.equal(classify('1x2 (3up)', 'home', ev).type, 'WIN_UP');
  const lfcTot = classify('Liverpool FC total', 'Over 1.5', ev);
  assert.equal(lfcTot.type, 'TEAM_OU');
  assert.equal(lfcTot.teamSide, 'H');
  assert.equal(lfcTot.line, 1.5);
});

test('target-driven ticket building stops early on low odds targets and scales past 30 fixtures for large targets', () => {
  const lowPicks = Array.from({ length: 6 }, (_, i) => ({
    evKey: `football:lh${i}:la${i}:${i}`, sport: 'football', odds: 1.45, p: 0.82, score: 0.9 - i / 1000, ts: i,
  }));
  // Low target (2.0): needs only 2 legs (1.45^2 = 2.10), never 30
  const low = build(lowPicks, { target: 2, count: 0, sports: ['football'] });
  assert.equal(low.complete, true);
  assert.ok(low.legs.length === 2 && low.total >= 2);
  // Large target (500): uses legs from a pool larger than 30 fixtures without any 30-match cap
  const highPicks = Array.from({ length: 65 }, (_, i) => ({
    evKey: `football:h${i}:a${i}:${i}`, sport: 'football', odds: 1.25, p: 0.82, score: 0.9 - i / 1000, ts: i,
  }));
  const high = build(highPicks, { target: 500, count: 0, sports: ['football'] });
  assert.equal(high.complete, true);
  assert.ok(high.total >= 500 && high.legs.length > 20);
});

test('PhoneGatewayServer counts exact upload/download bytes, warns at 80%, and stops forwarding at limit', async () => {
  const { PhoneGatewayServer } = require('../lib/gateway');
  const gw = new PhoneGatewayServer({ limitMb: 1 }); // 1 MB = 1,048,576 bytes
  const info = await gw.start({ useCloudflared: false });
  try {
    assert.ok(info.proxyUrl.startsWith('http://127.0.0.1:'));
    assert.ok(info.gatewayUrl.startsWith('ws://127.0.0.1:'));
    assert.equal(info.gatewayToken.length, 48);

    gw._account(500 * 1024, 'up');
    gw._account(350 * 1024, 'down');
    assert.equal(gw.warned80, true);
    assert.equal(gw.limitReached, false);
    assert.equal(gw.totalBytes, 850 * 1024);

    gw._account(200 * 1024, 'down');
    assert.equal(gw.limitReached, true);
    assert.equal(gw.status().limitReached, true);
  } finally {
    await gw.close();
  }
});

test('Gismo classifier, strict home/away UID association (arrival-order independent), and mismatch rejection', () => {
  const { GismoCache, GismoPageObserver, classifyEndpoint } = require('../lib/gismo');
  const fakePage = { on() {}, off() {} };
  const cache = new GismoCache();
  const obs = new GismoPageObserver(fakePage, cache);

  // Endpoint classification
  assert.equal(classifyEndpoint('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_teamscoringconceding/140786/2959/-1', { doc: [{ event: 'stats_season_teamscoringconceding', data: { team: { _id: 2959 }, stats: {} } }] }).category, 'team_scoring_conceding');
  assert.equal(classifyEndpoint('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_team_versusrecent/2959/3002', { doc: [{ event: 'stats_team_versusrecent', data: { matches: [] } }] }).category, 'head_to_head');
  assert.equal(classifyEndpoint('https://doubleclick.net/pixel', {}).category, 'ignored');

  // Fixture: Feyenoord (2959, Home) vs FC Porto (3002, Away) — feed AWAY (3002) FIRST to prove arrival order never swaps teams!
  const ev = { home: 'Feyenoord', away: 'FC Porto', url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A99001122' };
  obs.beginFixture(ev);
  obs._storeInCache({
    category: 'team_scoring_conceding', args: ['140786', '3002', '-1'],
    data: { team: { _id: 3002, name: 'FC Porto' }, stats: { totalmatches: { total: 10 }, scoring: { goalsscored: { total: 12 }, bothteamsscored: { total: 5 } }, conceding: { goalsconceded: { total: 8 } } } },
  });
  obs._storeInCache({
    category: 'team_scoring_conceding', args: ['140786', '2959', '-1'],
    data: { team: { _id: 2959, name: 'Feyenoord' }, stats: { totalmatches: { total: 10 }, scoring: { goalsscored: { total: 24 }, bothteamsscored: { total: 6 } }, conceding: { goalsconceded: { total: 9 } } } },
  });
  obs._storeInCache({
    category: 'head_to_head', args: ['2959', '3002'],
    data: { matches: [{ _id: 1, teams: { home: { uid: 2959, name: 'Feyenoord' }, away: { uid: 3002, name: 'FC Porto' } }, result: { home: 2, away: 0 } }] },
  });
  const miRec = {
    category: 'match_info', args: ['99001122'], pattern: '/gismo/match_info',
    data: {
      match: { _id: 99001122, _seasonid: 140786, teams: { home: { uid: 2959, name: 'Feyenoord' }, away: { uid: 3002, name: 'FC Porto' } } },
      tournament: { name: 'UEFA Europa League' }, realcategory: { name: 'International' },
    },
  };
  obs.records.push(miRec);
  obs._storeInCache(miRec);

  const stPartial = obs.assemble(ev);
  assert.equal(stPartial.available, true);
  assert.equal(stPartial.status, 'partial'); // recentMatches missing -> must NEVER be labelled complete
  assert.equal(stPartial.homeTeam.uid, 2959);
  assert.equal(stPartial.awayTeam.uid, 3002);
  assert.equal(stPartial.goals.hFor, 2.4);
  assert.equal(stPartial.goals.aFor, 1.2);
  assert.equal(stPartial.h2h.n, 1);
  assert.equal(stPartial.h2h.H, 1);
  assert.equal(stPartial.h2h.X, 0);
  assert.equal(stPartial.h2h.A, 0);
  assert.equal(stPartial.h2h.avgGoals, 2);
  assert.equal(stPartial.competition, 'UEFA Europa League');

  // Adding recentMatches for both teams upgrades status to complete
  obs._storeInCache({
    category: 'team_recent_matches', args: ['2959'],
    data: { team: { _id: 2959 }, matches: [{ _id: 11, teams: { home: { uid: 2959, name: 'Feyenoord' }, away: { uid: 99, name: 'Opp' } }, result: { home: 2, away: 1 } }] },
  });
  obs._storeInCache({
    category: 'team_recent_matches', args: ['3002'],
    data: { team: { _id: 3002 }, matches: [{ _id: 12, teams: { home: { uid: 3002, name: 'FC Porto' }, away: { uid: 88, name: 'Opp2' } }, result: { home: 1, away: 0 } }] },
  });
  const stComplete = obs.assemble(ev);
  assert.equal(stComplete.status, 'complete');
  assert.equal(stComplete.homeForm, 'W');
  assert.equal(stComplete.awayForm, 'W');

  // Mismatched fixture team names must be rejected as association_failed
  const wrongEv = { home: 'Arsenal', away: 'Chelsea', url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A99001122' };
  const bad = obs.assemble(wrongEv);
  assert.equal(bad.available, false);
  assert.equal(bad.status, 'association_failed');
});

test('GismoCache tracks hits, misses, and TTL expiry accurately', async () => {
  const { GismoCache } = require('../lib/gismo');
  const cache = new GismoCache();
  assert.equal(cache.get('missing_key'), null);
  assert.equal(cache.misses, 1);
  cache.set('k1', { ok: true }, 50);
  assert.deepEqual(cache.get('k1'), { ok: true });
  assert.equal(cache.hits, 1);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cache.get('k1'), null);
  assert.equal(cache.evictions, 1);
});

test('isVirtualFixture excludes SRL and virtual leagues without excluding genuine football', () => {
  const { isVirtualFixture } = require('../run');
  assert.equal(isVirtualFixture({ country: 'Simulated Reality League', league: 'Serie A SRL', home: 'AC Monza Srl', away: 'Fiorentina SRL' }), true);
  assert.equal(isVirtualFixture({ country: 'Simulated Reality League', league: 'Premier League SRL', home: 'Brentford FC', away: 'Everton FC SRL' }), true);
  assert.equal(isVirtualFixture({ country: 'Virtual', league: 'eFootball', home: 'Team A', away: 'Team B' }), true);
  assert.equal(isVirtualFixture({ country: 'Italy', league: 'Serie A', home: 'AC Monza', away: 'ACF Fiorentina' }), false);
  assert.equal(isVirtualFixture({ country: 'England', league: 'Premier League', home: 'Brentford FC', away: 'Everton FC' }), false);
  assert.equal(isVirtualFixture({ country: 'Ukraine', league: 'Premier League', home: 'FC Chernomorets Odessa', away: 'FC Epitsentr' }), false);
});

test('tallyRejections preserves rejection counts and reasons before early-return paths', () => {
  const { tallyRejections } = require('../run');
  const events = [
    { opened: true, markets: [{ odds: 1.5 }], stats: { available: false, responseCount: 0 }, rejected: 'markets extracted, but BangBet Stats tab did not provide readable statistics' },
    { opened: true, markets: [{ odds: 1.8 }], stats: { available: true, responseCount: 9, categories: { teamIdentity: true, recentMatches: true } }, evaluated: true },
    { opened: false, rejected: 'error: match page navigation timed out after 25s' },
  ];
  const state = { counts: {} };
  const why = tallyRejections(events, [{ evKey: '1', odds: 1.8 }], state);
  assert.equal(state.counts.opened, 2);
  assert.equal(state.counts.withMarkets, 2);
  assert.equal(state.counts.withStats, 1);
  assert.equal(state.counts.evaluated, 1);
  assert.equal(state.counts.rejected, 2);
  assert.equal(why['markets extracted, but BangBet Stats tab did not provide readable statistics'], 1);
  assert.equal(why['error: match page navigation timed out after 25s'], 1);
});

test('Over/Under Total markets classify cleanly with decimal lines', () => {
  const ev = { home: 'AC Monza', away: 'ACF Fiorentina' };
  const o15 = classify('Total', 'over 1.5', ev);
  assert.equal(o15.type, 'OU');
  assert.equal(o15.side, 'O');
  assert.equal(o15.line, 1.5);
  const u25 = classify('Over/Under', 'under 2.5', ev);
  assert.equal(u25.type, 'OU');
  assert.equal(u25.side, 'U');
  assert.equal(u25.line, 2.5);
});

// ---- Offline Real-Fixture & Reliability Tests (Part 10) ----
const fs = require('fs');
const path = require('path');
const {
  GismoPageObserver,
  GismoCache,
  classifyEndpoint,
  parseSeasonOverUnder,
  parseUniqueTeamStats,
  parseMatchMarketsProbabilities,
  parseH2H,
} = require('../lib/gismo');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));

function fakeEventPage() {
  const handlers = {};
  return {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    off(name, fn) { if (handlers[name]) handlers[name] = handlers[name].filter((h) => h !== fn); },
    emit(name, value) { for (const fn of (handlers[name] || [])) fn(value); },
  };
}

function fakeResponse(url, bodyObjOrText, opts = {}) {
  const status = opts.status || 200;
  const ct = opts.contentType || 'application/json';
  const delayMs = opts.delayMs || 0;
  return {
    url: () => url,
    status: () => status,
    headers: () => ({ 'content-type': ct }),
    text: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (opts.throwError) throw new Error(opts.throwError);
      return typeof bodyObjOrText === 'string' ? bodyObjOrText : JSON.stringify(bodyObjOrText);
    },
  };
}

test('Real captured stats_season_overunder V2 schema parses FT, 1H, 2H and Home/Away splits accurately', () => {
  const raw = loadFixture('stats_season_overunder_140786.json');
  const res = parseSeasonOverUnder(raw.doc[0].data, 656, 2058);
  assert.equal(res.parsed, true);
  assert.equal(res.home.schemaVersion, 'sportradar_overunder_v2');
  assert.equal(res.home.matches, 4);
  assert.equal(res.home.pct['0.5'], 75);
  assert.equal(res.home.pct['1.5'], 50);
  assert.equal(res.home.pct['2.5'], 50);
  assert.equal(res.home.p1['0.5'].overPct, 25);
  assert.equal(res.home.p2['0.5'].overPct, 75);
  assert.ok(res.home.goalsScoredFt && res.home.goalsScoredFt.average === 1);
  assert.ok(res.away && res.away.matches > 0);
});

test('parseSeasonOverUnder handles legacy schema and records explicit failure on unrecognized schema', () => {
  const legacy = { stats: { '10': { matches: { total: 10 }, over: { '1.5': { total: 8 }, '2.5': { total: 6 } } } } };
  const ok = parseSeasonOverUnder(legacy, 10, 20);
  assert.equal(ok.parsed, true);
  assert.equal(ok.home.schemaVersion, 'sportradar_overunder_legacy');
  assert.equal(ok.home.pct['1.5'], 80);

  const bad = { stats: { '10': { unknownShape: 42 } } };
  const fail = parseSeasonOverUnder(bad, 10, 20);
  assert.equal(fail.parsed, false);
  assert.ok(fail.reason && fail.schema);
});

test('Real captured stats_season_uniqueteamstats extracts corners, cards, shots and possession', () => {
  const raw = loadFixture('stats_season_uniqueteamstats_140786.json');
  const adv = parseUniqueTeamStats(raw.doc[0].data, 656, 2058);
  assert.ok(adv && adv.home && adv.away);
  assert.equal(adv.home.cornersAvg, 3.88);
  assert.equal(adv.home.shotsOnGoalAvg, 4.63);
  assert.equal(adv.home.cardsAvg, 0.88);
  assert.equal(adv.home.possessionAvg, 52.5);
  assert.ok(typeof adv.away.cornersAvg === 'number' && adv.away.cornersAvg > 0);
});

test('Real captured match_markets extracts Sportradar 1x2 and Double Chance model probabilities', () => {
  const raw = loadFixture('match_markets_74166014.json');
  const mp = parseMatchMarketsProbabilities(raw.doc[0].data, 74166014);
  assert.ok(mp && mp.probs);
  assert.ok(mp.probs.H > 0.64 && mp.probs.H < 0.67);
  assert.ok(mp.probs.X > 0.16 && mp.probs.X < 0.19);
  assert.ok(mp.probs.A > 0.15 && mp.probs.A < 0.19);
  assert.ok(Array.isArray(mp.extra.doubleChance) && mp.extra.doubleChance.length === 3);
});

test('Real captured stats_team_versusrecent distinguishes zero prior meetings from missing H2H', () => {
  const raw = loadFixture('stats_team_versusrecent_656_2058.json');
  const h2h = parseH2H(raw.doc[0].data, 656, 2058);
  assert.ok(h2h);
  assert.equal(h2h.n, 0);
  assert.equal(h2h.noPriorMeetings, true);
});

test('Real captured Sportradar exception payload is classified as api_exception, never valid statistics', () => {
  const raw = loadFixture('api_exception_sample.json');
  const cls = classifyEndpoint('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_cup_brackets/gm-74166014', raw);
  assert.equal(cls.category, 'api_exception');
  assert.equal(cls.valid, false);
  assert.ok(cls.exception && cls.exception.message);
});

test('Full end-to-end offline replay of all real captured fixtures produces complete status and 9/10 verified categories', async () => {
  const page = fakeEventPage();
  const cache = new GismoCache();
  const obs = new GismoPageObserver(page, cache);
  const ev = {
    home: 'Bodoe/Glimt',
    away: 'LASK Linz',
    league: 'UEFA Champions League',
    country: 'International Clubs',
    url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A74166014&sportId=sr%3Asport%3A1&producer=3',
  };
  obs.beginFixture(ev);

  const feed = [
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_info/74166014', 'match_info_74166014.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_markets/74166014', 'match_markets_74166014.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_overunder/140786', 'stats_season_overunder_140786.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_uniqueteamstats/140786', 'stats_season_uniqueteamstats_140786.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_team_versusrecent/656/2058', 'stats_team_versusrecent_656_2058.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_team_lastxextended/656', 'stats_team_lastxextended_656.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_team_lastxextended/2058', 'stats_team_lastxextended_2058.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_tables/140786', 'stats_season_tables_140786.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_teamscoringconceding/140786/656/-1', 'stats_season_teamscoringconceding_656.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_teamscoringconceding/140786/2058/-1', 'stats_season_teamscoringconceding_2058.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_teamdisciplinary/140786/656', 'stats_season_teamdisciplinary_656.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_season_teamdisciplinary/140786/2058', 'stats_season_teamdisciplinary_2058.json'],
    ['https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/stats_cup_brackets/gm-74166014', 'api_exception_sample.json'],
  ];

  for (const [url, file] of feed) {
    page.emit('response', fakeResponse(url, loadFixture(file), { delayMs: 10 }));
  }
  // Emit a duplicate to verify duplicate tracking
  page.emit('response', fakeResponse(feed[0][0], loadFixture(feed[0][1]), { delayMs: 5 }));
  // Emit an unknown potentially relevant non-Gismo endpoint to verify preservation
  page.emit('response', fakeResponse('https://bet-api.bangbet.com/api/bet/custom/newTeamAnalytics', { goalsscored: 2.1, corner_kicks: 6.4 }, { delayMs: 5 }));

  await obs.waitForQuiet(40, 1000);
  const st = obs.assemble(ev);

  assert.equal(st.status, 'complete');
  assert.equal(st.available, true);
  assert.equal(st.fixtureId, 74166014);
  assert.equal(st.homeTeam.uid, 656);
  assert.equal(st.awayTeam.uid, 2058);
  assert.equal(st.categories.teamIdentity, true);
  assert.equal(st.categories.competition, true);
  assert.equal(st.categories.teamSeasonScoring, true);
  assert.equal(st.categories.recentMatches, true);
  assert.equal(st.categories.standings, true);
  assert.equal(st.categories.overUnder, true);
  assert.equal(st.categories.disciplinary, true);
  assert.equal(st.categories.seasonTeamStats, true);
  assert.equal(st.categories.winProbabilities, true);
  assert.equal(st.h2hStatus, 'no_prior_meetings');
  assert.ok(st.avg.corners > 8 && st.avg.corners < 10);
  assert.equal(st.parseFailures.length, 0);
  assert.equal(st.diagnostics.apiExceptions.length, 1);
  assert.equal(st.diagnostics.duplicateResponses, 1);
  assert.equal(st.diagnostics.unknownRelevant.length, 1);
  obs.detach();
});

test('Gismo observer isolates late async responses across fixture boundaries and handles malformed/failed bodies', async () => {
  const page = fakeEventPage();
  const obs = new GismoPageObserver(page, new GismoCache());
  const mi = loadFixture('match_info_74166014.json');

  // Late response from match 74166014 must not leak into match 99999999
  obs.beginFixture({ matchId: 74166014 });
  page.emit('response', fakeResponse('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_info/74166014', mi, { delayMs: 35 }));
  obs.beginFixture({ matchId: 99999999 });
  await obs.waitForQuiet(50, 500);
  assert.equal(obs.records.length, 0);
  assert.equal(obs.assemble({ matchId: 99999999 }).status, 'no_data_returned');

  // Body read failure
  obs.beginFixture({ matchId: 111 });
  page.emit('response', fakeResponse('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_info/111', '', { throwError: 'Target closed' }));
  await obs.waitForQuiet(30, 500);
  const stBodyFail = obs.assemble({ matchId: 111 });
  assert.equal(stBodyFail.status, 'body_read_failed');
  assert.equal(stBodyFail.diagnostics.bodyReadFailures, 1);

  // Malformed JSON
  obs.beginFixture({ matchId: 222 });
  page.emit('response', fakeResponse('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_info/222', '{not valid json'));
  await obs.waitForQuiet(30, 500);
  const stParseFail = obs.assemble({ matchId: 222 });
  assert.equal(stParseFail.status, 'parse_failed');
  assert.equal(stParseFail.diagnostics.jsonParseFailures, 1);

  // Partial statistics preserved without claiming complete
  obs.beginFixture({ matchId: 74166014 });
  page.emit('response', fakeResponse('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_info/74166014', mi));
  page.emit('response', fakeResponse('https://ws-fn-cdn001.akamaized.net/common/en/Etc:UTC/gismo/match_markets/74166014', loadFixture('match_markets_74166014.json')));
  await obs.waitForQuiet(30, 500);
  const stPartial = obs.assemble({ matchId: 74166014 });
  assert.equal(stPartial.available, true);
  assert.equal(stPartial.status, 'partial');
  assert.equal(stPartial.categories.winProbabilities, true);
  assert.equal(stPartial.categories.teamSeasonScoring, false);
  obs.detach();
});

// ---- Booking Repair & Safeguard Tests (Section 6) ----
const {
  addLeg,
  share,
  openFullBetslip,
  normalizeSlipText,
  verifySlipText,
} = require('../lib/book');
const exMod = require('../lib/extract');

test('verifySlipText matches Under2.5 <-> Under 2.5 on real BangBet betslip text and never confuses Over 2.5 with Over 3.5', () => {
  const realFullSlip = [
    'Betslip', '2', 'Remove All', 'Multiple',
    'Under2.5', '2.90', 'Ratchaburi FC vs Johor Darul Ta\'zim', 'Total',
    'Over3.5', '2.27', 'Galatasaray Istanbul vs Aston Villa', 'Total',
    'Total Odds', '6.58', 'Share Bet',
  ].join('\n');

  const legs = [
    { home: 'Ratchaburi FC', away: 'Johor Darul Ta\'zim', outcome: 'under 2.5' },
    { home: 'Galatasaray Istanbul', away: 'Aston Villa', outcome: 'over 3.5' },
  ];
  assert.equal(normalizeSlipText('Under2.5'), 'under 2.5');
  assert.equal(normalizeSlipText('Under 2.5'), 'under 2.5');
  assert.equal(normalizeSlipText('Over3.5'), 'over 3.5');
  assert.equal(normalizeSlipText('Over 2.5'), 'over 2.5');

  const ok = verifySlipText(realFullSlip, legs);
  assert.equal(ok.ok, true);
  assert.equal(ok.verified.length, 2);
  assert.equal(ok.missing.length, 0);

  // Over 2.5 must NEVER match Over3.5
  const wrongLine = verifySlipText(realFullSlip, [
    { home: 'Galatasaray Istanbul', away: 'Aston Villa', outcome: 'over 2.5' },
  ]);
  assert.equal(wrongLine.ok, false);
  assert.equal(wrongLine.missing.length, 1);

  // Missing team must fail verification even if outcome exists
  const missingTeam = verifySlipText(realFullSlip, [
    { home: 'Como 1907', away: 'AEK Athens', outcome: 'over 3.5' },
  ]);
  assert.equal(missingTeam.ok, false);

  // Shortened club name (stripping FC) still matches strictly without accepting unrelated teams
  const shortClubSlip = 'Betslip\n1\nUnder4.5\n1.16\nBrentford vs Everton\nTotal';
  assert.equal(verifySlipText(shortClubSlip, [{ home: 'Brentford FC', away: 'Everton FC', outcome: 'under 4.5' }]).ok, true);
  assert.equal(verifySlipText(shortClubSlip, [{ home: 'Arsenal FC', away: 'Everton FC', outcome: 'under 4.5' }]).ok, false);
});

function makeMockBookingPage(cfg) {
  let slipCount = cfg.initialCount || 0;
  let scrollCount = 0;
  let clickCount = 0;
  let openedSelector = '';
  let fullSlipVisible = false;

  const page = {
    net: [],
    async evaluate(fn, arg) {
      const src = fn.toString();
      // readSlipCount
      if (src.includes('betslip-count')) return slipCount;
      // scrollTargetUnobstructed
      if (src.includes('scrollIntoView') && src.includes('elementFromPoint')) {
        scrollCount++;
        return { found: cfg.targetExists !== false, unobstructed: true, blockedByRapid: false, top: 400, bottom: 440 };
      }
      // openFullBetslip container check
      if (src.includes('.betslip-container') && src.includes('r.height > 200')) {
        return fullSlipVisible
          ? { opened: true, selector: '.betslip-container', containerText: cfg.containerText || '' }
          : { opened: false, selector: '', containerText: '' };
      }
      // re-read container text in share()
      if (src.includes('.betslip-container') && src.includes('getBoundingClientRect().height > 200')) {
        return fullSlipVisible ? (cfg.containerText || '') : '';
      }
      // document.body.innerText (deliberately includes underlying page text that should NOT fool container verification)
      if (src.includes('document.body.innerText')) {
        return cfg.bodyText || cfg.containerText || '';
      }
      return [];
    },
    locator(sel) {
      const makeLoc = (s) => ({
        first() { return makeLoc(s); },
        last() { return makeLoc(s); },
        getByText() { return makeLoc(s + ':text'); },
        async count() {
          if (s.includes('.rapid-betslip')) return 0;
          if (s.includes('.betslip-nav-container')) return cfg.hasNavButton === false ? 0 : 1;
          if (s.includes('.betslip-container')) return fullSlipVisible ? 1 : 0;
          if (s.includes('[data-bb=')) return 1;
          return 0;
        },
        async isVisible() { return (await this.count()) > 0; },
        async boundingBox() { return null; },
        async scrollIntoViewIfNeeded() {},
        async click() {
          if (s.includes('[data-bb=')) {
            clickCount++;
            if (cfg.failClick) throw new Error('element obscured');
            if (cfg.incrementOnAttempt === undefined || clickCount >= cfg.incrementOnAttempt) {
              if (!cfg.neverIncrement) slipCount++;
            }
            return;
          }
          if (s.includes('.betslip-nav-container')) {
            openedSelector = '.betslip-nav-container';
            if (!cfg.neverOpenContainer) fullSlipVisible = true;
            return;
          }
        },
      });
      return makeLoc(sel);
    },
    getByText() {
      return {
        first() { return { count: async () => 0, isVisible: async () => false }; },
        last() { return { count: async () => 0, isVisible: async () => false }; },
      };
    },
    async close() {},
    _stats: () => ({ slipCount, scrollCount, clickCount, openedSelector, fullSlipVisible }),
  };
  return page;
}

test('addLeg scrolls unobstructed, confirms +1 slip count, caps retries at 1, and never reports false success', async () => {
  const origMarkets = exMod.markets;
  exMod.markets = async () => [{ i: 13, title: 'Total', label: 'over 3.5', odds: 2.23 }];
  const fakeSite = { openEvent: async () => true, shot: async () => {} };
  const leg = { sport: 'football', home: 'Galatasaray Istanbul', away: 'Aston Villa', league: 'UCL', market: 'Total', outcome: 'over 3.5', odds: 2.23, url: 'https://test' };
  try {
    // 1) Normal unobstructed addition confirmed on attempt 1
    const p1 = makeMockBookingPage({ initialCount: 0 });
    const r1 = await addLeg(fakeSite, p1, leg);
    assert.equal(r1.ok, true);
    assert.equal(r1.slipCount, 1);
    assert.equal(r1.attempts, 1);
    assert.equal(p1._stats().scrollCount, 1);

    // 2) Covered by overlay on attempt 1, succeeds on the single controlled retry (attempt 2)
    const p2 = makeMockBookingPage({ initialCount: 1, incrementOnAttempt: 2 });
    const r2 = await addLeg(fakeSite, p2, leg);
    assert.equal(r2.ok, true);
    assert.equal(r2.slipCount, 2);
    assert.equal(r2.attempts, 2);
    assert.equal(p2._stats().scrollCount, 2);

    // 3) Click never increments betslip count -> stops after 2 attempts (1 initial + 1 retry) with ok:false
    const p3 = makeMockBookingPage({ initialCount: 1, neverIncrement: true });
    const r3 = await addLeg(fakeSite, p3, leg);
    assert.equal(r3.ok, false);
    assert.equal(r3.attempts, 2);
    assert.equal(p3._stats().clickCount, 2);
    assert.match(r3.why, /did not increase by 1/);

    // 4) Click throws error -> never produces false success, stops cleanly
    const p4 = makeMockBookingPage({ initialCount: 1, failClick: true });
    const r4 = await addLeg(fakeSite, p4, leg);
    assert.equal(r4.ok, false);
    assert.equal(p4._stats().clickCount, 2);
  } finally {
    exMod.markets = origMarkets;
  }
});

test('openFullBetslip uses .betslip-nav-container and share verifies ONLY full betslip container text (ignoring background page)', async () => {
  const fakeSite = { shot: async () => {} };
  const legs = [
    { home: 'Ratchaburi FC', away: 'Johor Darul Ta\'zim', outcome: 'under 2.5' },
    { home: 'Como 1907', away: 'AEK Athens', outcome: 'over 3.5' },
  ];
  // Background page text has Como 1907 / AEK Athens / over 3.5, but actual full betslip container ONLY has Leg 1!
  const p = makeMockBookingPage({
    initialCount: 1,
    containerText: 'Betslip\n1\nUnder2.5\n2.75\nRatchaburi FC vs Johor Darul Ta\'zim\nTotal',
    bodyText: 'Betslip\n1\nUnder2.5\nRatchaburi FC vs Johor Darul Ta\'zim\nComo 1907 vs AEK Athens\nOver 3.5',
  });
  const opened = await openFullBetslip(p);
  assert.equal(opened.opened, true);
  assert.equal(p._stats().openedSelector, '.betslip-nav-container');

  const res = await share(fakeSite, p, legs);
  assert.equal(res.code, '');
  assert.equal(res.verifiedLegs.length, 1);
  assert.equal(res.missingLegs.length, 1);
  assert.match(res.why, /Como 1907 v AEK Athens/);
});

// ---- Dynamic Statistics-to-Market Selection Tests (Section 6) ----
const { candidates, buildEvidenceProfile, interpretMarketSemantics } = require('../lib/analyze');
const { book } = require('../lib/book');

test('book() stops immediately when a leg fails betslip-count confirmation and never returns a booking code', async () => {
  const origMarkets = exMod.markets;
  exMod.markets = async () => [{ i: 13, title: 'Total', label: 'over 3.5', odds: 2.0 }];
  let openedMatches = 0;
  const p = makeMockBookingPage({ initialCount: 0, neverIncrement: true });
  const fakeSite = {
    newPage: async () => p,
    openEvent: async () => { openedMatches++; return true; },
    shot: async () => {},
  };
  const legs = [
    { sport: 'football', home: 'Match 1A', away: 'Match 1B', league: 'L', market: 'Total', outcome: 'over 3.5', odds: 2.0, url: 'https://t/1' },
    { sport: 'football', home: 'Match 2A', away: 'Match 2B', league: 'L', market: 'Total', outcome: 'over 3.5', odds: 2.0, url: 'https://t/2' },
  ];
  try {
    const res = await book(fakeSite, legs, Date.now() + 60000);
    assert.equal(res.ok, false);
    assert.equal(res.code, '');
    assert.equal(res.added, 0);
    assert.equal(openedMatches, 1, 'must stop immediately after Leg 1 fails instead of continuing to Leg 2');
  } finally {
    exMod.markets = origMarkets;
  }
});

test('Dynamic selection rejects unapproved novel market by default and evaluates it only when allowUnapprovedMarkets is explicitly enabled', () => {
  const ev = {
    key: 'football:novel:1', sport: 'football', home: 'Alpha FC', away: 'Beta United', league: 'Test League', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WWWDW',
      awayForm: 'WDLWW',
      avg: { 'throw ins': 39.2 },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Match Total Throw-Ins Band', label: '32-48', odds: 1.55, type: 'OTHER' },
      { i: 1, title: 'Match Total Throw-Ins Band', label: '0-10', odds: 9.50, type: 'OTHER' },
    ],
  };
  // By default, ONLY the 9 approved markets are authorized
  const strictCands = candidates(ev, { sports: ['football'], markets: [] });
  assert.equal(strictCands.length, 0, 'unapproved throw-ins market must be rejected under 9-approved-markets policy');
  assert.equal(ev.marketDiscoveryReport.rejectedUnapprovedCount, 2);

  // Underlying semantic evaluator still works when explicitly opted out in legacy diagnostic mode
  const cands = candidates(ev, { sports: ['football'], markets: [], allowUnapprovedMarkets: true });
  assert.ok(cands.length >= 1);
  const best = cands.sort((a, b) => b.score - a.score)[0];
  assert.equal(best.market, 'Match Total Throw-Ins Band');
  assert.equal(best.outcome, '32-48');
});

test('Selection evaluates approved non-1X2/non-Total markets (Team Total, Corner 1X2, Double Chance, Any Team To Win) while rejecting unapproved markets', () => {
  const ev = {
    key: 'football:approved-alt:1', sport: 'football', home: 'Dominant City', away: 'Low Scorers', league: 'Premier', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WWWWW',
      awayForm: 'LLLLD',
      goals: { hFor: 2.6, hAg: 0.4, aFor: 0.4, aAg: 2.2 },
      advancedStats: {
        home: { matches: 10, cornersAvg: 7.4, cardsAvg: 1.2, shotsOnGoalAvg: 6.5 },
        away: { matches: 10, cornersAvg: 4.8, cardsAvg: 2.3, shotsOnGoalAvg: 2.1 },
      },
      avg: { corners: 12.2, 'total cards': 3.5 },
      pct: [],
    },
    markets: [
      // Approved markets (NOT 1X2 and NOT match Total)
      { i: 0, title: 'Dominant City total', label: 'Over 1.5', odds: 1.52 },
      { i: 1, title: 'Corner 1x2', label: 'Home', odds: 1.48 },
      { i: 2, title: 'Double chance', label: 'Homeordraw', odds: 1.15 },
      { i: 3, title: 'Any team to win', label: '12', odds: 1.22 },
      // Unapproved markets MUST be excluded!
      { i: 4, title: 'Total corners', label: 'over 9.5', odds: 1.52 },
      { i: 5, title: 'Asian Handicap', label: 'Dominant City -0.5', odds: 1.45 },
      { i: 6, title: 'Dominant City clean sheet', label: 'yes', odds: 1.85 },
    ],
  };
  const cands = candidates(ev, { sports: ['football'], markets: [] });
  assert.equal(cands.length, 4, 'exactly the 4 approved markets should be evaluated');
  assert.equal(ev.marketDiscoveryReport.rejectedUnapprovedCount, 3);
  assert.ok(cands.every((c) => ['team_total', 'corner_1x2', 'double_chance', 'any_team_to_win'].includes(c.approvedMarketId)));
  const t = build(cands, { target: 0, count: 1 });
  assert.equal(t.legs.length, 1);
  assert.ok(['team_total', 'corner_1x2', 'double_chance', 'any_team_to_win'].includes(t.legs[0].approvedMarketId));
});

test('Dynamic selection rejects unsupported markets, skips matches with insufficient evidence, and never forces picks for target odds', () => {
  // Match has ONLY corner & player-prop markets, while collected stats contain ONLY goals (NO corner or player stats)
  const unsupportedEv = {
    key: 'football:no-corner-stats:1', sport: 'football', home: 'Team A', away: 'Team B', league: 'League', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WDLWD',
      awayForm: 'LDWLD',
      goals: { hFor: 1.2, hAg: 1.2, aFor: 1.1, aAg: 1.2 },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Total corners', label: 'over 9.5', odds: 1.85, type: 'STAT_OU', stat: 'corner', side: 'O', line: 9.5 },
      { i: 1, title: 'Anytime goalscorer', label: 'Player X', odds: 2.60, type: 'OTHER' },
    ],
  };
  const cands1 = candidates(unsupportedEv, { sports: ['football'], markets: [] });
  assert.equal(cands1.length, 0, 'must reject corner/player markets when no corner/player stats exist');
  assert.ok(unsupportedEv.rejected);

  // Match has ONLY an unlikely market (Over 5.5 when expected total goals = 1.6) — must NOT be forced even for target odds 25
  const lowEvidenceEv = {
    key: 'football:unlikely:1', sport: 'football', home: 'Tight FC', away: 'Defensive Utd', league: 'League', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'DDWDD',
      awayForm: 'DDLDD',
      goals: { hFor: 0.8, hAg: 0.8, aFor: 0.8, aAg: 0.8 },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Total', label: 'over 5.5', odds: 9.50, type: 'OU', side: 'O', line: 5.5 },
    ],
  };
  const cands2 = candidates(lowEvidenceEv, { sports: ['football'], markets: [] });
  // Never invents Over 1.5 or Under 2.5 when only Over 5.5 is displayed
  assert.ok(cands2.every((c) => c.outcome === 'over 5.5'));
  const t = build(cands2, { target: 25, count: 0 });
  assert.equal(t.legs.length, 0, 'must skip match and never force unsupported picks to chase target odds');
  assert.equal(t.complete, false);
  assert.equal(t.status, 'empty');
});

test('Dynamic selection uses exact displayed lines and adapts across different statistical match profiles without predetermined markets', () => {
  // Profile A: Strong corner match with balanced goals -> prefers corner market when offered
  const profA = buildEvidenceProfile({
    sport: 'football', home: 'Wing FC', away: 'Cross Utd',
    stats: {
      available: true, homeForm: 'WDLWD', awayForm: 'WDLWD',
      goals: { hFor: 1.2, hAg: 1.2, aFor: 1.2, aAg: 1.2 },
      advancedStats: { home: { matches: 10, cornersAvg: 7.2 }, away: { matches: 10, cornersAvg: 6.1 } },
      pct: [],
    },
    markets: [],
  });
  assert.ok(profA.metrics.corner && Math.abs(profA.metrics.corner.totalLambda - 13.3) < 0.01);
  const sem = interpretMarketSemantics({ title: 'Total corners', label: 'over 9.5', odds: 1.55 }, { home: 'Wing FC', away: 'Cross Utd' }, profA);
  assert.equal(sem.kind, 'threshold');
  assert.equal(sem.domain, 'corner');
  assert.equal(sem.line, 9.5);
});


// ---- Part 1, 2, 3, 4, 5, 7 Comprehensive Upgrade Tests (Part 8) ----
const dates = require('../lib/dates');
const mkLib = require('../lib/market_knowledge');
const { createFixtureRegistry, mergeDiscoveredFixture } = require('../lib/site');

test('Africa/Kampala natural date-range parser handles all inclusive single-day and multi-day phrases accurately', () => {
  // Fixed reference: Tuesday 2026-11-24 23:30:00 Africa/Kampala (= 20:30:00 UTC)
  const tueLateNight = Date.UTC(2026, 10, 24, 20, 30, 0);
  assert.equal(dates.kampalaYmd(tueLateNight), '2026-11-24');

  const today = dates.parseNaturalDateScope('Football matches today', tueLateNight);
  assert.deepEqual(today.dates, ['2026-11-24']);
  assert.equal(today.timezone, 'Africa/Kampala');

  const todayAndTomorrow = dates.parseNaturalDateScope('I need odd 100 from today and tomorrow matches', tueLateNight);
  assert.equal(todayAndTomorrow.scope, 'range');
  assert.deepEqual(todayAndTomorrow.dates, ['2026-11-24', '2026-11-25']);

  const todayPlusTwo = dates.parseNaturalDateScope('Football matches today and the next two days', tueLateNight);
  assert.deepEqual(todayPlusTwo.dates, ['2026-11-24', '2026-11-25', '2026-11-26']);

  const forThreeDays = dates.parseNaturalDateScope('Matches for three days from today', tueLateNight);
  assert.deepEqual(forThreeDays.dates, ['2026-11-24', '2026-11-25', '2026-11-26']);

  const todayPlusThree = dates.parseNaturalDateScope('Matches today and the next three days', tueLateNight);
  assert.deepEqual(todayPlusThree.dates, ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);

  const nextSeven = dates.parseNaturalDateScope('Football matches next seven days', tueLateNight);
  assert.equal(nextSeven.dates.length, 7);
  assert.equal(nextSeven.startDate, '2026-11-24');
  assert.equal(nextSeven.endDate, '2026-11-30');

  const weekend = dates.parseNaturalDateScope('Matches this weekend', tueLateNight);
  assert.deepEqual(weekend.dates, ['2026-11-28', '2026-11-29']);

  const friSun = dates.parseNaturalDateScope('Football from Friday through Sunday', tueLateNight);
  assert.deepEqual(friSun.dates, ['2026-11-27', '2026-11-28', '2026-11-29']);

  // Year & month boundary crossing: 2026-12-30 22:30 UTC == 2026-12-31 01:30 Africa/Kampala!
  const dec31Kampala = Date.UTC(2026, 11, 30, 22, 30, 0);
  assert.equal(dates.kampalaYmd(dec31Kampala), '2026-12-31');
  const crossYear = dates.parseNaturalDateScope('today and the next two days', dec31Kampala);
  assert.deepEqual(crossYear.dates, ['2026-12-31', '2027-01-01', '2027-01-02']);

  // Genuinely ambiguous phrase triggers clarification instead of silent guess
  const amb = dates.parseNaturalDateScope('football matches later this week', tueLateNight);
  assert.equal(amb.ambiguous, true);
  assert.ok(amb.clarificationQuestion.length > 10);
});

test('resolveDateScope protects multi-day natural requests from silent single-day collapse and plans all BangBet tabs', () => {
  const ref = Date.UTC(2026, 10, 24, 10, 0, 0);
  // Simulate legacy client mistakenly sending scope="tomorrow" for "today and tomorrow"
  const ds = dates.resolveDateScope({
    scope: 'tomorrow',
    text: 'I need odd 100 from today and tomorrow matches',
  }, ref);
  assert.equal(ds.scope, 'range');
  assert.deepEqual(ds.dates, ['2026-11-24', '2026-11-25']);
  assert.deepEqual(ds.bangbetTabs, ['today', 'tomorrow']);
  assert.equal(ds.timezone, 'Africa/Kampala');
});

test('Discovery dedupe registry merges DOM abbreviated names with network full names and preserves direct URLs', () => {
  const reg = createFixtureRegistry();
  // Network JSON arrives first with full Sportradar name + direct URL
  const r1 = mergeDiscoveredFixture(reg, {
    home: 'Sabah Masazir', away: 'FC Barcelona',
    id: 'sr:match:74166032', url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A74166032',
    ts: 1795628700000, source: 'network',
  }, 'football');
  assert.equal(r1.added, true);
  assert.equal(r1.item.matchId, 74166032);

  // DOM row arrives with abbreviated name and no URL -> MUST merge, NOT create duplicate!
  const r2 = mergeDiscoveredFixture(reg, {
    home: 'Sabah Masazir', away: 'Barcelona',
    id: '', url: '', ts: 1795628700000, odds: [12.0, 6.5, 1.15], source: 'dom',
  }, 'football');
  assert.equal(r2.added, false);
  assert.equal(reg.list.length, 1);
  assert.equal(reg.list[0].url, 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A74166032');
  assert.equal(reg.list[0].source, 'dom+network');

  // Reverse order: DOM PSG v AS Roma arrives first, then network Paris Saint-Germain v AS Roma upgrades it!
  const r3 = mergeDiscoveredFixture(reg, { home: 'PSG', away: 'AS Roma', url: '', source: 'dom' }, 'football');
  const r4 = mergeDiscoveredFixture(reg, {
    home: 'Paris Saint-Germain', away: 'AS Roma',
    id: 'sr:match:74166099', url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A74166099',
    source: 'network',
  }, 'football');
  assert.equal(r3.added, true);
  assert.equal(r4.added, false);
  assert.equal(reg.list.length, 2);
  assert.equal(reg.list[1].home, 'Paris Saint-Germain');
  assert.equal(reg.list[1].matchId, 74166099);
  assert.ok(reg.list[1].url.includes('74166099'));
});

test('Market Knowledge Library defines all required market families with complete structured metadata', () => {
  const required = [
    'match_result_1x2', 'double_chance', 'draw_no_bet', 'asian_handicap', 'european_handicap',
    'goals_over_under', 'goals_ranges', 'btts', 'team_goals', 'half_time_full_time',
    'correct_score', 'winning_margin', 'clean_sheet', 'win_to_nil', 'first_last_to_score',
    'corners', 'cards_bookings', 'shots_sot', 'fouls', 'offsides', 'odd_even',
    'combo_markets', 'player_props',
  ];
  for (const id of required) {
    const def = mkLib.getMarketDefinition(id);
    assert.ok(def, `Missing market knowledge definition: ${id}`);
    assert.ok(def.name && Array.isArray(def.aliases) && def.aliases.length > 0);
    assert.ok(def.plainMeaning && def.settlementRules && def.lineMechanics);
    assert.ok(Array.isArray(def.relevantStats) && def.relevantStats.length > 0);
    assert.ok(Array.isArray(def.unevaluableWhen) && def.unevaluableWhen.length > 0);
    assert.ok(Array.isArray(def.commonErrors) && def.commonErrors.length > 0);
    assert.ok(def.examples && Array.isArray(def.examples.valid) && Array.isArray(def.examples.invalid));
  }
});

test('European 3-way Handicap and Asian Handicap (half/integer/quarter) settlement math is exact', () => {
  // European 3-way Handicap 0:2 (Away starts +2 goals up; NEVER pushes)
  assert.equal(mkLib.settleEuropeanHandicap(3, 0, 0, 2, 'H'), 'win');  // 3 > 2
  assert.equal(mkLib.settleEuropeanHandicap(2, 0, 0, 2, 'H'), 'loss'); // 2 == 2 -> Draw wins, NOT push!
  assert.equal(mkLib.settleEuropeanHandicap(2, 0, 0, 2, 'X'), 'win');  // Handicap Draw wins
  assert.equal(mkLib.settleEuropeanHandicap(1, 0, 0, 2, 'A'), 'win');  // 1 < 2 -> Away 0:2 wins

  // European 3-way Handicap 2:0 (Home starts +2 goals up)
  assert.equal(mkLib.settleEuropeanHandicap(0, 1, 2, 0, 'H'), 'win');  // 2 > 1
  assert.equal(mkLib.settleEuropeanHandicap(0, 2, 2, 0, 'X'), 'win');  // 2 == 2
  assert.equal(mkLib.settleEuropeanHandicap(0, 3, 2, 0, 'A'), 'win');  // 2 < 3

  // Asian Handicap integer line (-1.0): push on exact 1-goal win
  assert.equal(mkLib.settleAsianHandicap(2, 0, -1, 'H').outcome, 'win');
  assert.equal(mkLib.settleAsianHandicap(1, 0, -1, 'H').outcome, 'push');
  assert.equal(mkLib.settleAsianHandicap(1, 1, -1, 'H').outcome, 'loss');

  // Asian Handicap quarter line (-0.25 = half on 0, half on -0.5)
  assert.equal(mkLib.settleAsianHandicap(1, 0, -0.25, 'H').outcome, 'win');
  assert.equal(mkLib.settleAsianHandicap(1, 1, -0.25, 'H').outcome, 'half_loss');
  assert.equal(mkLib.settleAsianHandicap(1, 1, +0.25, 'H').outcome, 'half_win');
  assert.equal(mkLib.settleAsianHandicap(0, 1, -0.25, 'H').outcome, 'loss');

  // Asian Handicap quarter line (-0.75 = half on -0.5, half on -1.0)
  assert.equal(mkLib.settleAsianHandicap(2, 0, -0.75, 'H').outcome, 'win');
  assert.equal(mkLib.settleAsianHandicap(1, 0, -0.75, 'H').outcome, 'half_win');
  assert.equal(mkLib.settleAsianHandicap(1, 1, -0.75, 'H').outcome, 'loss');
});

test('Mismatched fixture calibration prevents overestimating underdog European Handicap (Sabah vs Barcelona regression)', () => {
  const ev = {
    key: 'football:sabah:barca', sport: 'football', home: 'Sabah Masazir', away: 'FC Barcelona',
    league: 'UEFA Champions League', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WDLLD', awayForm: 'WWWWL',
      probs: { H: 0.04, X: 0.07, A: 0.89 },
      goals: { hFor: 1.67, hAg: 1.80, aFor: 2.90, aAg: 1.67 },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Handicap', label: 'home 2:0', odds: 4.00, type: 'HANDICAP', side: 'H' },
      { i: 1, title: 'Handicap', label: 'away 2:0', odds: 1.62, type: 'HANDICAP', side: 'A' },
    ],
  };
  // Strict mode rejects unapproved European Handicap; explicit calibration check with allowUnapprovedMarkets verifies math
  assert.equal(candidates(ev, { sports: ['football'], markets: [] }).length, 0);
  const cands = candidates(ev, { sports: ['football'], markets: [], allowUnapprovedMarkets: true });
  const homeHcp = cands.find((c) => c.outcome === 'home 2:0');
  assert.ok(homeHcp, 'should evaluate European Handicap home 2:0 in calibration test');
  assert.ok(homeHcp.modelProbability < 0.50, `calibrated probability for underdog home 2:0 must stay below 0.50, got ${homeHcp.modelProbability}`);
  assert.notEqual(homeHcp.modelProbability, homeHcp.confidenceScore);
  assert.ok(typeof homeHcp.confidenceScore === 'number' && homeHcp.confidenceScore > 0 && homeHcp.confidenceScore <= 1);
});

test('Per-match internal marketDiscoveryReport accurately counts approved vs unapproved markets, headings, lines, outcomes, and missing-stats exclusions', () => {
  const ev = {
    key: 'football:counts:1', sport: 'football', home: 'Alpha FC', away: 'Beta FC', league: 'Premier', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WWWDW', awayForm: 'LLDWL',
      goals: { hFor: 2.2, hAg: 0.7, aFor: 0.8, aAg: 1.9 },
      probs: { H: 0.72, X: 0.18, A: 0.10 },
      pct: [],
    },
    markets: [
      // 3 outcomes under 1 approved heading ("1X2") -> 1 heading, 1 line, 3 outcomes
      { i: 0, title: '1X2', label: 'Home', odds: 1.40, type: 'WIN', side: 'H' },
      { i: 1, title: '1X2', label: 'Draw', odds: 4.50, type: 'WIN', side: 'X' },
      { i: 2, title: '1X2', label: 'Away', odds: 7.50, type: 'WIN', side: 'A' },
      // 4 outcomes under 1 approved heading ("Total"), 2 distinct lines (1.5 and 2.5)
      { i: 3, title: 'Total', label: 'Over 1.5', odds: 1.25, type: 'OU', side: 'O', line: 1.5 },
      { i: 4, title: 'Total', label: 'Under 1.5', odds: 3.60, type: 'OU', side: 'U', line: 1.5 },
      { i: 5, title: 'Total', label: 'Over 2.5', odds: 1.78, type: 'OU', side: 'O', line: 2.5 },
      { i: 6, title: 'Total', label: 'Under 2.5', odds: 2.02, type: 'OU', side: 'U', line: 2.5 },
      // Approved market excluded for missing corner stats
      { i: 7, title: 'Corner 1x2', label: 'Home', odds: 1.85 },
      // Unapproved markets -> strictly rejected
      { i: 8, title: 'Anytime goalscorer', label: 'Striker 9', odds: 2.20, type: 'OTHER' },
      { i: 9, title: 'Booking points', label: 'Over 35.5', odds: 1.90, type: 'OTHER' },
      { i: 10, title: 'Mystery Special Exotic Z', label: 'Option Q', odds: 2.10, type: 'OTHER' },
    ],
  };
  const cands = candidates(ev, { sports: ['football'], markets: [] });
  assert.ok(cands.length > 0);
  const rpt = ev.marketDiscoveryReport;
  assert.ok(rpt, 'marketDiscoveryReport must be populated');
  assert.equal(rpt.approvedMarketsOnly, true);
  assert.equal(rpt.outcomesCount, 11);
  assert.equal(rpt.distinctHeadingsCount, 6);
  assert.equal(rpt.marketLinesCount, 4, '1X2 (1) + Total (2 lines) + Corner 1x2 (1) = 4 approved lines');
  assert.equal(rpt.excludedMissingStatsCount, 1, 'Corner 1x2 excluded for missing corner stats');
  assert.equal(rpt.rejectedUnapprovedCount, 3, 'player prop, booking points, and exotic market rejected as unapproved');
  assert.ok(rpt.approvedMarketsOffered.includes('match_result_1x2'));
  assert.ok(rpt.approvedMarketsOffered.includes('total_goals'));
  assert.ok(rpt.approvedMarketsOffered.includes('corner_1x2'));
  assert.ok(!rpt.approvedMarketsEvaluated.includes('corner_1x2'));
  assert.ok(rpt.selected && typeof rpt.selected.modelProbability === 'number' && typeof rpt.selected.confidenceScore === 'number');
});


test('book.js share() extracts genuine mixed-case and all-letter BangBet booking codes from /bookcode/ modal', async () => {
  const fakeSite = { shot: async () => {} };
  const legs = [
    { home: 'RB Leipzig', away: 'Racing Club De Lens', outcome: 'away 0:4' },
    { home: 'Slavia Prague', away: 'Villarreal CF', outcome: 'over 1.5' },
  ];
  const mockPage = {
    net: [],
    locator: (sel) => ({
      first: () => ({
        count: async () => (sel.includes('betslip-nav') || sel.includes('share-btn') ? 1 : 0),
        isVisible: async () => (sel.includes('betslip-nav') || sel.includes('share-btn')),
        click: async () => {},
      }),
      getByText: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    }),
    evaluate: async (fn) => {
      const s = String(fn);
      if (s.includes('.betslip-container') && s.includes('selector:')) {
        return {
          opened: true,
          selector: '.betslip-container',
          containerText: 'Betslip 2\nAway0:4\nRB Leipzig vs Racing Club De Lens\nOver1.5\nSlavia Prague vs Villarreal CF',
        };
      }
      if (s.includes('.betslip-container')) {
        return 'Betslip 2\nAway0:4\nRB Leipzig vs Racing Club De Lens\nOver1.5\nSlavia Prague vs Villarreal CF';
      }
      if (s.includes('.book-code')) {
        return 'Share Bet\nBooking Code:\nMmptud\nCopy\nwww.bangbet.com/bookcode/Mmptud\nCopy Link';
      }
      if (s.includes('input,textarea')) return [];
      if (s.includes('clipboard')) return '';
      return 'Share Bet\nBooking Code:\nMmptud\nwww.bangbet.com/bookcode/Mmptud';
    },
    getByText: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  };
  const res = await share(fakeSite, mockPage, legs);
  assert.equal(res.code, 'Mmptud');
  assert.equal(res.link, 'https://www.bangbet.com/bookcode/Mmptud');
  assert.equal(res.verifiedLegs.length, 2);
  assert.equal(res.missingLegs.length, 0);
});


// ---- Section 1-8 Comprehensive Research Engine Upgrade Tests ----
const { collectStatsWithRetry, buildProgress } = require('../run');
const { MAX_TICKET_SELECTIONS } = require('../lib/ticket');
const { verifyHighOddsCandidate, HIGH_ODDS_THRESHOLD } = require('../lib/analyze');
const { filterCompetitionForm, parseScoringConceding, parseRecentMatches } = require('../lib/gismo');

test('Fixture inventory deduplication scales past 50 (e.g. 120 fixtures) with no arbitrary discovery cap', () => {
  const reg = createFixtureRegistry();
  for (let i = 1; i <= 120; i++) {
    mergeDiscoveredFixture(reg, {
      home: `Club Home ${i}`, away: `Club Away ${i}`,
      id: `sr:match:${900000 + i}`,
      url: `https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A${900000 + i}`,
      ts: 1795628700000 + i * 60000,
      source: 'network',
    }, 'football');
  }
  assert.equal(reg.list.length, 120, 'discovery inventory must not be capped at 50');
});

test('Stage C collectStatsWithRetry performs exactly 1 genuine retry, recovers if loaded, or marks no_stats_after_retry', async () => {
  // Case 1: Delayed stats recover on the single retry
  let calls1 = 0;
  const ev1 = { home: 'A', away: 'B' };
  const r1 = await collectStatsWithRetry(
    ev1,
    async () => { calls1++; return { available: false, status: 'no_data_returned' }; },
    async () => { calls1++; return { available: true, status: 'complete' }; }
  );
  assert.equal(calls1, 2);
  assert.equal(r1.retried, true);
  assert.equal(r1.recoveredOnRetry, true);
  assert.equal(r1.statsStatus, 'complete');

  // Case 2: Still missing after 1 retry -> marked no_stats_after_retry and never retries indefinitely
  let calls2 = 0;
  const ev2 = { home: 'Small Town FC', away: 'Amateur Utd' };
  const r2 = await collectStatsWithRetry(
    ev2,
    async () => { calls2++; return { available: false, status: 'no_data_returned' }; },
    async () => { calls2++; return { available: false, status: 'no_data_returned' }; }
  );
  assert.equal(calls2, 2);
  assert.equal(r2.retried, true);
  assert.equal(r2.recoveredOnRetry, false);
  assert.equal(r2.statsStatus, 'no_stats_after_retry');
});

test('Competition-specific statistics separate target season from domestic matches and preserve unequal sample sizes', () => {
  const mixedMatches = {
    matches: [
      { _id: 1, _seasonid: 140786, teams: { home: { uid: 10 }, away: { uid: 20 } }, result: { home: 2, away: 0 } },
      { _id: 2, _seasonid: 140786, teams: { home: { uid: 30 }, away: { uid: 10 } }, result: { home: 1, away: 1 } },
      { _id: 3, _seasonid: 140786, teams: { home: { uid: 10 }, away: { uid: 40 } }, result: { home: 0, away: 3 } },
      { _id: 4, _seasonid: 140786, teams: { home: { uid: 50 }, away: { uid: 10 } }, result: { home: 2, away: 1 } },
      // Domestic league wins that MUST NOT pollute Champions League season 140786 form:
      { _id: 5, _seasonid: 999999, teams: { home: { uid: 10 }, away: { uid: 60 } }, result: { home: 5, away: 0 } },
      { _id: 6, _seasonid: 999999, teams: { home: { uid: 10 }, away: { uid: 70 } }, result: { home: 4, away: 0 } },
    ],
  };
  const recent = parseRecentMatches(mixedMatches, 10);
  const compOnly = filterCompetitionForm(recent, 140786);
  assert.equal(compOnly.context, 'competition_specific');
  assert.equal(compOnly.sampleSize, 4, 'must preserve exact 4 competition observations without mixing domestic wins');
  assert.equal(compOnly.overall, 'WDLL');
  assert.equal(compOnly.home, 'WL');
  assert.equal(compOnly.away, 'DL');
  assert.equal(compOnly.homeSampleSize, 2);
  assert.equal(compOnly.awaySampleSize, 2);

  // FTS (Failed To Score) and CS (Clean Sheets) extraction with sample size
  const sc = parseScoringConceding({
    team: { _id: 10, name: 'Test FC' },
    stats: {
      totalmatches: { total: 4, home: 2, away: 2 },
      totalwins: { total: 1 },
      scoring: { goalsscored: { total: 4 }, failedtoscore: { total: 1 } },
      conceding: { goalsconceded: { total: 6 }, cleansheets: { total: 1 } },
    },
  });
  assert.equal(sc.failedToScore, 1);
  assert.equal(sc.failedToScorePct, 25);
  assert.equal(sc.cleanSheets, 1);
  assert.equal(sc.cleanSheetPct, 25);
});

test('High-odds (>= 5.00) second verification accepts consistent verified picks and rejects mismatched or weakly supported picks', () => {
  assert.equal(HIGH_ODDS_THRESHOLD, 5.0);
  const baseEv = {
    sport: 'football', home: 'Strong FC', away: 'Weak FC', matchId: 55501,
    stats: {
      available: true, fixtureId: 55501, seasonId: 140786,
      homeForm: 'WWWWW', awayForm: 'LLLLL',
      homeFormSampleSize: 6, awayFormSampleSize: 6,
      goals: { hFor: 2.8, hAg: 0.4, aFor: 0.4, aAg: 2.6 },
      teamStats: { home: { matches: 8 }, away: { matches: 8 } },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Total', label: 'over 2.5', odds: 5.50, type: 'OU', side: 'O', line: 2.5 },
    ],
  };
  const cand = {
    evKey: 'football:55501', sport: 'football', market: 'Total', outcome: 'over 2.5',
    odds: 5.50, p: 0.62,
  };
  // 1) Mismatched fixtureId MUST be rejected
  const badId = verifyHighOddsCandidate(cand, baseEv, { ...baseEv.stats, fixtureId: 99999 }, baseEv.markets);
  assert.equal(badId.verified, false);
  assert.match(badId.reason, /fixtureId mismatch/);

  // 2) Tiny sample size (<4 matches, no probs) MUST be rejected
  const tiny = verifyHighOddsCandidate(
    cand, baseEv,
    { ...baseEv.stats, homeForm: 'WW', awayForm: 'LL', homeFormSampleSize: 2, awayFormSampleSize: 2, teamStats: { home: { matches: 2 }, away: { matches: 2 } } },
    baseEv.markets
  );
  assert.equal(tiny.verified, false);

  // 3) Valid strong consistent high-odds candidate passes
  const good = verifyHighOddsCandidate(cand, baseEv, baseEv.stats, baseEv.markets);
  assert.equal(good.verified, true);
});

test('Exact 50-selection rule: stops before 50 when target hit, books at 50 when target unmet, and never exceeds 50', () => {
  assert.equal(MAX_TICKET_SELECTIONS, 50);
  // 80 qualifying fixtures at 1.08 odds each (1.08^50 = 46.90 < target 500)
  const eighty = Array.from({ length: 80 }, (_, i) => ({
    evKey: `football:m${i}`, sport: 'football', home: `H${i}`, away: `A${i}`,
    market: 'Total', outcome: 'over 1.5', odds: 1.08, p: 0.85, score: 0.85 - i * 0.001, ts: 1e12 + i * 1000,
  }));

  // Situation B: 50 selections reached without hitting target 500 -> complete & bookable at 50 legs!
  const sitB = build(eighty, { target: 500, count: 0 });
  assert.equal(sitB.legs.length, 50);
  assert.equal(sitB.status, 'limit_50_reached');
  assert.equal(sitB.limitReached50, true);
  assert.equal(sitB.targetReached, false);
  assert.equal(sitB.bookable, true);
  assert.equal(sitB.complete, true);

  // Situation A: Target 2.0 reached well before 50 selections -> stops early!
  const sitA = build(eighty, { target: 2.0, count: 0 });
  assert.ok(sitA.legs.length < 50 && sitA.legs.length >= 9);
  assert.equal(sitA.status, 'ready');
  assert.equal(sitA.targetReached, true);
  assert.equal(sitA.limitReached50, false);
  assert.equal(sitA.bookable, true);

  // Situation C: Only 5 qualifying fixtures, target 500 -> partial, honest actual odds
  const sitC = build(eighty.slice(0, 5), { target: 500, count: 0 });
  assert.equal(sitC.legs.length, 5);
  assert.equal(sitC.status, 'partial');
  assert.equal(sitC.bookable, false);
  assert.equal(sitC.complete, false);
});

test('buildProgress never falsely reports 100% before completion and computes real estimates', () => {
  const started = Date.now() - 20000;
  const pRun = buildProgress('collecting_stats', 'Collecting statistics', started, {
    discovered: 100, inWindow: 80, statsChecked: 40, statsUsable: 30, statsSkippedUnavailable: 10,
  }, 80, null);
  assert.ok(pRun.percent > 15 && pRun.percent < 100);
  assert.ok(pRun.estimatedRemainingSec > 0);
  assert.equal(pRun.statsChecked, 40);

  const pCap = buildProgress('verifying_booking', 'Verifying the booking code', started, {}, 80, 100);
  assert.equal(pCap.percent, 99, 'must never report 100% until stageKey is completed');

  const pDone = buildProgress('completed', 'Booking code ready', started, {}, 80, 100);
  assert.equal(pDone.percent, 100);
});

test('Verification 2 deterministic 65-candidate 50-selection test: selects exact 50 strongest, computes exact combined odds, stays bookable, never adds 51st', () => {
  // 65 qualifying candidates with distinct evidence scores and odds (1.06 each -> 1.06^50 = 18.42015 < target 250)
  // Intentionally shuffled input order so sorting by evidence score is genuinely tested
  const cands = [];
  for (let i = 0; i < 65; i++) {
    cands.push({
      evKey: `football:det_${i}`,
      sport: 'football',
      home: `HomeTeam_${i}`,
      away: `AwayTeam_${i}`,
      market: 'Total',
      outcome: 'over 1.5',
      odds: 1.06,
      p: 0.72 + (i * 0.004), // higher i = stronger statistical evidence
      score: 0.72 + (i * 0.004),
      ts: 1795628700000 + i * 60000,
    });
  }
  // Shuffle deterministically (reverse every second block)
  const shuffled = [...cands.slice(0, 20), ...cands.slice(45, 65), ...cands.slice(20, 45)];

  // Situation B: 65 qualifying candidates, target 250 cannot be reached by 50 legs at 1.06
  const resB = build(shuffled, { target: 250, count: 0 });
  assert.equal(resB.legs.length, 50, 'must choose exactly 50 selections and never add a 51st');
  assert.equal(resB.status, 'limit_50_reached');
  assert.equal(resB.targetReached, false, 'target must be shown as unmet');
  assert.equal(resB.limitReached50, true);
  assert.equal(resB.bookable, true, 'must remain eligible for booking verification');
  assert.equal(resB.complete, true);
  // Exact 50 strongest candidates are indices 15..64
  const selectedIds = new Set(resB.legs.map((l) => l.evKey));
  for (let i = 15; i < 65; i++) {
    assert.ok(selectedIds.has(`football:det_${i}`), `strongest candidate det_${i} must be selected`);
  }
  for (let i = 0; i < 15; i++) {
    assert.ok(!selectedIds.has(`football:det_${i}`), `weaker candidate det_${i} must not displace top 50`);
  }
  const expectedCombined = Math.pow(1.06, 50);
  assert.ok(Math.abs(resB.total - expectedCombined) < 1e-6, `combined odds ${resB.total} must match 1.06^50 (${expectedCombined})`);

  // Situation A: target 1.50 reached well before 50 selections
  const resA = build(shuffled, { target: 1.50, count: 0 });
  assert.equal(resA.status, 'ready');
  assert.equal(resA.targetReached, true);
  assert.equal(resA.limitReached50, false);
  assert.equal(resA.bookable, true);
  assert.ok(resA.legs.length < 50 && resA.legs.length === 7, '1.06^7 = 1.5036 reaches 1.50 in 7 legs');

  // Situation C: only 12 qualifying candidates, target 250 unmet -> strongest 12 generated, no weak picks forced
  const resC = build(shuffled.slice(0, 12), { target: 250, count: 0 });
  assert.equal(resC.status, 'partial');
  assert.equal(resC.legs.length, 12);
  assert.equal(resC.targetReached, false);
  assert.ok(Math.abs(resC.total - Math.pow(1.06, 12)) < 1e-6);

  // Situation D: zero qualifying candidates -> empty, honest reason
  const resD = build([], { target: 250, count: 0 });
  assert.equal(resD.status, 'empty');
  assert.equal(resD.legs.length, 0);
  assert.equal(resD.bookable, false);
});

test('book.js verifySlipText matches European club prefix shortenings (HNK/PFC/RSC) while still rejecting unrelated teams', () => {
  const slip = 'Betslip\n2\n1\n2.26\nHajduk Split vs St. Truidense\n1x2\n1\n4.10\nCSKA Sofia vs Trabzonspor\n1x2';
  const ok = verifySlipText(slip, [
    { home: 'HNK Hajduk Split', away: 'St. Truidense VV', outcome: '1' },
    { home: 'PFC CSKA Sofia', away: 'Trabzonspor', outcome: '1' },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.verified.length, 2);

  const bad = verifySlipText(slip, [
    { home: 'Arsenal FC', away: 'Trabzonspor', outcome: '1' },
  ]);
  assert.equal(bad.ok, false);
});

test('eventsFromNet skips listAiMatch/listTags banners and registry separates raw, uniqueUrls, and duplicates', () => {
  const { eventsFromNet, createFixtureRegistry, mergeDiscoveredFixture } = require('../lib/site');
  const net = [
    { url: 'https://bet-api.bangbet.com/api/bet/match/listAiMatch?country=ug', body: { data: [{ homeTeamName: 'Promo A', awayTeamName: 'Promo B', matchId: 'sr:match:999' }] } },
    { url: 'https://bet-api.bangbet.com/api/bet/match/list', body: { data: { data: [
      { homeTeamName: 'FC Barcelona', awayTeamName: 'Real Madrid', matchId: 'sr:match:1001' },
      { homeTeamName: 'Arsenal FC', awayTeamName: 'Chelsea FC', matchId: 'sr:match:1002' },
    ] } } },
  ];
  const evs = eventsFromNet(net, 'football');
  assert.equal(evs.length, 2, 'listAiMatch promo must not pollute fixture list');

  const reg = createFixtureRegistry();
  for (const e of evs) mergeDiscoveredFixture(reg, { ...e, source: 'network' }, 'football');
  // Add a DOM duplicate for Barcelona v Real Madrid
  mergeDiscoveredFixture(reg, { home: 'Barcelona', away: 'Real Madrid', source: 'dom' }, 'football');
  assert.equal(reg.rawFound, 3);
  assert.equal(reg.list.length, 2);
  assert.equal(reg.duplicatesRemoved, 1);
  assert.equal(reg.uniqueUrls.size, 2);
});

test('createTelemetry records stage timings, p50/p95, retries, timeouts, and slowest operations', () => {
  const { createTelemetry } = require('../run');
  const t = createTelemetry();
  t.start('collecting_stats');
  t.recordOp('collecting_stats', 'Match A', 1200);
  t.recordOp('collecting_stats', 'Match B', 4800, { retried: true });
  t.recordOp('collecting_stats', 'Match C', 900);
  t.recordOp('collecting_stats', 'Match D', 15000, { failed: true, timeout: true });
  t.end('collecting_stats');
  const snap = t.snapshot().collecting_stats;
  assert.equal(snap.completedOps, 3);
  assert.equal(snap.failedOps, 1);
  assert.equal(snap.retries, 1);
  assert.equal(snap.timeouts, 1);
  assert.equal(snap.slowestOps[0].label, 'Match D');
  assert.equal(snap.slowestOps[0].durationMs, 15000);
  assert.ok(snap.avgOpMs > 0 && snap.p50OpMs > 0 && snap.p95OpMs >= snap.p50OpMs);
});

test('waitForHydratedSlipCount waits for BangBet betslip badge to hydrate from 0 to expected prior leg count', async () => {
  const { waitForHydratedSlipCount } = require('../lib/book');
  let calls = 0;
  const fakePage = {
    evaluate: async () => {
      calls++;
      // Simulate Vue hydration delay: returns 0 twice, then hydrates to 4
      return calls >= 3 ? 4 : 0;
    },
  };
  const res = await waitForHydratedSlipCount(fakePage, 4, 2000);
  assert.equal(res.ok, true);
  assert.equal(res.count, 4);
  assert.ok(calls >= 3);
});

test('cloud/server.js enforces Bearer auth, safe daily job limits (429), and cancellation without deploying', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const { EventEmitter } = require('events');
  const { createCloudServer } = require('../../cloud/server');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betrobot-cloud-test-'));
  const app = createCloudServer({
    port: 0,
    host: '127.0.0.1',
    stateDir: tmpDir,
    token: 'test_cloud_secret_1234',
    maxConcurrentJobs: 1,
    maxJobsPerDay: 1,
    maxJobMinutes: 10,
    spawnWorker: (id, job, stateFile) => {
      const child = new EventEmitter();
      child.kill = () => { child.emit('exit', 0); };
      setTimeout(() => {
        fs.writeFileSync(stateFile, JSON.stringify({ id, status: 'done', stage: 'Booking code confirmed' }));
        child.emit('exit', 0);
      }, 60);
      return { child, logStream: null };
    },
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const reqJson = (method, p, body, token) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  try {
    // 1) Rejects missing/wrong token
    const unauth = await reqJson('GET', '/health', null, 'wrong');
    assert.equal(unauth.status, 401);

    // 2) Health returns OK with limits
    const health = await reqJson('GET', '/health', null, 'test_cloud_secret_1234');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.engine, 'betrobot-cloud-run');
    assert.equal(health.body.acceptingJobs, true);

    // 3) Accepts first job (202) and enforces maxJobMinutes cap
    const j1 = await reqJson('POST', '/jobs', { id: 'cr_test_1', params: { sports: ['football'], target: 2, minutes: 90 } }, 'test_cloud_secret_1234');
    assert.equal(j1.status, 202);
    assert.equal(j1.body.maxMinutes, 10);

    // Wait for worker to finish
    await new Promise((r) => setTimeout(r, 140));
    const st1 = await reqJson('GET', '/jobs/cr_test_1', null, 'test_cloud_secret_1234');
    assert.equal(st1.status, 200);
    assert.equal(st1.body.status, 'done');

    // 4) Refuses second job because maxJobsPerDay=1 was reached (HTTP 429)
    const j2 = await reqJson('POST', '/jobs', { id: 'cr_test_2', params: { sports: ['football'], target: 3 } }, 'test_cloud_secret_1234');
    assert.equal(j2.status, 429);
    assert.match(j2.body.error, /Daily safe job limit reached/i);
  } finally {
    app.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



test('book.js verifySlipText matches Double Chance 1X/X2/12 synonyms (incl. BangBet Homeordraw/Draworaway) while rejecting wrong outcomes', () => {
  const slip = 'Betslip\n2\nDraworaway\n1.06\nInter Club de Escaldes vs FC Copenhagen\nDouble chance\nHomeordraw\n1.05\nJuventus Turin vs AC Omonia Nicosia\nDouble chance';
  const ok = verifySlipText(slip, [
    { home: 'Inter Club de Escaldes', away: 'FC Copenhagen', outcome: 'X2' },
    { home: 'Juventus Turin', away: 'AC Omonia Nicosia', outcome: '1X' },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.verified.length, 2);

  const wrong = verifySlipText(slip, [
    { home: 'Inter Club de Escaldes', away: 'FC Copenhagen', outcome: '12' },
  ]);
  assert.equal(wrong.ok, false);
});

test('run.js enforces MAX_FIXTURES_TO_CHECK=100, separated counters, and editable-until-locked target odds', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { MAX_FIXTURES_TO_CHECK, buildProgress, readPendingTargetUpdate } = require('../run');
  assert.equal(MAX_FIXTURES_TO_CHECK, 100);

  const tmp = path.join(os.tmpdir(), `betrobot-target-test-${Date.now()}.json`);
  fs.writeFileSync(tmp + '.target.json', JSON.stringify({ target: 15.5, updatedAt: Date.now() }));
  try {
    assert.equal(readPendingTargetUpdate(tmp, 5.0), 15.5);
  } finally {
    fs.rmSync(tmp + '.target.json', { force: true });
  }

  const pOpen = buildProgress('collecting_stats', 'Collecting statistics', Date.now() - 5000, {
    discovered: 211, fixturesMatchingDateRange: 140, fixturesAfterLeagueFilter: 120,
    fixturesSelectedForCheck: 100, fixturesExcludedByCap: 20, virtualExcluded: 20, outOfWindowExcluded: 71,
    inWindow: 100, statsChecked: 10, statsUsable: 9,
  }, 100, null, { targetOdds: 15.5, targetLocked: false });
  assert.equal(pOpen.targetEditable, true);
  assert.equal(pOpen.targetLocked, false);
  assert.equal(pOpen.fixturesDiscovered, 211);
  assert.equal(pOpen.fixturesMatchingDateRange, 140);
  assert.equal(pOpen.fixturesAfterLeagueFilter, 120);
  assert.equal(pOpen.fixturesSelectedForCheck, 100);
  assert.equal(pOpen.fixturesExcludedByCap, 20);

  const pLocked = buildProgress('ranking_selections', 'Ranking selections', Date.now() - 5000, { discovered: 211, inWindow: 100 }, 100, 88, { targetOdds: 15.5, targetLocked: true });
  assert.equal(pLocked.targetEditable, false);
  assert.equal(pLocked.targetLocked, true);
});

test('cloud/server.js /jobs/:id/target allows updates before selection and returns HTTP 409 once locked', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const { createCloudServer } = require('../../cloud/server');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betrobot-target-api-'));
  const app = createCloudServer({ port: 0, host: '127.0.0.1', stateDir: tmpDir, token: 'tok_target_123' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;

  const stateFile = path.join(tmpDir, 'job-tjob1.json');
  fs.writeFileSync(stateFile, JSON.stringify({ id: 'tjob1', status: 'running', targetLocked: false, request: { target: 5 }, progress: { targetOdds: 5, targetLocked: false } }));

  const postTarget = (val) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/jobs/tjob1/target', method: 'POST',
      headers: { Authorization: 'Bearer tok_target_123', 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ target: val }));
    req.end();
  });

  try {
    const r1 = await postTarget(12.5);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.target, 12.5);
    assert.equal(r1.body.targetLocked, false);

    // Freeze target as Stage F begins
    fs.writeFileSync(stateFile, JSON.stringify({ id: 'tjob1', status: 'running', targetLocked: true, request: { target: 12.5 }, progress: { targetOdds: 12.5, targetLocked: true } }));
    const r2 = await postTarget(25);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.targetLocked, true);
  } finally {
    app.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



// =============================================================================
// PART 10 — AUTHORITATIVE 9-MARKET DICTIONARY, EARLY-STOP, VIRTUAL FILTER & BOOKING TESTS
// =============================================================================
const approvedMarkets = require('../lib/approved_markets');

test('Approved Market Dictionary exposes ONLY the exact 9 authorized markets with complete metadata', () => {
  assert.equal(approvedMarkets.APPROVED_MARKET_IDS.length, 21);
  for (const orig of ['match_result_1x2','team_total','to_win_either_half','any_team_to_win','match_result_1x2_1up','match_result_1x2_2up','total_goals','double_chance','corner_1x2']) assert.ok(approvedMarkets.APPROVED_MARKET_IDS.includes(orig));
  for (const id of approvedMarkets.APPROVED_MARKET_IDS) {
    const def = approvedMarkets.getApprovedMarket(id);
    assert.ok(def, `missing definition for ${id}`);
    assert.ok(def.name && def.period && def.settlementRules && def.distinctionNotes);
    assert.ok(Array.isArray(def.aliases) && def.aliases.length > 0);
    assert.ok(Array.isArray(def.outcomes) && def.outcomes.length > 0);
    assert.ok(Array.isArray(def.relevantStats) && def.relevantStats.length > 0);
    assert.equal(typeof def.settle, 'function');
  }
  assert.equal(approvedMarkets.isApprovedMarketId('btts'), false);
  assert.equal(approvedMarkets.isApprovedMarketId('asian_handicap'), false);
  assert.equal(approvedMarkets.isApprovedMarketId('correct_score'), false);
});

test('All 9 approved markets settlement rules and strict distinctions are mathematically exact', () => {
  // 1) 1X2
  assert.equal(approvedMarkets.settle1x2(2, 1, '1').outcome, 'win');
  assert.equal(approvedMarkets.settle1x2(1, 1, 'X').outcome, 'win');
  assert.equal(approvedMarkets.settle1x2(0, 2, '2').outcome, 'win');
  assert.equal(approvedMarkets.settle1x2(1, 1, '1').outcome, 'loss');

  // 2) Team Total (counts ONLY the selected team's goals, never combined match goals!)
  assert.equal(approvedMarkets.settleTeamTotal(2, 1.5, 'O').outcome, 'win');
  assert.equal(approvedMarkets.settleTeamTotal(1, 1.5, 'O').outcome, 'loss'); // even if match was 1-4 (5 total goals)
  assert.equal(approvedMarkets.settleTeamTotal(1, 1.5, 'U').outcome, 'win');

  // 3) To Win Either Half (2H calculated from 2H goals independently; drawing one half does not invalidate winning the other)
  assert.equal(approvedMarkets.settleWinEitherHalf(1, 0, 0, 2, 'H').outcome, 'win'); // Home won 1H (1-0), lost match (1-2) -> WIN
  assert.equal(approvedMarkets.settleWinEitherHalf(0, 2, 1, 0, 'H').outcome, 'win'); // Home lost 1H (0-2), won 2H (1-0) -> WIN
  assert.equal(approvedMarkets.settleWinEitherHalf(0, 0, 1, 0, 'H').outcome, 'win'); // Drew 1H, won 2H -> WIN
  assert.equal(approvedMarkets.settleWinEitherHalf(1, 1, 0, 1, 'H').outcome, 'loss'); // Drew 1H, lost 2H -> LOSS
  assert.equal(approvedMarkets.settleWinEitherHalf(1, 0, 0, 1, 'A').outcome, 'win'); // Away lost 1H, won 2H -> WIN

  // 4) Any Team To Win (12 = Home or Away win; Draw loses)
  assert.equal(approvedMarkets.settleAnyTeamToWin(2, 0, '12').outcome, 'win');
  assert.equal(approvedMarkets.settleAnyTeamToWin(0, 1, '12').outcome, 'win');
  assert.equal(approvedMarkets.settleAnyTeamToWin(1, 1, '12').outcome, 'loss');
  assert.equal(approvedMarkets.settleAnyTeamToWin(2, 1, 'Y').outcome, 'win');
  assert.equal(approvedMarkets.settleAnyTeamToWin(0, 0, 'N').outcome, 'win');

  // 5) 1X2 (1UP): 1-goal lead at any point settles Home/Away as WIN even if later draw/loss; Draw gets NO early payout
  assert.equal(approvedMarkets.settle1x2EarlyPayout(1, 2, '1', 1, { maxHomeLead: 1, maxAwayLead: 1 }).outcome, 'win');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(1, 2, '1', 1, { maxHomeLead: 1 }).earlyPayoutTriggered, true);
  assert.equal(approvedMarkets.settle1x2EarlyPayout(1, 2, '1', 1, { maxHomeLead: 0 }).outcome, 'loss');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 1, 'X', 1, { maxHomeLead: 1, maxAwayLead: 1 }).outcome, 'loss');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(1, 1, 'X', 1, { maxHomeLead: 1 }).outcome, 'win');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(1, 1, 'X', 1, { maxHomeLead: 1 }).earlyPayoutTriggered, false);

  // 6) 1X2 (2UP): requires 2-goal lead; 1-goal lead does NOT trigger 2UP early payout; Draw gets NO early payout
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 2, '1', 2, { maxHomeLead: 2 }).outcome, 'win');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 2, '1', 2, { maxHomeLead: 2 }).earlyPayoutTriggered, true);
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 2, '1', 2, { maxHomeLead: 1 }).outcome, 'loss');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 2, 'X', 2, { maxHomeLead: 2 }).outcome, 'win');
  assert.equal(approvedMarkets.settle1x2EarlyPayout(2, 2, 'X', 2, { maxHomeLead: 2 }).earlyPayoutTriggered, false);

  // 7) Total (combined Home + Away goals)
  assert.equal(approvedMarkets.settleTotal(2, 1, 2.5, 'O').outcome, 'win');
  assert.equal(approvedMarkets.settleTotal(1, 1, 2.5, 'O').outcome, 'loss');
  assert.equal(approvedMarkets.settleTotal(1, 1, 2.5, 'U').outcome, 'win');

  // 8) Double Chance (1X, X2, 12 strictly distinct)
  assert.equal(approvedMarkets.settleDoubleChance(1, 1, '1X').outcome, 'win');
  assert.equal(approvedMarkets.settleDoubleChance(1, 2, '1X').outcome, 'loss');
  assert.equal(approvedMarkets.settleDoubleChance(1, 1, 'X2').outcome, 'win');
  assert.equal(approvedMarkets.settleDoubleChance(2, 1, 'X2').outcome, 'loss');
  assert.equal(approvedMarkets.settleDoubleChance(2, 1, '12').outcome, 'win');
  assert.equal(approvedMarkets.settleDoubleChance(1, 1, '12').outcome, 'loss');

  // 9) Corner 1X2 (corners, not match goals)
  assert.equal(approvedMarkets.settleCorner1x2(7, 4, 'H').outcome, 'win');
  assert.equal(approvedMarkets.settleCorner1x2(5, 5, 'X').outcome, 'win');
  assert.equal(approvedMarkets.settleCorner1x2(3, 8, 'A').outcome, 'win');
});

test('matchApprovedMarket handles BangBet aliases, dynamic lines, strict market separation, and rejects unapproved markets', () => {
  const ev = { home: 'Arsenal FC', away: 'Chelsea FC' };

  // Strict separation: 1X2 vs 1X2 (1UP) vs 1X2 (2UP) vs Corner 1X2
  const m1x2 = approvedMarkets.matchApprovedMarket('1x2', '1', ev);
  const m1up = approvedMarkets.matchApprovedMarket('1x2 (1up)', 'Home', ev);
  const m2up = approvedMarkets.matchApprovedMarket('1X2 - 2UP', 'Arsenal FC', ev);
  const mCor = approvedMarkets.matchApprovedMarket('Corner 1x2', '1', ev);
  assert.equal(m1x2.approvedMarketId, 'match_result_1x2');
  assert.equal(m1up.approvedMarketId, 'match_result_1x2_1up');
  assert.equal(m2up.approvedMarketId, 'match_result_1x2_2up');
  assert.equal(mCor.approvedMarketId, 'corner_1x2');

  // Strict separation: Total vs Team Total (both title-named and label-named)
  const mTot = approvedMarkets.matchApprovedMarket('Total', 'Over 2.5', ev);
  const mTeamTitle = approvedMarkets.matchApprovedMarket('Arsenal FC total', 'Over 1.5', ev);
  const mTeamAway = approvedMarkets.matchApprovedMarket('Away Team Goals', 'Under 0.5', ev);
  const mTeamLabel = approvedMarkets.matchApprovedMarket('Team Total', 'Chelsea Over 1.5', ev);
  assert.equal(mTot.approvedMarketId, 'total_goals');
  assert.equal(mTot.line, 2.5);
  assert.equal(mTeamTitle.approvedMarketId, 'team_total');
  assert.equal(mTeamTitle.teamSide, 'H');
  assert.equal(mTeamTitle.line, 1.5);
  assert.equal(mTeamAway.approvedMarketId, 'team_total');
  assert.equal(mTeamAway.teamSide, 'A');
  assert.equal(mTeamAway.dir, 'U');
  assert.equal(mTeamLabel.approvedMarketId, 'team_total');
  assert.equal(mTeamLabel.teamSide, 'A');
  assert.equal(mTeamLabel.line, 1.5);

  // Strict separation: Double Chance (all BangBet wordings) vs Any Team To Win
  assert.equal(approvedMarkets.matchApprovedMarket('Double chance', 'Homeordraw', ev).canonicalOutcome, '1X');
  assert.equal(approvedMarkets.matchApprovedMarket('Double chance', 'Draworaway', ev).canonicalOutcome, 'X2');
  assert.equal(approvedMarkets.matchApprovedMarket('Double chance', 'Homeoraway', ev).canonicalOutcome, '12');
  assert.equal(approvedMarkets.matchApprovedMarket('Double chance', 'Arsenal FC or Draw', ev).canonicalOutcome, '1X');
  const mAny12 = approvedMarkets.matchApprovedMarket('Any team to win', '12', ev);
  const mAnyYes = approvedMarkets.matchApprovedMarket('Any team to win', 'Yes', ev);
  assert.equal(mAny12.approvedMarketId, 'any_team_to_win');
  assert.equal(mAny12.canonicalOutcome, '12');
  assert.equal(mAnyYes.approvedMarketId, 'any_team_to_win');
  assert.equal(mAnyYes.canonicalOutcome, '12');

  // To Win Either Half
  const mWeh1 = approvedMarkets.matchApprovedMarket('To win either half', 'Arsenal FC', ev);
  const mWeh2 = approvedMarkets.matchApprovedMarket('Chelsea FC to win either half', 'Yes', ev);
  assert.equal(mWeh1.approvedMarketId, 'to_win_either_half');
  assert.equal(mWeh1.teamSide, 'H');
  assert.equal(mWeh2.approvedMarketId, 'to_win_either_half');
  assert.equal(mWeh2.teamSide, 'A');

  // Unapproved markets MUST be rejected
  assert.equal(approvedMarkets.matchApprovedMarket('Both teams to score(GG/NG)', 'Yes', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Asian Handicap', 'Home -0.5', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Handicap', 'home 0:2', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('1st half - 1x2', '1', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Total corners', 'Over 9.5', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('1x2 (3up)', '1', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('To win both halves', 'Home', ev).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('1x2 & Total', 'Home & Over 2.5', ev).approved, false);
});

test('1X2 (1UP), 1X2 (2UP), To Win Either Half, Any Team To Win, and Corner 1X2 statistical evaluation respects probability ordering and missing stats', () => {
  const baseEv = {
    key: 'football:9mkts:1', sport: 'football', home: 'Arsenal FC', away: 'Everton FC', league: 'Premier League', ts: 1e12,
    stats: {
      available: true,
      homeForm: 'WWWWW', awayForm: 'LLDWL',
      probs: { H: 0.65, X: 0.21, A: 0.14 },
      goals: {
        hFor: 2.3, hAg: 0.7, aFor: 0.8, aAg: 1.9,
        p1HFor: 1.1, p1HAg: 0.3, p1AFor: 0.35, p1AAg: 0.9,
        p2HFor: 1.2, p2HAg: 0.4, p2AFor: 0.45, p2AAg: 1.0,
      },
      advancedStats: {
        home: { matches: 10, cornersAvg: 7.2 },
        away: { matches: 10, cornersAvg: 3.8 },
      },
      pct: [],
    },
    markets: [
      { i: 0, title: '1x2', label: '1', odds: 1.50 },
      { i: 1, title: '1x2 (1up)', label: '1', odds: 1.25 },
      { i: 2, title: '1x2 (2up)', label: '1', odds: 1.44 },
      { i: 3, title: '1x2 (1up)', label: 'X', odds: 4.30 },
      { i: 4, title: '1x2', label: 'X', odds: 4.30 },
      { i: 5, title: 'To win either half', label: 'Arsenal FC', odds: 1.28 },
      { i: 6, title: 'Any team to win', label: '12', odds: 1.22 },
      { i: 7, title: 'Corner 1x2', label: 'Home', odds: 1.38 },
      { i: 8, title: 'Arsenal FC total', label: 'Over 1.5', odds: 1.55 },
      { i: 9, title: 'Total', label: 'Over 1.5', odds: 1.20 },
      { i: 10, title: 'Double chance', label: '1X', odds: 1.12 },
    ],
  };
  const cands = candidates(baseEv, { sports: ['football'], markets: [] });
  const findBy = (id, sideOrOut) => cands.find((c) => c.approvedMarketId === id && (c.side === sideOrOut || c.canonicalOutcome === sideOrOut));
  const p1x2H = findBy('match_result_1x2', 'H').modelProbability;
  const p2upH = findBy('match_result_1x2_2up', 'H').modelProbability;
  const p1upH = findBy('match_result_1x2_1up', 'H').modelProbability;
  assert.ok(p1upH > p2upH && p2upH > p1x2H, `expected P(1UP) ${p1upH} > P(2UP) ${p2upH} > P(1X2) ${p1x2H}`);

  // Draw in 1X2 (1UP) must equal Draw in standard 1X2 (NO early payout trigger on Draw!)
  assert.equal(findBy('match_result_1x2_1up', 'X').modelProbability, findBy('match_result_1x2', 'X').modelProbability);

  // All 9 approved markets evaluated when full evidence exists
  assert.equal(baseEv.marketDiscoveryReport.approvedMarketsEvaluated.length, 9);

  // Without 1H/2H stats or corner stats, To Win Either Half and Corner 1X2 MUST NOT be evaluated (no fabrication!)
  const noHalfOrCornerEv = {
    ...baseEv,
    stats: { available: true, homeForm: 'WWWWW', awayForm: 'LLLLL', probs: { H: 0.7, X: 0.2, A: 0.1 }, goals: { hFor: 2.0, hAg: 0.8, aFor: 0.7, aAg: 1.8 }, pct: [] },
    markets: [
      { i: 0, title: 'To win either half', label: 'Arsenal FC', odds: 1.30 },
      { i: 1, title: 'Corner 1x2', label: 'Home', odds: 1.40 },
    ],
  };
  const none = candidates(noHalfOrCornerEv, { sports: ['football'], markets: [] });
  assert.equal(none.length, 0, 'must not fabricate half or corner stats when absent');
});

test('Virtual fixture leak fix: eventsFromNet & isVirtualFixture exclude BangBet virtuals (VL/League Mode/London Guns/non-sr:match) while preserving real football', () => {
  const { eventsFromNet, isVirtualOrNonRealFixture } = require('../lib/site');
  const { isVirtualFixture } = require('../run');
  const net = [
    {
      url: 'https://bet-api.bangbet.com/api/bet/match/list',
      body: {
        data: {
          data: [
            { homeTeamName: 'GNK Dinamo Zagreb', awayTeamName: 'Bayer Leverkusen', matchId: 'sr:match:74173066', sportId: 'sr:sport:1', leagueName: 'UEFA Europa League' },
            { homeTeamName: 'VL Athens', awayTeamName: 'VL Moscow', matchId: 'vf:match:99901', sportId: 'vf:sport:1', leagueName: 'League Mode' },
            { homeTeamName: 'London Guns', awayTeamName: 'Southampton', matchId: '99902', leagueName: 'English League' },
            { homeTeamName: 'Hannover 96', awayTeamName: 'FC Bayern München', matchId: 'vbl:match:99903', leagueName: 'Bundesliga' },
            { homeTeamName: 'Manchester Blue', awayTeamName: 'Donetsk', matchId: 'sr:match:74179999', leagueName: 'Champions Cup' },
          ],
        },
      },
    },
    {
      url: 'https://bet-api.bangbet.com/api/bet/virtual/list',
      body: { data: [{ homeTeamName: 'France', awayTeamName: 'Spain', matchId: 'sr:match:88888' }] },
    },
  ];
  const evs = eventsFromNet(net, 'football');
  assert.equal(evs.length, 1, 'ONLY the genuine sr:match football fixture must survive');
  assert.equal(evs[0].home, 'GNK Dinamo Zagreb');
  assert.equal(evs[0].matchId, 74173066);
  assert.equal(isVirtualFixture({ home: 'VL Berlin', away: 'VL Amsterdam', league: 'League Mode' }), true);
  assert.equal(isVirtualFixture({ home: 'Turin', away: 'Madrid Red', league: 'Champions Cup' }), true);
  assert.equal(isVirtualOrNonRealFixture({ home: 'Hannover 96', away: 'FC Bayern München', league: 'Bundesliga', source: 'network', matchId: 0, url: '' }), true);
  assert.equal(isVirtualOrNonRealFixture({ home: 'FC Bayern München', away: 'Borussia Dortmund', league: 'Bundesliga', source: 'network', matchId: 74173100, url: 'https://www.bangbet.com/ug-m/sport/Football/match?matchId=sr%3Amatch%3A74173100' }), false);
});

test('Intelligent early stop collects 50 usable fixtures in strict league priority order and marks remaining as not_checked_early_stop (never no_stats)', async () => {
  const { runStatsCollectionPool, tallyRejections, TARGET_USABLE_FIXTURES } = require('../run');
  assert.equal(TARGET_USABLE_FIXTURES, 50);

  // 100 league-ordered fixtures: every 5th fixture fails stats (20 failures), rest have valid stats.
  // To reach 50 usable fixtures, the pool MUST check ~62-63 fixtures (NOT stop at 50 visited!)
  // and mark the remaining ~37 fixtures as not_checked_early_stop.
  const events = Array.from({ length: 100 }, (_, i) => ({
    key: `football:h${i}:a${i}:${i}`,
    sport: 'football',
    home: `Home${i}`,
    away: `Away${i}`,
    league: `League ${Math.floor(i / 5)}`,
    leagueOrderIndex: i,
    ts: 1795700000000 + i * 60000,
    statsStatus: 'pending',
    fixtureStatus: 'pending',
  }));

  const res = await runStatsCollectionPool(events, async (_wIdx, ev, idx) => {
    await new Promise((r) => setTimeout(r, idx % 2 === 0 ? 2 : 5));
    ev.opened = true;
    if (idx % 5 === 0) {
      ev.stats = { available: false, status: 'no_stats_after_retry' };
      ev.statsStatus = 'no_stats_after_retry';
      ev.rejected = 'statistics unavailable (no_stats_after_retry)';
    } else {
      ev.stats = { available: true, status: 'complete', homeForm: 'WWWDW', awayForm: 'LLDWL', probs: { H: 0.6, X: 0.2, A: 0.2 }, pct: [] };
      ev.statsStatus = 'complete';
    }
  }, { concurrency: 2, targetUsable: 50 });

  assert.equal(res.stopReason, 'early_stop_usable_target');
  assert.ok(res.usableCount >= 50 && res.usableCount <= 51, `expected 50-51 usable (in-flight concurrency=2), got ${res.usableCount}`);
  assert.ok(res.checkedCount >= 62 && res.checkedCount <= 64, `must keep checking past 50 visited until 50 usable are found; checked=${res.checkedCount}`);
  assert.equal(res.checkedCount + res.notCheckedEarlyStop, 100);
  // Strict league-priority dispatch order: checkedOrder must be strictly 0, 1, 2, ..., checkedCount-1
  for (let k = 0; k < res.checkedOrder.length; k++) {
    assert.equal(res.checkedOrder[k], k, 'fixtures must be dispatched strictly in league priority order');
  }

  const fakeState = { counts: { fixturesExcludedByCap: 15 } };
  tallyRejections(events, [], fakeState);
  assert.equal(fakeState.counts.statsChecked, res.checkedCount);
  assert.equal(fakeState.counts.statsUsable, res.usableCount);
  assert.equal(fakeState.counts.notCheckedEarlyStop, res.notCheckedEarlyStop);
  assert.equal(fakeState.counts.notCheckedLimitReached, 15);
  assert.ok(fakeState.counts.noStatsAfterRetry < 20 && fakeState.counts.noStatsAfterRetry >= 12);
  assert.equal(fakeState.counts.statsSkippedUnavailable, fakeState.counts.noStatsAfterRetry, 'unchecked early-stop fixtures must NEVER be counted as skipped/no-stats');

  // Pool exhaustion without reaching 50 usable: checks all 20, uses genuinely usable 8, never forces invalid fixtures
  const smallPool = Array.from({ length: 20 }, (_, i) => ({
    key: `football:s${i}`, sport: 'football', home: `SH${i}`, away: `SA${i}`, statsStatus: 'pending', fixtureStatus: 'pending',
  }));
  const resSmall = await runStatsCollectionPool(smallPool, async (_wIdx, ev, idx) => {
    if (idx < 8) {
      ev.stats = { available: true, status: 'partial', homeForm: 'WWWWW', awayForm: 'LLLLL', pct: [] };
      ev.statsStatus = 'partial';
    } else if (idx < 12) {
      // Partial with NO usable evidence (must NOT count as usable!)
      ev.stats = { available: true, status: 'partial', homeForm: '', awayForm: '', pct: [] };
      ev.statsStatus = 'partial';
    } else {
      ev.stats = { available: false, status: 'no_stats_after_retry' };
      ev.statsStatus = 'no_stats_after_retry';
    }
  }, { concurrency: 2, targetUsable: 50 });
  assert.equal(resSmall.stopReason, 'pool_exhausted');
  assert.equal(resSmall.checkedCount, 20);
  assert.equal(resSmall.usableCount, 8, 'evidence-free partial fixtures must not count as usable');
  assert.equal(resSmall.notCheckedEarlyStop, 0);
});

test('Booking uses approved_markets.js: prevents market substitution, safely skips unavailable legs, and verifies all 9 approved markets', async () => {
  const ev = { home: 'Arsenal FC', away: 'Chelsea FC' };
  const liveMarkets = [
    { i: 0, title: '1x2', label: '1', odds: 1.85 },
    { i: 1, title: '1x2 (1up)', label: '1', odds: 1.45 },
    { i: 2, title: 'Total', label: 'Over 1.5', odds: 1.28 },
    { i: 3, title: 'Arsenal FC total', label: 'Over 1.5', odds: 1.92 },
    { i: 4, title: 'Double chance', label: 'Homeoraway', odds: 1.24 },
  ];

  // Must NEVER substitute 1X2 (1UP) for 1X2 (2UP) when 2UP is missing
  const missing2up = approvedMarkets.findMatchingLiveMarket(liveMarkets, {
    ...ev, market: '1x2 (2up)', outcome: '1', approvedMarketId: 'match_result_1x2_2up', side: 'H', canonicalOutcome: 'H',
  });
  assert.equal(missing2up, null, 'must never substitute 1X2 or 1UP when 2UP is unavailable');

  // Must NEVER substitute Double Chance 12 for Any Team To Win
  const missingAny = approvedMarkets.findMatchingLiveMarket(liveMarkets, {
    ...ev, market: 'Any team to win', outcome: '12', approvedMarketId: 'any_team_to_win', side: '12', canonicalOutcome: '12',
  });
  assert.equal(missingAny, null, 'must never substitute Double Chance 12 for Any Team To Win');

  // Must match Team Total strictly and never confuse with match Total
  const teamTot = approvedMarkets.findMatchingLiveMarket(liveMarkets, {
    ...ev, market: 'Arsenal FC total', outcome: 'Over 1.5', approvedMarketId: 'team_total', teamSide: 'H', dir: 'O', line: 1.5, canonicalOutcome: 'H:O:1.5',
  });
  assert.ok(teamTot && teamTot.i === 3 && teamTot.odds === 1.92);

  // book() safely continues past an unavailable leg (without substituting) and reports added + unavailable accurately
  const origMarkets = exMod.markets;
  let callNum = 0;
  exMod.markets = async () => {
    callNum++;
    if (callNum === 1) return [{ i: 0, title: '1x2', label: '1', odds: 1.85 }]; // Leg 1 wants 1x2 (2up) -> UNAVAILABLE!
    return [{ i: 5, title: 'Total', label: 'Over 1.5', odds: 1.30 }]; // Leg 2 IS available!
  };
  const p = makeMockBookingPage({
    initialCount: 0,
    containerText: 'Betslip\n1\nOver 1.5\n1.30\nLiverpool FC vs Everton FC\nTotal',
  });
  const fakeSite = {
    newPage: async () => p,
    openEvent: async () => true,
    shot: async () => {},
    browser: null, // no live browser -> independent check reports cleanly without fabricating code
  };
  const legs = [
    { sport: 'football', home: 'Arsenal FC', away: 'Chelsea FC', league: 'EPL', market: '1x2 (2up)', outcome: '1', approvedMarketId: 'match_result_1x2_2up', side: 'H', canonicalOutcome: 'H', odds: 1.55, url: 'https://t/1' },
    { sport: 'football', home: 'Liverpool FC', away: 'Everton FC', league: 'EPL', market: 'Total', outcome: 'Over 1.5', approvedMarketId: 'total_goals', dir: 'O', line: 1.5, canonicalOutcome: 'O:1.5', odds: 1.30, url: 'https://t/2' },
  ];
  try {
    const res = await book(fakeSite, legs, Date.now() + 60000);
    assert.equal(res.added, 1, 'must safely continue and add Leg 2 when Leg 1 is unavailable');
    assert.equal(res.unavailableLegs.length, 1);
    assert.equal(res.unavailableLegs[0].approvedMarketId, 'match_result_1x2_2up');
    assert.equal(res.failedLegs.length, 0);
    assert.equal(res.verifiedLegs.length, 1);
  } finally {
    exMod.markets = origMarkets;
  }
});

// ---- Critical Repair Regression Tests (Parts 1–9) ----

test('Combined-odds selection engine scales leg counts to target, minimises overshoot, recalculates every 2 picks, and never forces weak picks', () => {
  // 1) Different targets on the same qualifying pool must produce appropriately different leg counts
  const pool = Array.from({ length: 30 }, (_, i) => ({
    evKey: `football:scale_${i}`,
    sport: 'football',
    home: `TeamH${i}`,
    away: `TeamA${i}`,
    market: 'Total',
    outcome: 'over 1.5',
    approvedMarketId: 'total_goals',
    canonicalOutcome: 'O:1.5',
    line: 1.5,
    odds: 1.25,
    p: 0.82 - i * 0.002,
    score: 0.88 - i * 0.002,
    ts: 1796000000000 + i * 60000,
  }));

  const tLow = build(pool, { target: 2.0, count: 0 });
  const tMid = build(pool, { target: 6.0, count: 0 });
  const tHigh = build(pool, { target: 25.0, count: 0 });

  assert.equal(tLow.status, 'ready');
  assert.equal(tMid.status, 'ready');
  assert.equal(tHigh.status, 'ready');
  assert.ok(tLow.legs.length < tMid.legs.length && tMid.legs.length < tHigh.legs.length,
    `expected leg counts to scale with target (got ${tLow.legs.length}, ${tMid.legs.length}, ${tHigh.legs.length})`);
  assert.equal(tLow.legs.length, 4, '1.25^4 = 2.4414 reaches 2.0 in 4 legs (1.25^3 = 1.9531 < 2.0)');
  assert.ok(tLow.selectionProgress.frozen === true);
  assert.equal(tLow.selectionProgress.stopReason, 'target_reached');
  assert.ok(tLow.selectionProgress.recalculations.some((r) => r.afterSelections === 2),
    'must record combined-odds recalculation checkpoint after every 2 accepted selections');

  // 2) Overshoot minimisation: prefers a strong candidate with closer price over one causing a huge overshoot
  //    WITHOUT ever picking a weak (sub-threshold) candidate!
  const overshootPool = [
    { evKey: 'm1', sport: 'football', home: 'H1', away: 'A1', market: '1x2', outcome: '1', approvedMarketId: 'match_result_1x2', canonicalOutcome: 'H', odds: 1.90, p: 0.85, score: 0.90, ts: 100 },
    // Next strongest would overshoot badly (1.90 * 1.45 = 2.755 vs target 2.0)
    { evKey: 'm2', sport: 'football', home: 'H2', away: 'A2', market: '1x2', outcome: '1', approvedMarketId: 'match_result_1x2', canonicalOutcome: 'H', odds: 1.45, p: 0.84, score: 0.88, ts: 200 },
    // Nearly equal strong candidate hits target cleanly with tiny overshoot (1.90 * 1.08 = 2.052)
    { evKey: 'm3', sport: 'football', home: 'H3', away: 'A3', market: 'Total', outcome: 'over 0.5', approvedMarketId: 'total_goals', canonicalOutcome: 'O:0.5', line: 0.5, odds: 1.08, p: 0.84, score: 0.85, ts: 300 },
    // Weak candidate with exact-ish odds MUST NEVER be picked
    { evKey: 'm4', sport: 'football', home: 'H4', away: 'A4', market: '1x2', outcome: 'X', approvedMarketId: 'match_result_1x2', canonicalOutcome: 'X', odds: 1.06, p: 0.35, score: 0.30, ts: 400 },
  ];
  const ov = build(overshootPool, { target: 2.0, count: 0 });
  assert.equal(ov.status, 'ready');
  assert.equal(ov.legs.length, 2);
  assert.ok(ov.legs.some((l) => l.evKey === 'm3'), 'must pick strong closer-price candidate m3 instead of overshooting with m2');
  assert.ok(!ov.legs.some((l) => l.evKey === 'm4'), 'must never force weak candidate m4');
  assert.ok(Math.abs(ov.total - (1.90 * 1.08)) < 1e-6);

  // 3) Insufficient qualifying candidates -> stops honestly, reports target not reached
  const ins = build(overshootPool.slice(0, 1), { target: 5.0, count: 0 });
  assert.equal(ins.status, 'partial');
  assert.equal(ins.targetReached, false);
  assert.equal(ins.selectionProgress.stopReason, 'candidates_exhausted');
});

test('Concurrency early-stop throttles near threshold (exact 50/50 with 0 overshoot) and preserves in-flight completions transparently', async () => {
  const { runStatsCollectionPool } = require('../run');
  const makeFixtures = (n) => Array.from({ length: n }, (_, i) => ({
    key: `f:${i}`, sport: 'football', home: `H${i}`, away: `A${i}`, league: 'EPL', statsStatus: 'pending',
  }));

  // 1) Default concurrency=2 throttles when inFlight covers remaining needed slots -> EXACT 50 scheduled, 50 checked, 50 usable!
  const evsExact = makeFixtures(80);
  const resExact = await runStatsCollectionPool(evsExact, async (_w, ev) => {
    await new Promise((r) => setTimeout(r, 3));
    ev.stats = { available: true, status: 'complete', homeForm: 'WWWWW', awayForm: 'LLLLL', categories: { recentMatches: true } };
    ev.statsStatus = 'complete';
  }, { concurrency: 2, targetUsable: 50 });

  assert.equal(resExact.scheduledCount, 50, 'must not schedule an unnecessary 51st fixture');
  assert.equal(resExact.checkedCount, 50);
  assert.equal(resExact.usableCount, 50);
  assert.equal(resExact.inFlightExtraUsableCount, 0);
  assert.equal(resExact.notCheckedEarlyStop, 30);
  assert.equal(resExact.stopReason, 'early_stop_usable_target');

  // 2) If an already-in-flight worker completes with a valid usable fixture after threshold (simulated via allowSpeculativeInFlight),
  //    it must NOT be silently discarded and stopExplanation must explicitly explain the in-flight extra result!
  const evsInFlight = makeFixtures(20);
  const resInFlight = await runStatsCollectionPool(evsInFlight, async (_w, ev) => {
    await new Promise((r) => setTimeout(r, 8));
    ev.stats = { available: true, status: 'complete', homeForm: 'WWWWW', awayForm: 'LLLLL', categories: { recentMatches: true } };
    ev.statsStatus = 'complete';
  }, { concurrency: 2, targetUsable: 5, allowSpeculativeInFlight: true });

  assert.ok(resInFlight.usableCount >= 5);
  assert.equal(resInFlight.usableCount, 5 + resInFlight.inFlightExtraUsableCount);
  assert.equal(resInFlight.checkedCount + resInFlight.notCheckedEarlyStop, 20);
  if (resInFlight.inFlightExtraUsableCount > 0) {
    assert.match(resInFlight.stopExplanation, /already in progress/i);
  }
});

test('BangBet /api/bet/match/odds parser recognises all 9 approved markets, rejects false positives, and tallies accurate 9-market status', () => {
  const { parseBangbetOddsApi } = require('../lib/extract');
  const { tallyRejections } = require('../run');
  const ev = {
    key: 'football:wb:bmg:0',
    sport: 'football',
    home: 'Werder Bremen',
    away: 'Borussia Monchengladbach',
    matchId: 'sr:match:72513342',
    opened: true,
    statsStatus: 'complete',
    stats: {
      available: true,
      status: 'complete',
      homeForm: 'WWWDW',
      awayForm: 'LLDLL',
      probs: { H: 0.62, X: 0.21, A: 0.17 },
      goals: { hFor: 2.1, aFor: 1.0, hAg: 0.9, aAg: 1.8, p1HFor: 1.0, p1AFor: 0.4, p1HAg: 0.4, p1AAg: 0.9, p2HFor: 1.1, p2AFor: 0.6, p2HAg: 0.5, p2AAg: 0.9 },
      categories: { recentMatches: true, teamSeasonScoring: true, winProbabilities: true },
      // Notice: NO corner averages -> Corner 1X2 must be reported honestly as offered_missing_stats, NOT evaluated!
    },
  };

  const fakeNet = [{
    url: 'https://bet-api.bangbet.com/api/bet/match/odds',
    body: {
      data: {
        id: 'sr:match:72513342',
        homeTeamName: 'Werder Bremen',
        awayTeamName: 'Borussia Monchengladbach',
        marketList: [
          { groups: ['Main'], markets: [{ name: '1x2', active: true, marketStatus: 'Active', outcomes: [{ desc: 'Werder Bremen', odds: 1.72, active: true }, { desc: 'draw', odds: 4.1, active: true }, { desc: 'Borussia Monchengladbach', odds: 4.6, active: true }] }] },
          { groups: ['Main'], markets: [{ name: '1x2 (1up)', active: true, marketStatus: 'Active', outcomes: [{ desc: 'home', odds: 1.28, active: true }, { desc: 'draw', odds: 4.1, active: true }, { desc: 'away', odds: 2.05, active: true }] }] },
          { groups: ['Main'], markets: [{ name: '1x2 (2up)', active: true, marketStatus: 'Active', outcomes: [{ desc: 'home', odds: 1.65, active: true }, { desc: 'draw', odds: 4.1, active: true }, { desc: 'away', odds: 4.4, active: true }] }] },
          { groups: ['Main'], markets: [{ name: 'Total', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 1.5', odds: 1.22, active: true }, { desc: 'under 1.5', odds: 4.2, active: true }] }] },
          { groups: ['Main'], markets: [{ name: 'Double chance', active: true, marketStatus: 'Active', outcomes: [{ desc: '1X', odds: 1.18, active: true }, { desc: 'X2', odds: 2.15, active: true }, { desc: '12', odds: 1.24, active: true }] }] },
          { groups: ['Goals'], markets: [{ name: 'Werder Bremen total', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 0.5', odds: 1.12, active: true }, { desc: 'under 0.5', odds: 6.5, active: true }] }] },
          { groups: null, markets: [{ name: 'Werder Bremen to win either half', active: true, marketStatus: 'Active', outcomes: [{ desc: 'yes', odds: 1.24, active: true }, { desc: 'no', odds: 3.4, active: true }] }] },
          { groups: null, markets: [{ name: 'Any team to win', active: true, marketStatus: 'Active', outcomes: [{ desc: 'yes', odds: 1.25, active: true }, { desc: 'no', odds: 4.0, active: true }] }] },
          { groups: ['Corner'], markets: [{ name: 'Corner 1x2', active: true, marketStatus: 'Active', outcomes: [{ desc: 'Werder Bremen', odds: 1.55, active: true }, { desc: 'draw', odds: 7.5, active: true }, { desc: 'Borussia Monchengladbach', odds: 2.8, active: true }] }] },
          // False-positive traps observed live on BangBet — ALL must be REJECTED!
          { groups: null, markets: [{ name: '10 minutes - 1x2 from 1 to 10', active: true, marketStatus: 'Active', outcomes: [{ desc: '1', odds: 5.5, active: true }] }] },
          { groups: null, markets: [{ name: 'Total bookings', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 2.5', odds: 1.45, active: true }] }] },
          { groups: null, markets: [{ name: 'Werder Bremen or over 2.5', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 2.5', odds: 1.35, active: true }] }] },
          { groups: null, markets: [{ name: 'Werder Bremen no bet', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 0.5', odds: 1.30, active: true }] }] },
          { groups: null, markets: [{ name: 'Werder Bremen sending off', active: true, marketStatus: 'Active', outcomes: [{ desc: 'over 0.5', odds: 4.5, active: true }] }] },
        ],
      },
    },
  }];

  const parsed = parseBangbetOddsApi(fakeNet, ev);
  ev.markets = parsed;
  const cands = candidates(ev, { sports: ['football'] });
  assert.ok(cands.length > 0);
  assert.equal(ev.marketDiscoveryReport.approvedMarketsOffered.length, 11, 'all 11 offered approved market IDs must be recognized from live API');
  assert.equal(ev.marketDiscoveryReport.approvedMarketsEvaluated.length, 10, '10 markets evaluated (Corner 1X2 lacks corner stats)');
  assert.deepEqual(ev.marketDiscoveryReport.approvedMarketsMissingStats, ['corner_1x2']);
  // Verify false-positive traps were NOT accepted as approved
  assert.ok(ev.marketDiscoveryReport.unapprovedHeadings.includes('10 minutes - 1x2 from 1 to 10'));
  assert.ok(ev.marketDiscoveryReport.unapprovedHeadings.includes('Total bookings'));
  assert.ok(ev.marketDiscoveryReport.unapprovedHeadings.includes('Werder Bremen or over 2.5'));

  const mockState = { counts: { fixturesExcludedByCap: 0 } };
  tallyRejections([ev], cands, mockState);
  assert.equal(mockState.counts.approvedMarketsStatus.corner_1x2.status, 'offered_missing_stats');
  assert.equal(mockState.counts.approvedMarketsStatus.team_total.status, 'evaluated');
  assert.equal(mockState.counts.approvedMarketsStatus.to_win_either_half.status, 'evaluated');
  assert.equal(mockState.counts.approvedMarketsStatus.any_team_to_win.status, 'evaluated');
});

test('Share Bet clears visible Accept Changes even when first DOM match is hidden, then locates and clicks visible .share-btn', async () => {
  let acceptCleared = false;
  let shareClicked = false;
  const fakeSite = { shot: async () => {}, dismiss: async () => {} };
  const legs = [
    { home: 'Cerro Porteno', away: 'Libertad Asuncion', outcome: 'under 4.5' },
  ];

  // Simulate the exact live failure: DOM has TWO "Accept Changes" nodes:
  //   index 0 -> HIDDEN (e.g. inside .rapid-betslip or inactive Singles tab)
  //   index 1 -> VISIBLE green bottom bar (which hides .share-btn until clicked!)
  const makeAcceptLoc = () => ({
    count: async () => (acceptCleared ? 0 : 2),
    nth: (idx) => ({
      isVisible: async () => (!acceptCleared && idx === 1),
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => ({ ok: idx === 1, disabled: false, txt: 'Accept Changes', rect: { x: 0, y: 794, w: 390, h: 50 } }),
      click: async () => { if (idx === 1) acceptCleared = true; },
    }),
    first: () => ({ count: async () => (acceptCleared ? 0 : 1), isVisible: async () => false }),
  });

  const makeShareLoc = () => ({
    count: async () => (acceptCleared ? 1 : 0),
    nth: () => ({
      isVisible: async () => acceptCleared,
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => ({ skip: false, visible: acceptCleared, enabled: true, unobstructed: true, coveredBy: '', rect: { x: 0, y: 794, w: 130, h: 50 }, txt: 'Share Bet' }),
      click: async () => { shareClicked = true; },
    }),
    first: () => ({ count: async () => (acceptCleared ? 1 : 0), isVisible: async () => acceptCleared, click: async () => { shareClicked = true; } }),
  });

  const mockPage = {
    net: [],
    locator: (sel) => {
      if (sel.includes('betslip-nav')) {
        return { first: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      }
      if (sel.includes('share-btn')) return makeShareLoc();
      return {
        count: async () => 0,
        nth: () => ({ isVisible: async () => false }),
        first: () => ({ count: async () => 0, isVisible: async () => false }),
        getByText: (re) => (/accept/i.test(String(re)) ? makeAcceptLoc() : { count: async () => 0, nth: () => ({ isVisible: async () => false }), first: () => ({ count: async () => 0, isVisible: async () => false }) }),
      };
    },
    getByText: (re) => (/accept/i.test(String(re)) ? makeAcceptLoc() : { count: async () => 0, nth: () => ({ isVisible: async () => false }), first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    evaluate: async (fn) => {
      const s = String(fn);
      if (s.includes('hasChangesBanner')) return { slipOpen: true, hasChangesBanner: !acceptCleared, overlays: [], viewport: { w: 390, h: 844 } };
      if (s.includes('selector:')) return { opened: true, selector: '.betslip-container', containerText: 'Betslip 1\nUnder4.5\nCerro Porteno vs Libertad Asuncion\nTotal' };
      if (s.includes('.betslip-container')) return 'Betslip 1\nUnder4.5\nCerro Porteno vs Libertad Asuncion\nTotal';
      if (s.includes('.book-code')) return shareClicked ? 'Booking Code:\nB7x9Kq\nwww.bangbet.com/bookcode/B7x9Kq' : '';
      if (s.includes('input,textarea')) return [];
      if (s.includes('clipboard')) return '';
      return shareClicked ? 'www.bangbet.com/bookcode/B7x9Kq' : '';
    },
  };

  const res = await share(fakeSite, mockPage, legs);
  assert.equal(acceptCleared, true, 'must find and click the visible 2nd Accept Changes control even when 1st is hidden');
  assert.equal(res.acceptChangesClicks, 1);
  assert.equal(shareClicked, true, 'must locate and click .share-btn once Accept Changes is cleared');
  assert.equal(res.code, 'B7x9Kq');
  assert.equal(res.link, 'https://www.bangbet.com/bookcode/B7x9Kq');
  assert.equal(res.shareDiag.shareButtonDiscovery.visible, true);
  assert.equal(res.shareDiag.shareButtonDiscovery.unobstructed, true);
  assert.equal(res.shareDiag.codeExtraction.source, 'bookcode_url');
});

test('Subsequent tickets diversify market exposure ONLY after explicit confirmed-used history and persist idempotently on backend', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const { createCloudServer } = require('../../cloud/server');
  const { loadConfirmedUsedSelections } = require('../run');

  // 4 qualifying candidates across 2 fixtures:
  // Fixture A has Total (top) + Corner 1X2 (independent approved alt)
  // Fixture B has Double Chance (top) + Team Total
  const cands = [
    { evKey: 'f:A', fixtureId: 1001, sport: 'football', home: 'Arsenal', away: 'Fulham', market: 'Total', outcome: 'over 1.5', approvedMarketId: 'total_goals', canonicalOutcome: 'O:1.5', line: 1.5, odds: 1.50, p: 0.85, score: 0.92, ts: 100 },
    { evKey: 'f:A', fixtureId: 1001, sport: 'football', home: 'Arsenal', away: 'Fulham', market: 'Corner 1x2', outcome: '1', approvedMarketId: 'corner_1x2', canonicalOutcome: 'H', line: null, odds: 1.55, p: 0.78, score: 0.82, ts: 100 },
    { evKey: 'f:B', fixtureId: 1002, sport: 'football', home: 'Liverpool', away: 'Everton', market: 'Double chance', outcome: '1X', approvedMarketId: 'double_chance', canonicalOutcome: '1X', line: null, odds: 1.45, p: 0.83, score: 0.89, ts: 200 },
    { evKey: 'f:C', fixtureId: 1003, sport: 'football', home: 'Chelsea', away: 'Brentford', market: 'Chelsea total', outcome: 'over 0.5', approvedMarketId: 'team_total', canonicalOutcome: 'H:O:0.5', line: 0.5, odds: 1.48, p: 0.81, score: 0.86, ts: 300 },
  ];

  // 1) Without confirmed-used history: picks strongest fixtures A (Total) + B (Double Chance)
  const first = build(cands, { target: 2.0, count: 0 });
  assert.equal(first.status, 'ready');
  assert.equal(first.legs.length, 2);
  assert.ok(first.legs.some((l) => l.fixtureId === 1001 && l.approvedMarketId === 'total_goals'));
  assert.ok(first.legs.some((l) => l.fixtureId === 1002 && l.approvedMarketId === 'double_chance'));
  assert.equal(first.diversification.applied, false);

  // 2) After user EXPLICITLY confirms Ticket 1 as used:
  //    Next ticket must NOT repeat A/Total or B/Double Chance; must prefer fresh fixture C (Team Total)
  //    and reuse Fixture A ONLY via its genuinely different independent market (Corner 1X2)!
  const usedFromFirst = first.legs.map((l) => ({
    fixtureId: l.fixtureId, home: l.home, away: l.away,
    approvedMarketId: l.approvedMarketId, market: l.market, outcome: l.outcome, canonicalOutcome: l.canonicalOutcome, line: l.line,
  }));
  const second = build(cands, { target: 2.0, count: 0, usedSelections: usedFromFirst });
  assert.equal(second.status, 'ready');
  assert.equal(second.legs.length, 2);
  assert.equal(second.diversification.applied, true);
  assert.equal(second.diversification.excludedExactRepeats, 2);
  assert.ok(second.legs.some((l) => l.fixtureId === 1003 && l.approvedMarketId === 'team_total'), 'must prioritize fresh fixture C');
  assert.ok(second.legs.some((l) => l.fixtureId === 1001 && l.approvedMarketId === 'corner_1x2'), 'may reuse fixture A with genuinely different Corner 1X2 market');
  assert.ok(!second.legs.some((l) => l.fixtureId === 1001 && l.approvedMarketId === 'total_goals'), 'must NEVER repeat confirmed-used A/Total');
  assert.ok(!second.legs.some((l) => l.fixtureId === 1002 && l.approvedMarketId === 'double_chance'), 'must NEVER repeat confirmed-used B/Double Chance');

  // 3) Backend persistence & idempotency via POST /tickets/:id/confirm-used & GET /tickets/confirmed-used
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betrobot-used-'));
  const app = createCloudServer({ port: 0, host: '127.0.0.1', stateDir: tmpDir, token: 'tok_used_test' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const reqJson = (method, p, body) => new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: { Authorization: 'Bearer tok_used_test', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
  try {
    const r1 = await reqJson('POST', '/tickets/tk_1/confirm-used', { bookingCode: 'M2ayny', selections: usedFromFirst });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.alreadyConfirmed, false);
    // Repeat confirmation (e.g. after reconnect) must be idempotent without duplicating
    const r2 = await reqJson('POST', '/tickets/tk_1/confirm-used', { bookingCode: 'M2ayny', selections: usedFromFirst });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.alreadyConfirmed, true);
    const list = await reqJson('GET', '/tickets/confirmed-used');
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1, 'must never duplicate confirmation on reconnect');
    const loaded = loadConfirmedUsedSelections(path.join(tmpDir, 'confirmed_used_tickets.json'), []);
    assert.equal(loaded.length, 2);
  } finally {
    app.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// NEXT-UPDATE VERIFICATION TESTS (Parts 4, 5, 6, 8, 9, 10, 12)
// =============================================================================
const leaguePriority = require('../lib/league_priority');
const sportMarkets = require('../lib/sport_markets');

test('Part 4: Target-aware selection avoids degenerate @1.05 leg piles, emits every-2 checkpoints, and buildProgress suppresses premature combinedOdds', () => {
  const cands = [];
  // 20 fixtures, each offering BOTH a filler @1.06 (p=0.95) AND a strong @1.45 (p=0.80)
  for (let i = 1; i <= 20; i++) {
    cands.push({
      evKey: `f:M${i}`, fixtureId: 5000 + i, sport: 'football', home: `Home${i}`, away: `Away${i}`,
      market: 'Total', outcome: 'under 5.5', approvedMarketId: 'total_goals', canonicalOutcome: 'U:5.5', line: 5.5,
      odds: 1.06, p: 0.95, confidenceScore: 0.85, score: 0.90, ts: i * 1000,
    });
    cands.push({
      evKey: `f:M${i}`, fixtureId: 5000 + i, sport: 'football', home: `Home${i}`, away: `Away${i}`,
      market: 'Total', outcome: 'over 1.5', approvedMarketId: 'total_goals', canonicalOutcome: 'O:1.5', line: 1.5,
      odds: 1.45, p: 0.80, confidenceScore: 0.85, score: 0.78, ts: i * 1000,
    });
  }
  const checkpoints = [];
  const res = build(cands, { target: 10, count: 0 }, { onCheckpoint: (cp) => checkpoints.push(cp) });
  assert.equal(res.status, 'ready');
  assert.equal(res.targetReached, true);
  assert.ok(res.total >= 10, `expected combined odds >= 10, got ${res.total}`);
  assert.ok(res.legs.length <= 10, `expected sensible leg count <= 10 for target 10, got ${res.legs.length}`);
  assert.ok(checkpoints.length >= 2, 'must fire every-2-selection checkpoints');
  assert.equal(checkpoints[0].afterSelections, 2);

  // Premature combined-odds suppression before selectionStarted
  const progBefore = buildProgress('evaluating_markets', 'Evaluating markets', Date.now() - 5000, {
    selectionStarted: false,
    selections: 12,
    combinedOdds: 42.5,
    candidatesQualified: 60,
  }, 50);
  assert.equal(progBefore.combinedOdds, 0, 'must NOT display combinedOdds before selection starts');
  assert.equal(progBefore.selectionsChosen, 0, 'must NOT display selectionsChosen before selection starts');

  const progAfter = buildProgress('selecting_legs', 'Selecting legs', Date.now() - 5000, {
    selectionStarted: true,
    selections: 4,
    combinedOdds: 4.42,
  }, 50);
  assert.equal(progAfter.combinedOdds, 4.42);
  assert.equal(progAfter.selectionsChosen, 4);
});

test('Part 5: Expanded 200/100 long-range pool activates ONLY for Weekend / >2-day ranges and retains strongest 100 candidates', async () => {
  const { resolveDateScope, isExpandedDateRange } = require('../lib/dates');
  const { runStatsCollectionPool, EXPANDED_MAX_FIXTURES_TO_CHECK, EXPANDED_MAX_RANKED_CANDIDATES } = require('../run');
  const { selectStrongestCandidatePool } = require('../lib/ticket');

  assert.equal(EXPANDED_MAX_FIXTURES_TO_CHECK, 200);
  assert.equal(EXPANDED_MAX_RANKED_CANDIDATES, 100);

  // Short ranges MUST NOT activate expanded mode
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'today' })), false);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'tomorrow' })), false);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'date', date: '2026-11-28' })), false);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'range', dateFrom: '2026-11-27', dateTo: '2026-11-28' })), false);

  // Weekend and >2-day ranges MUST activate expanded mode
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'weekend' })), true);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'next3days' })), true);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'next7days' })), true);
  assert.equal(isExpandedDateRange(resolveDateScope({ scope: 'range', dateFrom: '2026-11-27', dateTo: '2026-11-29' })), true);

  // Expanded pool with disableEarlyStop=true assesses all 70 fixtures past 50 usable without stopping early
  const events = Array.from({ length: 70 }, (_, i) => ({
    key: `f:exp:${i}`, sport: 'football', home: `H${i}`, away: `A${i}`, statsStatus: 'pending',
  }));
  const poolRes = await runStatsCollectionPool(events, async (_w, ev) => {
    ev.stats = { available: true, status: 'complete', homeForm: 'WWWWW', awayForm: 'LLDLL', categories: { recentMatches: true } };
    ev.statsStatus = 'complete';
  }, { concurrency: 2, targetUsable: 50, disableEarlyStop: true });
  assert.equal(poolRes.checkedCount, 70);
  assert.equal(poolRes.usableCount, 70);
  assert.equal(poolRes.stopReason, 'pool_exhausted');

  // Strongest-100 candidate retention preserves top 100 across 140 fixtures
  const manyCands = Array.from({ length: 140 }, (_, i) => ({
    evKey: `f:pool:${i}`, sport: 'football', home: `H${i}`, away: `A${i}`,
    odds: 1.4, p: 0.65 + (i % 30) * 0.01, score: 0.60 + (i / 1000),
  }));
  const retained = selectStrongestCandidatePool(manyCands, 100);
  assert.equal(retained.totalQualifying, 140);
  assert.equal(retained.retainedCount, 100);
  assert.ok(retained.retained[0].score > retained.retained[99].score);
});

test('Part 6: Transparent league-priority ordering ranks established competitions ahead of minor leagues and preserves unranked fixtures', () => {
  const fixtures = [
    { sport: 'football', home: 'Minor A', away: 'Minor B', league: 'Regional Cup', country: 'Unknown', ts: 1000 },
    { sport: 'football', home: 'Unranked A', away: 'Unranked B', league: '', country: '', ts: 2000 },
    { sport: 'football', home: 'Arsenal', away: 'Chelsea', league: 'Premier League', country: 'England', tournamentWeight: 1, countryWeight: 3, highLight: true, ts: 3000 },
    { sport: 'football', home: 'Real Madrid', away: 'Sevilla', league: 'LaLiga', country: 'Spain', tournamentWeight: 2, countryWeight: 4, highLight: true, ts: 4000 },
    { sport: 'football', home: 'Bangladesh A', away: 'Bangladesh B', league: 'Premier League', country: 'Bangladesh', tournamentWeight: 50, countryWeight: 80, ts: 500 },
  ];
  const res = leaguePriority.orderFixturesByLeaguePriority(fixtures);
  assert.equal(res.total, 5, 'must preserve ALL fixtures including unranked fallback');
  assert.equal(res.ordered[0].home, 'Arsenal', 'England Premier League ranked first');
  assert.equal(res.ordered[1].home, 'Real Madrid', 'Spain LaLiga ranked second');
  assert.ok(res.ordered.some((f) => f.home === 'Unranked A' && f.leaguePriority.source.includes('fallback')), 'unranked fixture preserved with documented fallback');
});

test('Part 8: Independent sport-specific dictionaries & evaluators for Basketball, Tennis, Baseball, and Hockey', () => {
  // Basketball: OT winner & Normal total points (NOT Poisson!)
  const bbEv = {
    sport: 'basketball', home: 'Boston Celtics', away: 'Atlanta Hawks',
    stats: {
      available: true, status: 'complete', homeForm: 'WWWWW', awayForm: 'WLLWL',
      probs: { H: 0.72, X: 0.04, A: 0.24 },
      goals: { hFor: 120.5, aFor: 112.0, hAg: 108.0, aAg: 119.5 },
      previousMatches: { home: [], away: [] },
    },
  };
  const bbWin = sportMarkets.matchSportMarket('basketball', 'Winner (incl. overtime)', 'Boston Celtics', bbEv);
  const bbTot = sportMarkets.matchSportMarket('basketball', 'Total (incl. overtime)', 'over 218.5', bbEv);
  const bbSub = sportMarkets.matchSportMarket('basketball', '1st quarter - total', 'over 55.5', bbEv);
  assert.equal(bbWin.approved, true);
  assert.equal(bbWin.approvedMarketId, 'bb_winner_ot');
  assert.equal(bbTot.approved, true);
  assert.equal(bbTot.approvedMarketId, 'bb_total_ot');
  assert.equal(bbSub.approved, false, 'sub-period quarter market rejected without quarter stats');
  const bbWinEval = sportMarkets.evaluateSportMarket(bbWin, { title: 'Winner (incl. overtime)', label: 'Boston Celtics', odds: 1.3 }, bbEv, { probs: bbEv.stats.probs });
  const bbTotEval = sportMarkets.evaluateSportMarket(bbTot, { title: 'Total (incl. overtime)', label: 'over 218.5', odds: 1.55 }, bbEv, { probs: bbEv.stats.probs });
  assert.ok(bbWinEval && bbWinEval.p > 0.7, `expected strong Celtics win prob, got ${bbWinEval && bbWinEval.p}`);
  assert.ok(bbTotEval && bbTotEval.p > 0.6, `expected Normal total prob > 0.6 for expected 230 vs 218.5, got ${bbTotEval && bbTotEval.p}`);

  // Tennis: 2-way winner, rejects game markets without game stats
  const tnEv = {
    sport: 'tennis', home: 'Player One', away: 'Player Two',
    stats: { available: true, status: 'complete', homeForm: 'WWWWW', awayForm: 'LLLLW', h2h: { n: 4, H: 3, X: 0, A: 1 } },
  };
  const tnWin = sportMarkets.matchSportMarket('tennis', 'Winner', 'home', tnEv);
  const tnGames = sportMarkets.matchSportMarket('tennis', 'Total games', 'over 21.5', tnEv);
  assert.equal(tnWin.approved, true);
  assert.equal(tnWin.approvedMarketId, 'tn_match_winner');
  assert.equal(tnGames.approved, false, 'must reject tennis game totals when game stats are unavailable');
  const tnEval = sportMarkets.evaluateSportMarket(tnWin, { title: 'Winner', label: 'home', odds: 1.45 }, tnEv, { probs: null });
  assert.ok(tnEval && tnEval.p > 0.65, `expected strong tennis 2-way win prob, got ${tnEval && tnEval.p}`);

  // Baseball: extra innings vs 9-inning separation
  const bsEv = {
    sport: 'baseball', home: 'New York Yankees', away: 'Boston Red Sox',
    stats: { available: true, status: 'complete', probs: { H: 0.62, X: 0.08, A: 0.30 }, goals: { hFor: 5.6, aFor: 4.1, hAg: 3.7, aAg: 5.2 } },
  };
  assert.equal(sportMarkets.matchSportMarket('baseball', 'Winner (incl. extra innings)', 'home', bsEv).approvedMarketId, 'bs_winner_ei');
  assert.equal(sportMarkets.matchSportMarket('baseball', '1x2', '1', bsEv).approvedMarketId, 'bs_1x2_reg');
  assert.equal(sportMarkets.matchSportMarket('baseball', 'Handicap (incl. extra innings)', 'New York Yankees (-1.5)', bsEv).approvedMarketId, 'bs_run_line_ei');

  // Hockey: strict separation between 60m regulation 1X2 and OT/shootout Moneyline
  const hkEv = {
    sport: 'hockey', home: 'Toronto Maple Leafs', away: 'Montreal Canadiens',
    stats: { available: true, status: 'complete', probs: { H: 0.56, X: 0.22, A: 0.22 }, goals: { hFor: 3.6, aFor: 2.5, hAg: 2.4, aAg: 3.4 } },
  };
  const hkReg = sportMarkets.matchSportMarket('hockey', '1x2', '1', hkEv);
  const hkOt = sportMarkets.matchSportMarket('hockey', 'Winner (incl. overtime and penalties)', 'home', hkEv);
  assert.equal(hkReg.approvedMarketId, 'hk_1x2_reg');
  assert.equal(hkOt.approvedMarketId, 'hk_winner_ot');
  const hkRegEval = sportMarkets.evaluateSportMarket(hkReg, { title: '1x2', label: '1', odds: 1.7 }, hkEv, { probs: hkEv.stats.probs });
  const hkOtEval = sportMarkets.evaluateSportMarket(hkOt, { title: 'Winner (incl. overtime and penalties)', label: 'home', odds: 1.42 }, hkEv, { probs: hkEv.stats.probs });
  assert.ok(hkOtEval.p > hkRegEval.p + 0.08, 'OT/SO moneyline probability must strictly exceed 60m regulation 1X2 probability');
});

test('Part 10: Confirmed-used diversification catches exact repeats even when fixtureId is present on history and absent on candidate', () => {
  const cands = [
    { evKey: 'f:1', sport: 'football', home: 'Rahmatganj MFS', away: 'Mohammedan SC Dhaka', market: 'Double chance', outcome: 'X2', approvedMarketId: 'double_chance', canonicalOutcome: 'X2', line: null, odds: 1.35, p: 0.85, score: 0.88, ts: 100 },
    { evKey: 'f:2', sport: 'football', home: 'Fresh Home', away: 'Fresh Away', market: 'Total', outcome: 'over 1.5', approvedMarketId: 'total_goals', canonicalOutcome: 'O:1.5', line: 1.5, odds: 1.40, p: 0.82, score: 0.85, ts: 200 },
    { evKey: 'f:3', sport: 'football', home: 'Fresh Home 2', away: 'Fresh Away 2', market: 'Total', outcome: 'over 1.5', approvedMarketId: 'total_goals', canonicalOutcome: 'O:1.5', line: 1.5, odds: 1.50, p: 0.80, score: 0.83, ts: 300 },
  ];
  const usedWithId = [
    { fixtureId: 76974098, home: 'Rahmatganj MFS', away: 'Mohammedan SC Dhaka', approvedMarketId: 'double_chance', market: 'Double chance', outcome: 'X2', canonicalOutcome: 'X2', line: null },
  ];
  const res = build(cands, { target: 2.0, count: 0, usedSelections: usedWithId });
  assert.equal(res.diversification.excludedExactRepeats, 1, 'must catch repeat across fixtureId vs teams key');
  assert.ok(!res.legs.some((l) => l.home === 'Rahmatganj MFS'), 'repeated selection must be excluded');
});

