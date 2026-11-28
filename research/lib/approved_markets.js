'use strict';
// =============================================================================
// AUTHORITATIVE APPROVED FOOTBALL MARKET DICTIONARY (21 APPROVED MARKET TYPES)
// =============================================================================
// Single source of truth shared by the research/evaluation engine
// (extract.js, analyze.js, ai_analyst.js, run.js) AND the BangBet booking engine (book.js).
//
// Preserves all 9 original internal football market IDs and expands to the full
// 21 approved football market types with exact settlement rules, market-family
// classification, line/handicap handling, and live BangBet matching.
// =============================================================================

const { norm, sameTeam } = require('./util');
const mkLib = require('./market_knowledge');

// Exact ordered list of all 21 approved football market IDs (preserving all 9 original IDs)
const APPROVED_MARKET_IDS = Object.freeze([
  'match_result_1x2',
  'double_chance',
  'match_result_1x2_1up',
  'match_result_1x2_2up',
  'to_win_either_half',
  'draw_no_bet',
  'team_total_over_0_5',
  'total_over_0_5',
  'total_over_1_5',
  'first_half_total_over_0_5',
  'second_half_total_over_0_5',
  'team_total',
  'total_goals',
  'btts_no',
  'corner_1x2',
  'first_half_double_chance',
  'asian_handicap_plus_0_5',
  'asian_handicap_plus_1',
  'to_score_in_both_halves_no',
  'highest_scoring_half_second',
  'any_team_to_win',
]);

// -----------------------------------------------------------------------------
// EXACT SETTLEMENT FUNCTIONS FOR ALL 21 APPROVED FOOTBALL MARKETS
// -----------------------------------------------------------------------------

function settle1x2(homeGoals, awayGoals, outcome) {
  const o = String(outcome || '').toUpperCase();
  const s = o === '1' || o === 'HOME' ? 'H' : (o === '2' || o === 'AWAY' ? 'A' : (o === 'X' || o === 'DRAW' ? 'X' : o));
  if (s === 'H') return { outcome: homeGoals > awayGoals ? 'win' : 'loss', payoutFactor: homeGoals > awayGoals ? 1 : 0 };
  if (s === 'X') return { outcome: homeGoals === awayGoals ? 'win' : 'loss', payoutFactor: homeGoals === awayGoals ? 1 : 0 };
  if (s === 'A') return { outcome: awayGoals > homeGoals ? 'win' : 'loss', payoutFactor: awayGoals > homeGoals ? 1 : 0 };
  return { outcome: 'invalid', payoutFactor: 0 };
}

function settleTeamTotal(teamGoals, line, dir) {
  const d = String(dir || '').toUpperCase().startsWith('U') ? 'U' : 'O';
  return mkLib.settleOverUnder(teamGoals, Number(line), d);
}

function settleWinEitherHalf(h1, a1, h2, a2, teamSide, yesNo = 'Y') {
  const side = String(teamSide || '').toUpperCase();
  const yn = String(yesNo || 'Y').toUpperCase();
  let teamWonHalf = false;
  if (side === 'H' || side === '1' || side === 'HOME') {
    teamWonHalf = (h1 > a1) || (h2 > a2);
  } else if (side === 'A' || side === '2' || side === 'AWAY') {
    teamWonHalf = (a1 > h1) || (a2 > h2);
  } else {
    return { outcome: 'invalid', payoutFactor: 0 };
  }
  const wins = yn === 'N' || yn === 'NO' ? !teamWonHalf : teamWonHalf;
  return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0 };
}

function settleAnyTeamToWin(homeGoals, awayGoals, side) {
  const s = String(side || '').toUpperCase().replace(/\s+/g, '');
  const nonDraw = homeGoals !== awayGoals;
  if (s === '12' || s === 'Y' || s === 'YES' || s === 'HOMEORAWAY' || s === '1OR2' || s === 'EITHER') {
    return { outcome: nonDraw ? 'win' : 'loss', payoutFactor: nonDraw ? 1 : 0 };
  }
  if (s === 'N' || s === 'NO' || s === 'X' || s === 'DRAW') {
    return { outcome: !nonDraw ? 'win' : 'loss', payoutFactor: !nonDraw ? 1 : 0 };
  }
  return { outcome: 'invalid', payoutFactor: 0 };
}

function settle1x2EarlyPayout(homeGoals, awayGoals, outcome, leadThreshold = 1, leadState = {}) {
  const o = String(outcome || '').toUpperCase();
  const s = o === '1' || o === 'HOME' ? 'H' : (o === '2' || o === 'AWAY' ? 'A' : (o === 'X' || o === 'DRAW' ? 'X' : o));
  const maxHomeLead = Number.isFinite(leadState.maxHomeLead) ? leadState.maxHomeLead : Math.max(0, homeGoals - awayGoals);
  const maxAwayLead = Number.isFinite(leadState.maxAwayLead) ? leadState.maxAwayLead : Math.max(0, awayGoals - homeGoals);

  if (s === 'X') {
    const wins = homeGoals === awayGoals;
    return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0, earlyPayoutTriggered: false };
  }
  if (s === 'H') {
    const early = maxHomeLead >= leadThreshold;
    const wins = early || homeGoals > awayGoals;
    return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0, earlyPayoutTriggered: early };
  }
  if (s === 'A') {
    const early = maxAwayLead >= leadThreshold;
    const wins = early || awayGoals > homeGoals;
    return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0, earlyPayoutTriggered: early };
  }
  return { outcome: 'invalid', payoutFactor: 0, earlyPayoutTriggered: false };
}

function settleTotal(homeGoals, awayGoals, line, dir) {
  const d = String(dir || '').toUpperCase().startsWith('U') ? 'U' : 'O';
  return mkLib.settleOverUnder(homeGoals + awayGoals, Number(line), d);
}

function settleDoubleChance(homeGoals, awayGoals, side) {
  const s = String(side || '').toUpperCase().replace(/\s+/g, '');
  let wins = false;
  if (s === '1X' || s === 'HOMEORDRAW') wins = homeGoals >= awayGoals;
  else if (s === 'X2' || s === 'DRAWORAWAY') wins = awayGoals >= homeGoals;
  else if (s === '12' || s === 'HOMEORAWAY') wins = homeGoals !== awayGoals;
  else return { outcome: 'invalid', payoutFactor: 0 };
  return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0 };
}

function settleDrawNoBet(homeGoals, awayGoals, side) {
  const o = String(side || '').toUpperCase();
  const s = o === '1' || o === 'HOME' ? 'H' : (o === '2' || o === 'AWAY' ? 'A' : o);
  if (s !== 'H' && s !== 'A') return { outcome: 'invalid', payoutFactor: 0 };
  if (homeGoals === awayGoals) return { outcome: 'push', payoutFactor: 1 };
  const wins = s === 'H' ? homeGoals > awayGoals : awayGoals > homeGoals;
  return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0 };
}

function settleBttsNo(homeGoals, awayGoals) {
  const wins = homeGoals === 0 || awayGoals === 0;
  return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0 };
}

function settleCorner1x2(homeCorners, awayCorners, side) {
  return settle1x2(homeCorners, awayCorners, side);
}

function settleAsianHandicap(homeGoals, awayGoals, hcp, side) {
  const o = String(side || '').toUpperCase();
  const s = o === '1' || o === 'HOME' ? 'H' : (o === '2' || o === 'AWAY' ? 'A' : o);
  if (s !== 'H' && s !== 'A') return { outcome: 'invalid', payoutFactor: 0 };
  return mkLib.settleAsianHandicap(homeGoals, awayGoals, Number(hcp), s);
}

