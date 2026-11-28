'use strict';
// Comprehensive Football & Sports Market Knowledge Library.
// This is a semantic knowledge reference catalogue — NOT a fixed selection shortlist.
// It defines market meaning, outcome structure, handicap/line mechanics, settlement rules,
// required statistical inputs, unevaluable conditions, and common interpretation traps,
// plus deterministic settlement math for Asian (half/integer/quarter) & European 3-way handicaps.

const { norm } = require('./util');

const MARKET_CATALOG = {
  match_result_1x2: {
    id: 'match_result_1x2',
    name: 'Match Result (1X2)',
    aliases: ['1x2', 'match result', 'full time result', 'match winner', 'moneyline', 'regular time', 'winner'],
    category: 'result',
    plainMeaning: 'Predicts whether the home team wins (1), the match ends in a draw (X), or the away team wins (2) at the end of regulation time.',
    possibleOutcomes: ['1 (Home)', 'X (Draw)', '2 (Away)'],
    lineMechanics: 'No goal line or handicap adjustment. Regulation time (90 min + stoppage time) only; excludes extra time and penalties.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: '1 wins if Home > Away; X wins if Home == Away; 2 wins if Away > Home.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'standings', 'headToHead', 'winProbabilities'],
    requiredStats: ['outcome1x2 or scoring averages or winProbabilities'],
    unevaluableWhen: ['Period is 1H/2H without period-specific scoring/result data', 'Early payout (1UP/2UP) rules when early-lead probability is unmodelled'],
    commonErrors: ['Treating 1X2 as including extra time/penalties in cup knockouts', 'Confusing 2-way Moneyline (no draw) with 3-way 1X2'],
    examples: {
      valid: ['1X2 -> Home (1)', '1X2 -> Draw (X)', '1X2 -> Away (2)'],
      invalid: ['1X2 - 2UP -> Home (early-payout rule differs from standard 1X2)'],
    },
  },

  double_chance: {
    id: 'double_chance',
    name: 'Double Chance',
    aliases: ['double chance', 'dc', '1x', 'x2', '12'],
    category: 'result',
    plainMeaning: 'Covers two of the three regulation-time outcomes simultaneously: Home or Draw (1X), Draw or Away (X2), or Either Team to Win (12).',
    possibleOutcomes: ['1X (Home or Draw)', 'X2 (Draw or Away)', '12 (Home or Away)'],
    lineMechanics: 'Two-outcome union of 1X2 in regulation time. No handicap line.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: '1X wins if Home >= Away; X2 wins if Away >= Home; 12 wins if Home != Away.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'standings', 'headToHead', 'winProbabilities'],
    requiredStats: ['outcome1x2'],
    unevaluableWhen: ['Period is 1H/2H without half-time 1X2 distribution'],
    commonErrors: ['Treating Double Chance 1X as identical to Asian Handicap +0.5 on 1H without half stats'],
    examples: {
      valid: ['Double Chance -> 1X', 'Double Chance -> X2', 'Double Chance -> 12'],
      invalid: ['Double Chance -> Draw (Draw alone is 1X2, not Double Chance)'],
    },
  },

  draw_no_bet: {
    id: 'draw_no_bet',
    name: 'Draw No Bet (DNB)',
    aliases: ['draw no bet', 'dnb', 'home/away no draw'],
    category: 'result',
    plainMeaning: 'Backs either Home or Away to win; if the match finishes in a draw, the selection pushes (void/refund at odds 1.00).',
    possibleOutcomes: ['Home (DNB)', 'Away (DNB)'],
    lineMechanics: 'Equivalent to Asian Handicap 0.0 (level ball). Draw removes the leg (void).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Home wins if Home > Away; Away wins if Away > Home; Draw = push/void.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'standings', 'headToHead', 'winProbabilities'],
    requiredStats: ['outcome1x2 with non-zero decisive mass'],
    unevaluableWhen: ['Period is 1H/2H without period-specific win/draw rates'],
    commonErrors: ['Using raw P(Home) instead of conditional P(Home | not Draw) when assessing DNB win-or-void merit'],
    examples: {
      valid: ['Draw No Bet -> Home', 'Draw No Bet -> Away'],
      invalid: ['Draw No Bet -> Draw (Draw is a push, never a winning outcome)'],
    },
  },

  asian_handicap: {
    id: 'asian_handicap',
    name: 'Asian Handicap',
    aliases: ['asian handicap', 'ah', 'spread', 'run line', 'puck line'],
    category: 'handicap',
    plainMeaning: 'Applies a signed goal handicap (integer, half, or quarter split) to one team to eliminate or refund draws.',
    possibleOutcomes: ['Home (+/- line)', 'Away (+/- line)'],
    lineMechanics: 'Half lines (e.g. -0.5, +1.5) have no push. Integer lines (0, -1, +1) push on exact adjusted tie. Quarter lines (-0.25, +0.25, -0.75, +0.75) split stake 50/50 across the two adjacent quarter-offset lines (line - 0.25 and line + 0.25).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Adjusted margin = (teamGoals + handicap) - oppGoals. Half/integer: >0 win, ==0 push, <0 loss. Quarter: average settlement of (line - 0.25) and (line + 0.25) yielding win, half_win, half_loss, or loss.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'standings', 'winProbabilities'],
    requiredStats: ['calibrated bivariate score distribution (lamH, lamA)'],
    unevaluableWhen: ['Missing goal scoring/conceding rates', 'Handicap sign or team attribution is ambiguous'],
    commonErrors: [
      'Confusing Asian Handicap +1 with European 3-way Handicap 1:0 (Asian pushes on 1-goal loss; European Draw wins on 1-goal loss)',
      'Ignoring half-win / half-loss split mechanics on quarter lines (-0.25, +0.75)',
      'Applying Away handicap sign backwards (Away +1.5 means Away gets +1.5 goals, NOT Home +1.5)',
    ],
    examples: {
      valid: ['Asian Handicap -> Home -0.5', 'Asian Handicap -> Away +1.25', 'Asian Handicap -> Home -0.75'],
      invalid: ['Handicap -> home 0:2 (colon syntax is European 3-way handicap, not Asian)'],
    },
  },

  european_handicap: {
    id: 'european_handicap',
    name: 'European 3-Way Handicap',
    aliases: ['handicap', '3-way handicap', 'european handicap', '3way handicap'],
    category: 'handicap',
    plainMeaning: 'Starts the match with a virtual integer scoreline (e.g. 0:2 gives Away a 2-goal head start; 2:0 gives Home a 2-goal head start) and settles as 3-way Home / Draw / Away with NO push.',
    possibleOutcomes: ['Home (h:a)', 'Draw (h:a)', 'Away (h:a)'],
    lineMechanics: 'Notation "H:A" adds H virtual goals to Home and A virtual goals to Away. There is NEVER a refund/push because Handicap Draw is a separate selectable outcome.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Let diff = (homeGoals + H) - (awayGoals + A). Home wins iff diff > 0; Draw wins iff diff == 0; Away wins iff diff < 0.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'standings', 'winProbabilities'],
    requiredStats: ['calibrated bivariate score distribution (lamH, lamA)'],
    unevaluableWhen: ['Missing calibrated scoring distribution', 'Virtual scoreline H:A cannot be unambiguously parsed'],
    commonErrors: [
      'Confusing 0:2 (Away starts +2 up -> Home must win by 3+) with 2:0 (Home starts +2 up -> Home wins if it wins, draws, or loses by 1)',
      'Treating Handicap Draw (e.g. Draw 0:2 = Home wins by exactly 2) as a push/refund',
      'Using uncalibrated domestic league goal averages in mismatched international/cup fixtures without anchoring to prematch win probabilities',
    ],
    examples: {
      valid: ['Handicap -> home 0:2 (wins if Home wins by 3+)', 'Handicap -> draw 0:2 (wins if Home wins by exactly 2)', 'Handicap -> away 0:2 (wins if Away wins, draws, or loses by 1)'],
      invalid: ['Handicap -> Home -0.25 (quarter line is Asian Handicap, never European 3-way)'],
    },
  },

  goals_over_under: {
    id: 'goals_over_under',
    name: 'Total Goals Over/Under',
    aliases: ['total', 'total goals', 'over/under', 'goals over/under', '1st half total', '2nd half total', 'asian total'],
    category: 'goals',
    plainMeaning: 'Predicts whether total goals scored in the specified period exceed (Over) or stay below (Under) a given numeric line.',
    possibleOutcomes: ['Over X', 'Under X'],
    lineMechanics: 'Half lines (0.5, 1.5, 2.5, 3.5...) never push. Integer lines (1.0, 2.0, 3.0) push on exact equality. Quarter lines (2.25, 2.75) split 50/50 across adjacent lines.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Over wins if totalGoals > line; Under wins if totalGoals < line; exact match pushes on integer lines and half-settles on quarter lines.',
    relevantStats: ['teamSeasonScoring', 'overUnder', 'recentMatches'],
    requiredStats: ['goal scoring/conceding rates or empirical over/under percentages'],
    unevaluableWhen: ['1H/2H Over/Under when neither half-specific scoring rates nor half-specific empirical O/U rates were collected'],
    commonErrors: ['Applying full-time goal averages directly to 1st Half or 2nd Half Over/Under lines', 'Confusing "Over 2.5" with "Over 3.5"'],
    examples: {
      valid: ['Total -> Over 1.5', 'Total -> Under 3.5', '1st Half - Total -> Over 0.5 (when 1H stats exist)'],
      invalid: ['1st Half - Total -> Over 1.5 when only full-time averages exist'],
    },
  },

  goals_ranges: {
    id: 'goals_ranges',
    name: 'Goal Ranges / Multigoals / Exact Goals',
    aliases: ['multigoals', 'total goals range', 'goal bands', 'exact goals', 'number of goals'],
    category: 'goals',
    plainMeaning: 'Predicts that total goals fall within an inclusive integer range (e.g. 1-3, 2-4), hit an exact integer count (e.g. 2), or reach at least N goals (e.g. 3+).',
    possibleOutcomes: ['0-1', '1-3', '2-4', '3+', 'Exact 0/1/2/3...'],
    lineMechanics: 'Inclusive integer bounds [lo, hi]; "N+" means >= N (equivalent to Over N-0.5).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Wins iff actual goal count lies inside [lo, hi] (or equals exact count). No push.',
    relevantStats: ['teamSeasonScoring', 'overUnder', 'recentMatches'],
    requiredStats: ['calibrated expected goals total'],
    unevaluableWhen: ['Missing goal rates', '1H/2H without half-specific goal data'],
    commonErrors: ['Confusing scoreline "2-1" with goal range "1-2"'],
    examples: {
      valid: ['Multigoals -> 1-3', 'Total Goals -> 2-4', 'Exact Goals -> 2'],
      invalid: ['Correct Score -> 2-1 (that is a scoreline, not a goal range)'],
    },
  },

  btts: {
    id: 'btts',
    name: 'Both Teams to Score (BTTS / GG-NG)',
    aliases: ['both teams to score', 'both teams score', 'btts', 'gg/ng', 'gg'],
    category: 'scoring',
    plainMeaning: 'Predicts whether both teams score at least one goal each (Yes/GG) or at least one team fails to score (No/NG).',
    possibleOutcomes: ['Yes (GG)', 'No (NG)'],
    lineMechanics: 'Binary yes/no market. No push.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Yes wins iff homeGoals >= 1 AND awayGoals >= 1; No wins iff homeGoals == 0 OR awayGoals == 0.',
    relevantStats: ['teamSeasonScoring', 'overUnder', 'recentMatches'],
    requiredStats: ['team scoring/conceding rates or empirical BTTS percentage'],
    unevaluableWhen: ['Period is 1H/2H without half-specific BTTS or half scoring data'],
    commonErrors: ['Using total goals lambda alone instead of separate Home and Away scoring lambdas (a 4-0 blowout has high total goals but BTTS = No)'],
    examples: {
      valid: ['Both Teams to Score -> Yes', 'GG/NG -> No'],
      invalid: ['First Team to Score -> Home (different market)'],
    },
  },

  team_goals: {
    id: 'team_goals',
    name: 'Team Total Goals / Team to Score',
    aliases: ['home total', 'away total', 'home team goals', 'away team goals', 'team to score'],
    category: 'goals',
    plainMeaning: 'Predicts the number of goals scored specifically by the Home team or specifically by the Away team.',
    possibleOutcomes: ['Home Over/Under X', 'Away Over/Under X', 'Team to Score Yes/No'],
    lineMechanics: 'Counts only the named team\'s goals (including opponent own goals credited to them).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'team',
    settlementRules: 'Same Over/Under or >=1 settlement applied strictly to the specified team\'s score.',
    relevantStats: ['teamSeasonScoring', 'recentMatches', 'winProbabilities'],
    requiredStats: ['separate calibrated homeLambda and awayLambda'],
    unevaluableWhen: ['Only combined match goals total is available without team split', 'Named team cannot be unambiguously resolved to Home or Away'],
    commonErrors: ['Evaluating a team-total market using combined match expected goals (lamH + lamA) instead of the single team lambda'],
    examples: {
      valid: ['Home Total -> Over 1.5', 'Away Team to Score -> Yes'],
      invalid: ['Team Total when home/away attribution is unknown'],
    },
  },

  half_time_full_time: {
    id: 'half_time_full_time',
    name: 'Half-Time / Full-Time (HT/FT)',
    aliases: ['ht/ft', 'halftime/fulltime', 'half time / full time', 'half-time/full-time'],
    category: 'result',
    plainMeaning: 'Predicts both the result at half-time AND the result at full-time (9 combinations: 1/1, 1/X, 1/2, X/1, X/X, X/2, 2/1, 2/X, 2/2).',
    possibleOutcomes: ['1/1', '1/X', '1/2', 'X/1', 'X/X', 'X/2', '2/1', '2/X', '2/2'],
    lineMechanics: 'Joint compound event across first half and full match. Regulation time only.',
    periods: ['ft'],
    teamScope: 'match',
    settlementRules: 'Wins only if BOTH the half-time result and the full-time result match the selected pair.',
    relevantStats: ['teamSeasonScoring', 'overUnder', 'recentMatches'],
    requiredStats: ['explicit 1st-half and 2nd-half team scoring rates'],
    unevaluableWhen: ['No verified 1st-half vs 2nd-half team scoring split was collected (never fabricate a 45/55 split)'],
    commonErrors: ['Multiplying marginal 1H and FT probabilities as if they were independent (they are strongly coupled because FT = 1H + 2H)'],
    examples: {
      valid: ['HT/FT -> 1/1 (only if explicit 1H & 2H team scoring splits exist)'],
      invalid: ['HT/FT evaluated purely from full-time averages'],
    },
  },

  correct_score: {
    id: 'correct_score',
    name: 'Correct Score',
    aliases: ['correct score', 'exact score', 'final score'],
    category: 'scoring',
    plainMeaning: 'Predicts the exact regulation-time scoreline (e.g. 1:0, 2:1, 0:0).',
    possibleOutcomes: ['0:0', '1:0', '2:1', '1:1', 'etc.'],
    lineMechanics: 'Exact bivariate integer outcome (homeGoals == h && awayGoals == a).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Wins iff final score equals exact selected home:away scoreline.',
    relevantStats: ['teamSeasonScoring', 'winProbabilities'],
    requiredStats: ['calibrated bivariate score matrix'],
    unevaluableWhen: ['Missing team scoring rates', 'Scoreline notation ambiguous or unparseable'],
    commonErrors: ['Confusing "Any other score" with numeric scorelines', 'Reversing Home:Away order'],
    examples: {
      valid: ['Correct Score -> 1:0', 'Correct Score -> 2:1'],
      invalid: ['Handicap -> 0:2 (colon in Handicap is a virtual head start, not Correct Score)'],
    },
  },

  winning_margin: {
    id: 'winning_margin',
    name: 'Winning Margin',
    aliases: ['winning margin', 'goal difference', 'margin of victory'],
    category: 'scoring',
    plainMeaning: 'Predicts which team wins AND by how many goals (e.g. Home by 1 goal, Away by 2+ goals, Draw/No Goal).',
    possibleOutcomes: ['Home by 1', 'Home by 2', 'Home by 3+', 'Away by 1', 'Away by 2+', 'Draw'],
    lineMechanics: 'Goal difference (homeGoals - awayGoals) evaluated exactly or as >= N.',
    periods: ['ft'],
    teamScope: 'match',
    settlementRules: 'Wins iff actual team and exact/minimum goal difference match.',
    relevantStats: ['teamSeasonScoring', 'winProbabilities'],
    requiredStats: ['calibrated bivariate score matrix'],
    unevaluableWhen: ['Missing calibrated score grid'],
    commonErrors: ['Treating "Home by 2" (exact difference == 2) as "Home by 2+" (difference >= 2)'],
    examples: {
      valid: ['Winning Margin -> Home by 1', 'Winning Margin -> Away by 2+'],
      invalid: ['Winning Margin -> 2-0 (exact scoreline is Correct Score, not Winning Margin)'],
    },
  },

  clean_sheet: {
    id: 'clean_sheet',
    name: 'Clean Sheet',
    aliases: ['clean sheet', 'home clean sheet', 'away clean sheet', 'to keep a clean sheet'],
    category: 'scoring',
    plainMeaning: 'Predicts whether a specified team concedes zero goals (Yes) or concedes at least one goal (No).',
    possibleOutcomes: ['Home Clean Sheet Yes/No', 'Away Clean Sheet Yes/No'],
    lineMechanics: 'Depends on opponent scoring 0 goals (oppGoals == 0).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'team',
    settlementRules: 'Yes wins iff opponent scores 0; No wins iff opponent scores >= 1.',
    relevantStats: ['teamSeasonScoring', 'recentMatches'],
    requiredStats: ['opponent expected goals (lamA for Home clean sheet; lamH for Away clean sheet)'],
    unevaluableWhen: ['Missing separate home/away expected goals', 'Team attribution unclear'],
    commonErrors: ['Checking the team\'s own goals scored instead of the opponent\'s goals scored'],
    examples: {
      valid: ['Home Clean Sheet -> Yes', 'Away Clean Sheet -> No'],
      invalid: ['Clean Sheet without specifying Home or Away'],
    },
  },

  win_to_nil: {
    id: 'win_to_nil',
    name: 'Win to Nil',
    aliases: ['win to nil', 'home win to nil', 'away win to nil'],
    category: 'scoring',
    plainMeaning: 'Predicts whether a team wins the match while keeping a clean sheet (e.g. 1-0, 2-0, 3-0).',
    possibleOutcomes: ['Home Win to Nil Yes/No', 'Away Win to Nil Yes/No'],
    lineMechanics: 'Joint condition: teamGoals >= 1 AND oppGoals == 0.',
    periods: ['ft'],
    teamScope: 'team',
    settlementRules: 'Yes wins iff team wins AND concedes 0 goals; No wins otherwise (including 0-0 draw).',
    relevantStats: ['teamSeasonScoring', 'winProbabilities', 'recentMatches'],
    requiredStats: ['calibrated bivariate score matrix'],
    unevaluableWhen: ['Missing separate team goal rates'],
    commonErrors: ['Treating a 0-0 draw as Win to Nil (it is Clean Sheet, NOT Win to Nil)'],
    examples: {
      valid: ['Home Win to Nil -> Yes', 'Away Win to Nil -> No'],
      invalid: ['Win to Nil -> Draw'],
    },
  },

  first_last_to_score: {
    id: 'first_last_to_score',
    name: 'First / Last Team to Score',
    aliases: ['first team to score', '1st goal', 'first goal', 'last team to score', 'last goal'],
    category: 'scoring',
    plainMeaning: 'Predicts which team scores the first (or last) goal of the match, or that no goals are scored.',
    possibleOutcomes: ['Home', 'Away', 'No Goal / Neither'],
    lineMechanics: 'Under homogeneous Poisson scoring intensities (lamH, lamA), P(No Goal) = exp(-(lamH+lamA)) and P(Home first/last) = (1 - P(No Goal)) * lamH / (lamH + lamA).',
    periods: ['ft'],
    teamScope: 'match',
    settlementRules: 'First goal settles on earliest goal; Last goal settles on final goal of regulation time; 0-0 settles on No Goal.',
    relevantStats: ['teamSeasonScoring', 'winProbabilities'],
    requiredStats: ['calibrated lamH and lamA'],
    unevaluableWhen: ['Missing team scoring rates'],
    commonErrors: ['Forgetting the "No Goal" (0-0) probability mass so probabilities sum to >1'],
    examples: {
      valid: ['First Team to Score -> Home', 'Last Team to Score -> Away', 'First Goal -> No Goal'],
      invalid: ['First Goalscorer -> Player X (player prop, not team market)'],
    },
  },

  corners: {
    id: 'corners',
    name: 'Corners Markets',
    aliases: ['corners', 'total corners', 'corner 1x2', 'home corners', 'away corners', 'corners range'],
    category: 'team_stats',
    plainMeaning: 'Predicts total match corners, individual team corners, corner ranges, or which team wins more corners.',
    possibleOutcomes: ['Over/Under X corners', 'Home/Draw/Away most corners', 'Corner ranges (e.g. 8-10)'],
    lineMechanics: 'Evaluated strictly from collected season corners averages (never from goal averages).',
    periods: ['ft', '1h', '2h'],
    teamScope: 'both',
    settlementRules: 'Counts corners actually taken in regulation time.',
    relevantStats: ['seasonTeamStats'],
    requiredStats: ['collected corners averages (total and/or home+away split)'],
    unevaluableWhen: ['Corners statistics were not collected', 'Team corners or Corner 1X2 when only combined total corners exist', '1H/2H corners without half corner stats'],
    commonErrors: ['Falling back to goal averages when corner stats are missing', 'Using combined total corners to evaluate Home Team Corners'],
    examples: {
      valid: ['Total Corners -> Over 8.5 (with season corners avg)', 'Corner 1X2 -> Home (with home & away corner avgs)'],
      invalid: ['1st Half Corners -> Over 4.5 without 1H corner stats'],
    },
  },

  cards_bookings: {
    id: 'cards_bookings',
    name: 'Cards / Bookings Markets',
    aliases: ['cards', 'total cards', 'bookings', 'yellow cards', 'booking points', 'home cards', 'away cards'],
    category: 'team_stats',
    plainMeaning: 'Predicts total cards/bookings or team cards in regulation time.',
    possibleOutcomes: ['Over/Under X cards', 'Home/Away cards Over/Under', 'Card ranges'],
    lineMechanics: 'Requires exact distinction between card count (yellow=1, red=1 or 2) and booking points (yellow=10, red=25). Booking points must NOT be evaluated using card-count averages unless converted explicitly.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'both',
    settlementRules: 'Follows sportsbook card-counting rules in regulation time.',
    relevantStats: ['disciplinary', 'seasonTeamStats'],
    requiredStats: ['collected disciplinary / cards averages'],
    unevaluableWhen: ['Card/disciplinary stats missing', 'Booking points market (e.g. Over 35.5 points) without booking-points scoring rules'],
    commonErrors: ['Evaluating Booking Points (line 35.5) with raw card count average (3.8 cards)'],
    examples: {
      valid: ['Total Cards -> Over 3.5', 'Total Yellow Cards -> Under 5.5'],
      invalid: ['Total Booking Points -> Over 45.5 evaluated directly against 4.2 cards avg'],
    },
  },

  shots_sot: {
    id: 'shots_sot',
    name: 'Shots / Shots on Target',
    aliases: ['shots', 'total shots', 'shots on target', 'sot', 'shots on goal'],
    category: 'team_stats',
    plainMeaning: 'Predicts total shots or shots on target for the match or an individual team.',
    possibleOutcomes: ['Over/Under X shots / SoT', 'Team shots / SoT Over/Under'],
    lineMechanics: 'Must strictly distinguish Total Shots from Shots on Target (SoT) — never use SoT averages to evaluate Total Shots!',
    periods: ['ft'],
    teamScope: 'both',
    settlementRules: 'Official Opta/Sportradar match shot / shot-on-target count in regulation time.',
    relevantStats: ['seasonTeamStats'],
    requiredStats: ['matching metric average (SoT average for SoT markets; total shots average for total shots markets)'],
    unevaluableWhen: ['Only SoT average is collected but market is Total Shots (including off-target/blocked), or stats missing'],
    commonErrors: ['Using Shots on Target average (~9.5) to price Total Shots (~24.5)'],
    examples: {
      valid: ['Shots on Target -> Over 7.5 (using shotsOnGoalAvg)'],
      invalid: ['Total Shots -> Over 22.5 priced using shotsOnGoalAvg'],
    },
  },

  fouls: {
    id: 'fouls',
    name: 'Fouls / Free Kicks',
    aliases: ['fouls', 'total fouls', 'free kicks', 'freekicks'],
    category: 'team_stats',
    plainMeaning: 'Predicts total fouls or free kicks in regulation time.',
    possibleOutcomes: ['Over/Under X fouls', 'Team fouls Over/Under'],
    lineMechanics: 'Requires verified fouls/freekicks averages from collected statistics.',
    periods: ['ft'],
    teamScope: 'both',
    settlementRules: 'Official regulation-time foul count.',
    relevantStats: ['seasonTeamStats'],
    requiredStats: ['collected fouls/freekicks averages'],
    unevaluableWhen: ['Fouls statistics were not collected'],
    commonErrors: ['Conflating offsides or cards with fouls'],
    examples: {
      valid: ['Total Fouls -> Over 21.5 (when fouls/freekicks avg collected)'],
      invalid: ['Total Fouls evaluated from cards avg'],
    },
  },

  offsides: {
    id: 'offsides',
    name: 'Offsides',
    aliases: ['offsides', 'total offsides', 'home offsides', 'away offsides'],
    category: 'team_stats',
    plainMeaning: 'Predicts total offsides or team offsides called during regulation time.',
    possibleOutcomes: ['Over/Under X offsides', 'Team offsides Over/Under'],
    lineMechanics: 'Evaluated strictly from collected season offsides averages.',
    periods: ['ft'],
    teamScope: 'both',
    settlementRules: 'Official regulation-time offside count.',
    relevantStats: ['seasonTeamStats'],
    requiredStats: ['collected offsides averages'],
    unevaluableWhen: ['Offsides statistics were not collected'],
    commonErrors: ['Assuming zero offsides when field is absent'],
    examples: {
      valid: ['Total Offsides -> Over 3.5 (when offsides avg collected)'],
      invalid: ['Offsides evaluated without offsides stats'],
    },
  },

  odd_even: {
    id: 'odd_even',
    name: 'Odd / Even Totals',
    aliases: ['odd/even', 'odd even', 'goals odd/even', 'corners odd/even'],
    category: 'goals',
    plainMeaning: 'Predicts whether the final total count (goals, corners, etc.) is an odd number (1, 3, 5...) or even number (0, 2, 4...).',
    possibleOutcomes: ['Odd', 'Even'],
    lineMechanics: 'Zero (0) is mathematically Even. Under Poisson(lam), P(Even) = (1 + exp(-2*lam)) / 2.',
    periods: ['ft', '1h', '2h'],
    teamScope: 'match',
    settlementRules: 'Even wins if count % 2 == 0 (including 0); Odd wins if count % 2 == 1.',
    relevantStats: ['teamSeasonScoring', 'seasonTeamStats'],
    requiredStats: ['expected total lambda for the target domain'],
    unevaluableWhen: ['Domain statistics missing', 'Note: for lam >= 2, P(Even) is ~50.9%, rarely offering strong statistical edge'],
    commonErrors: ['Treating 0 goals as neither odd nor even (0 is Even)'],
    examples: {
      valid: ['Goals Odd/Even -> Even', 'Goals Odd/Even -> Odd'],
      invalid: ['Odd/Even evaluated with fabricated rate'],
    },
  },

  combo_markets: {
    id: 'combo_markets',
    name: 'Combined / Joint Markets',
    aliases: ['1x2 & total', 'double chance & total', '1x2 & btts', 'double chance & btts', 'total & btts', 'result & both teams to score'],
    category: 'combo',
    plainMeaning: 'Combines two correlated match conditions that MUST BOTH succeed for the bet to win.',
    possibleOutcomes: ['Home & Over 2.5', '1X & Under 3.5', 'Home & BTTS Yes', 'BTTS Yes & Over 2.5', 'etc.'],
    lineMechanics: 'Must be evaluated jointly on the bivariate score matrix (i, j) — NEVER by naively multiplying marginal probabilities!',
    periods: ['ft'],
    teamScope: 'match',
    settlementRules: 'Wins iff BOTH sub-conditions are satisfied by the final regulation-time scoreline.',
    relevantStats: ['teamSeasonScoring', 'winProbabilities', 'overUnder', 'recentMatches'],
    requiredStats: ['calibrated bivariate score matrix'],
    unevaluableWhen: ['Sub-components cannot both be parsed unambiguously', 'Combo involves unmodelled legs (e.g. player scorer + result, corners + result)'],
    commonErrors: [
      'Multiplying P(Home) * P(BTTS) as independent (violates correlation: e.g., Draw & Over 2.5 is only 2-2, 3-3...; BTTS Yes & Under 1.5 has probability 0!)',
      'Guessing unfamiliar 3-leg or exotic combo headings',
    ],
    examples: {
      valid: ['1X2 & Total -> Home & Over 1.5', 'Double Chance & BTTS -> 1X & Yes'],
      invalid: ['Anytime Goalscorer & 1X2 (requires player stats)', '1X2 & Corners (cross-domain correlation unmodelled)'],
    },
  },

  player_props: {
    id: 'player_props',
    name: 'Player & Minute-Interval Props',
    aliases: ['player', 'anytime goalscorer', 'first goalscorer', 'last goalscorer', 'player shots', 'player cards', '10 min', '15 min', 'method of victory', 'substitute', 'var'],
    category: 'player_props',
    plainMeaning: 'Markets settled on individual player events (scorers, assists, player shots/cards) or narrow minute-interval events.',
    possibleOutcomes: ['Named player', 'Minute band'],
    lineMechanics: 'Requires verified player-level lineups, minutes, shot/goal rates, or minute-by-minute goal timing distributions.',
    periods: ['ft', 'interval'],
    teamScope: 'player',
    settlementRules: 'Settles on official player/minute event records; void if player does not participate (bookmaker dependent).',
    relevantStats: ['playerStats (not available in team-only Gismo feeds)'],
    requiredStats: ['verified player-level statistics and confirmed lineups'],
    unevaluableWhen: ['ALWAYS unevaluable when only team/match-level statistics are collected'],
    commonErrors: ['Guessing player markets from team goal averages'],
    examples: {
      valid: ['Classified as unevaluable/skipped without player stats'],
      invalid: ['Selecting an Anytime Goalscorer from team scoring averages'],
    },
  },
};

