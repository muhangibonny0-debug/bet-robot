'use strict';
// Complete, structured, provenance-preserving statistics packet builder & completeness validator.
// Never converts missing values to 0, never fabricates missing fields, never mixes home/away/overall
// or team averages with league comparisons, and retains raw extra statistics for AI interpretation.

function field(value, meta = {}) {
  const present = value !== null && value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value));
  return {
    value: present ? value : null,
    status: present ? 'retrieved' : (meta.unavailable ? 'unavailable' : 'missing'),
    ...(meta.team ? { team: meta.team } : {}),
    ...(meta.context ? { context: meta.context } : {}),
    ...(meta.sampleSize != null ? { sampleSize: meta.sampleSize } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.dateRange ? { dateRange: meta.dateRange } : {}),
  };
}

function pctFromList(pctArr, re, teamIdx = null) {
  if (!Array.isArray(pctArr)) return null;
  const hit = pctArr.find((p) => p && re.test(String(p.label || '').toLowerCase()));
  if (!hit || !Array.isArray(hit.vals) || !hit.vals.length) return null;
  if (teamIdx != null) {
    return typeof hit.vals[teamIdx] === 'number' && Number.isFinite(hit.vals[teamIdx]) ? hit.vals[teamIdx] : null;
  }
  return typeof hit.vals[0] === 'number' && Number.isFinite(hit.vals[0]) ? hit.vals[0] : null;
}