// Selected team does NOT score in both halves (wins if team fails to score in 1H OR fails to score in 2H).
function settleToScoreInBothHalvesNo(teamGoals1H, teamGoals2H) {
  const scoredBoth = teamGoals1H >= 1 && teamGoals2H >= 1;
  return { outcome: !scoredBoth ? 'win' : 'loss', payoutFactor: !scoredBoth ? 1 : 0 };
}

// Highest Scoring Half — Second Half: strictly 2H total goals > 1H total goals (equality loses unless bookmaker explicitly states otherwise).
function settleHighestScoringHalfSecond(h1, a1, h2, a2, equalityWins = false) {
  const g1 = h1 + a1;
  const g2 = h2 + a2;
  const wins = equalityWins ? g2 >= g1 : g2 > g1;
  return { outcome: wins ? 'win' : 'loss', payoutFactor: wins ? 1 : 0 };
}

// -----------------------------------------------------------------------------
// EXACT CENTRAL MARKET DICTIONARY (ALL 21 APPROVED FOOTBALL MARKETS)
// -----------------------------------------------------------------------------

const APPROVED_MARKETS = Object.freeze({
  match_result_1x2: {
    id: 'match_result_1x2',
    name: '1X2',
    shortName: '1X2',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft',
    aliases: ['1x2', 'match result', 'full time result', 'match winner', 'regular time', '3 way', '3-way', 'ft result'],
    outcomes: ['H', 'X', 'A'],
    requiredParams: ['side'],
    relevantStats: ['team_form', 'home_away_form', 'h2h', 'goals_scored_conceded', 'standings', 'win_probabilities'],
    settlementRules: 'Full-time regular-time result (90 min + stoppage, excluding extra time/penalties): 1 = Home wins, X = Draw, 2 = Away wins.',
    distinctionNotes: 'Strictly separate from 1X2 (1UP), 1X2 (2UP), Corner 1X2, and Half-Time 1X2.',
    settle: settle1x2,
  },
  double_chance: {
    id: 'double_chance',
    name: 'Double Chance',
    shortName: 'Double Chance',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft',
    aliases: ['double chance', 'dc'],
    outcomes: ['1X', 'X2', '12'],
    requiredParams: ['side'],
    relevantStats: ['team_form', 'home_away_form', 'h2h', 'goals_scored_conceded', 'win_probabilities', 'draw_rate'],
    settlementRules: 'Full-time two-outcome coverage: 1X = Home or Draw, X2 = Draw or Away, 12 = Home or Away.',
    distinctionNotes: 'Strictly separate from First-Half Double Chance and Any Team To Win.',
    settle: settleDoubleChance,
  },
  match_result_1x2_1up: {
    id: 'match_result_1x2_1up',
    name: '1X2 (1UP)',
    shortName: '1X2 (1UP)',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft_early_1up',
    leadThreshold: 1,
    aliases: ['1x2 (1up)', '1x2 1up', '1x2 - 1up', '1up', '1x2 early payout 1up', '1 goal ahead early payout'],
    outcomes: ['H', 'X', 'A'],
    requiredParams: ['side'],
    relevantStats: ['goals_scored_conceded', 'scoring_first_ability', 'team_form', 'h2h', 'win_probabilities'],
    settlementRules: 'Home (1) or Away (2) wins immediately if the backed team leads by 1+ goals at any point in regular time OR wins at full time. Draw (X) settles ONLY on full-time draw.',
    distinctionNotes: 'Strictly separate from standard 1X2 and 1X2 (2UP).',
    settle: (h, a, o, ls) => settle1x2EarlyPayout(h, a, o, 1, ls),
  },
  match_result_1x2_2up: {
    id: 'match_result_1x2_2up',
    name: '1X2 (2UP)',
    shortName: '1X2 (2UP)',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft_early_2up',
    leadThreshold: 2,
    aliases: ['1x2 (2up)', '1x2 2up', '1x2 - 2up', '2up', '1x2 early payout 2up', '2 goals ahead early payout'],
    outcomes: ['H', 'X', 'A'],
    requiredParams: ['side'],
    relevantStats: ['goals_scored_conceded', 'multi_goal_margin_ability', 'team_form', 'h2h', 'win_probabilities'],
    settlementRules: 'Home (1) or Away (2) wins immediately if the backed team leads by 2+ goals at any point in regular time OR wins at full time. Draw (X) settles ONLY on full-time draw.',
    distinctionNotes: 'Strictly separate from standard 1X2 and 1X2 (1UP).',
    settle: (h, a, o, ls) => settle1x2EarlyPayout(h, a, o, 2, ls),
  },
  to_win_either_half: {
    id: 'to_win_either_half',
    name: 'To Win Either Half',
    shortName: 'Win Either Half',
    sport: 'football',
    marketFamily: 'team_specific',
    period: 'halves',
    aliases: ['to win either half', 'win either half', 'to win a half', 'to win any half', 'home to win either half', 'away to win either half'],
    outcomes: ['H', 'A'],
    requiredParams: ['teamSide'],
    relevantStats: ['first_half_goals_scored_conceded', 'second_half_goals_scored_conceded', 'first_half_win_rate', 'second_half_win_rate'],
    settlementRules: 'Selected team wins if it outscores its opponent in the 1st half (h1 > a1) OR in the 2nd half standalone (h2 > a2).',
    distinctionNotes: 'Strictly separate from To Win Both Halves, 1st Half 1X2, and 2nd Half 1X2. Requires genuine 1H/2H statistics.',
    settle: settleWinEitherHalf,
  },
  draw_no_bet: {
    id: 'draw_no_bet',
    name: 'Draw No Bet',
    shortName: 'Draw No Bet',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft',
    aliases: ['draw no bet', 'dnb', 'home/away no draw'],
    outcomes: ['H', 'A'],
    requiredParams: ['side'],
    relevantStats: ['team_form', 'home_away_form', 'h2h', 'goals_scored_conceded', 'standings', 'win_probabilities'],
    settlementRules: 'Selected team wins at full time; if the match ends in a draw, stake is refunded (push / void at odds 1.00).',
    distinctionNotes: 'Equivalent to Asian Handicap 0.0; Draw pushes rather than loses.',
    settle: settleDrawNoBet,
  },
  team_total_over_0_5: {
    id: 'team_total_over_0_5',
    name: 'Team Total Over 0.5',
    shortName: 'Team Total O0.5',
    sport: 'football',
    marketFamily: 'fixed_line',
    period: 'ft',
    fixedLine: 0.5,
    aliases: ['team total over 0.5', 'home total over 0.5', 'away total over 0.5', 'home team total over 0.5', 'away team total over 0.5'],
    outcomes: ['H:O:0.5', 'A:O:0.5'],
    requiredParams: ['teamSide', 'line', 'dir'],
    relevantStats: ['team_goals_scored_avg', 'opponent_goals_conceded_avg', 'failed_to_score_rate', 'opponent_clean_sheet_rate'],
    settlementRules: 'Selected named team scores at least 1 goal in regular time (teamGoals >= 1).',
    distinctionNotes: 'Fixed-line 0.5 Over specialization of Team Total; must identify the exact team.',
    settle: (teamGoals) => settleTeamTotal(teamGoals, 0.5, 'O'),
  },
  total_over_0_5: {
    id: 'total_over_0_5',
    name: 'Total Over 0.5',
    shortName: 'Total O0.5',
    sport: 'football',
    marketFamily: 'fixed_line',
    period: 'ft',
    fixedLine: 0.5,
    aliases: ['total over 0.5', 'over 0.5', 'over 0.5 goals'],
    outcomes: ['O:0.5'],
    requiredParams: ['line', 'dir'],
    relevantStats: ['goals_scored_conceded', 'season_over_under_rates', 'recent_match_totals', 'h2h_goals'],
    settlementRules: 'At least 1 goal scored in the full match (homeGoals + awayGoals >= 1).',
    distinctionNotes: 'Fixed-line 0.5 Over specialization of full-match Total.',
    settle: (h, a) => settleTotal(h, a, 0.5, 'O'),
  },
  total_over_1_5: {
    id: 'total_over_1_5',
    name: 'Total Over 1.5',
    shortName: 'Total O1.5',
    sport: 'football',
    marketFamily: 'fixed_line',
    period: 'ft',
    fixedLine: 1.5,
    aliases: ['total over 1.5', 'over 1.5', 'over 1.5 goals'],
    outcomes: ['O:1.5'],
    requiredParams: ['line', 'dir'],
    relevantStats: ['goals_scored_conceded', 'season_over_under_rates', 'recent_match_totals', 'h2h_goals'],
    settlementRules: 'At least 2 goals scored in the full match (homeGoals + awayGoals >= 2).',
    distinctionNotes: 'Fixed-line 1.5 Over specialization of full-match Total.',
    settle: (h, a) => settleTotal(h, a, 1.5, 'O'),
  },
  first_half_total_over_0_5: {
    id: 'first_half_total_over_0_5',
    name: 'First-Half Total Over 0.5',
    shortName: '1H Total O0.5',
    sport: 'football',
    marketFamily: 'first_half',
    period: '1h',
    fixedLine: 0.5,
    aliases: ['1st half - total', '1st half total', 'first half total', 'first-half total over 0.5', '1st half over 0.5', 'ht over 0.5'],
    outcomes: ['O:0.5'],
    requiredParams: ['line', 'dir'],
    relevantStats: ['first_half_goals_scored_conceded', 'ht_over_0_5_pct', 'first_half_scoring_splits'],
    settlementRules: 'At least 1 goal scored in the 1st half (h1 + a1 >= 1). Requires genuine 1st-half statistics.',
    distinctionNotes: 'Strictly 1st half only; never use full-time averages without 1H evidence.',
    settle: (h1, a1) => settleTotal(h1, a1, 0.5, 'O'),
  },
  second_half_total_over_0_5: {
    id: 'second_half_total_over_0_5',
    name: 'Second-Half Total Over 0.5',
    shortName: '2H Total O0.5',
    sport: 'football',
    marketFamily: 'second_half',
    period: '2h',
    fixedLine: 0.5,
    aliases: ['2nd half - total', '2nd half total', 'second half total', 'second-half total over 0.5', '2nd half over 0.5'],
    outcomes: ['O:0.5'],
    requiredParams: ['line', 'dir'],
    relevantStats: ['second_half_goals_scored_conceded', 'second_half_over_0_5_pct', 'second_half_scoring_splits'],
    settlementRules: 'At least 1 goal scored in the 2nd half (h2 + a2 >= 1). Requires genuine 2nd-half statistics.',
    distinctionNotes: 'Strictly 2nd half only; never confuse with 1st-half or full-time totals.',
    settle: (h2, a2) => settleTotal(h2, a2, 0.5, 'O'),
  },
  team_total: {
    id: 'team_total',
    name: 'Team Total',
    shortName: 'Team Total',
    sport: 'football',
    marketFamily: 'over_under_family',
    period: 'ft',
    aliases: ['team total', 'home total', 'away total', 'home team total', 'away team total', 'home team goals', 'away team goals', 'team goals'],
    outcomes: ['O', 'U'],
    requiredParams: ['teamSide', 'line', 'dir'],
    relevantStats: ['team_goals_scored_avg', 'opponent_goals_conceded_avg', 'home_away_scoring_splits', 'clean_sheet_rate', 'failed_to_score_rate'],
    settlementRules: 'Over/Under on full-time goals scored by the single named team only (Home or Away). Never combined match goals.',
    distinctionNotes: 'Strictly separate from Total (combined match goals) and period-specific team totals.',
    settle: settleTeamTotal,
  },
  total_goals: {
    id: 'total_goals',
    name: 'Total',
    shortName: 'Total',
    sport: 'football',
    marketFamily: 'over_under_family',
    period: 'ft',
    aliases: ['total', 'total goals', 'over/under', 'over under', 'goals over/under', 'match goals', 'goals total'],
    outcomes: ['O', 'U'],
    requiredParams: ['line', 'dir'],
    relevantStats: ['goals_scored_conceded', 'season_over_under_rates', 'recent_match_totals', 'h2h_goals'],
    settlementRules: 'Over/Under on combined full-time goals scored by both teams (homeGoals + awayGoals) against the displayed numeric line.',
    distinctionNotes: 'Strictly separate from Team Total, 1st/2nd Half Total, Corner Total, Card Total, and Combo Total markets.',
    settle: settleTotal,
  },
  btts_no: {
    id: 'btts_no',
    name: 'Both Teams To Score — No',
    shortName: 'BTTS No',
    sport: 'football',
    marketFamily: 'fixed_line',
    period: 'ft',
    aliases: ['both teams to score', 'btts', 'gg/ng', 'both teams to score - no', 'btts no', 'ng'],
    outcomes: ['N'],
    requiredParams: ['side'],
    relevantStats: ['btts_pct', 'clean_sheet_rate', 'failed_to_score_rate', 'goals_scored_conceded', 'h2h_btts'],
    settlementRules: 'Wins if at least one team fails to score at full time (homeGoals == 0 OR awayGoals == 0).',
    distinctionNotes: 'ONLY the No (NG) outcome is approved in this market entry; Yes (GG) is not approved here.',
    settle: settleBttsNo,
  },
  corner_1x2: {
    id: 'corner_1x2',
    name: 'Corner 1X2',
    shortName: 'Corner 1X2',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft',
    aliases: ['corner 1x2', 'corners 1x2', 'most corners', 'corner match bet', '1x2 corners', 'corners result'],
    outcomes: ['H', 'X', 'A'],
    requiredParams: ['side'],
    relevantStats: ['home_corners_avg', 'away_corners_avg', 'season_team_stats'],
    settlementRules: 'Full-time 3-way comparison of corners taken: 1 = Home more corners, X = Equal corners, 2 = Away more corners.',
    distinctionNotes: 'Requires actual per-team corner statistics; NEVER substitute goal statistics.',
    settle: settleCorner1x2,
  },
  first_half_double_chance: {
    id: 'first_half_double_chance',
    name: 'First-Half Double Chance',
    shortName: '1H Double Chance',
    sport: 'football',
    marketFamily: 'first_half',
    period: '1h',
    aliases: ['1st half - double chance', '1st half double chance', 'first half double chance', 'first-half double chance', 'ht double chance'],
    outcomes: ['1X', 'X2', '12'],
    requiredParams: ['side'],
    relevantStats: ['first_half_goals_scored_conceded', 'ht_win_pct', 'first_half_1x2_probs'],
    settlementRules: 'First-half-only two-outcome coverage (45 min + stoppage): 1X = Home or Draw at HT, X2 = Draw or Away at HT, 12 = Home or Away at HT.',
    distinctionNotes: 'Strictly 1st half only; never confuse with full-time Double Chance.',
    settle: settleDoubleChance,
  },
  asian_handicap_plus_0_5: {
    id: 'asian_handicap_plus_0_5',
    name: 'Asian Handicap +0.5',
    shortName: 'AH +0.5',
    sport: 'football',
    marketFamily: 'handicap',
    period: 'ft',
    fixedLine: 0.5,
    aliases: ['asian handicap', 'asian handicap +0.5', 'ah +0.5'],
    outcomes: ['H:+0.5', 'A:+0.5'],
    requiredParams: ['side', 'line'],
    relevantStats: ['team_form', 'home_away_form', 'goals_scored_conceded', 'win_probabilities', 'standings'],
    settlementRules: 'Selected team starts with a +0.5 goal advantage. Wins if the selected team wins OR draws at full time; loses if it loses.',
    distinctionNotes: 'No push possible; strictly +0.5 handicap.',
    settle: (h, a, side) => settleAsianHandicap(h, a, 0.5, side),
  },
  asian_handicap_plus_1: {
    id: 'asian_handicap_plus_1',
    name: 'Asian Handicap +1',
    shortName: 'AH +1',
    sport: 'football',
    marketFamily: 'handicap',
    period: 'ft',
    fixedLine: 1,
    aliases: ['asian handicap', 'asian handicap +1', 'asian handicap +1.0', 'ah +1'],
    outcomes: ['H:+1', 'A:+1'],
    requiredParams: ['side', 'line'],
    relevantStats: ['team_form', 'home_away_form', 'goals_scored_conceded', 'win_probabilities', 'standings'],
    settlementRules: 'Selected team starts with a +1.0 goal advantage. Wins on win or draw; PUSHES (stake refunded) on an exact 1-goal loss; loses on a 2+ goal defeat.',
    distinctionNotes: 'Integer Asian Handicap with push/refund on exact 1-goal loss; strictly separate from European 3-way Handicap 1:0.',
    settle: (h, a, side) => settleAsianHandicap(h, a, 1.0, side),
  },
  to_score_in_both_halves_no: {
    id: 'to_score_in_both_halves_no',
    name: 'To Score In Both Halves — No',
    shortName: 'Score Both Halves No',
    sport: 'football',
    marketFamily: 'team_specific',
    period: 'halves',
    aliases: ['to score in both halves', 'home to score in both halves', 'away to score in both halves', 'score in both halves'],
    outcomes: ['H:N', 'A:N'],
    requiredParams: ['teamSide', 'yesNo'],
    relevantStats: ['first_half_goals_scored_conceded', 'second_half_goals_scored_conceded', 'failed_to_score_rate', 'opponent_clean_sheet_rate'],
    settlementRules: 'Selected team does NOT score in both halves — wins if the team fails to score in at least one half (teamGoals1H == 0 OR teamGoals2H == 0).',
    distinctionNotes: 'Requires genuine 1H and 2H team scoring splits; ONLY the No outcome is approved.',
    settle: settleToScoreInBothHalvesNo,
  },
  highest_scoring_half_second: {
    id: 'highest_scoring_half_second',
    name: 'Highest Scoring Half — Second Half',
    shortName: 'Highest Half 2H',
    sport: 'football',
    marketFamily: 'second_half',
    period: 'halves',
    aliases: ['highest scoring half', 'highest-scoring half', 'half with most goals'],
    outcomes: ['2H'],
    requiredParams: ['side'],
    relevantStats: ['first_half_goals_scored_conceded', 'second_half_goals_scored_conceded', 'half_scoring_splits'],
    settlementRules: 'Wins strictly if more total goals are scored in the 2nd half than in the 1st half (h2 + a2 > h1 + a1). Equal goals loses unless bookmaker explicitly includes equality.',
    distinctionNotes: 'Requires genuine 1H and 2H scoring rates; never assume equality wins.',
    settle: settleHighestScoringHalfSecond,
  },
  any_team_to_win: {
    id: 'any_team_to_win',
    name: 'Any Team To Win',
    shortName: 'Any Team To Win',
    sport: 'football',
    marketFamily: 'result',
    period: 'ft',
    aliases: ['any team to win', 'either team to win', 'match not a draw'],
    outcomes: ['12', 'Y', 'N'],
    requiredParams: ['side'],
    relevantStats: ['draw_rate', 'team_form', 'h2h_draw_rate', 'win_probabilities', 'goals_scored_conceded'],
    settlementRules: '12 / Yes wins if either Home or Away wins at full time (a draw loses). No wins if the match ends in a full-time draw.',
    distinctionNotes: 'Strictly separate market heading and booking identity from Double Chance (12).',
    settle: settleAnyTeamToWin,
  },
});

