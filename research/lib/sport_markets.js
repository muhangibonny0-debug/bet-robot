'use strict';
// Dedicated, independent sport-specific market dictionaries and statistical evaluators
// for Basketball, Tennis, Baseball, and Hockey.
// Football uses ONLY approved_markets.js (9 approved football markets) and NEVER uses this file.
// Neither football markets, football goal assumptions, nor football Poisson models are blindly
// reused here; unsupported markets or missing sport-specific stats are marked honestly.
const { norm } = require('./util');

function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26 rational approximation (max error < 1.5e-7)
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function poisPmf(lam, k) {
  if (!(lam >= 0) || k < 0) return 0;
  if (lam === 0) return k === 0 ? 1 : 0;
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(lam) - lam - logFact);
}

function buildGrid(lamH, lamA, maxK = 16) {
  if (!(lamH >= 0) || !(lamA >= 0)) return null;
  const g = [];
  for (let i = 0; i <= maxK; i++) {
    const row = [];
    const pi = poisPmf(lamH, i);
    for (let j = 0; j <= maxK; j++) row.push(pi * poisPmf(lamA, j));
    g.push(row);
  }
  return g;
}

function teamNameMatches(text, teamName) {
  const t = norm(text);
  const nm = norm(teamName);
  if (!t || !nm) return false;
  if (t.includes(nm)) return true;
  const words = nm.split(' ').filter((w) => w.length >= 4 && !/^(team|club|city|united|sport|real|inter|athletic|hc|bc|fc|sc)$/i.test(w));
  if (!words.length) return false;
  const hits = words.filter((w) => t.includes(w)).length;
  return hits >= Math.min(2, words.length);
}

function parseTeamSideFromLabel(label, ev) {
  const l = norm(label);
  if (l === '1' || l === 'home' || l === 'home team' || l.startsWith('home ')) return 'H';
  if (l === '2' || l === 'away' || l === 'away team' || l.startsWith('away ')) return 'A';
  if (l === 'x' || l === 'draw' || l === 'tie') return 'X';
  if (ev) {
    const isH = teamNameMatches(label, ev.home);
    const isA = teamNameMatches(label, ev.away);
    if (isH && !isA) return 'H';
    if (isA && !isH) return 'A';
  }
  return '';
}

function parseOverUnder(label) {
  const m = /\b(over|under)\s*(\d+(?:\.\d+)?)\b/i.exec(String(label || ''));
  if (!m) return null;
  return { dir: m[1].toLowerCase() === 'over' ? 'O' : 'U', line: Number(m[2]) };
}

function parseSignedHandicap(label, ev) {
  const s = String(label || '');
  const hm = /\(\s*([+-]?\d+(?:\.\d+)?)\s*\)|([+-]\d+(?:\.\d+)?)/.exec(s);
  if (!hm) return null;
  const hcp = Number(hm[1] != null ? hm[1] : hm[2]);
  if (!Number.isFinite(hcp)) return null;
  const side = parseTeamSideFromLabel(s.replace(/\([^)]*\)/g, ' ').replace(/[+-]\d+(?:\.\d+)?/g, ' '), ev);
  if (side !== 'H' && side !== 'A') return null;
  return { side, hcp };
}

// ============================================================================
// SPORT-SPECIFIC APPROVED MARKET DICTIONARIES
// Based strictly on live-verified BangBet markets for each sport.
// ============================================================================
const SPORT_APPROVED_MARKETS = {
  basketball: [
    { id: 'bb_winner_ot', name: 'Winner (incl. overtime)', settlement: '2-way full-game winner including overtime' },
    { id: 'bb_total_ot', name: 'Total (incl. overtime)', settlement: 'Over/Under total game points including overtime' },
    { id: 'bb_handicap_ot', name: 'Handicap (incl. overtime)', settlement: 'Point spread handicap including overtime' },
    { id: 'bb_team_total_ot', name: 'Team Total (incl. overtime)', settlement: 'Over/Under points scored by one specific team including overtime' },
    { id: 'bb_1x2_reg', name: '1X2 (Regulation)', settlement: '3-way regulation time result (excludes overtime)' },
    { id: 'bb_dnb_reg', name: 'Draw No Bet (Regulation)', settlement: 'Regulation winner; draw pushes' },
  ],
  tennis: [
    { id: 'tn_match_winner', name: 'Match Winner', settlement: '2-way tennis match winner (no draw)' },
    { id: 'tn_total_sets', name: 'Total Sets', settlement: 'Over/Under total sets played in match' },
    { id: 'tn_set_handicap', name: 'Set Handicap', settlement: 'Set spread handicap' },
  ],
  baseball: [
    { id: 'bs_winner_ei', name: 'Winner (incl. extra innings)', settlement: '2-way full-game moneyline including extra innings' },
    { id: 'bs_total_ei', name: 'Total Runs (incl. extra innings)', settlement: 'Over/Under total runs scored including extra innings' },
    { id: 'bs_run_line_ei', name: 'Run Line (incl. extra innings)', settlement: 'Run spread handicap including extra innings' },
    { id: 'bs_team_total_ei', name: 'Team Total Runs (incl. extra innings)', settlement: 'Over/Under runs scored by one team including extra innings' },
    { id: 'bs_1x2_reg', name: '1X2 (9 Innings)', settlement: '3-way regulation innings result (excludes extra innings)' },
  ],
  hockey: [
    { id: 'hk_1x2_reg', name: '1X2 (Regulation)', settlement: '3-way 60-minute regulation result (excludes overtime/shootout)' },
    { id: 'hk_winner_ot', name: 'Winner (incl. OT & penalties)', settlement: '2-way moneyline including overtime and shootout' },
    { id: 'hk_double_chance_reg', name: 'Double Chance (Regulation)', settlement: '60-minute regulation double chance (1X, X2, 12)' },
    { id: 'hk_dnb_reg', name: 'Draw No Bet (Regulation)', settlement: '60-minute regulation winner; tie pushes' },
    { id: 'hk_total_reg', name: 'Total Goals (Regulation)', settlement: 'Over/Under 60-minute regulation total goals' },
    { id: 'hk_team_total_reg', name: 'Team Total Goals (Regulation)', settlement: 'Over/Under 60-minute regulation goals by one specific team' },
    { id: 'hk_puck_line_reg', name: 'Asian Handicap (Regulation)', settlement: '60-minute regulation puck line / Asian handicap' },
  ],
};