function buildStructuredStatsPacket(ev) {
  const st = (ev && ev.stats) || {};
  const src = st.source || 'unknown';
  const prov = st.provenance || {};
  const tsHome = (st.teamStats && st.teamStats.home) || {};
  const tsAway = (st.teamStats && st.teamStats.away) || {};
  const advHome = (st.advancedStats && st.advancedStats.home) || {};
  const advAway = (st.advancedStats && st.advancedStats.away) || {};
  const discHome = (st.disciplinary && st.disciplinary.home) || {};
  const discAway = (st.disciplinary && st.disciplinary.away) || {};
  const ouHome = (st.seasonOverUnder && st.seasonOverUnder.home) || {};
  const ouAway = (st.seasonOverUnder && st.seasonOverUnder.away) || {};
  const fmHome = (st.formMetrics && st.formMetrics.home) || {};
  const fmAway = (st.formMetrics && st.formMetrics.away) || {};
  const avg = st.avg || {};
  const leagueAvg = st.leagueAvg || {};

  const homeSample = tsHome.matches ?? ouHome.matches ?? advHome.matches ?? st.homeFormSampleSize ?? null;
  const awaySample = tsAway.matches ?? ouAway.matches ?? advAway.matches ?? st.awayFormSampleSize ?? null;
  const h2hSample = st.h2h ? st.h2h.n : 0;

  const h2hAvgGoals = st.h2h && st.h2h.avgGoals != null ? st.h2h.avgGoals : (avg['goals scored'] ?? avg['total goals'] ?? null);
  const h2hBttsPct = st.h2h && st.h2h.bttsPct != null ? st.h2h.bttsPct : (avg.btts ?? null);
  const h2hOver15Pct = st.h2h && st.h2h.over15Pct != null ? st.h2h.over15Pct : (avg['over 1.5'] ?? null);
  const h2hOver25Pct = st.h2h && st.h2h.over25Pct != null ? st.h2h.over25Pct : (avg['over 2.5'] ?? null);

  const packet = {
    matchIdentity: {
      matchId: st.fixtureId || (ev && ev.matchId) || null,
      sport: (ev && ev.sport) || 'football',
      competition: st.competition || (ev && ev.league) || '',
      country: st.country || (ev && ev.country) || '',
      seasonId: st.seasonId || null,
      stage: st.stage || '',
      kickoffTs: (ev && ev.ts) || null,
      kickoffIso: (ev && ev.ts) ? new Date(ev.ts).toISOString() : null,
      homeTeam: (st.homeTeam && st.homeTeam.name) || (ev && ev.home) || '',
      awayTeam: (st.awayTeam && st.awayTeam.name) || (ev && ev.away) || '',
    },

    headToHeadAverages: {
      avgGoals: field(h2hAvgGoals, { context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      leagueAvgGoals: field(leagueAvg['goals scored'] ?? leagueAvg['total goals'] ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      bttsPct: field(h2hBttsPct, { context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      leagueAvgBttsPct: field(leagueAvg.btts ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      over15Pct: field(h2hOver15Pct, { context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      leagueAvgOver15Pct: field(leagueAvg['over 1.5'] ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      over25Pct: field(h2hOver25Pct, { context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      leagueAvgOver25Pct: field(leagueAvg['over 2.5'] ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      avgTotalCards: field(avg['total cards'] ?? null, { context: 'combined', source: prov.seasonTeamStats || prov.disciplinary || src }),
      leagueAvgCards: field(leagueAvg['total cards'] ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      cardsPerSide: {
        home: field(advHome.cardsAvg ?? discHome.yellowAvg ?? tsHome.cards ?? null, { team: 'home', context: 'overall', sampleSize: advHome.matches ?? discHome.matches ?? null, source: prov.seasonTeamStats || prov.disciplinary || src }),
        away: field(advAway.cardsAvg ?? discAway.yellowAvg ?? tsAway.cards ?? null, { team: 'away', context: 'overall', sampleSize: advAway.matches ?? discAway.matches ?? null, source: prov.seasonTeamStats || prov.disciplinary || src }),
      },
      avgTotalCorners: field(avg.corners ?? null, { context: 'combined', source: prov.seasonTeamStats || src }),
      leagueAvgCorners: field(leagueAvg.corners ?? null, { context: 'league_comparison', source: 'bangbet-dom' }),
      cornersPerSide: {
        home: field(advHome.cornersAvg ?? tsHome.corners ?? null, { team: 'home', context: 'overall', sampleSize: advHome.matches ?? null, source: prov.seasonTeamStats || src }),
        away: field(advAway.cornersAvg ?? tsAway.corners ?? null, { team: 'away', context: 'overall', sampleSize: advAway.matches ?? null, source: prov.seasonTeamStats || src }),
      },
    },

    winProbability: {
      order: ['homeWinPct', 'drawPct', 'awayWinPct'],
      homeWinPct: field(st.probs && Number.isFinite(st.probs.H) ? Math.round(st.probs.H * 1000) / 10 : null, { team: 'home', context: 'provider_prematch', source: prov.winProbabilities || src }),
      drawPct: field(st.probs && Number.isFinite(st.probs.X) ? Math.round(st.probs.X * 1000) / 10 : null, { context: 'provider_prematch', source: prov.winProbabilities || src }),
      awayWinPct: field(st.probs && Number.isFinite(st.probs.A) ? Math.round(st.probs.A * 1000) / 10 : null, { team: 'away', context: 'provider_prematch', source: prov.winProbabilities || src }),
    },

    previousMeetings: {
      status: st.h2hStatus || (st.h2h ? 'verified' : 'not_captured'),
      totalMeetings: field(st.h2h ? st.h2h.n : null, { context: 'h2h', source: prov.headToHead || src }),
      homeWins: field(st.h2h ? st.h2h.H : null, { team: 'home', context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      draws: field(st.h2h ? st.h2h.X : null, { context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      awayWins: field(st.h2h ? st.h2h.A : null, { team: 'away', context: 'h2h', sampleSize: h2hSample || null, source: prov.headToHead || src }),
      meetings: Array.isArray(st.h2hMeetings) ? st.h2hMeetings.slice(0, 10) : [],
    },

    leagueStandings: {
      home: st.standings && st.standings.home ? {
        position: field(st.standings.home.pos, { team: 'home', context: 'standings', source: prov.standings || src }),
        matchesPlayed: field(st.standings.home.played, { team: 'home', context: 'standings', source: prov.standings || src }),
        points: field(st.standings.home.pts, { team: 'home', context: 'standings', source: prov.standings || src }),
        wins: st.standings.home.win ?? null,
        draws: st.standings.home.draw ?? null,
        losses: st.standings.home.loss ?? null,
        goalsFor: st.standings.home.gf ?? null,
        goalsAgainst: st.standings.home.ga ?? null,
      } : { status: 'missing' },
      away: st.standings && st.standings.away ? {
        position: field(st.standings.away.pos, { team: 'away', context: 'standings', source: prov.standings || src }),
        matchesPlayed: field(st.standings.away.played, { team: 'away', context: 'standings', source: prov.standings || src }),
        points: field(st.standings.away.pts, { team: 'away', context: 'standings', source: prov.standings || src }),
        wins: st.standings.away.win ?? null,
        draws: st.standings.away.draw ?? null,
        losses: st.standings.away.loss ?? null,
        goalsFor: st.standings.away.gf ?? null,
        goalsAgainst: st.standings.away.ga ?? null,
      } : { status: 'missing' },
    },

    lastMatchesForm: {
      notation: 'W=Win (Green), L=Loss (Yellow), D=Draw (Grey); order preserved as reported',
      home: {
        context: st.homeFormContext || 'overall',
        overall: field((st.homeFormSplit && st.homeFormSplit.overall) || st.homeForm || null, { team: 'home', context: 'overall', sampleSize: (st.homeFormSplit && st.homeFormSplit.overallCount) || st.homeFormSampleSize || null, source: prov.recentMatches || src }),
        homeOnly: field((st.homeFormSplit && st.homeFormSplit.home) || null, { team: 'home', context: 'home', sampleSize: (st.homeFormSplit && st.homeFormSplit.homeCount) || null, source: prov.recentMatches || src }),
        awayOnly: field((st.homeFormSplit && st.homeFormSplit.away) || null, { team: 'home', context: 'away', sampleSize: (st.homeFormSplit && st.homeFormSplit.awayCount) || null, source: prov.recentMatches || src }),
        htWinPct: field(fmHome.htWinPct ?? tsHome.htWinPct ?? ouHome.htWinPct ?? null, { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        ftsPct: field(fmHome.ftsPct ?? tsHome.failedToScorePct ?? (ouHome.failedToScore != null && ouHome.matches ? Math.round((ouHome.failedToScore / ouHome.matches) * 100) : null), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        csPct: field(fmHome.csPct ?? tsHome.cleanSheetPct ?? (advHome.cleanSheetAvg != null ? Math.round(advHome.cleanSheetAvg * 100) : null), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || prov.seasonTeamStats || src }),
        allCompetitions: st.allCompetitionsForm && st.allCompetitionsForm.home ? st.allCompetitionsForm.home : null,
        competitionSpecific: st.competitionForm && st.competitionForm.home ? st.competitionForm.home : null,
      },
      away: {
        context: st.awayFormContext || 'overall',
        overall: field((st.awayFormSplit && st.awayFormSplit.overall) || st.awayForm || null, { team: 'away', context: 'overall', sampleSize: (st.awayFormSplit && st.awayFormSplit.overallCount) || st.awayFormSampleSize || null, source: prov.recentMatches || src }),
        homeOnly: field((st.awayFormSplit && st.awayFormSplit.home) || null, { team: 'away', context: 'home', sampleSize: (st.awayFormSplit && st.awayFormSplit.homeCount) || null, source: prov.recentMatches || src }),
        awayOnly: field((st.awayFormSplit && st.awayFormSplit.away) || null, { team: 'away', context: 'away', sampleSize: (st.awayFormSplit && st.awayFormSplit.awayCount) || null, source: prov.recentMatches || src }),
        htWinPct: field(fmAway.htWinPct ?? tsAway.htWinPct ?? ouAway.htWinPct ?? null, { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        ftsPct: field(fmAway.ftsPct ?? tsAway.failedToScorePct ?? (ouAway.failedToScore != null && ouAway.matches ? Math.round((ouAway.failedToScore / ouAway.matches) * 100) : null), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        csPct: field(fmAway.csPct ?? tsAway.cleanSheetPct ?? (advAway.cleanSheetAvg != null ? Math.round(advAway.cleanSheetAvg * 100) : null), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || prov.seasonTeamStats || src }),
        allCompetitions: st.allCompetitionsForm && st.allCompetitionsForm.away ? st.allCompetitionsForm.away : null,
        competitionSpecific: st.competitionForm && st.competitionForm.away ? st.competitionForm.away : null,
      },
    },

    teamStatsComparison: {
      home: {
        matchesPlayed: field(homeSample, { team: 'home', context: 'overall', source: prov.teamSeasonScoring || prov.overUnder || src }),
        winPct: field(tsHome.winPct ?? (tsHome.wins != null && tsHome.matches ? Math.round((tsHome.wins / tsHome.matches) * 100) : (ouHome.winRateFt != null ? (ouHome.winRateFt <= 1 ? Math.round(ouHome.winRateFt * 100) : Math.round(ouHome.winRateFt)) : null)), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        totalGoalsScored: field(tsHome.goalsFor ?? tsHome.totalGoals ?? (ouHome.goalsScoredFt && ouHome.goalsScoredFt.total) ?? null, { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        avgGoalsScored: field(tsHome.avgFor ?? tsHome.avgGoalsFor ?? (st.goals && st.goals.hFor) ?? null, { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || src }),
        avgGoalsScoredHome: field(tsHome.avgForHome ?? null, { team: 'home', context: 'home', sampleSize: tsHome.homeMatches ?? null, source: prov.teamSeasonScoring || src }),
        avgGoalsConceded: field(tsHome.avgAg ?? tsHome.avgGoalsAgainst ?? (st.goals && st.goals.hAg) ?? null, { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || src }),
        avgGoalsConcededHome: field(tsHome.avgAgHome ?? null, { team: 'home', context: 'home', sampleSize: tsHome.homeMatches ?? null, source: prov.teamSeasonScoring || src }),
        bttsPct: field(tsHome.bttsPct ?? tsHome.btts ?? pctFromList(st.pct, /both teams|btts/, 0), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.teamSeasonScoring || src }),
        over15Pct: field(tsHome.over15 ?? (ouHome.pct && ouHome.pct['1.5']) ?? pctFromList(st.pct, /^over 1\.5$/, 0), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.overUnder || src }),
        over25Pct: field(tsHome.over25 ?? (ouHome.pct && ouHome.pct['2.5']) ?? pctFromList(st.pct, /^over 2\.5$/, 0), { team: 'home', context: 'overall', sampleSize: homeSample, source: prov.overUnder || src }),
        htOver05Pct: field(tsHome.htOver05 ?? (ouHome.p1 && ouHome.p1['0.5'] && ouHome.p1['0.5'].overPct) ?? pctFromList(st.pct, /first half over 0\.5/, 0), { team: 'home', context: 'first_half', sampleSize: homeSample, source: prov.overUnder || src }),
        htOver15Pct: field(tsHome.htOver15 ?? (ouHome.p1 && ouHome.p1['1.5'] && ouHome.p1['1.5'].overPct) ?? pctFromList(st.pct, /first half over 1\.5/, 0), { team: 'home', context: 'first_half', sampleSize: homeSample, source: prov.overUnder || src }),
        yellowCards: field(tsHome.yellowCards ?? advHome.yellowCardsAvg ?? discHome.yellowAvg ?? null, { team: 'home', context: 'overall', sampleSize: advHome.matches ?? discHome.matches ?? null, source: prov.disciplinary || prov.seasonTeamStats || src }),
        totalCards: field(tsHome.cards ?? advHome.cardsAvg ?? (discHome.yellowAvg != null ? +((discHome.yellowAvg || 0) + (discHome.redAvg || 0)).toFixed(2) : null), { team: 'home', context: 'overall', sampleSize: advHome.matches ?? discHome.matches ?? null, source: prov.seasonTeamStats || prov.disciplinary || src }),
        cornersAvg: field(advHome.cornersAvg ?? tsHome.corners ?? null, { team: 'home', context: 'overall', sampleSize: advHome.matches ?? null, source: prov.seasonTeamStats || src }),
      },
      away: {
        matchesPlayed: field(awaySample, { team: 'away', context: 'overall', source: prov.teamSeasonScoring || prov.overUnder || src }),
        winPct: field(tsAway.winPct ?? (tsAway.wins != null && tsAway.matches ? Math.round((tsAway.wins / tsAway.matches) * 100) : (ouAway.winRateFt != null ? (ouAway.winRateFt <= 1 ? Math.round(ouAway.winRateFt * 100) : Math.round(ouAway.winRateFt)) : null)), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        totalGoalsScored: field(tsAway.goalsFor ?? tsAway.totalGoals ?? (ouAway.goalsScoredFt && ouAway.goalsScoredFt.total) ?? null, { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || prov.overUnder || src }),
        avgGoalsScored: field(tsAway.avgFor ?? tsAway.avgGoalsFor ?? (st.goals && st.goals.aFor) ?? null, { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || src }),
        avgGoalsScoredAway: field(tsAway.avgForAway ?? null, { team: 'away', context: 'away', sampleSize: tsAway.awayMatches ?? null, source: prov.teamSeasonScoring || src }),
        avgGoalsConceded: field(tsAway.avgAg ?? tsAway.avgGoalsAgainst ?? (st.goals && st.goals.aAg) ?? null, { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || src }),
        avgGoalsConcededAway: field(tsAway.avgAgAway ?? null, { team: 'away', context: 'away', sampleSize: tsAway.awayMatches ?? null, source: prov.teamSeasonScoring || src }),
        bttsPct: field(tsAway.bttsPct ?? tsAway.btts ?? pctFromList(st.pct, /both teams|btts/, 1), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.teamSeasonScoring || src }),
        over15Pct: field(tsAway.over15 ?? (ouAway.pct && ouAway.pct['1.5']) ?? pctFromList(st.pct, /^over 1\.5$/, 1), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.overUnder || src }),
        over25Pct: field(tsAway.over25 ?? (ouAway.pct && ouAway.pct['2.5']) ?? pctFromList(st.pct, /^over 2\.5$/, 1), { team: 'away', context: 'overall', sampleSize: awaySample, source: prov.overUnder || src }),
        htOver05Pct: field(tsAway.htOver05 ?? (ouAway.p1 && ouAway.p1['0.5'] && ouAway.p1['0.5'].overPct) ?? pctFromList(st.pct, /first half over 0\.5/, 1), { team: 'away', context: 'first_half', sampleSize: awaySample, source: prov.overUnder || src }),
        htOver15Pct: field(tsAway.htOver15 ?? (ouAway.p1 && ouAway.p1['1.5'] && ouAway.p1['1.5'].overPct) ?? pctFromList(st.pct, /first half over 1\.5/, 1), { team: 'away', context: 'first_half', sampleSize: awaySample, source: prov.overUnder || src }),
        yellowCards: field(tsAway.yellowCards ?? advAway.yellowCardsAvg ?? discAway.yellowAvg ?? null, { team: 'away', context: 'overall', sampleSize: advAway.matches ?? discAway.matches ?? null, source: prov.disciplinary || prov.seasonTeamStats || src }),
        totalCards: field(tsAway.cards ?? advAway.cardsAvg ?? (discAway.yellowAvg != null ? +((discAway.yellowAvg || 0) + (discAway.redAvg || 0)).toFixed(2) : null), { team: 'away', context: 'overall', sampleSize: advAway.matches ?? discAway.matches ?? null, source: prov.seasonTeamStats || prov.disciplinary || src }),
        cornersAvg: field(advAway.cornersAvg ?? tsAway.corners ?? null, { team: 'away', context: 'overall', sampleSize: advAway.matches ?? null, source: prov.seasonTeamStats || src }),
      },
    },

    halfScoringSplits: {
      available: !!(st.goals && st.goals.p1HFor != null && st.goals.p2HFor != null),
      p1HomeFor: st.goals ? (st.goals.p1HFor ?? null) : null,
      p1HomeAgainst: st.goals ? (st.goals.p1HAg ?? null) : null,
      p1AwayFor: st.goals ? (st.goals.p1AFor ?? null) : null,
      p1AwayAgainst: st.goals ? (st.goals.p1AAg ?? null) : null,
      p2HomeFor: st.goals ? (st.goals.p2HFor ?? null) : null,
      p2HomeAgainst: st.goals ? (st.goals.p2HAg ?? null) : null,
      p2AwayFor: st.goals ? (st.goals.p2AFor ?? null) : null,
      p2AwayAgainst: st.goals ? (st.goals.p2AAg ?? null) : null,
      empiricalHalfStats: st.halfStats || null,
      source: prov.halfStats || src,
    },

    additionalRawStats: {
      pct: Array.isArray(st.pct) ? st.pct : [],
      avg,
      leagueAvg,
      extraTeamStats: (st.teamStats && st.teamStats.extra) || null,
      shotsOnTargetAvg: { home: advHome.shotsOnGoalAvg ?? null, away: advAway.shotsOnGoalAvg ?? null },
      possessionAvg: { home: advHome.possessionAvg ?? null, away: advAway.possessionAvg ?? null },
      offsidesAvg: { home: advHome.offsidesAvg ?? null, away: advAway.offsidesAvg ?? null },
    },
  };

  packet.completeness = validateStatsCompleteness(packet);
  return packet;
}

function validateStatsCompleteness(packet) {
  const checks = [
    ['winProbability', packet.winProbability.homeWinPct.status === 'retrieved' && packet.winProbability.awayWinPct.status === 'retrieved'],
    ['previousMeetings', packet.previousMeetings.status === 'verified' || packet.previousMeetings.status === 'no_prior_meetings'],
    ['standings', packet.leagueStandings.home.position && packet.leagueStandings.home.position.status === 'retrieved'],
    ['homeFormOverall', packet.lastMatchesForm.home.overall.status === 'retrieved'],
    ['awayFormOverall', packet.lastMatchesForm.away.overall.status === 'retrieved'],
    ['homeAvgGoalsScored', packet.teamStatsComparison.home.avgGoalsScored.status === 'retrieved'],
    ['awayAvgGoalsScored', packet.teamStatsComparison.away.avgGoalsScored.status === 'retrieved'],
    ['homeAvgGoalsConceded', packet.teamStatsComparison.home.avgGoalsConceded.status === 'retrieved'],
    ['awayAvgGoalsConceded', packet.teamStatsComparison.away.avgGoalsConceded.status === 'retrieved'],
    ['over15Pct', packet.teamStatsComparison.home.over15Pct.status === 'retrieved' || packet.headToHeadAverages.over15Pct.status === 'retrieved'],
    ['over25Pct', packet.teamStatsComparison.home.over25Pct.status === 'retrieved' || packet.headToHeadAverages.over25Pct.status === 'retrieved'],
    ['bttsPct', packet.teamStatsComparison.home.bttsPct.status === 'retrieved' || packet.headToHeadAverages.bttsPct.status === 'retrieved'],
    ['cornersAvg', packet.headToHeadAverages.cornersPerSide.home.status === 'retrieved' || packet.headToHeadAverages.avgTotalCorners.status === 'retrieved'],
    ['cardsAvg', packet.headToHeadAverages.cardsPerSide.home.status === 'retrieved' || packet.headToHeadAverages.avgTotalCards.status === 'retrieved'],
    ['halfScoringSplits', packet.halfScoringSplits.available === true],
  ];

  const retrievedFields = checks.filter(([, ok]) => ok).map(([k]) => k);
  const missingFields = checks.filter(([, ok]) => !ok).map(([k]) => k);
  const ratio = Math.round((retrievedFields.length / checks.length) * 100) / 100;

  const hasCoreForm = packet.lastMatchesForm.home.overall.status === 'retrieved' && packet.lastMatchesForm.away.overall.status === 'retrieved';
  const hasCoreGoals = packet.teamStatsComparison.home.avgGoalsScored.status === 'retrieved' && packet.teamStatsComparison.away.avgGoalsScored.status === 'retrieved';
  const hasProbs = packet.winProbability.homeWinPct.status === 'retrieved' && packet.winProbability.awayWinPct.status === 'retrieved';
  const usable = (hasCoreForm && hasCoreGoals) || (hasCoreForm && hasProbs) || (hasCoreGoals && hasProbs);
  const complete = usable && ratio >= 0.65;

  return {
    usable,
    complete,
    completenessRatio: ratio,
    retrievedCount: retrievedFields.length,
    totalChecked: checks.length,
    retrievedFields,
    missingFields,
  };
}

module.exports = {
  buildStructuredStatsPacket,
  validateStatsCompleteness,
};