function isApprovedMarketId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(APPROVED_MARKETS, id);
}

function getApprovedMarket(id) {
  return isApprovedMarketId(id) ? APPROVED_MARKETS[id] : null;
}

function listApprovedMarkets() {
  return APPROVED_MARKET_IDS.map((id) => APPROVED_MARKETS[id]);
}

// -----------------------------------------------------------------------------
// DYNAMIC LIVE MARKET MATCHING (USED BY RESEARCH, AI ANALYST, AND BOOKING)
// -----------------------------------------------------------------------------

const CLUB_STOP_WORDS = new Set([
  'fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'bk', 'nk', 'hnk', 'pfc', 'rsc', 'tsg',
  'rc', 'cs', 'vv', 'sv', 'cd', 'ud', 'sd', 'ca', 'ac', 'as', 'ss', 'us', 'cp',
  'if', 'srl', 'ofi', 'club', 'the', 'de', 'la', 'le', 'el', 'al', 'st', 'united', 'city',
]);

function coreTeamTokens(name) {
  return norm(name)
    .split(' ')
    .filter((w) => w.length >= 3 && !CLUB_STOP_WORDS.has(w));
}

function detectTeamSideInText(rawText, ev) {
  const t = norm(rawText);
  if (!t) return '';
  if (/^(1|home|home team)$/.test(t) || /\bhome\b/.test(t)) return 'H';
  if (/^(2|away|away team)$/.test(t) || /\baway\b/.test(t)) return 'A';
  if (/^(x|draw|tie)$/.test(t)) return 'X';

  const homeName = (ev && ev.home) || '';
  const awayName = (ev && ev.away) || '';
  const nh = norm(homeName);
  const na = norm(awayName);

  const matchHomeFull = homeName && (sameTeam(rawText, homeName) || (nh.length >= 4 && t.includes(nh)));
  const matchAwayFull = awayName && (sameTeam(rawText, awayName) || (na.length >= 4 && t.includes(na)));
  if (matchHomeFull && !matchAwayFull) return 'H';
  if (matchAwayFull && !matchHomeFull) return 'A';

  const hToks = coreTeamTokens(homeName);
  const aToks = coreTeamTokens(awayName);
  const hHits = hToks.filter((w) => t.split(' ').includes(w) || (w.length >= 4 && t.includes(w))).length;
  const aHits = aToks.filter((w) => t.split(' ').includes(w) || (w.length >= 4 && t.includes(w))).length;
  if (hHits > 0 && aHits === 0) return 'H';
  if (aHits > 0 && hHits === 0) return 'A';
  if (hHits > aHits && hHits >= 1) return 'H';
  if (aHits > hHits && aHits >= 1) return 'A';
  return '';
}