function getApprovedIdsForSport(sport) {
  const sp = String(sport || '').toLowerCase();
  return (SPORT_APPROVED_MARKETS[sp] || []).map((m) => m.id);
}

function getApprovedDefForSport(sport, id) {
  const sp = String(sport || '').toLowerCase();
  return (SPORT_APPROVED_MARKETS[sp] || []).find((m) => m.id === id) || null;
}

// Strict sport-specific market matching — never merges regulation and OT/extra-innings markets!
function matchSportMarket(sport, title, label, ev = null) {
  const sp = String(sport || '').toLowerCase();
  const t = norm(title);
  const rawTitle = String(title || '').trim();
  const l = norm(label);
  const no = (reason) => ({ approved: false, sport: sp, reason });
  if (!t || !l) return no('empty_title_or_label');

  // Exclude combo, odd/even, race, margin, player, quarter/inning/period props, exact score
  if (/\b(odd\s*even|odd\/even|race to|lead by|winning margin|point range|correct score|will there be|exact|halftime\/fulltime|ht\/ft|player|highest scoring|&|and total|and both)\b/i.test(rawTitle)) {
    return no('excluded_prop_or_combo_market');
  }

  // ---------------- BASKETBALL ----------------
  if (sp === 'basketball') {
    if (/\b(quarter|1st half|2nd half|first half|second half)\b/i.test(rawTitle)) {
      return no('basketball_subperiod_not_approved_without_period_splits');
    }
    const isInclOt = /\bincl\s*\.?\s*overtime\b|\bincluding\s+overtime\b|\bmoneyline\b/i.test(rawTitle);

    if (/^winner\b/i.test(t) && isInclOt) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_bb_winner_side');
      return { approved: true, sport: sp, approvedMarketId: 'bb_winner_ot', marketName: 'Winner (incl. overtime)', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'ot' };
    }
    if (/^1x2$/.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'X' && side !== 'A') return no('unrecognized_bb_1x2_side');
      return { approved: true, sport: sp, approvedMarketId: 'bb_1x2_reg', marketName: '1X2 (Regulation)', canonicalOutcome: side === 'H' ? '1' : (side === 'X' ? 'X' : '2'), side, period: 'reg' };
    }
    if (/^draw no bet$/.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_bb_dnb_side');
      return { approved: true, sport: sp, approvedMarketId: 'bb_dnb_reg', marketName: 'Draw No Bet (Regulation)', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'reg' };
    }
    if (/^handicap\b/i.test(t) && isInclOt) {
      const h = parseSignedHandicap(label, ev);
      if (!h) return no('unrecognized_bb_handicap');
      return { approved: true, sport: sp, approvedMarketId: 'bb_handicap_ot', marketName: 'Handicap (incl. overtime)', canonicalOutcome: `${h.side === 'H' ? '1' : '2'} ${h.hcp >= 0 ? '+' : ''}${h.hcp}`, side: h.side, hcp: h.hcp, line: h.hcp, period: 'ot' };
    }
    if (/^total\b/i.test(t) && isInclOt && !/\bexact\b/i.test(rawTitle)) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_bb_total');
      return { approved: true, sport: sp, approvedMarketId: 'bb_total_ot', marketName: 'Total (incl. overtime)', canonicalOutcome: `${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, dir: ou.dir, line: ou.line, period: 'ot' };
    }
    if (isInclOt && /\btotal\b/i.test(rawTitle) && !/^total\b/i.test(t)) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_bb_team_total_ou');
      let teamSide = '';
      if (/\bhome\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.home))) teamSide = 'H';
      else if (/\baway\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.away))) teamSide = 'A';
      if (!teamSide) return no('unrecognized_bb_team_total_team');
      return { approved: true, sport: sp, approvedMarketId: 'bb_team_total_ot', marketName: 'Team Total (incl. overtime)', canonicalOutcome: `${teamSide === 'H' ? 'home' : 'away'} ${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, teamSide, dir: ou.dir, line: ou.line, period: 'ot' };
    }
    return no('not_in_basketball_approved_dictionary');
  }

  // ---------------- TENNIS ----------------
  if (sp === 'tennis') {
    if (/\b(game|games|1st set|2nd set|3rd set|first set|second set|tiebreak|ace|double fault)\b/i.test(rawTitle)) {
      return no('tennis_game_or_single_set_market_requires_point_game_stats');
    }
    if (/^(winner|match winner|moneyline|to win)$/i.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_tennis_winner_side');
      return { approved: true, sport: sp, approvedMarketId: 'tn_match_winner', marketName: 'Match Winner', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'ft' };
    }
    if (/^(total sets|sets total)$/i.test(t)) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_tennis_total_sets');
      return { approved: true, sport: sp, approvedMarketId: 'tn_total_sets', marketName: 'Total Sets', canonicalOutcome: `${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, dir: ou.dir, line: ou.line, period: 'ft' };
    }
    if (/^(set handicap|sets handicap)$/i.test(t)) {
      const h = parseSignedHandicap(label, ev);
      if (!h) return no('unrecognized_tennis_set_handicap');
      return { approved: true, sport: sp, approvedMarketId: 'tn_set_handicap', marketName: 'Set Handicap', canonicalOutcome: `${h.side === 'H' ? '1' : '2'} ${h.hcp >= 0 ? '+' : ''}${h.hcp}`, side: h.side, hcp: h.hcp, line: h.hcp, period: 'ft' };
    }
    return no('not_in_tennis_approved_dictionary');
  }

  // ---------------- BASEBALL ----------------
  if (sp === 'baseball') {
    if (/\b(1st|2nd|3rd|4th|5th|first 5|f5|inning\s*\d)\b/i.test(rawTitle)) {
      return no('baseball_innings_submarket_requires_inning_splits');
    }
    const isInclEi = /\bincl\s*\.?\s*extra\s*innings?\b|\bincluding\s+extra\s+innings?\b|\bmoneyline\b/i.test(rawTitle);
    if (/^winner\b/i.test(t) && (isInclEi || t === 'winner')) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_baseball_winner_side');
      return { approved: true, sport: sp, approvedMarketId: 'bs_winner_ei', marketName: 'Winner (incl. extra innings)', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'ei' };
    }
    if (/^1x2$/.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'X' && side !== 'A') return no('unrecognized_baseball_1x2_side');
      return { approved: true, sport: sp, approvedMarketId: 'bs_1x2_reg', marketName: '1X2 (9 Innings)', canonicalOutcome: side === 'H' ? '1' : (side === 'X' ? 'X' : '2'), side, period: 'reg' };
    }
    if (/^(handicap|run line)\b/i.test(t) && isInclEi) {
      const h = parseSignedHandicap(label, ev);
      if (!h) return no('unrecognized_baseball_run_line');
      return { approved: true, sport: sp, approvedMarketId: 'bs_run_line_ei', marketName: 'Run Line (incl. extra innings)', canonicalOutcome: `${h.side === 'H' ? '1' : '2'} ${h.hcp >= 0 ? '+' : ''}${h.hcp}`, side: h.side, hcp: h.hcp, line: h.hcp, period: 'ei' };
    }
    if (/^total\b/i.test(t) && isInclEi) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_baseball_total');
      return { approved: true, sport: sp, approvedMarketId: 'bs_total_ei', marketName: 'Total Runs (incl. extra innings)', canonicalOutcome: `${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, dir: ou.dir, line: ou.line, period: 'ei' };
    }
    if (isInclEi && /\btotal\b/i.test(rawTitle) && !/^total\b/i.test(t)) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_baseball_team_total');
      let teamSide = '';
      if (/\bhome\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.home))) teamSide = 'H';
      else if (/\baway\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.away))) teamSide = 'A';
      if (!teamSide) return no('unrecognized_baseball_team_total_team');
      return { approved: true, sport: sp, approvedMarketId: 'bs_team_total_ei', marketName: 'Team Total Runs (incl. extra innings)', canonicalOutcome: `${teamSide === 'H' ? 'home' : 'away'} ${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, teamSide, dir: ou.dir, line: ou.line, period: 'ei' };
    }
    return no('not_in_baseball_approved_dictionary');
  }

  // ---------------- HOCKEY ----------------
  if (sp === 'hockey') {
    if (/\b(1st period|2nd period|3rd period|first period|second period|third period)\b/i.test(rawTitle)) {
      return no('hockey_period_market_requires_period_splits');
    }
    const isInclOt = /\bincl\s*\.?\s*(?:overtime|ot)\b|\bincluding\s+overtime\b|\bmoneyline\b/i.test(rawTitle);
    if (/^winner\b/i.test(t) && isInclOt) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_hockey_ot_winner');
      return { approved: true, sport: sp, approvedMarketId: 'hk_winner_ot', marketName: 'Winner (incl. OT & penalties)', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'ot' };
    }
    if (/^1x2$/.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'X' && side !== 'A') return no('unrecognized_hockey_1x2');
      return { approved: true, sport: sp, approvedMarketId: 'hk_1x2_reg', marketName: '1X2 (Regulation)', canonicalOutcome: side === 'H' ? '1' : (side === 'X' ? 'X' : '2'), side, period: 'reg' };
    }
    if (/^double chance$/.test(t)) {
      const compact = l.replace(/\s+/g, '');
      let side = '';
      if (compact === '1x' || compact.includes('homeordraw') || (ev && teamNameMatches(label, ev.home) && /\bdraw\b/i.test(label))) side = '1X';
      else if (compact === 'x2' || compact.includes('draworaway') || (ev && teamNameMatches(label, ev.away) && /\bdraw\b/i.test(label))) side = 'X2';
      else if (compact === '12' || compact.includes('homeoraway')) side = '12';
      if (!side) return no('unrecognized_hockey_dc');
      return { approved: true, sport: sp, approvedMarketId: 'hk_double_chance_reg', marketName: 'Double Chance (Regulation)', canonicalOutcome: side, side, period: 'reg' };
    }
    if (/^draw no bet$/.test(t)) {
      const side = parseTeamSideFromLabel(label, ev);
      if (side !== 'H' && side !== 'A') return no('unrecognized_hockey_dnb');
      return { approved: true, sport: sp, approvedMarketId: 'hk_dnb_reg', marketName: 'Draw No Bet (Regulation)', canonicalOutcome: side === 'H' ? '1' : '2', side, period: 'reg' };
    }
    if (/^total$/.test(t)) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_hockey_total');
      return { approved: true, sport: sp, approvedMarketId: 'hk_total_reg', marketName: 'Total Goals (Regulation)', canonicalOutcome: `${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, dir: ou.dir, line: ou.line, period: 'reg' };
    }
    if (/^asian handicap$/i.test(t)) {
      const h = parseSignedHandicap(label, ev);
      if (!h) return no('unrecognized_hockey_puck_line');
      return { approved: true, sport: sp, approvedMarketId: 'hk_puck_line_reg', marketName: 'Asian Handicap (Regulation)', canonicalOutcome: `${h.side === 'H' ? '1' : '2'} ${h.hcp >= 0 ? '+' : ''}${h.hcp}`, side: h.side, hcp: h.hcp, line: h.hcp, period: 'reg' };
    }
    if (/\btotal$/i.test(t) && !/^total$/i.test(t) && !isInclOt) {
      const ou = parseOverUnder(label);
      if (!ou) return no('unrecognized_hockey_team_total');
      let teamSide = '';
      if (/\bhome\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.home))) teamSide = 'H';
      else if (/\baway\b/i.test(t) || (ev && teamNameMatches(rawTitle, ev.away))) teamSide = 'A';
      if (!teamSide) return no('unrecognized_hockey_team_total_team');
      return { approved: true, sport: sp, approvedMarketId: 'hk_team_total_reg', marketName: 'Team Total Goals (Regulation)', canonicalOutcome: `${teamSide === 'H' ? 'home' : 'away'} ${ou.dir === 'O' ? 'over' : 'under'} ${ou.line}`, teamSide, dir: ou.dir, line: ou.line, period: 'reg' };
    }
    return no('not_in_hockey_approved_dictionary');
  }

  return no('unsupported_sport');
}

