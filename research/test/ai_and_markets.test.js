'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const approvedMarkets = require('../lib/approved_markets');
const bbstats = require('../lib/bbstats');
const gismo = require('../lib/gismo');
const { buildStructuredStatsPacket } = require('../lib/stats_packet');
const { getKnowledgeGuideForSport } = require('../lib/ai_knowledge');
const aiAnalyst = require('../lib/ai_analyst');
const analyze = require('../lib/analyze');

const SAMPLE_EV = {
  key: 'football:arsenal:chelsea:1',
  matchId: 74166014,
  sport: 'football',
  home: 'Arsenal FC',
  away: 'Chelsea FC',
  league: 'Premier League',
  country: 'England',
  ts: Date.now() + 3600000,
};

test('Phase 6: All 21 approved football markets match live BangBet labels accurately and enforce strict boundaries', () => {
  assert.equal(approvedMarkets.APPROVED_MARKET_IDS.length, 21);

  const cases = [
    ['1x2', '1', 'match_result_1x2', 'H'],
    ['Double chance', '1X', 'double_chance', '1X'],
    ['1x2 (1up)', 'Home', 'match_result_1x2_1up', 'H'],
    ['1x2 (2up)', 'Away', 'match_result_1x2_2up', 'A'],
    ['To win either half', 'Arsenal FC', 'to_win_either_half', 'H:Y'],
    ['Draw no bet', 'Arsenal FC', 'draw_no_bet', 'H'],
    ['Arsenal FC total', 'Over 0.5', 'team_total_over_0_5', 'H:O:0.5'],
    ['Total', 'Over 0.5', 'total_over_0_5', 'O:0.5'],
    ['Total', 'Over 1.5', 'total_over_1_5', 'O:1.5'],
    ['1st half - total', 'Over 0.5', 'first_half_total_over_0_5', '1H:O:0.5'],
    ['2nd half - total', 'Over 0.5', 'second_half_total_over_0_5', '2H:O:0.5'],
    ['Arsenal FC total', 'Over 1.5', 'team_total', 'H:O:1.5'],
    ['Total', 'Over 2.5', 'total_goals', 'O:2.5'],
    ['Both teams to score', 'No', 'btts_no', 'N'],
    ['Corner 1x2', '1', 'corner_1x2', 'H'],
    ['1st half - double chance', '1X', 'first_half_double_chance', '1H:1X'],
    ['Asian handicap', 'Arsenal FC +0.5', 'asian_handicap_plus_0_5', 'H:+0.5'],
    ['Asian handicap', 'Chelsea FC +1', 'asian_handicap_plus_1', 'A:+1'],
    ['Arsenal FC to score in both halves', 'No', 'to_score_in_both_halves_no', 'H:N'],
    ['Highest scoring half', '2nd half', 'highest_scoring_half_second', '2H'],
    ['Any team to win', '12', 'any_team_to_win', '12'],
  ];

  const matchedIds = new Set();
  for (const [title, label, expId, expCanon] of cases) {
    const res = approvedMarkets.matchApprovedMarket(title, label, SAMPLE_EV);
    assert.equal(res.approved, true, `expected approved for "${title} / ${label}", got ${JSON.stringify(res)}`);
    assert.equal(res.approvedMarketId, expId, `wrong id for "${title} / ${label}"`);
    assert.equal(res.canonicalOutcome, expCanon, `wrong canonicalOutcome for "${title} / ${label}"`);
    matchedIds.add(res.approvedMarketId);
  }
  assert.equal(matchedIds.size, 21, 'all 21 approved market IDs must be matched');

  // Strict negative boundary checks
  assert.equal(approvedMarkets.matchApprovedMarket('Both teams to score', 'Yes', SAMPLE_EV).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Asian handicap', 'Arsenal FC -0.5', SAMPLE_EV).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Handicap', 'Home 0:2', SAMPLE_EV).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Highest scoring half', '1st half', SAMPLE_EV).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Highest scoring half', 'Equal', SAMPLE_EV).approved, false);
  assert.equal(approvedMarkets.matchApprovedMarket('Arsenal FC to score in both halves', 'Yes', SAMPLE_EV).approved, false);
});

