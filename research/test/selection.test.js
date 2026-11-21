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
    evKey: String(i), sport: 'football', odds: 1.25, p: 0.8, score: 1 - i / 100, ts: i,
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