// Extract empirical scoring/margin statistics from Gismo stats for a non-football sport.
function buildSportStatsSummary(sport, ev) {
  const st = (ev && ev.stats) || {};
  const g = st.goals || null;
  const prevH = (st.previousMatches && Array.isArray(st.previousMatches.home)) ? st.previousMatches.home : [];
  const prevA = (st.previousMatches && Array.isArray(st.previousMatches.away)) ? st.previousMatches.away : [];

  const avgOf = (arr, fn) => {
    const vals = arr.map(fn).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.length > 1
      ? vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (vals.length - 1)
      : 0;
    return { n: vals.length, mean, sd: Math.sqrt(Math.max(0, variance)) };
  };

  const hFor = g && Number.isFinite(g.hFor) ? g.hFor : (avgOf(prevH, (m) => m.goalsFor)?.mean ?? null);
  const hAg = g && Number.isFinite(g.hAg) ? g.hAg : (avgOf(prevH, (m) => m.goalsAgainst)?.mean ?? null);
  const aFor = g && Number.isFinite(g.aFor) ? g.aFor : (avgOf(prevA, (m) => m.goalsFor)?.mean ?? null);
  const aAg = g && Number.isFinite(g.aAg) ? g.aAg : (avgOf(prevA, (m) => m.goalsAgainst)?.mean ?? null);

  const hTotStat = avgOf(prevH, (m) => (m.goalsFor != null && m.goalsAgainst != null) ? (m.goalsFor + m.goalsAgainst) : null);
  const aTotStat = avgOf(prevA, (m) => (m.goalsFor != null && m.goalsAgainst != null) ? (m.goalsFor + m.goalsAgainst) : null);
  const hMarginStat = avgOf(prevH, (m) => (m.goalsFor != null && m.goalsAgainst != null) ? (m.goalsFor - m.goalsAgainst) : null);
  const aMarginStat = avgOf(prevA, (m) => (m.goalsFor != null && m.goalsAgainst != null) ? (m.goalsFor - m.goalsAgainst) : null);

  const muH = (hFor != null && aAg != null) ? 0.5 * (hFor + aAg) : null;
  const muA = (aFor != null && hAg != null) ? 0.5 * (aFor + hAg) : null;
  const muTotal = (muH != null && muA != null) ? (muH + muA) : null;
  const muMargin = (muH != null && muA != null) ? (muH - muA) : null;

  return {
    sport,
    muH,
    muA,
    muTotal,
    muMargin,
    hFor,
    hAg,
    aFor,
    aAg,
    hTotSd: hTotStat && hTotStat.n >= 3 ? hTotStat.sd : null,
    aTotSd: aTotStat && aTotStat.n >= 3 ? aTotStat.sd : null,
    hMarginSd: hMarginStat && hMarginStat.n >= 3 ? hMarginStat.sd : null,
    aMarginSd: aMarginStat && aMarginStat.n >= 3 ? aMarginStat.sd : null,
    prevH,
    prevA,
    sampleN: Math.min(prevH.length, prevA.length),
  };
}