test('Phase 6: Settlement rules for newly added markets (DNB, BTTS No, AH +0.5, AH +1 push, Score Both Halves No, Highest Half 2H)', () => {
  assert.equal(approvedMarkets.settleDrawNoBet(1, 1, 'H').outcome, 'push');
  assert.equal(approvedMarkets.settleDrawNoBet(2, 1, 'H').outcome, 'win');
  assert.equal(approvedMarkets.settleBttsNo(2, 0).outcome, 'win');
  assert.equal(approvedMarkets.settleBttsNo(1, 1).outcome, 'loss');
  assert.equal(approvedMarkets.settleAsianHandicap(1, 1, 0.5, 'H').outcome, 'win');
  assert.equal(approvedMarkets.settleAsianHandicap(0, 1, 1.0, 'H').outcome, 'push');
  assert.equal(approvedMarkets.settleAsianHandicap(0, 2, 1.0, 'H').outcome, 'loss');
  assert.equal(approvedMarkets.settleToScoreInBothHalvesNo(1, 0).outcome, 'win');
  assert.equal(approvedMarkets.settleToScoreInBothHalvesNo(1, 1).outcome, 'loss');
  assert.equal(approvedMarkets.settleHighestScoringHalfSecond(0, 0, 1, 0).outcome, 'win');
  assert.equal(approvedMarkets.settleHighestScoringHalfSecond(1, 0, 1, 0).outcome, 'loss');
});

test('Phase 4: BangBet DOM parser separates H2H averages from League averages and extracts HT WIN %, FTS, CS without zeroing missing fields', () => {
  const domText = [
    'HEAD TO HEAD TEAM AVERAGES',
    'GOALS SCORED', '2.80', 'League', '2.45',
    'BTTS', '65%', 'League', '51%',
    'OVER 1.5', '85%', 'League', '74%',
    'OVER 2.5', '60%', 'League', '48%',
    'CORNERS', '9.50', 'League', '8.90',
    'WIN PROBABILITY',
    '58%', 'ARS', '24%', 'DRAW', '18%', 'CHE',
    'PREVIOUS MEETINGS',
    '8', 'WINS', '4', 'DRAW', '3', 'WINS',
    'Arsenal FC',
    'LAST MATCHES',
    'W', 'W', 'D', 'W', 'L',
    'W', 'W', 'W', 'D', 'W',
    'L', 'D', 'W', 'L', 'D',
    'HT WIN %', '60%',
    'FTS', '10%',
    'CS', '50%',
    'Chelsea FC',
    'LAST MATCHES',
    'L', 'D', 'W', 'L', 'L',
    'W', 'D', 'W', 'L', 'D',
    'L', 'L', 'D', 'L', 'W',
    'HT WIN %', '25%',
    'FTS', '35%',
    'CS', '20%',
    'TEAM STATS',
    '20', 'MATCHES PLAYED', '20',
    '65%', 'WIN %', '35%',
    '42', 'TOTAL GOALS', '24',
    '2.10', 'AVG GOALS SCORED', '1.20',
    '0.85', 'AVG GOALS CONCEDED', '1.55',
    '50%', 'BTTS', '55%',
    '85%', 'OVER 1.5', '75%',
    '60%', 'OVER 2.5', '45%',
    '70%', 'HT OVER 0.5', '55%',
    '35%', 'HT OVER 1.5', '20%',
    '1.6', 'YELLOW CARDS', '2.4',
    '1.7', 'TOTAL CARDS', '2.6',
  ].join('\n');

  const st = bbstats.parse(domText, SAMPLE_EV);
  assert.equal(st.available, true);
  assert.equal(st.avg['goals scored'], 2.8);
  assert.equal(st.leagueAvg['goals scored'], 2.45);
  assert.equal(st.avg.btts, 65);
  assert.equal(st.leagueAvg.btts, 51);
  assert.equal(st.homeFormSplit.overall, 'WWDWL');
  assert.equal(st.homeFormSplit.home, 'WWWDW');
  assert.equal(st.homeFormSplit.away, 'LDWLD');
  assert.equal(st.formMetrics.home.htWinPct, 60);
  assert.equal(st.formMetrics.home.ftsPct, 10);
  assert.equal(st.formMetrics.home.csPct, 50);
  assert.equal(st.formMetrics.away.ftsPct, 35);

  const pkt = buildStructuredStatsPacket({ ...SAMPLE_EV, stats: st });
  assert.equal(pkt.headToHeadAverages.avgGoals.value, 2.8);
  assert.equal(pkt.headToHeadAverages.leagueAvgGoals.value, 2.45);
  assert.equal(pkt.winProbability.homeWinPct.status, 'retrieved');
  assert.equal(pkt.lastMatchesForm.home.htWinPct.value, 60);
  assert.equal(pkt.lastMatchesForm.home.ftsPct.value, 10);
  assert.equal(pkt.lastMatchesForm.home.csPct.value, 50);
  // Standings were missing -> MUST be 'missing', never 0!
  assert.equal(pkt.leagueStandings.home.status, 'missing');
  assert.equal(pkt.completeness.usable, true);
});

