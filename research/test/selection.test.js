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
  assert.equal(classify('1st Half Goals', 'Over 0.5', ev).type, 'HALF_OU');
  assert.equal(classify('Total Corners', 'Over 8.5', ev).type, 'STAT_OU');
  assert.equal(classify('Home Team Goals', 'Over 0.5', ev).type, 'TEAM_OU');
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