function parseDoubleChanceSide(rawLabel, ev) {
  const l = norm(rawLabel);
  const compact = l.replace(/\s+/g, '');
  if (!compact) return '';
  if (compact === '1x' || compact === 'homeordraw' || compact === '1ordraw' || compact === '1orx' || compact === 'draworhome') return '1X';
  if (compact === 'x2' || compact === 'draworaway' || compact === 'drawor2' || compact === 'xor2' || compact === 'awayordraw') return 'X2';
  if (compact === '12' || compact === 'homeoraway' || compact === '1or2' || compact === 'awayorhome') return '12';
  if (/\bor\b/.test(l)) {
    const parts = l.split(/\bor\b/).map((s) => s.trim());
    if (parts.length === 2) {
      const p0 = detectTeamSideInText(parts[0], ev);
      const p1 = detectTeamSideInText(parts[1], ev);
      const pair = new Set([p0, p1]);
      if (pair.has('H') && pair.has('X')) return '1X';
      if (pair.has('A') && pair.has('X')) return 'X2';
      if (pair.has('H') && pair.has('A')) return '12';
    }
  }
  return '';
}

function parseOverUnderParams(rawTitle, rawLabel) {
  const titleL = String(rawTitle || '').toLowerCase();
  const labelL = String(rawLabel || '').toLowerCase();
  const ouLabel = /\b(over|under)\s*(\d+(?:\.\d+)?)\b/.exec(labelL);
  const dirOnly = /\b(over|under)\b/.exec(labelL);
  const titleLine = dirOnly ? /\b(\d+(?:\.\d+)?)\b/.exec(titleL) : null;
  const line = ouLabel ? parseFloat(ouLabel[2]) : (titleLine ? parseFloat(titleLine[1]) : null);
  const dirWord = ouLabel ? ouLabel[1] : (dirOnly ? dirOnly[1] : '');
  if (line == null || !Number.isFinite(line) || !dirWord) return null;
  return { dir: dirWord === 'over' ? 'O' : 'U', line };
}