test('Phase 4: Gismo parseH2H computes H2H avgGoals, BTTS %, Over 1.5 %, Over 2.5 % accurately', () => {
  const h2hData = {
    matches: [
      { _id: 1, teams: { home: { uid: 10, name: 'A' }, away: { uid: 20, name: 'B' } }, result: { home: 2, away: 1 } },
      { _id: 2, teams: { home: { uid: 20, name: 'B' }, away: { uid: 10, name: 'A' } }, result: { home: 1, away: 1 } },
      { _id: 3, teams: { home: { uid: 10, name: 'A' }, away: { uid: 20, name: 'B' } }, result: { home: 3, away: 0 } },
      { _id: 4, teams: { home: { uid: 20, name: 'B' }, away: { uid: 10, name: 'A' } }, result: { home: 0, away: 1 } },
    ],
  };
  const res = gismo.parseH2H(h2hData, 10, 20);
  assert.equal(res.n, 4);
  assert.equal(res.H, 3);
  assert.equal(res.X, 1);
  assert.equal(res.A, 0);
  assert.equal(res.avgGoals, 2.25);
  assert.equal(res.bttsPct, 50);
  assert.equal(res.over15Pct, 75);
  assert.equal(res.over25Pct, 50);
});

test('Phase 5 & 12: Permanent AI knowledge guides are sport-specific and forbid football assumptions on other sports', () => {
  for (const sp of ['football', 'basketball', 'tennis', 'baseball', 'hockey']) {
    const g = getKnowledgeGuideForSport(sp);
    assert.ok(g.length > 100, `guide missing for ${sp}`);
    if (sp !== 'football') {
      assert.match(g, /NEVER.*football/i);
    }
  }
});