// ============================================================================
// Deterministic Handicap & Over/Under Settlement Math (Explicit & Testable)
// ============================================================================

// European 3-way Handicap: virtual start score (startHome : startAway), e.g. 0:2 or 2:0.
// Returns 'win' or 'loss' (3-way European handicap NEVER pushes).
function settleEuropeanHandicap(homeGoals, awayGoals, startHome, startAway, side) {
  const adjH = homeGoals + startHome;
  const adjA = awayGoals + startAway;
  const diff = adjH - adjA;
  if (side === 'H') return diff > 0 ? 'win' : 'loss';
  if (side === 'X') return diff === 0 ? 'win' : 'loss';
  if (side === 'A') return diff < 0 ? 'win' : 'loss';
  throw new Error(`Invalid European handicap side: ${side}`);
}

// Single non-quarter Asian Handicap leg settlement (integer or half line).
function settleSingleAsianLine(homeGoals, awayGoals, line, side) {
  const margin = side === 'H'
    ? (homeGoals + line) - awayGoals
    : (awayGoals + line) - homeGoals;
  if (margin > 1e-9) return 1;    // win
  if (margin < -1e-9) return -1;  // loss
  return 0;                       // push
}

// Full Asian Handicap settlement supporting half (-0.5, +1.5), integer (0, -1, +1),
// and quarter/split lines (-0.25, +0.25, -0.75, +0.75, -1.25, +1.25).
// Returns { outcome: 'win'|'half_win'|'push'|'half_loss'|'loss', payoutFactor: 1|0.5|0|-0.5|-1, legs: [...] }
function settleAsianHandicap(homeGoals, awayGoals, line, side) {
  if (side !== 'H' && side !== 'A') throw new Error(`Invalid Asian handicap side: ${side}`);
  const q = Math.round(line * 4);
  const isQuarter = Math.abs(q) % 2 === 1;
  if (!isQuarter) {
    const r = settleSingleAsianLine(homeGoals, awayGoals, line, side);
    return {
      outcome: r === 1 ? 'win' : (r === -1 ? 'loss' : 'push'),
      payoutFactor: r,
      split: false,
      lines: [line],
    };
  }
  const lowLine = (q - 1) / 4;
  const highLine = (q + 1) / 4;
  const r1 = settleSingleAsianLine(homeGoals, awayGoals, lowLine, side);
  const r2 = settleSingleAsianLine(homeGoals, awayGoals, highLine, side);
  const avg = (r1 + r2) / 2;
  let outcome = 'push';
  if (avg === 1) outcome = 'win';
  else if (avg === 0.5) outcome = 'half_win';
  else if (avg === -0.5) outcome = 'half_loss';
  else if (avg === -1) outcome = 'loss';
  return {
    outcome,
    payoutFactor: avg,
    split: true,
    lines: [lowLine, highLine],
  };
}