const NON_APPROVED_PERIOD_RE = /\b(quarter|period|inning|set|10 mins?|15 mins?|30 mins?|60 mins?|75 mins?|minutes?|interval|from \d+ to \d+|rest of match|extra time|overtime|penalties|ht ft|half time full time)\b/;
const HALF_RE = /\b(1st half|first half|2nd half|second half|half time|halftime|ht|1h|2h)\b/;
const EXCLUDED_ALWAYS_RE = /\b(clean sheet|win to nil|correct score|exact score|exact goals|exact bookings?|exact|odd even|odd\/even|winning margin|first goal|last goal|first team|last team|multi|range|player|scorer|goalscorer|anytime|cards?|bookings?|yellow|red|sending off|shots?|offsides?|fouls?|freekicks?|penalt(?:y|ies)|qualify|shootout|method|var|substitute|3up|or over|or under|to win both halves)\b/;

function matchApprovedMarket(title, label, ev = {}) {
  const rawTitle = String(title || '').trim();
  const rawLabel = String(label || '').trim();
  const t = norm(rawTitle);
  const l = norm(rawLabel);

  if (!t || !l) {
    return { approved: false, reason: 'empty_market_or_outcome', rawTitle, rawLabel };
  }

  // Always reject non-approved period/interval/prop/combo markets
  if (NON_APPROVED_PERIOD_RE.test(t) || EXCLUDED_ALWAYS_RE.test(t) || /[&]/.test(rawTitle)) {
    return { approved: false, reason: 'unapproved_market_type', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 5 — TO WIN EITHER HALF
  // ---------------------------------------------------------------------------
  if (/\b(to win either half|win either half|to win a half|to win any half)\b/.test(t) && !/\bboth halves\b/.test(t)) {
    const titleTeam = detectTeamSideInText(rawTitle, ev);
    if ((titleTeam === 'H' || titleTeam === 'A') && /^(yes|no)$/.test(l)) {
      const yn = l === 'yes' ? 'Y' : 'N';
      return {
        approved: true,
        approvedMarketId: 'to_win_either_half',
        marketName: APPROVED_MARKETS.to_win_either_half.name,
        period: 'halves',
        teamSide: titleTeam,
        side: titleTeam,
        yesNo: yn,
        canonicalOutcome: `${titleTeam}:${yn}`,
      };
    }
    const labelNo = /\bno\b/.test(l);
    const strippedLabel = rawLabel.replace(/\b(yes|no)\b/gi, '').trim();
    const side = detectTeamSideInText(strippedLabel || rawLabel, ev);
    if (side === 'H' || side === 'A') {
      const yn = labelNo ? 'N' : 'Y';
      return {
        approved: true,
        approvedMarketId: 'to_win_either_half',
        marketName: APPROVED_MARKETS.to_win_either_half.name,
        period: 'halves',
        teamSide: side,
        side,
        yesNo: yn,
        canonicalOutcome: `${side}:${yn}`,
      };
    }
    return { approved: false, reason: 'unrecognized_win_either_half_outcome', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 19 — TO SCORE IN BOTH HALVES — NO
  // ---------------------------------------------------------------------------
  if (/\bto score in both halves\b|\bscore in both halves\b/.test(t)) {
    const titleTeam = detectTeamSideInText(rawTitle, ev);
    const isNo = l === 'no' || /\bno\b/.test(l);
    if (!isNo) return { approved: false, reason: 'only_to_score_in_both_halves_no_approved', rawTitle, rawLabel };
    const side = (titleTeam === 'H' || titleTeam === 'A')
      ? titleTeam
      : detectTeamSideInText(rawLabel.replace(/\b(yes|no)\b/gi, '').trim(), ev);
    if (side === 'H' || side === 'A') {
      return {
        approved: true,
        approvedMarketId: 'to_score_in_both_halves_no',
        marketName: APPROVED_MARKETS.to_score_in_both_halves_no.name,
        period: 'halves',
        teamSide: side,
        side,
        yesNo: 'N',
        canonicalOutcome: `${side}:N`,
      };
    }
    return { approved: false, reason: 'unrecognized_score_both_halves_team', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 20 — HIGHEST SCORING HALF — SECOND HALF
  // ---------------------------------------------------------------------------
  if (/\bhighest scoring half\b|\bhalf with most goals\b/.test(t)) {
    if (/\b(2nd half|second half|2nd|2h)\b/.test(l) && !/\b(draw|equal|tie|1st|first)\b/.test(l)) {
      return {
        approved: true,
        approvedMarketId: 'highest_scoring_half_second',
        marketName: APPROVED_MARKETS.highest_scoring_half_second.name,
        period: 'halves',
        side: '2H',
        canonicalOutcome: '2H',
      };
    }
    return { approved: false, reason: 'only_second_half_highest_scoring_approved', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 16 — FIRST-HALF DOUBLE CHANCE
  // ---------------------------------------------------------------------------
  if (/\b(1st half|first half|half time|halftime|1h|ht)\b/.test(t) && /\bdouble chance\b/.test(t)) {
    if (/\b(over|under|total)\b/.test(t) || /\b(over|under)\b/.test(l)) {
      return { approved: false, reason: 'unapproved_1h_dc_combo', rawTitle, rawLabel };
    }
    const side = parseDoubleChanceSide(rawLabel, ev);
    if (side === '1X' || side === 'X2' || side === '12') {
      return {
        approved: true,
        approvedMarketId: 'first_half_double_chance',
        marketName: APPROVED_MARKETS.first_half_double_chance.name,
        period: '1h',
        side,
        canonicalOutcome: `1H:${side}`,
      };
    }
    return { approved: false, reason: 'unrecognized_1h_dc_outcome', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 10 — FIRST-HALF TOTAL OVER 0.5 & MARKET 11 — SECOND-HALF TOTAL OVER 0.5
  // ---------------------------------------------------------------------------
  const is1H = /\b(1st half|first half|half time|halftime|1h|ht)\b/.test(t);
  const is2H = /\b(2nd half|second half|2h)\b/.test(t);
  if ((is1H || is2H) && /\b(total|over under|goals)\b/.test(t) && !/\b(corners?|cards?|bookings?|shots?|team|home|away)\b/.test(t)) {
    const ou = parseOverUnderParams(rawTitle, rawLabel);
    if (ou && ou.dir === 'O' && Math.abs(ou.line - 0.5) < 0.001) {
      const id = is1H ? 'first_half_total_over_0_5' : 'second_half_total_over_0_5';
      return {
        approved: true,
        approvedMarketId: id,
        marketName: APPROVED_MARKETS[id].name,
        period: is1H ? '1h' : '2h',
        dir: 'O',
        side: 'O',
        line: 0.5,
        canonicalOutcome: `${is1H ? '1H' : '2H'}:O:0.5`,
      };
    }
    return { approved: false, reason: 'unapproved_half_total_line', rawTitle, rawLabel };
  }

  // Reject any other half/period market (e.g. 1st half 1X2, 2nd half 1X2, 1st half BTTS)
  if (HALF_RE.test(t)) {
    return { approved: false, reason: 'unapproved_period_market', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 17 — ASIAN HANDICAP +0.5 & MARKET 18 — ASIAN HANDICAP +1
  // ---------------------------------------------------------------------------
  if (/\basian handicap\b/.test(t)) {
    // Reject colon European 3-way handicap syntax
    if (/\d+\s*:\s*\d+/.test(rawTitle) || /\d+\s*:\s*\d+/.test(rawLabel)) {
      return { approved: false, reason: 'unapproved_european_handicap', rawTitle, rawLabel };
    }
    const ahMatch = /\(\s*([+-]?\d+(?:\.\d+)?)\s*\)|([+-]\d+(?:\.\d+)?)|(?:^|\s)(0\.5|1(?:\.0)?)(?:\s|$)/.exec(rawLabel) ||
      /\(\s*([+-]?\d+(?:\.\d+)?)\s*\)|([+-]\d+(?:\.\d+)?)/.exec(rawTitle);
    const rawNum = ahMatch ? (ahMatch[1] != null ? ahMatch[1] : (ahMatch[2] != null ? ahMatch[2] : ahMatch[3])) : null;
    const val = rawNum != null ? parseFloat(rawNum) : null;
    const stripped = rawLabel.replace(/\([^)]*\)/g, ' ').replace(/[+-]?\d+(?:\.\d+)?/g, ' ').trim();
    const side = detectTeamSideInText(stripped, ev);
    if ((side === 'H' || side === 'A') && val != null && Number.isFinite(val)) {
      if (Math.abs(val - 0.5) < 0.001) {
        return {
          approved: true,
          approvedMarketId: 'asian_handicap_plus_0_5',
          marketName: APPROVED_MARKETS.asian_handicap_plus_0_5.name,
          period: 'ft',
          side,
          hcp: 0.5,
          line: 0.5,
          canonicalOutcome: `${side}:+0.5`,
        };
      }
      if (Math.abs(val - 1.0) < 0.001) {
        return {
          approved: true,
          approvedMarketId: 'asian_handicap_plus_1',
          marketName: APPROVED_MARKETS.asian_handicap_plus_1.name,
          period: 'ft',
          side,
          hcp: 1.0,
          line: 1.0,
          canonicalOutcome: `${side}:+1`,
        };
      }
    }
    return { approved: false, reason: 'unapproved_asian_handicap_line', rawTitle, rawLabel };
  }

  // Reject non-Asian handicaps / spreads (e.g. European 3-way Handicap 0:2)
  if (/\b(handicap|spread)\b/.test(t)) {
    return { approved: false, reason: 'unapproved_handicap_market', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 14 — BOTH TEAMS TO SCORE — NO (strictly No/NG only)
  // ---------------------------------------------------------------------------
  if (/\b(both teams to score|both teams score|btts|gg ng|gg\/ng)\b/.test(t)) {
    if (/\b(1x2|result|winner|double chance|over|under|total)\b/.test(t)) {
      return { approved: false, reason: 'unapproved_btts_combo', rawTitle, rawLabel };
    }
    if (/^(no|ng)$/.test(l)) {
      return {
        approved: true,
        approvedMarketId: 'btts_no',
        marketName: APPROVED_MARKETS.btts_no.name,
        period: 'ft',
        side: 'N',
        yesNo: 'N',
        canonicalOutcome: 'N',
      };
    }
    return { approved: false, reason: 'only_btts_no_approved', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 6 — DRAW NO BET
  // ---------------------------------------------------------------------------
  if (/\b(draw no bet|dnb)\b/.test(t)) {
    const side = detectTeamSideInText(rawLabel, ev);
    if (side === 'H' || side === 'A') {
      return {
        approved: true,
        approvedMarketId: 'draw_no_bet',
        marketName: APPROVED_MARKETS.draw_no_bet.name,
        period: 'ft',
        side,
        canonicalOutcome: side,
      };
    }
    return { approved: false, reason: 'unrecognized_dnb_outcome', rawTitle, rawLabel };
  }

  // Reject any remaining combo '+' headings (after AH +0.5 / +1 have been handled)
  if (/\+/.test(rawTitle)) {
    return { approved: false, reason: 'unapproved_combo_market', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 15 — CORNER 1X2
  // ---------------------------------------------------------------------------
  if (/\bcorners?\b/.test(t)) {
    if (/\b(total|over|under|race|first|last|odd|even|exact|range)\b/.test(t) || /\b(over|under)\b/.test(l)) {
      return { approved: false, reason: 'unapproved_corner_market', rawTitle, rawLabel };
    }
    if (/\b(1x2|most|winner|result|match bet)\b/.test(t)) {
      const side = detectTeamSideInText(rawLabel, ev);
      if (side === 'H' || side === 'X' || side === 'A') {
        return {
          approved: true,
          approvedMarketId: 'corner_1x2',
          marketName: APPROVED_MARKETS.corner_1x2.name,
          period: 'ft',
          side,
          canonicalOutcome: side,
        };
      }
    }
    return { approved: false, reason: 'unapproved_corner_market', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 21 — ANY TEAM TO WIN
  // ---------------------------------------------------------------------------
  if (/\b(any team to win|either team to win|match not a draw)\b/.test(t)) {
    const compact = l.replace(/\s+/g, '');
    if (compact === '12' || compact === 'homeoraway' || compact === '1or2' || compact === 'either' || compact === 'yes') {
      return {
        approved: true,
        approvedMarketId: 'any_team_to_win',
        marketName: APPROVED_MARKETS.any_team_to_win.name,
        period: 'ft',
        side: '12',
        canonicalOutcome: '12',
      };
    }
    if (compact === 'no' || compact === 'draw' || compact === 'x') {
      return {
        approved: true,
        approvedMarketId: 'any_team_to_win',
        marketName: APPROVED_MARKETS.any_team_to_win.name,
        period: 'ft',
        side: 'N',
        canonicalOutcome: 'N',
      };
    }
    return { approved: false, reason: 'unrecognized_any_team_to_win_outcome', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 3 — 1X2 (1UP) & MARKET 4 — 1X2 (2UP)
  // ---------------------------------------------------------------------------
  const is1Up = /\b1\s*up\b/.test(t) || /\b1\s*goal\s*ahead\b/.test(t);
  const is2Up = /\b2\s*up\b/.test(t) || /\b2\s*goals?\s*ahead\b/.test(t);
  if (is1Up || is2Up) {
    if (/\b(double chance|total|over|under)\b/.test(t)) {
      return { approved: false, reason: 'unapproved_early_payout_variant', rawTitle, rawLabel };
    }
    const side = detectTeamSideInText(rawLabel, ev);
    if (side === 'H' || side === 'X' || side === 'A') {
      const id = is1Up ? 'match_result_1x2_1up' : 'match_result_1x2_2up';
      return {
        approved: true,
        approvedMarketId: id,
        marketName: APPROVED_MARKETS[id].name,
        period: APPROVED_MARKETS[id].period,
        leadThreshold: is1Up ? 1 : 2,
        side,
        canonicalOutcome: side,
      };
    }
    return { approved: false, reason: 'unrecognized_early_payout_outcome', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 2 — DOUBLE CHANCE (FT)
  // ---------------------------------------------------------------------------
  if (/\bdouble chance\b/.test(t) || t === 'dc') {
    if (/\b(over|under|total)\b/.test(t) || /\b(over|under)\b/.test(l)) {
      return { approved: false, reason: 'unapproved_dc_combo', rawTitle, rawLabel };
    }
    const side = parseDoubleChanceSide(rawLabel, ev);
    if (side === '1X' || side === 'X2' || side === '12') {
      return {
        approved: true,
        approvedMarketId: 'double_chance',
        marketName: APPROVED_MARKETS.double_chance.name,
        period: 'ft',
        side,
        canonicalOutcome: side,
      };
    }
    return { approved: false, reason: 'unrecognized_double_chance_outcome', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKETS 7, 8, 9, 12, 13 — TEAM TOTAL (+ O0.5) & TOTAL (+ O0.5, O1.5)
  // ---------------------------------------------------------------------------
  const ou = parseOverUnderParams(rawTitle, rawLabel);
  if (ou && !/\b(1x2|result|winner|double chance|to win|to score)\b/.test(t)) {
    const isTotalHeading = /\b(total|goals|over under)\b/.test(t) &&
      !/\b(corners?|cards?|bookings?|shots?|fouls?|offsides?|throws?|points?|penalt(?:y|ies))\b/.test(t);
    const titleTeam = detectTeamSideInText(rawTitle, ev);
    const labelWithoutOu = rawLabel.replace(/\b(over|under)\s*\d*(?:\.\d+)?/gi, '').trim();
    const labelTeam = labelWithoutOu ? detectTeamSideInText(labelWithoutOu, ev) : '';
    const explicitTeamPhrase = /\b(team total|team goals|home total|away total|home team|away team|total home|total away)\b/.test(t);
    const resolvedTeam = isTotalHeading && (titleTeam === 'H' || titleTeam === 'A')
      ? titleTeam
      : ((explicitTeamPhrase || /^(total|total goals|goals total|over under)$/.test(t)) && (labelTeam === 'H' || labelTeam === 'A') ? labelTeam : '');
    if (resolvedTeam === 'H' || resolvedTeam === 'A') {
      const isTeamO05 = ou.dir === 'O' && Math.abs(ou.line - 0.5) < 0.001;
      const id = isTeamO05 ? 'team_total_over_0_5' : 'team_total';
      return {
        approved: true,
        approvedMarketId: id,
        familyId: 'team_total',
        marketName: APPROVED_MARKETS[id].name,
        period: 'ft',
        teamSide: resolvedTeam,
        dir: ou.dir,
        side: ou.dir,
        line: ou.line,
        canonicalOutcome: `${resolvedTeam}:${ou.dir}:${ou.line}`,
      };
    }
    if (explicitTeamPhrase) {
      return { approved: false, reason: 'ambiguous_team_total_side', rawTitle, rawLabel };
    }
    if (/^(total|total goals|goals total|match goals|over under|goals over under|goals)$/.test(t) ||
        (/\b(total|over under)\b/.test(t) && !/\b(corners?|cards?|bookings?|shots?|fouls?|offsides?|throws?|points?)\b/.test(t))) {
      let id = 'total_goals';
      if (ou.dir === 'O' && Math.abs(ou.line - 0.5) < 0.001) id = 'total_over_0_5';
      else if (ou.dir === 'O' && Math.abs(ou.line - 1.5) < 0.001) id = 'total_over_1_5';
      return {
        approved: true,
        approvedMarketId: id,
        familyId: 'total_goals',
        marketName: APPROVED_MARKETS[id].name,
        period: 'ft',
        dir: ou.dir,
        side: ou.dir,
        line: ou.line,
        canonicalOutcome: `${ou.dir}:${ou.line}`,
      };
    }
    return { approved: false, reason: 'unapproved_total_market', rawTitle, rawLabel };
  }

  // ---------------------------------------------------------------------------
  // MARKET 1 — 1X2 (standard full-time result only)
  // ---------------------------------------------------------------------------
  if (/^(1x2|match result|full time result|match winner|regular time|3 way|ft result|result|winner|full time)$/.test(t) ||
      (/\b(1x2|match result|full time result|match winner)\b/.test(t) && !/\b(over|under|total|early|up|corner)\b/.test(t))) {
    const side = detectTeamSideInText(rawLabel, ev);
    if (side === 'H' || side === 'X' || side === 'A') {
      return {
        approved: true,
        approvedMarketId: 'match_result_1x2',
        marketName: APPROVED_MARKETS.match_result_1x2.name,
        period: 'ft',
        side,
        canonicalOutcome: side,
      };
    }
    return { approved: false, reason: 'unrecognized_1x2_outcome', rawTitle, rawLabel };
  }

  return { approved: false, reason: 'unapproved_market_type', rawTitle, rawLabel };
}

function compatibleMarketIds(idA, idB) {
  if (idA === idB) return true;
  if ((idA === 'total_goals' && (idB === 'total_over_0_5' || idB === 'total_over_1_5')) ||
      (idB === 'total_goals' && (idA === 'total_over_0_5' || idA === 'total_over_1_5'))) return true;
  if ((idA === 'team_total' && idB === 'team_total_over_0_5') ||
      (idB === 'team_total' && idA === 'team_total_over_0_5')) return true;
  return false;
}

function findMatchingLiveMarket(liveMarkets, leg) {
  if (!Array.isArray(liveMarkets) || !liveMarkets.length || !leg) return null;
  const ev = { home: leg.home, away: leg.away };
  const legMatched = leg.approvedMarketId
    ? {
        approved: true,
        approvedMarketId: leg.approvedMarketId,
        side: leg.side || '',
        teamSide: leg.teamSide || '',
        dir: leg.dir || '',
        line: leg.line != null ? Number(leg.line) : null,
        canonicalOutcome: leg.canonicalOutcome || '',
      }
    : matchApprovedMarket(leg.market, leg.outcome, ev);

  if (!legMatched || !legMatched.approved || !isApprovedMarketId(legMatched.approvedMarketId)) {
    return null;
  }

  const same = (a, b) => norm(a) === norm(b);

  const exactMatches = liveMarkets.filter((x) => {
    if (!same(x.title, leg.market) || !same(x.label, leg.outcome)) return false;
    const xm = matchApprovedMarket(x.title, x.label, ev);
    if (!xm.approved || !compatibleMarketIds(xm.approvedMarketId, legMatched.approvedMarketId)) return false;
    if (legMatched.canonicalOutcome && xm.canonicalOutcome && xm.canonicalOutcome !== legMatched.canonicalOutcome) return false;
    return true;
  });
  const clickableExact = exactMatches.find((x) => x.i >= 0);
  if (clickableExact) return clickableExact;
  if (exactMatches.length) return exactMatches[0];

  if (!legMatched.canonicalOutcome) return null;
  const canonicalMatches = liveMarkets.filter((x) => {
    const xm = matchApprovedMarket(x.title, x.label, ev);
    if (!xm.approved) return false;
    if (!compatibleMarketIds(xm.approvedMarketId, legMatched.approvedMarketId)) return false;
    if (xm.canonicalOutcome !== legMatched.canonicalOutcome) return false;
    if (legMatched.line != null && xm.line !== legMatched.line) return false;
    if (legMatched.teamSide && xm.teamSide !== legMatched.teamSide) return false;
    return true;
  });
  const clickableCanonical = canonicalMatches.find((x) => x.i >= 0);
  return clickableCanonical || canonicalMatches[0] || null;
}

function slipOutcomeSynonymsForLeg(leg, normalizeSlipText) {
  const normFn = typeof normalizeSlipText === 'function' ? normalizeSlipText : norm;
  const out = new Set();
  const raw = normFn(leg.outcome || '');
  if (raw) out.add(raw);

  const m = leg.approvedMarketId
    ? {
        approved: true,
        approvedMarketId: leg.approvedMarketId,
        side: leg.side || '',
        teamSide: leg.teamSide || '',
        dir: leg.dir || '',
        yesNo: leg.yesNo || '',
        line: leg.line != null ? Number(leg.line) : null,
      }
    : matchApprovedMarket(leg.market, leg.outcome, { home: leg.home, away: leg.away });

  if (!m || !m.approved) return [...out];

  if (m.approvedMarketId === 'double_chance' || m.approvedMarketId === 'first_half_double_chance') {
    const map = {
      '1X': ['1 x', 'home or draw', 'homeordraw', '1 or draw', '1 or x'],
      'X2': ['x 2', 'draw or away', 'draworaway', 'draw or 2', 'x or 2'],
      '12': ['1 2', 'home or away', 'homeoraway', '1 or 2'],
    };
    for (const s of (map[m.side] || [])) out.add(s);
    if (m.side === '1X' && leg.home) out.add(normFn(`${leg.home} or draw`));
    if (m.side === 'X2' && leg.away) out.add(normFn(`draw or ${leg.away}`));
    if (m.side === '12' && leg.home && leg.away) out.add(normFn(`${leg.home} or ${leg.away}`));
  } else if (
    m.approvedMarketId === 'match_result_1x2' ||
    m.approvedMarketId === 'match_result_1x2_1up' ||
    m.approvedMarketId === 'match_result_1x2_2up' ||
    m.approvedMarketId === 'corner_1x2' ||
    m.approvedMarketId === 'draw_no_bet'
  ) {
    if (m.side === 'H') {
      out.add('1');
      out.add('home');
      if (leg.home) out.add(normFn(leg.home));
    } else if (m.side === 'X') {
      out.add('x');
      out.add('draw');
    } else if (m.side === 'A') {
      out.add('2');
      out.add('away');
      if (leg.away) out.add(normFn(leg.away));
    }
  } else if (
    m.approvedMarketId === 'total_goals' ||
    m.approvedMarketId === 'total_over_0_5' ||
    m.approvedMarketId === 'total_over_1_5' ||
    m.approvedMarketId === 'first_half_total_over_0_5' ||
    m.approvedMarketId === 'second_half_total_over_0_5' ||
    m.approvedMarketId === 'team_total' ||
    m.approvedMarketId === 'team_total_over_0_5'
  ) {
    if (m.line != null && (m.dir === 'O' || m.dir === 'U')) {
      const word = m.dir === 'O' ? 'over' : 'under';
      out.add(`${word} ${m.line}`);
    }
  } else if (m.approvedMarketId === 'btts_no') {
    out.add('no');
    out.add('ng');
  } else if (m.approvedMarketId === 'asian_handicap_plus_0_5' || m.approvedMarketId === 'asian_handicap_plus_1') {
    const lineStr = m.approvedMarketId === 'asian_handicap_plus_0_5' ? '0.5' : '1';
    if (m.side === 'H') {
      out.add(`home ${lineStr}`);
      if (leg.home) out.add(normFn(`${leg.home} ${lineStr}`));
    } else if (m.side === 'A') {
      out.add(`away ${lineStr}`);
      if (leg.away) out.add(normFn(`${leg.away} ${lineStr}`));
    }
  } else if (m.approvedMarketId === 'to_win_either_half' || m.approvedMarketId === 'to_score_in_both_halves_no') {
    if (m.teamSide === 'H') {
      out.add('home');
      if (leg.home) out.add(normFn(leg.home));
      if (m.yesNo === 'Y') out.add('yes');
      if (m.yesNo === 'N') out.add('no');
    } else if (m.teamSide === 'A') {
      out.add('away');
      if (leg.away) out.add(normFn(leg.away));
      if (m.yesNo === 'Y') out.add('yes');
      if (m.yesNo === 'N') out.add('no');
    }
  } else if (m.approvedMarketId === 'highest_scoring_half_second') {
    out.add('2nd half');
    out.add('second half');
    out.add('2 nd half');
  } else if (m.approvedMarketId === 'any_team_to_win') {
    if (m.side === '12' || m.side === 'Y') {
      out.add('yes');
      out.add('1 2');
      out.add('12');
      out.add('home or away');
      out.add('homeoraway');
    }
    if (m.side === 'N') out.add('no');
  }

  return [...out].filter(Boolean);
}

function matchesApprovedFilter(cand, filters) {
  if (!Array.isArray(filters) || !filters.length) return true;
  const cid = cand.approvedMarketId || '';
  const def = getApprovedMarket(cid);
  const candMarketNorm = norm(cand.market || '');
  const candNameNorm = def ? norm(def.name) : '';
  const aliases = def ? def.aliases.map((a) => norm(a)) : [];

  for (const rawF of filters) {
    const f = norm(rawF);
    if (!f) continue;
    if (cid && norm(cid) === f) return true;
    if (candNameNorm && candNameNorm === f) return true;
    if (aliases.some((a) => a === f || a.includes(f) || f.includes(a))) return true;
    if (candMarketNorm && (candMarketNorm === f || candMarketNorm.includes(f))) return true;
  }
  return false;
}

module.exports = {
  APPROVED_MARKET_IDS,
  APPROVED_MARKETS,
  isApprovedMarketId,
  getApprovedMarket,
  listApprovedMarkets,
  matchApprovedMarket,
  findMatchingLiveMarket,
  slipOutcomeSynonymsForLeg,
  matchesApprovedFilter,
  detectTeamSideInText,
  parseDoubleChanceSide,
  parseOverUnderParams,
  settle1x2,
  settleTeamTotal,
  settleWinEitherHalf,
  settleAnyTeamToWin,
  settle1x2EarlyPayout,
  settleTotal,
  settleDoubleChance,
  settleDrawNoBet,
  settleBttsNo,
  settleCorner1x2,
  settleAsianHandicap,
  settleToScoreInBothHalvesNo,
  settleHighestScoringHalfSecond,
};