test('Phase 5, 7, 12: AI Analyst validates structured JSON, rejects fabricated markets, supports NO SELECTION, and executes Rank 1 -> 2 -> 3 fallback', async () => {
  const ev = {
    ...SAMPLE_EV,
    stats: {
      available: true,
      status: 'complete',
      homeForm: 'WWWWW',
      awayForm: 'LLLLD',
      homeFormSplit: { overall: 'WWWWW', home: 'WWWWW', away: 'WWDWL' },
      awayFormSplit: { overall: 'LLLLD', home: 'DLDWL', away: 'LLLLL' },
      goals: { hFor: 2.3, hAg: 0.6, aFor: 0.7, aAg: 2.0, p1HFor: 1.1, p1HAg: 0.3, p1AFor: 0.3, p1AAg: 0.9, p2HFor: 1.2, p2HAg: 0.3, p2AFor: 0.4, p2AAg: 1.1 },
      probs: { H: 0.68, X: 0.20, A: 0.12 },
      h2h: { n: 5, H: 4, X: 1, A: 0, avgGoals: 2.6, bttsPct: 40, over15Pct: 80, over25Pct: 60 },
      pct: [],
    },
    markets: [
      { i: 0, title: '1x2', label: '1', odds: 1.48 },
      { i: 1, title: 'Double chance', label: '1X', odds: 1.14 },
      { i: 2, title: 'Total', label: 'Over 1.5', odds: 1.25 },
      { i: 3, title: 'Draw no bet', label: 'Arsenal FC', odds: 1.18 },
    ],
  };

  // Mock Groq returning 1 fabricated market + 3 valid ranked markets (truncated/filtered to 3)
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                matchId: 74166014,
                homeTeam: 'Arsenal FC',
                awayTeam: 'Chelsea FC',
                competition: 'Premier League',
                kickoff: new Date(ev.ts).toISOString(),
                statisticalEvidenceSummary: 'Strong home form (WWWWW) and scoring advantage vs weak away form (LLLLL).',
                supportingStatistics: ['Home 5/5 wins at home', 'Away 0/5 wins away'],
                contradictoryStatistics: [],
                missingInformation: ['corners'],
                dataCompletenessAssessment: 'complete',
                noSelection: false,
                noSelectionReason: '',
                recommendations: [
                  { rank: 1, approvedMarketId: 'match_result_1x2', marketName: '1X2', outcome: '1', canonicalOutcome: 'H', line: null, odds: 1.48, explanation: 'Dominant home metrics', confidenceAssessment: 'high', evidenceStrength: 0.76 },
                  { rank: 2, approvedMarketId: 'total_over_1_5', marketName: 'Total Over 1.5', outcome: 'Over 1.5', canonicalOutcome: 'O:1.5', line: 1.5, odds: 1.25, explanation: 'High combined expected goals', confidenceAssessment: 'high', evidenceStrength: 0.80 },
                  { rank: 3, approvedMarketId: 'draw_no_bet', marketName: 'Draw No Bet', outcome: 'Arsenal FC', canonicalOutcome: 'H', line: null, odds: 1.18, explanation: 'Draw protection', confidenceAssessment: 'high', evidenceStrength: 0.84 },
                ],
                rejectedAlternatives: [{ market: 'Corner 1X2', reason: 'Missing corner stats' }],
                requestedMissingFields: [],
              }),
            },
          }],
          usage: { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
        };
      },
    };
  };

  const aiRes = await aiAnalyst.analyzeFixtureWithAi(ev, { apiKey: 'mock-key', fetch: mockFetch });
  assert.equal(aiRes.ok, true);
  assert.equal(aiRes.aiSource, 'groq');
  assert.equal(calls, 1);
  assert.equal(aiRes.tokens.total, 750);
  assert.equal(aiRes.analysis.recommendations.length, 3);

  // Fallback Test 1: Rank 1 unavailable -> falls back cleanly to Rank 2
  const liveWithoutRank1 = ev.markets.filter((m) => m.title !== '1x2');
  const fb2 = aiAnalyst.resolveRankedSelectionWithFallback(aiRes.analysis, liveWithoutRank1, ev);
  assert.equal(fb2.selected.approvedMarketId, 'total_over_1_5');
  assert.equal(fb2.trace.rank1Attempted, true);
  assert.equal(fb2.trace.rank2Fallback, true);
  assert.equal(fb2.trace.rank3Fallback, false);

  // Fallback Test 2: Rank 1 & Rank 2 unavailable -> falls back cleanly to Rank 3
  const liveOnlyRank3 = ev.markets.filter((m) => m.title === 'Draw no bet');
  const fb3 = aiAnalyst.resolveRankedSelectionWithFallback(aiRes.analysis, liveOnlyRank3, ev);
  assert.equal(fb3.selected.approvedMarketId, 'draw_no_bet');
  assert.equal(fb3.trace.rank3Fallback, true);

  // Fallback Test 3: All 3 unavailable -> skips fixture without substituting unanalyzed Double Chance!
  const liveOnlyUnanalyzed = ev.markets.filter((m) => m.title === 'Double chance');
  const fbSkip = aiAnalyst.resolveRankedSelectionWithFallback(aiRes.analysis, liveOnlyUnanalyzed, ev);
  assert.equal(fbSkip.selected, null);
  assert.equal(fbSkip.trace.skipped, true);
  assert.equal(fbSkip.trace.reason, 'all_ranked_recommendations_unavailable');

  // Fabricated market rejection + NO SELECTION test
  const badMockFetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              statisticalEvidenceSummary: 'Conflicting evidence.',
              dataCompletenessAssessment: 'insufficient',
              noSelection: false,
              recommendations: [
                { rank: 1, approvedMarketId: 'fake_market_xyz', marketName: 'Fake', outcome: 'Yes', odds: 2.5 },
              ],
            }),
          },
        }],
      };
    },
  });
  const badRes = await aiAnalyst.analyzeFixtureWithAi(ev, { apiKey: 'mock-key', fetch: badMockFetch });
  assert.equal(badRes.ok, true);
  assert.equal(badRes.analysis.noSelection, true, 'fabricated market must be rejected and result in NO SELECTION');
  assert.equal(badRes.analysis.recommendations.length, 0);
});

