# BetRobot Permanent AI Statistical Knowledge Guide

This version-controlled document mirrors `research/lib/ai_knowledge.js` and defines the permanent statistical interpretation rules supplied to the backend Groq AI analyst.

## Football (BangBet / Sportradar Stats)

| Section | Fields | Interpretation Rules |
|---|---|---|
| **Match Identity** | Competition, Kick-off (`Africa/Kampala`), Home, Away, Match ID | Anchor all team attribution strictly to Home vs Away. |
| **Head-to-Head Team Averages** | Avg Goals, League Avg Comparison, BTTS %, Over 1.5 %, Over 2.5 %, Total Cards, Cards/Side, Total Corners, Corners/Side | Never confuse the League Average baseline with the team's own average. |
| **Win Probability** | Home %, Draw %, Away % | Always preserve `[Home, Draw, Away]` order; treat as provider pre-match estimate. |
| **Previous Meetings** | Home Wins, Draws, Away Wins | Weight by sample size and recency; 0 prior meetings is not an error. |
| **League Standings** | Position, Matches Played, Points | Account for games in hand (points per game). |
| **Last Matches Form** | Overall (5), Home (5), Away (5) | `W` = Win (Green), `L` = Loss (Yellow), `D` = Draw (Grey). Never mix Overall with Home or Away splits. |
| **Form Percentages** | `HT WIN %`, `FTS`, `CS` | `HT WIN %` = leading at half-time; `FTS` = failed to score; `CS` = clean sheet. |
| **Team Stats Comparison** | MP, Win %, Total Goals, Avg Scored/Conceded, BTTS %, O1.5 %, O2.5 %, HT O0.5 %, HT O1.5 %, Yellow Cards, Total Cards (incl. Red), Corners | Missing fields remain `null` (`missing`), never `0`. |

## Sport-Specific Separation

- **Basketball**: Points-based Normal scoring & spreads; separate Regulation vs Incl. Overtime.
- **Tennis**: 2-way match winner (no draw) and set-count markets only when set history exists.
- **Baseball**: Run-based totals/run-lines; separate 9-Inning Regulation vs Incl. Extra Innings.
- **Ice Hockey**: 60-minute Regulation vs Incl. OT & Shootout.

## Decision Discipline

1. Never invent missing statistics or markets.
2. Never use goal stats to justify Corner 1X2.
3. Return `NO SELECTION` (`noSelection: true`) whenever evidence is missing, small-sample, or contradictory.
4. Rank up to 3 suitable markets strictly from the live bookmaker catalogue for that fixture.