// Over/Under settlement supporting half (2.5), integer (2.0), and quarter (2.25, 2.75) lines.
function settleOverUnder(actualCount, line, dir) {
  if (dir !== 'O' && dir !== 'U') throw new Error(`Invalid Over/Under direction: ${dir}`);
  const single = (ln) => {
    const diff = dir === 'O' ? (actualCount - ln) : (ln - actualCount);
    if (diff > 1e-9) return 1;
    if (diff < -1e-9) return -1;
    return 0;
  };
  const q = Math.round(line * 4);
  const isQuarter = Math.abs(q) % 2 === 1;
  if (!isQuarter) {
    const r = single(line);
    return {
      outcome: r === 1 ? 'win' : (r === -1 ? 'loss' : 'push'),
      payoutFactor: r,
      split: false,
      lines: [line],
    };
  }
  const r1 = single((q - 1) / 4);
  const r2 = single((q + 1) / 4);
  const avg = (r1 + r2) / 2;
  const outcome = avg === 1 ? 'win' : (avg === 0.5 ? 'half_win' : (avg === -0.5 ? 'half_loss' : (avg === -1 ? 'loss' : 'push')));
  return { outcome, payoutFactor: avg, split: true, lines: [(q - 1) / 4, (q + 1) / 4] };
}