test('Phase 12: Evaluating newly added approved markets in analyze.js (DNB, BTTS No, 1H O0.5, 2H O0.5, 1H DC, AH +0.5, AH +1, Score Both Halves No, Highest Half 2H)', () => {
  const ev = {
    ...SAMPLE_EV,
    stats: {
      available: true,
      status: 'complete',
      homeForm: 'WWWWW',
      awayForm: 'LLLLD',
      goals: { hFor: 2.1, hAg: 0.4, aFor: 0.5, aAg: 1.8, p1HFor: 0.9, p1HAg: 0.2, p1AFor: 0.2, p1AAg: 0.8, p2HFor: 1.2, p2HAg: 0.2, p2AFor: 0.3, p2AAg: 1.0 },
      probs: { H: 0.70, X: 0.18, A: 0.12 },
      pct: [],
    },
    markets: [
      { i: 0, title: 'Draw no bet', label: 'Arsenal FC', odds: 1.20 },
      { i: 1, title: 'Both teams to score', label: 'No', odds: 1.72 },
      { i: 2, title: '1st half - total', label: 'Over 0.5', odds: 1.32 },
      { i: 3, title: '2nd half - total', label: 'Over 0.5', odds: 1.22 },
      { i: 4, title: '1st half - double chance', label: '1X', odds: 1.15 },
      { i: 5, title: 'Asian handicap', label: 'Arsenal FC +0.5', odds: 1.14 },
      { i: 6, title: 'Asian handicap', label: 'Arsenal FC +1', odds: 1.08 },
      { i: 7, title: 'Chelsea FC to score in both halves', label: 'No', odds: 1.08 },
      { i: 8, title: 'Highest scoring half', label: '2nd half', odds: 2.05 },
    ],
  };
  const cands = analyze.candidates(ev, { sports: ['football'], markets: [] });
  assert.equal(cands.length, 9, 'all 9 newly added approved market types should be evaluated cleanly');
  const ids = new Set(cands.map((c) => c.approvedMarketId));
  for (const id of [
    'draw_no_bet', 'btts_no', 'first_half_total_over_0_5', 'second_half_total_over_0_5',
    'first_half_double_chance', 'asian_handicap_plus_0_5', 'asian_handicap_plus_1',
    'to_score_in_both_halves_no', 'highest_scoring_half_second',
  ]) {
    assert.ok(ids.has(id), `expected evaluated candidate for ${id}`);
  }
});
