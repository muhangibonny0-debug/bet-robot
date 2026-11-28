'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const espn = require('../lib/espn_stats');
const { buildStructuredStatsPacket } = require('../lib/stats_packet');

describe('ESPN public soccer statistics fallback', () => {
  it('computes honest form splits, goal averages, over/under, BTTS, CS, FTS, and standings without fabricating missing fields', async () => {
    espn.clearCaches();
    const fakeScoreboard = {
      events: [
        {
          id: '401879227',
          date: '2026-11-28T15:00Z',
          league: { slug: 'eng.1', name: 'English Premier League' },
          competitions: [{
            competitors: [
              { homeAway: 'home', form: 'WWLDW', team: { id: '357', displayName: 'Leeds United' } },
              { homeAway: 'away', form: 'LLWLW', team: { id: '388', displayName: 'Coventry City' } },
            ],
          }],
        },
      ],
    };
    const fakeSummary = {
      standings: {
        groups: [{
          standings: {
            entries: [
              {
                team: { id: '357', displayName: 'Leeds United' },
                stats: [
                  { name: 'rank', value: 8 },
                  { name: 'gamesPlayed', value: 11 },
                  { name: 'wins', value: 5 },
                  { name: 'ties', value: 3 },
                  { name: 'losses', value: 3 },
                  { name: 'points', value: 18 },
                  { name: 'pointsFor', value: 19 },
                  { name: 'pointsAgainst', value: 13 },
                ],
              },
              {
                team: { id: '388', displayName: 'Coventry City' },
                stats: [
                  { name: 'rank', value: 15 },
                  { name: 'gamesPlayed', value: 11 },
                  { name: 'wins', value: 3 },
                  { name: 'ties', value: 2 },
                  { name: 'losses', value: 6 },
                  { name: 'points', value: 11 },
                  { name: 'pointsFor', value: 12 },
                  { name: 'pointsAgainst', value: 20 },
                ],
              },
            ],
          },
        }],
      },
      headToHeadGames: [],
      lastFiveGames: [],
    };
    const mkSched = (tid, rows) => ({
      events: rows.map((r, i) => ({
        date: `2026-10-${String(10 + i).padStart(2, '0')}T15:00Z`,
        competitions: [{
          status: { type: { completed: true } },
          competitors: [
            { homeAway: r.isHome ? 'home' : 'away', team: { id: tid }, score: { value: r.gf } },
            { homeAway: r.isHome ? 'away' : 'home', team: { id: '999' }, score: { value: r.ga } },
          ],
        }],
      })),
    });

    const fakeFetch = async (url) => {
      if (url.includes('/all/scoreboard')) return { ok: true, status: 200, json: async () => fakeScoreboard };
      if (url.includes('/summary?event=401879227')) return { ok: true, status: 200, json: async () => fakeSummary };
      if (url.includes('/teams/357/schedule')) {
        return {
          ok: true,
          status: 200,
          json: async () => mkSched('357', [
            { isHome: true, gf: 2, ga: 0 },
            { isHome: false, gf: 1, ga: 1 },
            { isHome: true, gf: 3, ga: 1 },
            { isHome: false, gf: 2, ga: 1 },
          ]),
        };
      }
      if (url.includes('/teams/388/schedule')) {
        return {
          ok: true,
          status: 200,
          json: async () => mkSched('388', [
            { isHome: false, gf: 0, ga: 2 },
            { isHome: true, gf: 2, ga: 1 },
            { isHome: false, gf: 1, ga: 3 },
            { isHome: true, gf: 0, ga: 1 },
          ]),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const ev = { home: 'Leeds United', away: 'Coventry City', league: 'Premier League', sport: 'football', ts: Date.parse('2026-11-28T15:00Z') };
    const st = await espn.fetchEspnStatsForFixture(ev, { fetch: fakeFetch, bypassCache: true });

    assert.equal(st.available, true);
    assert.equal(st.source, 'espn-public-soccer');
    assert.equal(st.status, 'complete');
    assert.equal(st.homeForm, 'WDWW');
    assert.equal(st.awayForm, 'LWLL');
    assert.equal(st.goals.hFor, 2);
    assert.equal(st.goals.hAg, 0.75);
    assert.equal(st.standings.home.pos, 8);
    assert.equal(st.standings.away.pos, 15);
    assert.equal(st.probs, null);
    assert.equal(st.categories.disciplinary, false);

    ev.stats = st;
    const pkt = buildStructuredStatsPacket(ev);
    assert.equal(pkt.completeness.usable, true);
    assert.equal(pkt.completeness.complete, true);
    assert.ok(pkt.completeness.retrievedCount >= 10, `Expected >=10 fields, got ${pkt.completeness.retrievedCount}`);
    assert.equal(pkt.headToHeadAverages.cornersPerSide.home.status, 'missing');
    assert.equal(pkt.winProbability.homeWinPct.status, 'missing');
  });

  it('returns null honestly when no matching fixture exists on ESPN (never substitutes unrelated matches)', async () => {
    espn.clearCaches();
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) });
    const ev = { home: 'Unknown Local FC', away: 'Mystery Town', sport: 'football', ts: Date.parse('2026-11-28T15:00Z') };
    const st = await espn.fetchEspnStatsForFixture(ev, { fetch: fakeFetch, bypassCache: true });
    assert.equal(st, null);
  });
});