// Evaluate an approved sport-specific market using sport-appropriate math & real collected stats.
function evaluateSportMarket(ap, m, ev, profile) {
  if (!ap || !ap.approved) return null;
  const sp = ap.sport;
  const ss = buildSportStatsSummary(sp, ev);
  const st = (ev && ev.stats) || {};
  const probs = profile && profile.probs ? profile.probs : null; // { H, X, A }

  // Helper: 2-way win probability (eliminating draw mass for no-draw / incl. OT / incl. extra-innings)
  const twoWayWin = () => {
    if (!probs) return null;
    const pH = Math.max(0.02, probs.H + 0.5 * (probs.X || 0));
    const pA = Math.max(0.02, probs.A + 0.5 * (probs.X || 0));
    const sum = pH + pA;
    return { H: pH / sum, A: pA / sum };
  };

  // ---------------- BASKETBALL (Normal points distribution, NEVER Poisson!) ----------------
  if (sp === 'basketball') {
    // Sanity check: real basketball scoring averages are >= 50 pts per team
    const hasPts = ss.muH != null && ss.muA != null && ss.muH >= 45 && ss.muA >= 45;
    if (ap.approvedMarketId === 'bb_winner_ot') {
      const w2 = twoWayWin();
      if (!w2) return null;
      // Blend with Normal margin win probability when team scoring averages are present
      let p = w2[ap.side];
      if (hasPts) {
        const marginSd = Math.max(9.5, Math.min(18, ((ss.hMarginSd || 12) + (ss.aMarginSd || 12)) / 2));
        const pHNorm = 1 - normalCdf((0 - ss.muMargin) / marginSd);
        const pNorm = ap.side === 'H' ? pHNorm : (1 - pHNorm);
        p = 0.65 * p + 0.35 * pNorm;
      }
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_points',
        why: `Basketball Winner (incl. OT): ${Math.round(100 * p)}% from team win strength${hasPts ? ` and scoring averages (${ss.muH.toFixed(1)} vs ${ss.muA.toFixed(1)} pts)` : ''}.`,
      };
    }
    if (ap.approvedMarketId === 'bb_1x2_reg') {
      if (!probs) return null;
      const p = probs[ap.side];
      if (!(p > 0.01)) return null;
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_regulation',
        why: `Basketball 1X2 (Regulation): ${Math.round(100 * p)}% from regulation win/draw probabilities.`,
      };
    }
    if (ap.approvedMarketId === 'bb_dnb_reg') {
      if (!probs || (probs.H + probs.A) <= 0.2) return null;
      const p = (ap.side === 'H' ? probs.H : probs.A) / (probs.H + probs.A);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_regulation',
        why: `Basketball Draw No Bet (Regulation): ${Math.round(100 * p)}% conditional non-tie probability.`,
      };
    }
    if (ap.approvedMarketId === 'bb_total_ot') {
      if (!hasPts) return null;
      const totSd = Math.max(12.5, Math.min(24, ((ss.hTotSd || 16) + (ss.aTotSd || 16)) / 2));
      const pOver = 1 - normalCdf((ap.line - ss.muTotal) / totSd);
      const p = ap.dir === 'O' ? pOver : (1 - pOver);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_points',
        why: `Basketball Total ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line} (incl. OT): ${Math.round(100 * p)}% from Normal points model (expected ${ss.muTotal.toFixed(1)} ± ${totSd.toFixed(1)} pts).`,
      };
    }
    if (ap.approvedMarketId === 'bb_team_total_ot') {
      if (!hasPts) return null;
      const mu = ap.teamSide === 'H' ? ss.muH : ss.muA;
      const teamSd = Math.max(8.5, Math.min(16, (((ss.hTotSd || 16) + (ss.aTotSd || 16)) / 2) * 0.68));
      const pOver = 1 - normalCdf((ap.line - mu) / teamSd);
      const p = ap.dir === 'O' ? pOver : (1 - pOver);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_points',
        why: `Basketball ${ap.teamSide === 'H' ? ev.home : ev.away} Total ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line}: ${Math.round(100 * p)}% from expected ${mu.toFixed(1)} pts.`,
      };
    }
    if (ap.approvedMarketId === 'bb_handicap_ot') {
      if (!hasPts) return null;
      const marginSd = Math.max(9.5, Math.min(18, ((ss.hMarginSd || 12.5) + (ss.aMarginSd || 12.5)) / 2));
      // Home (+hcp) wins if (H - A) + hcp > 0 => (H - A) > -hcp
      // Away (+hcp) wins if (A - H) + hcp > 0 => (H - A) < hcp
      const p = ap.side === 'H'
        ? (1 - normalCdf((-ap.hcp - ss.muMargin) / marginSd))
        : normalCdf((ap.hcp - ss.muMargin) / marginSd);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'basketball_points',
        why: `Basketball Spread ${ap.canonicalOutcome} (incl. OT): ${Math.round(100 * p)}% from expected margin ${ss.muMargin >= 0 ? '+' : ''}${ss.muMargin.toFixed(1)} pts (σ=${marginSd.toFixed(1)}).`,
      };
    }
    return null;
  }

  // ---------------- TENNIS (2-way match / set model, NO draws, NEVER fabricates game counts) ----------------
  if (sp === 'tennis') {
    // Build tennis-specific 2-way match win probability from form, H2H, provider probs, and set differential
    const hForm = String(st.homeForm || '');
    const aForm = String(st.awayForm || '');
    const hRate = hForm.length ? (hForm.match(/W/g) || []).length / hForm.length : null;
    const aRate = aForm.length ? (aForm.match(/W/g) || []).length / aForm.length : null;
    let pH = null;
    if (probs) {
      const sum = Math.max(0.01, probs.H + probs.A);
      pH = probs.H / sum;
    } else if (hRate != null && aRate != null) {
      // Logistic shrinkage around 0.50 based on recent match win-rate difference + H2H
      const nMin = Math.min(hForm.length, aForm.length);
      const shrink = Math.min(1, nMin / 5);
      let diff = (hRate - aRate) * 0.45 * shrink;
      if (st.h2h && st.h2h.n >= 2) {
        const h2hDiff = (st.h2h.H - st.h2h.A) / st.h2h.n;
        diff += h2hDiff * 0.12 * Math.min(1, st.h2h.n / 5);
      }
      pH = Math.max(0.15, Math.min(0.85, 0.5 + diff));
    }
    if (pH == null) return null;

    if (ap.approvedMarketId === 'tn_match_winner') {
      const p = ap.side === 'H' ? pH : (1 - pH);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'tennis_match',
        why: `Tennis Match Winner (${ap.side === 'H' ? ev.home : ev.away}): ${Math.round(100 * p)}% from 2-way form/H2H profile (no draw).`,
      };
    }
    // Set markets require genuine recent set-count history (at least 3 matches each with set scores 0..5)
    const setCountsH = ss.prevH.map((x) => (x.goalsFor != null && x.goalsAgainst != null && (x.goalsFor + x.goalsAgainst) >= 2 && (x.goalsFor + x.goalsAgainst) <= 5) ? (x.goalsFor + x.goalsAgainst) : null).filter((v) => v != null);
    const setCountsA = ss.prevA.map((x) => (x.goalsFor != null && x.goalsAgainst != null && (x.goalsFor + x.goalsAgainst) >= 2 && (x.goalsFor + x.goalsAgainst) <= 5) ? (x.goalsFor + x.goalsAgainst) : null).filter((v) => v != null);
    if (ap.approvedMarketId === 'tn_total_sets') {
      if (setCountsH.length < 3 || setCountsA.length < 3) return null;
      const all = [...setCountsH, ...setCountsA];
      const overRate = all.filter((s) => s > ap.line).length / all.length;
      const p = ap.dir === 'O' ? overRate : (1 - overRate);
      return {
        p: Math.max(0.05, Math.min(0.95, p)),
        domain: 'tennis_sets',
        why: `Tennis Total Sets ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line}: ${Math.round(100 * p)}% from ${all.length} recent match set counts.`,
      };
    }
    if (ap.approvedMarketId === 'tn_set_handicap') {
      if (setCountsH.length < 3 || setCountsA.length < 3) return null;
      // Best-of-3 approximate straight-sets win prob from per-set win prob s where s^2*(3 - 2s) = pH
      const pSide = ap.side === 'H' ? pH : (1 - pH);
      // Approximate set win prob s from match win prob (Bo3)
      let lo = 0.05, hi = 0.95;
      for (let it = 0; it < 20; it++) {
        const mid = (lo + hi) / 2;
        if (mid * mid * (3 - 2 * mid) < pSide) lo = mid; else hi = mid;
      }
      const sWin = (lo + hi) / 2;
      let p = null;
      if (Math.abs(ap.hcp + 1.5) < 0.05) p = sWin * sWin; // -1.5 sets = must win 2-0
      else if (Math.abs(ap.hcp - 1.5) < 0.05) p = 1 - (1 - sWin) * (1 - sWin); // +1.5 sets = win at least 1 set
      if (p == null) return null;
      return {
        p: Math.max(0.05, Math.min(0.95, p)),
        domain: 'tennis_sets',
        why: `Tennis Set Handicap ${ap.canonicalOutcome}: ${Math.round(100 * p)}% from implied set-win probability (${Math.round(100 * sWin)}%).`,
      };
    }
    return null;
  }

  // ---------------- BASEBALL (Runs model with extra-innings vs 9-inning distinction) ----------------
  if (sp === 'baseball') {
    const hasRuns = ss.muH != null && ss.muA != null && ss.muH >= 1.5 && ss.muH <= 12 && ss.muA >= 1.5 && ss.muA <= 12;
    const w2 = twoWayWin();
    if (ap.approvedMarketId === 'bs_winner_ei') {
      if (!w2) return null;
      const p = w2[ap.side];
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'baseball_runs',
        why: `Baseball Moneyline (incl. extra innings): ${Math.round(100 * p)}% from team win strength.`,
      };
    }
    if (ap.approvedMarketId === 'bs_1x2_reg') {
      if (!probs) return null;
      const p = probs[ap.side];
      if (!(p > 0.01)) return null;
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'baseball_regulation',
        why: `Baseball 1X2 (9 Innings): ${Math.round(100 * p)}% from 9-inning regulation probabilities.`,
      };
    }
    if (!hasRuns) return null;
    // Overdispersed run total distribution (Normal with baseball run variance ~ 1.45 * mu + continuity)
    if (ap.approvedMarketId === 'bs_total_ei') {
      const sd = Math.max(2.6, Math.sqrt(1.45 * ss.muTotal));
      const pOver = 1 - normalCdf((ap.line - ss.muTotal) / sd);
      const p = ap.dir === 'O' ? pOver : (1 - pOver);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'baseball_runs',
        why: `Baseball Total Runs ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line}: ${Math.round(100 * p)}% from expected ${ss.muTotal.toFixed(2)} runs.`,
      };
    }
    if (ap.approvedMarketId === 'bs_team_total_ei') {
      const mu = ap.teamSide === 'H' ? ss.muH : ss.muA;
      const sd = Math.max(1.8, Math.sqrt(1.45 * mu));
      const pOver = 1 - normalCdf((ap.line - mu) / sd);
      const p = ap.dir === 'O' ? pOver : (1 - pOver);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'baseball_runs',
        why: `Baseball Team Total Runs ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line}: ${Math.round(100 * p)}% from expected ${mu.toFixed(2)} runs.`,
      };
    }
    if (ap.approvedMarketId === 'bs_run_line_ei') {
      const marginSd = Math.max(2.8, Math.sqrt(1.45 * (ss.muH + ss.muA)));
      const p = ap.side === 'H'
        ? (1 - normalCdf((-ap.hcp - ss.muMargin) / marginSd))
        : normalCdf((ap.hcp - ss.muMargin) / marginSd);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'baseball_runs',
        why: `Baseball Run Line ${ap.canonicalOutcome}: ${Math.round(100 * p)}% from expected run margin ${ss.muMargin >= 0 ? '+' : ''}${ss.muMargin.toFixed(2)}.`,
      };
    }
    return null;
  }

  // ---------------- HOCKEY (Strict 60-min regulation vs OT/shootout separation) ----------------
  if (sp === 'hockey') {
    const hasGoals = ss.muH != null && ss.muA != null && ss.muH >= 0.8 && ss.muH <= 7.5 && ss.muA >= 0.8 && ss.muA <= 7.5;
    const grid = hasGoals ? buildGrid(ss.muH, ss.muA, 14) : null;
    let regProbs = probs;
    if (!regProbs && grid) {
      let pH = 0, pX = 0, pA = 0;
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          if (i > j) pH += grid[i][j];
          else if (i === j) pX += grid[i][j];
          else pA += grid[i][j];
        }
      }
      const s = pH + pX + pA;
      if (s > 0.5) regProbs = { H: pH / s, X: pX / s, A: pA / s };
    }

    if (ap.approvedMarketId === 'hk_1x2_reg') {
      if (!regProbs) return null;
      const p = regProbs[ap.side];
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_regulation',
        why: `Hockey 1X2 (60m Regulation): ${Math.round(100 * p)}% from regulation result probabilities (excludes OT/SO).`,
      };
    }
    if (ap.approvedMarketId === 'hk_winner_ot') {
      if (!regProbs) return null;
      // OT/shootout resolves ties (~50/50 split slightly tilted by team strength)
      const tilt = Math.max(0.42, Math.min(0.58, 0.5 + 0.15 * (regProbs.H - regProbs.A)));
      const pH = regProbs.H + regProbs.X * tilt;
      const pA = regProbs.A + regProbs.X * (1 - tilt);
      const p = ap.side === 'H' ? pH : pA;
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_moneyline',
        why: `Hockey Moneyline (incl. OT & penalties): ${Math.round(100 * p)}% from regulation + OT/shootout resolution.`,
      };
    }
    if (ap.approvedMarketId === 'hk_double_chance_reg') {
      if (!regProbs) return null;
      const p = ap.side === '1X' ? (regProbs.H + regProbs.X) : (ap.side === 'X2' ? (regProbs.X + regProbs.A) : (regProbs.H + regProbs.A));
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_regulation',
        why: `Hockey Double Chance ${ap.side} (60m Regulation): ${Math.round(100 * p)}%.`,
      };
    }
    if (ap.approvedMarketId === 'hk_dnb_reg') {
      if (!regProbs || (regProbs.H + regProbs.A) <= 0.2) return null;
      const p = (ap.side === 'H' ? regProbs.H : regProbs.A) / (regProbs.H + regProbs.A);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_regulation',
        why: `Hockey Draw No Bet (60m Regulation): ${Math.round(100 * p)}% non-tie probability.`,
      };
    }
    if (!grid) return null;
    if (ap.approvedMarketId === 'hk_total_reg') {
      let win = 0, loss = 0;
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const tot = i + j;
          if (tot === ap.line) continue;
          if ((ap.dir === 'O' && tot > ap.line) || (ap.dir === 'U' && tot < ap.line)) win += grid[i][j];
          else loss += grid[i][j];
        }
      }
      if (win + loss <= 0.1) return null;
      const p = win / (win + loss);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_goals',
        why: `Hockey Total ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line} (60m Regulation): ${Math.round(100 * p)}% from expected ${(ss.muH + ss.muA).toFixed(2)} goals.`,
      };
    }
    if (ap.approvedMarketId === 'hk_team_total_reg') {
      const lam = ap.teamSide === 'H' ? ss.muH : ss.muA;
      let win = 0, loss = 0;
      for (let k = 0; k <= 16; k++) {
        const pk = poisPmf(lam, k);
        if (k === ap.line) continue;
        if ((ap.dir === 'O' && k > ap.line) || (ap.dir === 'U' && k < ap.line)) win += pk;
        else loss += pk;
      }
      if (win + loss <= 0.1) return null;
      const p = win / (win + loss);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_goals',
        why: `Hockey Team Total ${ap.dir === 'O' ? 'Over' : 'Under'} ${ap.line} (Regulation): ${Math.round(100 * p)}% from expected ${lam.toFixed(2)} goals.`,
      };
    }
    if (ap.approvedMarketId === 'hk_puck_line_reg') {
      let win = 0, loss = 0;
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const diff = (ap.side === 'H' ? (i - j) : (j - i)) + ap.hcp;
          if (Math.abs(diff) < 1e-6) continue;
          if (diff > 0) win += grid[i][j];
          else loss += grid[i][j];
        }
      }
      if (win + loss <= 0.1) return null;
      const p = win / (win + loss);
      return {
        p: Math.max(0.02, Math.min(0.98, p)),
        domain: 'hockey_goals',
        why: `Hockey Puck Line ${ap.canonicalOutcome} (60m Regulation): ${Math.round(100 * p)}% from expected goals (${ss.muH.toFixed(2)} vs ${ss.muA.toFixed(2)}).`,
      };
    }
  }

  return null;
}