// Evaluate exact Asian Handicap probabilities across a bivariate score grid.
function evaluateAsianHandicapGrid(scoreGrid, line, side) {
  let pFullWin = 0;
  let pHalfWin = 0;
  let pPush = 0;
  let pHalfLoss = 0;
  let pFullLoss = 0;
  for (let i = 0; i < scoreGrid.length; i++) {
    for (let j = 0; j < scoreGrid[i].length; j++) {
      const prob = scoreGrid[i][j];
      const s = settleAsianHandicap(i, j, line, side);
      if (s.outcome === 'win') pFullWin += prob;
      else if (s.outcome === 'half_win') pHalfWin += prob;
      else if (s.outcome === 'push') pPush += prob;
      else if (s.outcome === 'half_loss') pHalfLoss += prob;
      else pFullLoss += prob;
    }
  }
  // Effective win probability conditioned on the non-void stake share:
  // Half-win = 0.5 win + 0.5 push; half-loss = 0.5 loss + 0.5 push.
  const winMass = pFullWin + 0.5 * pHalfWin;
  const lossMass = pFullLoss + 0.5 * pHalfLoss;
  const decisive = winMass + lossMass;
  const effectiveWinProb = decisive > 0.05 ? winMass / decisive : pFullWin;
  return { pFullWin, pHalfWin, pPush, pHalfLoss, pFullLoss, effectiveWinProb };
}

