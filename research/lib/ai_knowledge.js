'use strict';
// Permanent, version-controlled statistical knowledge guide for the BetRobot Groq AI Analyst.
// Teaches the AI how to interpret BangBet / Sportradar statistics accurately per sport,
// how to distinguish home/away/overall splits and league averages, how to handle small samples,
// contradictory evidence, and missing fields, and how to map evidence to approved markets.

const FOOTBALL_STATS_GUIDE = `
PERMANENT FOOTBALL STATISTICAL KNOWLEDGE GUIDE (BANGBET / SPORTRADAR)

1. FIELD MEANINGS & CONTEXT RULES
- Match Identity: Competition, kick-off date/time (Africa/Kampala), Home team, Away team, Match ID.
- Head-to-Head (H2H) Team Averages vs League Comparison:
  * H2H Avg Goals, BTTS %, Over 1.5 %, Over 2.5 %, Total Cards, Corners reflect historical meetings between these teams (or combined team averages).
  * League Average Comparison is the competition baseline, NOT the team's own average. Never confuse a league average with a team's own average.
- Win Probability: Always ordered [Home Win %, Draw %, Away Win %]. This is a pre-match provider estimate, not guaranteed truth.
- Previous Meetings: Count of Home wins, Draws, Away wins. Small H2H samples (e.g. 1-3 matches) or old meetings carry lower weight than recent season form.
- League Standings: Position (POS), Matches Played (MP), Points (PTS). Compare points-per-game when MP differs.
- Last Matches Form (3 SEPARATE ROWS per team — NEVER MIX):
  * Overall: last 5 matches across both home and away.
  * Home: last 5 matches played strictly at home.
  * Away: last 5 matches played strictly away.
  * Notation: W = Win (Green), L = Loss (Yellow), D = Draw (Grey). Order is preserved as reported.
  * For the Home team, weight Home-only form heavily; for the Away team, weight Away-only form heavily. Flag conflicts between Overall and Home/Away form as contradictory evidence.
- Additional Form Percentages:
  * HT WIN %: Percentage of matches in which the team was leading at half-time.
  * FTS (Failed To Score %): Percentage of matches in which the team scored 0 goals. High FTS supports BTTS-No and cautions against Team Total Over 0.5.
  * CS (Clean Sheet %): Percentage of matches in which the team conceded 0 goals. High CS supports BTTS-No and Under markets.
- Team Statistics Comparison (both teams):
  * Matches played (sample size), Win %, Total goals scored, Avg goals scored, Avg goals conceded, BTTS %, Over 1.5 %, Over 2.5 %, First-Half Over 0.5 %, First-Half Over 1.5 %, Yellow cards, Total cards (incl. red), Corners avg.
- First-Half vs Second-Half Indicators:
  * Use genuine 1H and 2H scoring rates, HT WIN %, HT Over 0.5 %, HT Over 1.5 % for half markets (1st Half Total Over 0.5, 2nd Half Total Over 0.5, 1st Half Double Chance, To Win Either Half, To Score In Both Halves - No, Highest Scoring Half - Second Half).
  * Never assume 1H and 2H scoring are identical without half-specific statistics.

2. DATA QUALITY, SAMPLE SIZE & CONTRADICTION RULES
- Missing values are MISSING, never zero. Never invent or guess missing statistics.
- Small sample sizes (< 5 matches) reduce confidence; state sample limitations explicitly.
- Corners markets (Corner 1X2) MUST use actual corner statistics per side. NEVER use goal statistics as a substitute for corner evidence.
- Cards evidence uses yellow/total card averages, not goals.
- If evidence is contradictory, insufficient, or missing key required stats for all available markets, you MUST return noSelection: true with a clear noSelectionReason. Never force a pick.
- Do not rank markets solely because odds are high. Do not rank multiple highly correlated markets (e.g. 1X2 Home, 1X2 1UP Home, Asian Handicap +0.5 Home) as if they were independent when distinct well-supported alternatives exist.
`;

const SPORT_GUIDES = {
  football: FOOTBALL_STATS_GUIDE,
  basketball: `
PERMANENT BASKETBALL STATISTICAL KNOWLEDGE GUIDE
- NEVER apply football goal or Poisson assumptions to basketball.
- Basketball scoring is high-volume (typically 70-130 points per team) and follows Normal-like point totals and margins.
- Always distinguish Regulation Time (4 quarters, draw possible in 1X2 Regulation) from Full Game including Overtime (Winner incl. OT, Total incl. OT, Handicap incl. OT, Team Total incl. OT).
- Key evidence: team points scored/conceded averages, recent home/away form, win strength, head-to-head margins, and sample size.
- Return noSelection: true if scoring averages or form are missing/contradictory.
`,
  tennis: `
PERMANENT TENNIS STATISTICAL KNOWLEDGE GUIDE
- NEVER apply football or team-sport assumptions to tennis. There is NO draw in tennis.
- Key evidence: recent match win/loss form (W/L), head-to-head record, provider win probabilities, and recent set-count history (straight sets vs 3-setters).
- Only recommend Total Sets or Set Handicap if genuine set-count history exists; never fabricate game or tiebreak stats.
- Return noSelection: true when form and probabilities are weak, missing, or contradictory.
`,
  baseball: `
PERMANENT BASEBALL STATISTICAL KNOWLEDGE GUIDE
- NEVER apply football assumptions to baseball.
- Distinguish Full Game including Extra Innings (Winner incl. EI, Total Runs incl. EI, Run Line incl. EI, Team Total Runs incl. EI) from 9-Inning Regulation (1X2 9 Innings).
- Key evidence: average runs scored/conceded per game, home/away form, H2H record, and win probabilities.
- Return noSelection: true when run averages or form are insufficient or contradictory.
`,
  hockey: `
PERMANENT ICE HOCKEY STATISTICAL KNOWLEDGE GUIDE
- NEVER blindly apply football rules to ice hockey.
- Strictly distinguish 60-Minute Regulation markets (1X2 Regulation, Double Chance Regulation, Draw No Bet Regulation, Total Goals Regulation, Team Total Regulation, Puck Line Regulation) from Full-Game including OT & Shootout (Winner incl. OT & penalties).
- Key evidence: regulation goals scored/conceded (typically 2.0-4.0 per team), home/away form, H2H, and standings.
- Return noSelection: true when regulation stats are missing or contradictory.
`,
};

function getKnowledgeGuideForSport(sport) {
  const sp = String(sport || 'football').toLowerCase();
  return (SPORT_GUIDES[sp] || SPORT_GUIDES.football).trim();
}

module.exports = {
  FOOTBALL_STATS_GUIDE,
  SPORT_GUIDES,
  getKnowledgeGuideForSport,
};
