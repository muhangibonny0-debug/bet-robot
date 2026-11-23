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