// Evaluate exact European 3-way Handicap probabilities across a bivariate score grid.
function evaluateEuropeanHandicapGrid(scoreGrid, startHome, startAway, side) {
  let pWin = 0;
  for (let i = 0; i < scoreGrid.length; i++) {
    for (let j = 0; j < scoreGrid[i].length; j++) {
      if (settleEuropeanHandicap(i, j, startHome, startAway, side) === 'win') {
        pWin += scoreGrid[i][j];
      }
    }
  }
  return { pWin };
}

// Map a semantic kind (or raw title) to its Market Knowledge Library family id.
function familyForSemantic(sem, rawTitle = '', rawLabel = '') {
  if (sem && sem.kind) {
    switch (sem.kind) {
      case 'win': return 'match_result_1x2';
      case 'dc': return 'double_chance';
      case 'dnb': return 'draw_no_bet';
      case 'asian_handicap': return 'asian_handicap';
      case 'eu_handicap': return 'european_handicap';
      case 'btts': return 'btts';
      case 'clean_sheet': return 'clean_sheet';
      case 'win_to_nil': return 'win_to_nil';
      case 'team_score': return 'team_goals';
      case 'first_to_score':
      case 'last_to_score': return 'first_last_to_score';
      case 'odd_even': return 'odd_even';
      case 'correct_score': return 'correct_score';
      case 'winning_margin': return 'winning_margin';
      case 'ht_ft': return 'half_time_full_time';
      case 'combo_result_ou':
      case 'combo_result_btts':
      case 'combo_btts_ou': return 'combo_markets';
      case 'threshold':
      case 'range':
      case 'exact':
      case 'metric_1x2': {
        if (sem.domain === 'corner') return 'corners';
        if (sem.domain === 'card') return 'cards_bookings';
        if (sem.domain === 'shot') return 'shots_sot';
        if (sem.domain === 'foul') return 'fouls';
        if (sem.domain === 'offside') return 'offsides';
        if (sem.teamScope === 'H' || sem.teamScope === 'A') return 'team_goals';
        if (sem.kind === 'range' || sem.kind === 'exact') return 'goals_ranges';
        return 'goals_over_under';
      }
      case 'unsupported':
        if (sem.reason === 'no_player_or_interval_stats') return 'player_props';
        break;
    }
  }
  const t = norm(rawTitle);
  const l = norm(rawLabel);
  if (/\b(player|scorer|anytime|goalscorer|minute|interval|10 min|15 min|method|substitute|var)\b/.test(t)) return 'player_props';
  if (/corner/.test(t)) return 'corners';
  if (/\b(card|cards|booking|bookings|yellow)\b/.test(t)) return 'cards_bookings';
  if (/\b(shot|shots|sot)\b/.test(t)) return 'shots_sot';
  if (/\b(foul|fouls|freekick|free kick)\b/.test(t)) return 'fouls';
  if (/offside/.test(t)) return 'offsides';
  if (/(ht\s*\/\s*ft|halftime\s*fulltime|half time full time)/.test(t)) return 'half_time_full_time';
  if (/(correct score|exact score)/.test(t)) return 'correct_score';
  if (/winning margin/.test(t)) return 'winning_margin';
  if (/clean sheet/.test(t)) return 'clean_sheet';
  if (/win to nil/.test(t)) return 'win_to_nil';
  if (/(first|last)\s*(team\s*)?to\s*score|\b(1st|first|last)\s+goal\b/.test(t)) return 'first_last_to_score';
  if (/asian\s*handicap/.test(t)) return 'asian_handicap';
  if (/handicap/.test(t) && (/\d+\s*:\s*\d+/.test(rawTitle) || /\d+\s*:\s*\d+/.test(rawLabel))) return 'european_handicap';
  if (/handicap|spread/.test(t)) return 'asian_handicap';
  if (/double chance/.test(t)) return 'double_chance';
  if (/draw no bet/.test(t)) return 'draw_no_bet';
  if (/(both teams|btts|gg)/.test(t)) return 'btts';
  if (/odd\s*even/.test(t)) return 'odd_even';
  if (/(1x2|match result|full time result|match winner)/.test(t) && !/&/.test(rawTitle)) return 'match_result_1x2';
  if (/&/.test(rawTitle) || /\band\b/.test(t)) return 'combo_markets';
  if (/\b(over|under)\b/.test(l) || /total|goals/.test(t)) return 'goals_over_under';
  return 'unknown';
}

function getMarketDefinition(familyId) {
  return MARKET_CATALOG[familyId] || null;
}

function listMarketFamilies() {
  return Object.keys(MARKET_CATALOG);
}

module.exports = {
  MARKET_CATALOG,
  getMarketDefinition,
  listMarketFamilies,
  familyForSemantic,
  settleEuropeanHandicap,
  settleAsianHandicap,
  settleOverUnder,
  evaluateAsianHandicapGrid,
  evaluateEuropeanHandicapGrid,
};