function isApprovedSportMarketId(sport, id) {
  const sp = String(sport || '').toLowerCase();
  const s = String(id || '').trim();
  return getApprovedIdsForSport(sp).includes(s);
}

// Find the exact clickable live DOM market outcome for a non-football leg.
function findMatchingLiveSportMarket(liveMarkets, leg) {
  if (!Array.isArray(liveMarkets) || !leg) return null;
  const sp = String(leg.sport || '').toLowerCase();
  const ev = { home: leg.home, away: leg.away };
  const targetId = leg.approvedMarketId || (matchSportMarket(sp, leg.market, leg.outcome, ev).approvedMarketId || '');
  const targetCanon = norm(leg.canonicalOutcome || '');
  const targetTitle = norm(leg.market || '');
  const targetOutcome = norm(leg.outcome || '');

  // Pass 1: exact sport approvedMarketId + canonicalOutcome
  if (targetId) {
    for (const m of liveMarkets) {
      if (!m || m.i == null || m.i < 0) continue;
      const ap = matchSportMarket(sp, m.title, m.label, ev);
      if (!ap || !ap.approved || ap.approvedMarketId !== targetId) continue;
      if (targetCanon && norm(ap.canonicalOutcome) === targetCanon) return m;
      if (leg.side && ap.side === leg.side && (leg.line == null || Math.abs(Number(ap.line) - Number(leg.line)) < 0.01)) return m;
      if (leg.dir && ap.dir === leg.dir && (leg.line == null || Math.abs(Number(ap.line) - Number(leg.line)) < 0.01) && (!leg.teamSide || ap.teamSide === leg.teamSide)) return m;
    }
  }
  // Pass 2: exact normalized heading + outcome fallback (strictly within same heading)
  for (const m of liveMarkets) {
    if (!m || m.i == null || m.i < 0) continue;
    if (norm(m.title) === targetTitle && norm(m.label) === targetOutcome) return m;
  }
  return null;
}

module.exports = {
  SPORT_APPROVED_MARKETS,
  getApprovedIdsForSport,
  getApprovedDefForSport,
  isApprovedSportMarketId,
  matchSportMarket,
  findMatchingLiveSportMarket,
  evaluateSportMarket,
  buildSportStatsSummary,
  normalCdf,
};
