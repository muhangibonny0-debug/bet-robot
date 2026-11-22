'use strict';
// Real bookmaker market catalogue (120 market definitions) and fuzzy user-intent resolver.
// Never invents odds or assumes a bookmaker offers every market: only classifies markets
// actually present on BangBet and interprets natural user market requests.
const { norm } = require('./util');

const CATALOG = [
  // ---- Football: Main Result & Double Chance (1–12) ----
  { id: 'ft_1x2', name: '1X2 (Full Time Result)', category: 'result', sport: 'football', type: 'WIN', aliases: ['1x2', 'match result', 'full time result', 'match winner', 'win', 'home win', 'away win', 'draw', 'ft result'] },
  { id: 'ft_double_chance', name: 'Double Chance', category: 'result', sport: 'football', type: 'DC', aliases: ['double chance', 'dc', '1x', 'x2', '12', 'win or draw', 'or draw', 'double chanse'] },
  { id: 'ft_draw_no_bet', name: 'Draw No Bet', category: 'result', sport: 'football', type: 'DNB', aliases: ['draw no bet', 'dnb', 'tie no bet', 'draw refund'] },
  { id: 'ht_1x2', name: '1st Half 1X2', category: 'half', sport: 'football', type: 'HALF_WIN', aliases: ['1st half 1x2', 'first half winner', 'half time result', 'ht result', '1h result', 'first half result'] },
  { id: 'ht_double_chance', name: '1st Half Double Chance', category: 'half', sport: 'football', type: 'HALF_DC', aliases: ['1st half double chance', 'first half double chance', '1h dc'] },
  { id: 'ht_draw_no_bet', name: '1st Half Draw No Bet', category: 'half', sport: 'football', type: 'HALF_DNB', aliases: ['1st half draw no bet', 'first half dnb', '1h dnb'] },
  { id: 'h2_1x2', name: '2nd Half 1X2', category: 'half', sport: 'football', type: 'HALF2_WIN', aliases: ['2nd half 1x2', 'second half winner', '2nd half result', '2h result'] },
  { id: 'h2_double_chance', name: '2nd Half Double Chance', category: 'half', sport: 'football', type: 'HALF2_DC', aliases: ['2nd half double chance', 'second half double chance', '2h dc'] },
  { id: 'h2_draw_no_bet', name: '2nd Half Draw No Bet', category: 'half', sport: 'football', type: 'HALF2_DNB', aliases: ['2nd half draw no bet', 'second half dnb', '2h dnb'] },
  { id: 'ht_ft', name: 'Half Time / Full Time', category: 'combo', sport: 'football', type: 'HT_FT', aliases: ['ht/ft', 'half time full time', 'halftime fulltime', 'ht ft'] },
  { id: 'win_either_half', name: 'To Win Either Half', category: 'half', sport: 'football', type: 'WIN_HALF', aliases: ['win either half', 'to win either half', 'win any half', 'win a half'] },
  { id: 'win_both_halves', name: 'To Win Both Halves', category: 'half', sport: 'football', type: 'WIN_BOTH_HALVES', aliases: ['win both halves', 'to win both halves'] },

  // ---- Football: Goals Over/Under Lines (13–24) ----
  { id: 'ou_0_5', name: 'Total Goals Over/Under 0.5', category: 'goals', sport: 'football', type: 'OU', line: 0.5, aliases: ['over 0.5', 'under 0.5', 'o0.5', 'u0.5', 'ov 0.5'] },
  { id: 'ou_1_5', name: 'Total Goals Over/Under 1.5', category: 'goals', sport: 'football', type: 'OU', line: 1.5, aliases: ['over 1.5', 'under 1.5', 'o1.5', 'u1.5', 'ov 1.5', 'over 1.5 goals'] },
  { id: 'ou_2_5', name: 'Total Goals Over/Under 2.5', category: 'goals', sport: 'football', type: 'OU', line: 2.5, aliases: ['over 2.5', 'under 2.5', 'o2.5', 'u2.5', 'ov 2.5', 'over 2.5 goals', 'under 2.5 goals'] },
  { id: 'ou_3_5', name: 'Total Goals Over/Under 3.5', category: 'goals', sport: 'football', type: 'OU', line: 3.5, aliases: ['over 3.5', 'under 3.5', 'o3.5', 'u3.5', 'ov 3.5', 'under 3.5 goals'] },
  { id: 'ou_4_5', name: 'Total Goals Over/Under 4.5', category: 'goals', sport: 'football', type: 'OU', line: 4.5, aliases: ['over 4.5', 'under 4.5', 'o4.5', 'u4.5'] },
  { id: 'ou_5_5', name: 'Total Goals Over/Under 5.5', category: 'goals', sport: 'football', type: 'OU', line: 5.5, aliases: ['over 5.5', 'under 5.5', 'o5.5', 'u5.5'] },
  { id: 'ou_6_5', name: 'Total Goals Over/Under 6.5', category: 'goals', sport: 'football', type: 'OU', line: 6.5, aliases: ['over 6.5', 'under 6.5'] },
  { id: 'ou_generic', name: 'Total Goals Over/Under', category: 'goals', sport: 'football', type: 'OU', aliases: ['over under', 'over/under', 'total goals', 'goals o/u', 'goals'] },
  { id: 'ht_ou_0_5', name: '1st Half Goals Over/Under 0.5', category: 'half_goals', sport: 'football', type: 'HALF_OU', line: 0.5, aliases: ['1st half over 0.5', 'first half over 0.5', 'ht over 0.5', '1h over 0.5', 'first half goal'] },
  { id: 'ht_ou_1_5', name: '1st Half Goals Over/Under 1.5', category: 'half_goals', sport: 'football', type: 'HALF_OU', line: 1.5, aliases: ['1st half over 1.5', 'first half over 1.5', 'ht over 1.5', '1h over 1.5'] },
  { id: 'ht_ou_2_5', name: '1st Half Goals Over/Under 2.5', category: 'half_goals', sport: 'football', type: 'HALF_OU', line: 2.5, aliases: ['1st half over 2.5', 'first half over 2.5', 'ht over 2.5'] },
  { id: 'ht_ou_generic', name: '1st Half Goals Over/Under', category: 'half_goals', sport: 'football', type: 'HALF_OU', aliases: ['1st half goals', 'first half goals', 'half time goals', '1h goals'] },

  // ---- Football: 2nd Half Goals & Halves Scoring (25–33) ----
  { id: 'h2_ou_0_5', name: '2nd Half Goals Over/Under 0.5', category: 'half_goals', sport: 'football', type: 'HALF2_OU', line: 0.5, aliases: ['2nd half over 0.5', 'second half over 0.5', '2h over 0.5'] },
  { id: 'h2_ou_1_5', name: '2nd Half Goals Over/Under 1.5', category: 'half_goals', sport: 'football', type: 'HALF2_OU', line: 1.5, aliases: ['2nd half over 1.5', 'second half over 1.5', '2h over 1.5'] },
  { id: 'h2_ou_2_5', name: '2nd Half Goals Over/Under 2.5', category: 'half_goals', sport: 'football', type: 'HALF2_OU', line: 2.5, aliases: ['2nd half over 2.5', 'second half over 2.5'] },
  { id: 'h2_ou_generic', name: '2nd Half Goals Over/Under', category: 'half_goals', sport: 'football', type: 'HALF2_OU', aliases: ['2nd half goals', 'second half goals', '2h goals'] },
  { id: 'both_halves_o0_5', name: 'Goals in Both Halves (Over 0.5)', category: 'half_goals', sport: 'football', type: 'BOTH_HALVES_OU', aliases: ['goal in both halves', 'both halves over 0.5', 'score in both halves'] },
  { id: 'both_halves_o1_5', name: 'Both Halves Over 1.5 Goals', category: 'half_goals', sport: 'football', type: 'BOTH_HALVES_OU', aliases: ['both halves over 1.5'] },
  { id: 'highest_scoring_half', name: 'Highest Scoring Half', category: 'half_goals', sport: 'football', type: 'HIGHEST_HALF', aliases: ['highest scoring half', 'most goals half', 'hsh'] },
  { id: 'home_highest_half', name: 'Home Team Highest Scoring Half', category: 'half_goals', sport: 'football', type: 'HIGHEST_HALF', aliases: ['home highest scoring half'] },
  { id: 'away_highest_half', name: 'Away Team Highest Scoring Half', category: 'half_goals', sport: 'football', type: 'HIGHEST_HALF', aliases: ['away highest scoring half'] },

  // ---- Football: BTTS & Clean Sheets (34–45) ----
  { id: 'btts', name: 'Both Teams to Score (GG/NG)', category: 'btts', sport: 'football', type: 'BTTS', aliases: ['btts', 'both teams to score', 'both teams score', 'both team score', 'gg', 'ng', 'gg/ng', 'bts'] },
  { id: 'btts_1h', name: '1st Half Both Teams to Score', category: 'btts', sport: 'football', type: 'HALF_BTTS', aliases: ['1st half btts', 'first half btts', '1h btts', '1st half gg'] },
  { id: 'btts_2h', name: '2nd Half Both Teams to Score', category: 'btts', sport: 'football', type: 'HALF2_BTTS', aliases: ['2nd half btts', 'second half btts', '2h btts', '2nd half gg'] },
  { id: 'btts_both_halves', name: 'BTTS in Both Halves', category: 'btts', sport: 'football', type: 'BTTS_BOTH_HALVES', aliases: ['btts both halves', 'gg both halves'] },
  { id: 'clean_sheet_home', name: 'Home Clean Sheet', category: 'defense', sport: 'football', type: 'CLEAN_SHEET', aliases: ['home clean sheet', 'clean sheet home', 'clean sheet'] },
  { id: 'clean_sheet_away', name: 'Away Clean Sheet', category: 'defense', sport: 'football', type: 'CLEAN_SHEET', aliases: ['away clean sheet', 'clean sheet away'] },
  { id: 'home_win_to_nil', name: 'Home Win to Nil', category: 'combo', sport: 'football', type: 'WIN_TO_NIL', aliases: ['home win to nil', 'win to nil', 'wtn'] },
  { id: 'away_win_to_nil', name: 'Away Win to Nil', category: 'combo', sport: 'football', type: 'WIN_TO_NIL', aliases: ['away win to nil'] },
  { id: 'home_to_score', name: 'Home Team to Score', category: 'team_goals', sport: 'football', type: 'TEAM_SCORE', aliases: ['home to score', 'home team to score', 'home score'] },
  { id: 'away_to_score', name: 'Away Team to Score', category: 'team_goals', sport: 'football', type: 'TEAM_SCORE', aliases: ['away to score', 'away team to score', 'away score'] },
  { id: 'home_score_both_halves', name: 'Home to Score in Both Halves', category: 'team_goals', sport: 'football', type: 'TEAM_BOTH_HALVES', aliases: ['home score both halves', 'home to score in both halves'] },
  { id: 'away_score_both_halves', name: 'Away to Score in Both Halves', category: 'team_goals', sport: 'football', type: 'TEAM_BOTH_HALVES', aliases: ['away score both halves', 'away to score in both halves'] },

  // ---- Football: Team Goals Over/Under (46–55) ----
  { id: 'home_ou_0_5', name: 'Home Team Goals Over/Under 0.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 0.5, aliases: ['home over 0.5', 'home team over 0.5'] },
  { id: 'home_ou_1_5', name: 'Home Team Goals Over/Under 1.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 1.5, aliases: ['home over 1.5', 'home team over 1.5'] },
  { id: 'home_ou_2_5', name: 'Home Team Goals Over/Under 2.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 2.5, aliases: ['home over 2.5', 'home team over 2.5'] },
  { id: 'home_ou_generic', name: 'Home Team Total Goals', category: 'team_goals', sport: 'football', type: 'TEAM_OU', aliases: ['home team goals', 'home goals', 'total home'] },
  { id: 'away_ou_0_5', name: 'Away Team Goals Over/Under 0.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 0.5, aliases: ['away over 0.5', 'away team over 0.5'] },
  { id: 'away_ou_1_5', name: 'Away Team Goals Over/Under 1.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 1.5, aliases: ['away over 1.5', 'away team over 1.5'] },
  { id: 'away_ou_2_5', name: 'Away Team Goals Over/Under 2.5', category: 'team_goals', sport: 'football', type: 'TEAM_OU', line: 2.5, aliases: ['away over 2.5', 'away team over 2.5'] },
  { id: 'away_ou_generic', name: 'Away Team Total Goals', category: 'team_goals', sport: 'football', type: 'TEAM_OU', aliases: ['away team goals', 'away goals', 'total away'] },
  { id: 'home_1h_ou', name: 'Home 1st Half Goals Over/Under', category: 'team_goals', sport: 'football', type: 'TEAM_HALF_OU', aliases: ['home 1st half goals', 'home first half goals'] },
  { id: 'away_1h_ou', name: 'Away 1st Half Goals Over/Under', category: 'team_goals', sport: 'football', type: 'TEAM_HALF_OU', aliases: ['away 1st half goals', 'away first half goals'] },

  // ---- Football: Combo Markets (56–65) ----
  { id: 'result_btts', name: '1X2 & Both Teams to Score', category: 'combo', sport: 'football', type: 'BTTS_RESULT', aliases: ['result and btts', '1x2 and btts', 'win and btts', 'match result and btts'] },
  { id: 'dc_btts', name: 'Double Chance & Both Teams to Score', category: 'combo', sport: 'football', type: 'DC_BTTS', aliases: ['double chance and btts', 'dc and btts', 'dc & gg'] },
  { id: 'result_ou_1_5', name: '1X2 & Over/Under 1.5', category: 'combo', sport: 'football', type: 'RESULT_OU', line: 1.5, aliases: ['1x2 and over 1.5', 'result and over 1.5', 'win and over 1.5'] },
  { id: 'result_ou_2_5', name: '1X2 & Over/Under 2.5', category: 'combo', sport: 'football', type: 'RESULT_OU', line: 2.5, aliases: ['1x2 and over 2.5', 'result and over 2.5', 'win and over 2.5'] },
  { id: 'result_ou_3_5', name: '1X2 & Over/Under 3.5', category: 'combo', sport: 'football', type: 'RESULT_OU', line: 3.5, aliases: ['1x2 and over 3.5', 'result and over 3.5'] },
  { id: 'dc_ou_1_5', name: 'Double Chance & Over/Under 1.5', category: 'combo', sport: 'football', type: 'DC_OU', line: 1.5, aliases: ['double chance and over 1.5', 'dc and over 1.5'] },
  { id: 'dc_ou_2_5', name: 'Double Chance & Over/Under 2.5', category: 'combo', sport: 'football', type: 'DC_OU', line: 2.5, aliases: ['double chance and over 2.5', 'dc and over 2.5'] },
  { id: 'dc_ou_3_5', name: 'Double Chance & Over/Under 3.5', category: 'combo', sport: 'football', type: 'DC_OU', line: 3.5, aliases: ['double chance and over 3.5', 'dc and over 3.5'] },
  { id: 'btts_ou_2_5', name: 'BTTS & Over/Under 2.5', category: 'combo', sport: 'football', type: 'BTTS_OU', line: 2.5, aliases: ['btts and over 2.5', 'gg and over 2.5'] },
  { id: 'ht_ft_ou', name: 'HT/FT & Total Goals', category: 'combo', sport: 'football', type: 'HT_FT_OU', aliases: ['ht/ft and over', 'ht ft goals'] },

  // ---- Football: Handicaps (66–72) ----
  { id: 'asian_handicap', name: 'Asian Handicap', category: 'handicap', sport: 'football', type: 'HANDICAP', aliases: ['asian handicap', 'ah', 'handicap'] },
  { id: 'asian_handicap_1h', name: '1st Half Asian Handicap', category: 'handicap', sport: 'football', type: 'HALF_HANDICAP', aliases: ['1st half asian handicap', 'first half handicap', '1h ah'] },
  { id: 'asian_handicap_2h', name: '2nd Half Asian Handicap', category: 'handicap', sport: 'football', type: 'HALF2_HANDICAP', aliases: ['2nd half asian handicap', 'second half handicap'] },
  { id: 'european_handicap', name: '3-Way / European Handicap', category: 'handicap', sport: 'football', type: 'EU_HANDICAP', aliases: ['european handicap', '3-way handicap', '3 way handicap', 'eh'] },
  { id: 'asian_total', name: 'Asian Total Goals', category: 'goals', sport: 'football', type: 'ASIAN_OU', aliases: ['asian total', 'asian goals', 'asian over under'] },
  { id: 'winning_margin', name: 'Winning Margin', category: 'result', sport: 'football', type: 'WINNING_MARGIN', aliases: ['winning margin', 'win margin'] },
  { id: 'win_from_behind', name: 'To Win From Behind', category: 'special', sport: 'football', type: 'SPECIAL', aliases: ['win from behind', 'comeback win'] },

  // ---- Football: Exact, Ranges, Odd/Even, Timing (73–84) ----
  { id: 'odd_even', name: 'Total Goals Odd/Even', category: 'goals', sport: 'football', type: 'ODD_EVEN', aliases: ['odd even', 'odd/even', 'goals odd even'] },
  { id: 'odd_even_1h', name: '1st Half Goals Odd/Even', category: 'half_goals', sport: 'football', type: 'HALF_ODD_EVEN', aliases: ['1st half odd even', 'first half odd/even'] },
  { id: 'exact_goals', name: 'Exact Total Goals', category: 'goals', sport: 'football', type: 'EXACT_GOALS', aliases: ['exact goals', 'exact total goals'] },
  { id: 'home_exact_goals', name: 'Home Exact Goals', category: 'team_goals', sport: 'football', type: 'EXACT_GOALS', aliases: ['home exact goals'] },
  { id: 'away_exact_goals', name: 'Away Exact Goals', category: 'team_goals', sport: 'football', type: 'EXACT_GOALS', aliases: ['away exact goals'] },
  { id: 'multi_goals', name: 'Multi-Goals / Goal Range', category: 'goals', sport: 'football', type: 'MULTI_GOALS', aliases: ['multi goals', 'multigoals', 'goal range', 'goals range', '1-3 goals', '2-3 goals', '2-4 goals'] },
  { id: 'home_multi_goals', name: 'Home Multi-Goals', category: 'team_goals', sport: 'football', type: 'MULTI_GOALS', aliases: ['home multi goals', 'home goal range'] },
  { id: 'away_multi_goals', name: 'Away Multi-Goals', category: 'team_goals', sport: 'football', type: 'MULTI_GOALS', aliases: ['away multi goals', 'away goal range'] },
  { id: 'correct_score', name: 'Correct Score', category: 'score', sport: 'football', type: 'CORRECT_SCORE', aliases: ['correct score', 'exact score', 'cs'] },
  { id: 'correct_score_1h', name: '1st Half Correct Score', category: 'score', sport: 'football', type: 'HALF_CORRECT_SCORE', aliases: ['1st half correct score', 'half time correct score', 'ht cs'] },
  { id: 'first_team_to_score', name: 'First Team to Score', category: 'timing', sport: 'football', type: 'FIRST_TO_SCORE', aliases: ['first team to score', 'first goal', 'team to score first', '1st goal'] },
  { id: 'last_team_to_score', name: 'Last Team to Score', category: 'timing', sport: 'football', type: 'LAST_TO_SCORE', aliases: ['last team to score', 'last goal', 'team to score last'] },

  // ---- Football: Corners, Cards, Shots, Stats (85–99) ----
  { id: 'corners_ou', name: 'Total Corners Over/Under', category: 'corners', sport: 'football', type: 'STAT_OU', stat: 'corner', aliases: ['corners', 'total corners', 'corners over', 'corners under', 'corner'] },
  { id: 'corners_1h_ou', name: '1st Half Corners Over/Under', category: 'corners', sport: 'football', type: 'STAT_OU', stat: 'corner', aliases: ['1st half corners', 'first half corners'] },
  { id: 'corners_2h_ou', name: '2nd Half Corners Over/Under', category: 'corners', sport: 'football', type: 'STAT_OU', stat: 'corner', aliases: ['2nd half corners', 'second half corners'] },
  { id: 'corners_1x2', name: 'Most Corners (1X2)', category: 'corners', sport: 'football', type: 'CORNERS_1X2', aliases: ['most corners', 'corners 1x2', 'corner winner'] },
  { id: 'corners_handicap', name: 'Corners Handicap', category: 'corners', sport: 'football', type: 'CORNERS_HANDICAP', aliases: ['corners handicap', 'corner handicap'] },
  { id: 'home_corners_ou', name: 'Home Team Corners Over/Under', category: 'corners', sport: 'football', type: 'STAT_OU', stat: 'corner', aliases: ['home corners'] },
  { id: 'away_corners_ou', name: 'Away Team Corners Over/Under', category: 'corners', sport: 'football', type: 'STAT_OU', stat: 'corner', aliases: ['away corners'] },
  { id: 'corners_race', name: 'Race to Corners', category: 'corners', sport: 'football', type: 'CORNERS_RACE', aliases: ['race to corners', 'first to corners'] },
  { id: 'cards_ou', name: 'Total Cards / Bookings Over/Under', category: 'cards', sport: 'football', type: 'STAT_OU', stat: 'card', aliases: ['cards', 'bookings', 'total cards', 'total bookings', 'yellow cards'] },
  { id: 'cards_1h_ou', name: '1st Half Cards Over/Under', category: 'cards', sport: 'football', type: 'STAT_OU', stat: 'card', aliases: ['1st half cards', 'first half cards', 'first half bookings'] },
  { id: 'home_cards_ou', name: 'Home Team Cards Over/Under', category: 'cards', sport: 'football', type: 'STAT_OU', stat: 'card', aliases: ['home cards', 'home bookings'] },
  { id: 'away_cards_ou', name: 'Away Team Cards Over/Under', category: 'cards', sport: 'football', type: 'STAT_OU', stat: 'card', aliases: ['away cards', 'away bookings'] },
  { id: 'red_card', name: 'Red Card in Match (Yes/No)', category: 'cards', sport: 'football', type: 'RED_CARD', aliases: ['red card', 'sending off'] },
  { id: 'penalty_awarded', name: 'Penalty Awarded (Yes/No)', category: 'special', sport: 'football', type: 'PENALTY', aliases: ['penalty', 'penalty awarded', 'penalty in match'] },
  { id: 'shots_on_target_ou', name: 'Shots on Target Over/Under', category: 'stats', sport: 'football', type: 'STAT_OU', stat: 'shot', aliases: ['shots on target', 'sot', 'total shots'] },
  { id: 'offsides_ou', name: 'Total Offsides Over/Under', category: 'stats', sport: 'football', type: 'STAT_OU', stat: 'offside', aliases: ['offsides', 'total offsides'] },
  { id: 'fouls_ou', name: 'Total Fouls Over/Under', category: 'stats', sport: 'football', type: 'STAT_OU', stat: 'foul', aliases: ['fouls', 'total fouls'] },
  { id: 'anytime_scorer', name: 'Anytime Goalscorer', category: 'player', sport: 'football', type: 'PLAYER', aliases: ['anytime scorer', 'anytime goalscorer', 'player to score'] },
  { id: 'first_scorer', name: 'First Goalscorer', category: 'player', sport: 'football', type: 'PLAYER', aliases: ['first goalscorer', 'first scorer'] },
  { id: 'goal_interval', name: 'Time of First Goal / 10-Min Result', category: 'timing', sport: 'football', type: 'TIMING', aliases: ['time of first goal', '10 minute', '15 minute', 'goal interval'] },

  // ---- Basketball (105–110) ----
  { id: 'bball_moneyline', name: 'Basketball Match Winner (Incl. OT)', category: 'result', sport: 'basketball', type: 'WIN', aliases: ['basketball winner', 'moneyline', 'incl ot', 'winner incl overtime'] },
  { id: 'bball_spread', name: 'Basketball Point Spread / Handicap', category: 'handicap', sport: 'basketball', type: 'HANDICAP', aliases: ['point spread', 'basketball handicap', 'spread'] },
  { id: 'bball_total', name: 'Basketball Total Points Over/Under', category: 'points', sport: 'basketball', type: 'OU', aliases: ['total points', 'basketball over under', 'points o/u'] },
  { id: 'bball_team_total', name: 'Basketball Team Total Points', category: 'team_points', sport: 'basketball', type: 'TEAM_OU', aliases: ['team points', 'home points', 'away points'] },
  { id: 'bball_1h_total', name: 'Basketball 1st Half Total Points', category: 'half', sport: 'basketball', type: 'HALF_OU', aliases: ['basketball first half points', '1st half points'] },
  { id: 'bball_q1_winner', name: 'Basketball 1st Quarter Winner / Total', category: 'quarter', sport: 'basketball', type: 'QUARTER', aliases: ['1st quarter', 'first quarter', 'q1'] },

  // ---- Tennis (111–114) ----
  { id: 'tennis_winner', name: 'Tennis Match Winner', category: 'result', sport: 'tennis', type: 'WIN', aliases: ['tennis winner', 'match winner'] },
  { id: 'tennis_games_ou', name: 'Tennis Total Games Over/Under', category: 'games', sport: 'tennis', type: 'OU', aliases: ['total games', 'games over under'] },
  { id: 'tennis_set_handicap', name: 'Tennis Set Handicap', category: 'handicap', sport: 'tennis', type: 'HANDICAP', aliases: ['set handicap', 'games handicap'] },
  { id: 'tennis_set1_winner', name: 'Tennis 1st Set Winner', category: 'set', sport: 'tennis', type: 'SET_WIN', aliases: ['1st set winner', 'first set winner'] },

  // ---- Hockey (115–117) ----
  { id: 'hockey_1x2', name: 'Ice Hockey 1X2 (Regular Time)', category: 'result', sport: 'hockey', type: 'WIN', aliases: ['hockey 1x2', 'regular time', '3-way hockey'] },
  { id: 'hockey_total', name: 'Ice Hockey Total Goals Over/Under', category: 'goals', sport: 'hockey', type: 'OU', aliases: ['hockey goals', 'hockey over under'] },
  { id: 'hockey_puck_line', name: 'Ice Hockey Puck Line / Handicap', category: 'handicap', sport: 'hockey', type: 'HANDICAP', aliases: ['puck line', 'hockey handicap'] },

  // ---- Baseball (118–120) ----
  { id: 'baseball_ml', name: 'Baseball Moneyline (Match Winner)', category: 'result', sport: 'baseball', type: 'WIN', aliases: ['baseball winner', 'baseball moneyline'] },
  { id: 'baseball_runs_ou', name: 'Baseball Total Runs Over/Under', category: 'runs', sport: 'baseball', type: 'OU', aliases: ['total runs', 'runs over under'] },
  { id: 'baseball_run_line', name: 'Baseball Run Line / Handicap', category: 'handicap', sport: 'baseball', type: 'HANDICAP', aliases: ['run line', 'baseball handicap'] },
];

// Lightweight character similarity for handling user typos ("doubel chanse", "btts", "coners")
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// Resolve a natural-language user market phrase into structured filter criteria
function resolveMarketFilter(raw) {
  const lower = String(raw || '').toLowerCase();
  const q = norm(raw);
  if (!q) return null;

  // Check explicit Over/Under direction + decimal line on raw lowercase string before norm() strips "."
  const ouMatch = /\b(over|under|ov|un)\s*(\d+(?:\.\d+)?)\b/.exec(lower);
  const direction = ouMatch ? (/^(over|ov)$/.test(ouMatch[1]) ? 'O' : 'U') : null;
  const line = ouMatch ? parseFloat(ouMatch[2]) : null;
  const isFirstHalf = /\b(1st|first|1h|half ?time|ht)\b/.test(q);
  const isSecondHalf = /\b(2nd|second|2h)\b/.test(q);

  if (ouMatch) {
    if (/corner/.test(q)) return { type: 'STAT_OU', stat: 'corner', side: direction, line, raw };
    if (/card|booking/.test(q)) return { type: 'STAT_OU', stat: 'card', side: direction, line, raw };
    if (/\bhome\b/.test(q)) return { type: 'TEAM_OU', teamSide: 'H', side: direction, line, raw };
    if (/\baway\b/.test(q)) return { type: 'TEAM_OU', teamSide: 'A', side: direction, line, raw };
    if (isFirstHalf) return { type: 'HALF_OU', side: direction, line, raw };
    if (isSecondHalf) return { type: 'HALF2_OU', side: direction, line, raw };
    return { type: 'OU', side: direction, line, raw };
  }

  // Exact / substring alias match across the 120-market catalogue
  for (const entry of CATALOG) {
    for (const alias of entry.aliases) {
      const na = norm(alias);
      if (q === na || q.includes(na) || (q.length >= 4 && na.includes(q))) {
        const filter = { id: entry.id, name: entry.name, type: entry.type, raw };
        if (entry.line != null) filter.line = entry.line;
        if (entry.stat) filter.stat = entry.stat;
        if (entry.type === 'BTTS') {
          if (/\b(no|ng|not)\b/.test(q)) filter.side = 'N';
          else if (/\b(yes|gg)\b/.test(q)) filter.side = 'Y';
        }
        return filter;
      }
    }
  }

  // Typo-tolerant fallback against aliases (edit distance <= 2 for tokens >= 5 chars)
  let best = null;
  let bestDist = 3;
  for (const entry of CATALOG) {
    for (const alias of entry.aliases) {
      const na = norm(alias);
      if (na.length < 5 || Math.abs(na.length - q.length) > 2) continue;
      const d = levenshtein(q, na);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
  }
  if (best) {
    const filter = { id: best.id, name: best.name, type: best.type, raw };
    if (best.line != null) filter.line = best.line;
    if (best.stat) filter.stat = best.stat;
    return filter;
  }
  return null;
}

// Match an extracted BangBet market candidate against resolved user market filters
function matchesMarketFilter(cand, rawFilters) {
  if (!Array.isArray(rawFilters) || !rawFilters.length) return true;
  const filters = rawFilters.map((f) => (typeof f === 'string' ? resolveMarketFilter(f) : f)).filter(Boolean);
  if (!filters.length) return true;
  return filters.some((f) => {
    if (f.type && cand.marketType && f.type !== cand.marketType) return false;
    if (f.stat && cand.stat && f.stat !== cand.stat) return false;
    if (f.side && cand.side && f.side !== cand.side) return false;
    if (f.teamSide && cand.teamSide && f.teamSide !== cand.teamSide) return false;
    if (f.line != null && cand.line != null && Math.abs(Number(f.line) - Number(cand.line)) > 0.01) return false;
    if (f.line != null && cand.line == null) return false;
    return true;
  });
}

// Lookup canonical catalogue metadata for a classified BangBet market
function catalogFor(classified) {
  if (!classified || !classified.type) return null;
  if (classified.line != null) {
    const exact = CATALOG.find((c) => c.type === classified.type && c.line === classified.line);
    if (exact) return exact;
  }
  if (classified.stat) {
    const byStat = CATALOG.find((c) => c.type === classified.type && c.stat === classified.stat);
    if (byStat) return byStat;
  }
  return CATALOG.find((c) => c.type === classified.type) || null;
}

module.exports = { CATALOG, resolveMarketFilter, matchesMarketFilter, catalogFor };
