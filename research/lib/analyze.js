'use strict';
// Dynamic statistics-to-market evaluation engine backed by the Market Knowledge Library.
// Separates market semantic knowledge (market_knowledge.js) from statistical evidence evaluation,
// distinguishes modelProbability from confidenceScore, handles Asian (half/integer/quarter) &
// European 3-way handicaps explicitly, and records accurate per-match internal discovery telemetry.
const { norm, sameTeam } = require('./util');
const { matchesMarketFilter } = require('./markets');
const mkLib = require('./market_knowledge');
const approvedMarkets = require('./approved_markets');
const sportMarkets = require('./sport_markets');

const HIGH_ODDS_THRESHOLD = 5.0;

const CFG = {
  minForm: 3, // recent matches needed for full form confidence
  minProb: { football: 0.5, basketball: 0.55, tennis: 0.55, baseball: 0.52, hockey: 0.5 },
  minOdds: 1.05,
  // No arbitrary low odds cap (e.g. 12); high-odds markets (>= 5.00) undergo independent second verification instead.
  maxOdds: 1000,
  wForm: 0.25,
  wH2H: 0.1,
  wDraw: 0.15,
  blendShown: 0.5,
};

const MODEL_LIMITATION =
  'Independent Poisson/empirical shrinkage estimate from collected team statistics; does not account for late lineups, injuries, weather, or in-play events.';

const formOf = (s) => {
  const f = String(s || '');
  const n = f.length;
  const w = (f.match(/W/g) || []).length;
  const d = (f.match(/D/g) || []).length;
  return { n, w, d, l: n - w - d, rate: n ? w / n : 0 };
};

const pois = (l, k) => {
  if (!(l >= 0) || k < 0) return 0;
  if (l === 0) return k === 0 ? 1 : 0;
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(l) - l - logFact);
};

const pOver = (lam, line) => {
  // Exact settlement for half, integer, and quarter Over/Under lines via Poisson distribution
  const maxK = Math.min(300, Math.max(30, Math.ceil(lam * 4 + 25)));
  let winMass = 0;
  let lossMass = 0;
  for (let k = 0; k <= maxK; k++) {
    const pk = pois(lam, k);
    const s = mkLib.settleOverUnder(k, line, 'O');
    if (s.outcome === 'win') winMass += pk;
    else if (s.outcome === 'half_win') winMass += 0.5 * pk;
    else if (s.outcome === 'half_loss') lossMass += 0.5 * pk;
    else if (s.outcome === 'loss') lossMass += pk;
  }
  const decisive = winMass + lossMass;
  if (decisive <= 0.05) return 0;
  return Math.max(0, Math.min(1, winMass / decisive));
};

const pRange = (lam, lo, hi) => {
  if (hi < lo || lo < 0) return 0;
  let sum = 0;
  for (let k = lo; k <= Math.min(hi, 300); k++) sum += pois(lam, k);
  return Math.max(0, Math.min(1, sum));
};

function buildScoreMatrix(lamH, lamA, maxG = 10) {
  if (!(lamH >= 0) || !(lamA >= 0)) return null;
  const grid = [];
  for (let i = 0; i <= maxG; i++) {
    const row = [];
    const pi = pois(lamH, i);
    for (let j = 0; j <= maxG; j++) row.push(pi * pois(lamA, j));
    grid.push(row);
  }
  return grid;
}

function grid1x2(grid) {
  if (!grid) return null;
  let pH = 0, pX = 0, pA = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (i > j) pH += grid[i][j];
      else if (i === j) pX += grid[i][j];
      else pA += grid[i][j];
    }
  }
  const sum = pH + pX + pA;
  return sum > 0.5 ? { H: pH / sum, X: pX / sum, A: pA / sum } : null;
}

// Exact Ballot Theorem / Andre Reflection Principle probability that Home (side='H')
// or Away (side='A') reaches a lead >= k (k=1 for 1UP, k=2 for 2UP) at any time during
// regular time OR wins at full time, conditioned on final score (i, j).
// Draw (side='X') has NO early-payout trigger and settles strictly on full-time draw.
function probEarlyLeadFromScoreGrid(grid, side, leadThreshold = 1) {
  if (!grid || (side !== 'H' && side !== 'A' && side !== 'X')) return null;
  const k = Math.max(1, Math.round(leadThreshold));
  let totalMass = 0;
  let hitMass = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const p = grid[i][j];
      totalMass += p;
      if (side === 'X') {
        if (i === j) hitMass += p;
      } else {
        const gFor = side === 'H' ? i : j;
        const gAg = side === 'H' ? j : i;
        if (gFor > gAg) {
          hitMass += p;
        } else if (gFor >= k) {
          // Reflection ratio C(gFor+gAg, gFor-k) / C(gFor+gAg, gFor)
          let num = 1;
          let den = 1;
          for (let r = 0; r < k; r++) {
            num *= (gFor - r);
            den *= (gAg + 1 + r);
          }
          hitMass += p * (num / den);
        }
      }
    }
  }
  return totalMass > 0.5 ? Math.max(0, Math.min(1, hitMass / totalMass)) : null;
}

// When unadjusted domestic scoring averages clash severely with collected prematch win probabilities
// (e.g. a minnow with high domestic goals facing an elite club at 4% vs 90%), tilt the team scoring
// share gently toward the collected win-probability ratio while keeping total expected goals realistic.
function calibrateLambdasWithProbs(rawLamH, rawLamA, probs) {
  if (rawLamH == null || rawLamA == null || !probs) return { lamH: rawLamH, lamA: rawLamA, calibrated: false };
  if (!Number.isFinite(probs.H) || !Number.isFinite(probs.A)) return { lamH: rawLamH, lamA: rawLamA, calibrated: false };
  const rawGrid = buildScoreMatrix(rawLamH, rawLamA, 10);
  const raw1x2 = grid1x2(rawGrid);
  if (!raw1x2) return { lamH: rawLamH, lamA: rawLamA, calibrated: false };
  const divergence = Math.abs(raw1x2.H - probs.H) + Math.abs(raw1x2.A - probs.A);
  if (divergence <= 0.35) return { lamH: rawLamH, lamA: rawLamA, calibrated: false };
  const tot = rawLamH + rawLamA;
  const pH = Math.max(0.03, probs.H);
  const pA = Math.max(0.03, probs.A);
  const targetShareH = Math.max(0.12, Math.min(0.88, pH / (pH + pA)));
  const rawShareH = rawLamH / Math.max(0.1, tot);
  const blendedShareH = 0.35 * rawShareH + 0.65 * targetShareH;
  return {
    lamH: Math.max(0.15, tot * blendedShareH),
    lamA: Math.max(0.15, tot * (1 - blendedShareH)),
    calibrated: true,
  };
}

function pctFor(st, re) {
  const e = (st.pct || []).find((p) => re.test(norm(p.label)));
  if (!e || !e.vals || !e.vals.length) return null;
  return {
    p: e.vals.reduce((a, b) => a + b, 0) / e.vals.length / 100,
    sampleSize: Number(e.sampleSize || 0),
    source: e.source || 'displayed',
  };
}

// Conservative shrinkage when empirical sample size is small (e.g. 4 UEFA matches)
function blendEmpiricalAndPoisson(emp, poisP) {
  if (emp == null) return poisP;
  if (poisP == null) return emp.p;
  if (emp.sampleSize > 0 && emp.sampleSize < 10) {
    const w = emp.sampleSize / (emp.sampleSize + 6);
    return w * emp.p + (1 - w) * poisP;
  }
  return emp.p;
}

// Step 2: Build an independent statistical evidence profile solely from what was collected.
// Never assumes any specific market exists on BangBet and never treats missing stats as zero.
function buildEvidenceProfile(ev) {
  const st = ev.stats || {};
  const sport = ev.sport || 'football';
  const hF = formOf(st.homeForm);
  const aF = formOf(st.awayForm);
  const formN = Math.min(hF.n, aF.n);
  const h2n = st.h2h ? st.h2h.n : 0;

  const g = st.goals;
  const rawLamH = g && Number.isFinite(g.hFor) && Number.isFinite(g.aAg) ? Math.max(0.05, (g.hFor + g.aAg) / 2) : null;
  const rawLamA = g && Number.isFinite(g.aFor) && Number.isFinite(g.hAg) ? Math.max(0.05, (g.aFor + g.hAg) / 2) : null;
  const cal = calibrateLambdasWithProbs(rawLamH, rawLamA, st.probs);
  const lamH = cal.lamH;
  const lamA = cal.lamA;
  const scoreGrid = lamH != null && lamA != null ? buildScoreMatrix(lamH, lamA, 10) : null;

  // Period-specific scoring rates ONLY when explicitly present in collected stats (never fabricated)
  const p1LamH = g && Number.isFinite(g.p1HFor) && Number.isFinite(g.p1AAg) ? Math.max(0.02, (g.p1HFor + g.p1AAg) / 2) : null;
  const p1LamA = g && Number.isFinite(g.p1AFor) && Number.isFinite(g.p1HAg) ? Math.max(0.02, (g.p1AFor + g.p1HAg) / 2) : null;
  const p2LamH = g && Number.isFinite(g.p2HFor) && Number.isFinite(g.p2AAg) ? Math.max(0.02, (g.p2HFor + g.p2AAg) / 2) : null;
  const p2LamA = g && Number.isFinite(g.p2AFor) && Number.isFinite(g.p2HAg) ? Math.max(0.02, (g.p2AFor + g.p2HAg) / 2) : null;

  // Build statistical 1X2 baseline independently of whether BangBet even offers a 1X2 market
  let stat1x2 = null;
  const g1x2 = grid1x2(scoreGrid);
  if (g1x2) stat1x2 = { ...g1x2, source: 'poisson_goals' };
  if (st.probs && Number.isFinite(st.probs.H) && Number.isFinite(st.probs.A)) {
    const pX = Number.isFinite(st.probs.X) ? st.probs.X : 0;
    const sum = st.probs.H + pX + st.probs.A;
    if (sum > 0.5) {
      const sp = { H: st.probs.H / sum, X: pX / sum, A: st.probs.A / sum, source: 'sportradar_probs' };
      stat1x2 = stat1x2
        ? { H: 0.65 * sp.H + 0.35 * stat1x2.H, X: 0.65 * sp.X + 0.35 * stat1x2.X, A: 0.65 * sp.A + 0.35 * stat1x2.A, source: 'blended_stats_and_probs' }
        : sp;
    }
  }
  if (!stat1x2 && formN >= 2) {
    const baseH = 0.42 + 0.25 * (hF.rate - aF.rate) + (h2n ? 0.1 * ((st.h2h.H - st.h2h.A) / h2n) : 0);
    const baseA = 0.32 - 0.25 * (hF.rate - aF.rate) - (h2n ? 0.1 * ((st.h2h.H - st.h2h.A) / h2n) : 0);
    const baseX = sport === 'football' ? Math.max(0.12, 1 - baseH - baseA) : 0;
    const pH = Math.max(0.05, baseH), pA = Math.max(0.05, baseA), pX = Math.max(0, baseX);
    const s = pH + pA + pX;
    stat1x2 = { H: pH / s, X: pX / s, A: pA / s, source: 'form_and_h2h' };
  }

  // Dynamic metric rates map: populated ONLY from real collected statistics (missing = absent)
  const metrics = {};
  if (lamH != null && lamA != null) {
    metrics.goal = {
      totalLambda: lamH + lamA,
      homeLambda: lamH,
      awayLambda: lamA,
      p1Lambda: p1LamH != null && p1LamA != null ? p1LamH + p1LamA : null,
      p2Lambda: p2LamH != null && p2LamA != null ? p2LamH + p2LamA : null,
      source: (st.provenance && st.provenance.teamSeasonScoring) || 'collected_goal_averages',
    };
  }

  const adv = st.advancedStats;
  const avg = st.avg || {};
  const addPairMetric = (key, hVal, aVal, fallbackTotal, sampleSize, source) => {
    const hasPair = typeof hVal === 'number' && Number.isFinite(hVal) && typeof aVal === 'number' && Number.isFinite(aVal);
    const hasTot = typeof fallbackTotal === 'number' && Number.isFinite(fallbackTotal) && fallbackTotal > 0;
    if (hasPair) {
      metrics[key] = {
        totalLambda: hVal + aVal,
        homeLambda: hVal,
        awayLambda: aVal,
        sampleSize: sampleSize || 0,
        source,
      };
    } else if (hasTot) {
      metrics[key] = {
        totalLambda: fallbackTotal,
        homeLambda: null,
        awayLambda: null,
        sampleSize: sampleSize || 0,
        source,
      };
    }
  };

  const advN = adv && adv.home && adv.away ? Math.min(adv.home.matches || 0, adv.away.matches || 0) : 0;
  addPairMetric('corner', adv && adv.home && adv.home.cornersAvg, adv && adv.away && adv.away.cornersAvg, avg.corners, advN, 'season_uniqueteamstats');
  const disc = st.disciplinary;
  const discH = (adv && adv.home && adv.home.cardsAvg != null) ? adv.home.cardsAvg : (disc && disc.home ? disc.home.yellowAvg : null);
  const discA = (adv && adv.away && adv.away.cardsAvg != null) ? adv.away.cardsAvg : (disc && disc.away ? disc.away.yellowAvg : null);
  addPairMetric('card', discH, discA, avg['total cards'], advN || (disc && disc.home && disc.home.matches) || 0, 'season_disciplinary_and_teamstats');
  // Keep Shots on Target strictly distinct from Total Shots!
  addPairMetric('shot_on_target', adv && adv.home && adv.home.shotsOnGoalAvg, adv && adv.away && adv.away.shotsOnGoalAvg, avg['shots on target'], advN, 'season_uniqueteamstats');
  // Alias 'shot' only when totalShotsAvg was explicitly collected (never alias SoT to Total Shots)
  addPairMetric('total_shot', adv && adv.home && adv.home.totalShotsAvg, adv && adv.away && adv.away.totalShotsAvg, avg['total shots'], advN, 'season_uniqueteamstats');
  addPairMetric('offside', adv && adv.home && adv.home.offsidesAvg, adv && adv.away && adv.away.offsidesAvg, avg.offsides, advN, 'season_uniqueteamstats');
  addPairMetric('foul', adv && adv.home && adv.home.freekicksAvg, adv && adv.away && adv.away.freekicksAvg, avg.fouls || avg.freekicks, advN, 'season_uniqueteamstats');

  // Index any additional custom numeric averages present in st.avg dynamically
  for (const [k, v] of Object.entries(avg)) {
    const nk = norm(k);
    if (!nk || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    if (!metrics[nk] && !/(goal|corner|card|shot|offside|foul)/.test(nk)) {
      metrics[nk] = { totalLambda: v, homeLambda: null, awayLambda: null, sampleSize: 0, source: `avg:${k}` };
    }
  }

  // Optional 1X2 market-implied blend ONLY if a 1X2 market happens to be displayed on BangBet
  const mk = ev.markets || [];
  const winMkts = mk.filter((m) => m.type === 'WIN');
  const H = winMkts.find((m) => m.side === 'H');
  const X = winMkts.find((m) => m.side === 'X');
  const A = winMkts.find((m) => m.side === 'A');
  let outcome1x2 = stat1x2;
  let marketImplied = null;
  if (H && A && H.odds > 1 && A.odds > 1) {
    const inv = 1 / H.odds + 1 / A.odds + (X && X.odds > 1 ? 1 / X.odds : 0);
    const pm = { H: 1 / H.odds / inv, A: 1 / A.odds / inv, X: X && X.odds > 1 ? 1 / X.odds / inv : 0 };
    marketImplied = pm;
    const fe = hF.rate - aF.rate;
    const he = h2n ? (st.h2h.H - st.h2h.A) / h2n : 0;
    let pH = pm.H * (1 + CFG.wForm * fe + CFG.wH2H * he);
    let pA = pm.A * (1 - CFG.wForm * fe - CFG.wH2H * he);
    let pX = pm.X * (1 - CFG.wDraw * Math.abs(fe));
    if (st.probs) {
      const b = CFG.blendShown;
      pH = (1 - b) * pH + b * st.probs.H;
      pA = (1 - b) * pA + b * st.probs.A;
      pX = X ? (1 - b) * pX + b * st.probs.X : 0;
    }
    const sum = pH + pA + pX;
    if (sum > 0) outcome1x2 = { H: pH / sum, A: pA / sum, X: pX / sum, source: 'market_form_h2h_probs' };
  }

  // Explicit confidenceScore (0..1) — measures data depth/completeness, NEVER a probability!
  const cats = st.categories && typeof st.categories === 'object' ? Object.values(st.categories) : [];
  const catRatio = cats.length ? cats.filter(Boolean).length / cats.length : 0;
  const hasRichMetrics = Object.keys(metrics).length > 0;
  const confidenceScore = Math.round(
    Math.min(
      1,
      Math.max(
        formN ? Math.min(1, formN / 5) * (h2n ? 1 : 0.88) : 0,
        st.probs ? 0.78 : 0,
        hasRichMetrics ? 0.75 : 0,
        catRatio > 0 ? 0.45 + 0.55 * catRatio : 0
      )
    ) * 1000
  ) / 1000;

  const facts = [];
  if (st.homeForm) facts.push(`${ev.home} recent form: ${st.homeForm}`);
  if (st.awayForm) facts.push(`${ev.away} recent form: ${st.awayForm}`);
  if (st.probs) facts.push(`BangBet win probability: ${Math.round(st.probs.H * 100)}% / draw ${Math.round(st.probs.X * 100)}% / ${Math.round(st.probs.A * 100)}%`);
  if (h2n) facts.push(`Head-to-head (${h2n}): ${ev.home} ${st.h2h.H} wins, ${st.h2h.X} draws, ${ev.away} ${st.h2h.A} wins`);
  else facts.push('Head-to-head: no meetings found');
  if (metrics.corner) facts.push(`Season corners avg: ${metrics.corner.totalLambda.toFixed(2)}`);
  if (metrics.card) facts.push(`Season cards avg: ${metrics.card.totalLambda.toFixed(2)}`);
  if (metrics.shot_on_target) facts.push(`Season shots on target avg: ${metrics.shot_on_target.totalLambda.toFixed(2)}`);

  const hasAnyEvidence = formN >= 2 || !!st.probs || h2n > 0 || (st.pct || []).length > 0 || Object.keys(metrics).length > 0;

  return {
    sport,
    st,
    hF,
    aF,
    formN,
    h2n,
    conf: confidenceScore,
    confidenceScore,
    facts,
    lamH,
    lamA,
    lambdasCalibrated: cal.calibrated,
    p1LamH,
    p1LamA,
    p2LamH,
    p2LamA,
    scoreGrid,
    outcome1x2,
    marketImplied,
    metrics,
    hasAnyEvidence,
  };
}

function detectTeamSide(rawText, ev) {
  const t = norm(rawText);
  if (/\bhome\b/.test(t) || t === '1') return 'H';
  if (/\baway\b/.test(t) || t === '2') return 'A';
  if (/\bdraw\b/.test(t) || t === 'x') return 'X';
  if (ev.home && (sameTeam(rawText, ev.home) || (norm(ev.home).length >= 4 && t.includes(norm(ev.home))))) return 'H';
  if (ev.away && (sameTeam(rawText, ev.away) || (norm(ev.away).length >= 4 && t.includes(norm(ev.away))))) return 'A';
  const hw = norm(ev.home).split(' ').find((w) => w.length > 3 && t.includes(w));
  const aw = norm(ev.away).split(' ').find((w) => w.length > 3 && t.includes(w));
  if (hw && !aw) return 'H';
  if (aw && !hw) return 'A';
  return '';
}

// Step 3: Dynamically interpret a displayed market's meaning.
// Authoritatively checks the 9-market Approved Market Dictionary FIRST so research,
// evaluation, and booking share one identical canonical definition with zero drift.
function semanticFromApprovedMatch(apMatch) {
  if (!apMatch || !apMatch.approved) return null;
  switch (apMatch.approvedMarketId) {
    case 'match_result_1x2':
      return {
        kind: 'win',
        family: 'match_result_1x2',
        approvedMarketId: 'match_result_1x2',
        period: 'ft',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'team_total':
    case 'team_total_over_0_5':
      return {
        kind: 'threshold',
        family: apMatch.approvedMarketId,
        approvedMarketId: apMatch.approvedMarketId,
        domain: 'goal',
        period: 'ft',
        teamScope: apMatch.teamSide,
        teamSide: apMatch.teamSide,
        dir: apMatch.dir,
        line: apMatch.line,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'to_win_either_half':
      return {
        kind: 'win_either_half',
        family: 'to_win_either_half',
        approvedMarketId: 'to_win_either_half',
        period: 'halves',
        teamSide: apMatch.teamSide,
        side: apMatch.teamSide,
        yesNo: apMatch.yesNo || 'Y',
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'draw_no_bet':
      return {
        kind: 'dnb',
        family: 'draw_no_bet',
        approvedMarketId: 'draw_no_bet',
        period: 'ft',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'any_team_to_win':
      return {
        kind: 'any_team_to_win',
        family: 'any_team_to_win',
        approvedMarketId: 'any_team_to_win',
        period: 'ft',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'match_result_1x2_1up':
    case 'match_result_1x2_2up':
      return {
        kind: 'win_early_payout',
        family: apMatch.approvedMarketId,
        approvedMarketId: apMatch.approvedMarketId,
        period: apMatch.period,
        leadThreshold: apMatch.leadThreshold,
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'total_goals':
    case 'total_over_0_5':
    case 'total_over_1_5':
      return {
        kind: 'threshold',
        family: apMatch.approvedMarketId,
        approvedMarketId: apMatch.approvedMarketId,
        domain: 'goal',
        period: 'ft',
        teamScope: 'match',
        dir: apMatch.dir,
        line: apMatch.line,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'first_half_total_over_0_5':
      return {
        kind: 'threshold',
        family: 'first_half_total_over_0_5',
        approvedMarketId: 'first_half_total_over_0_5',
        domain: 'goal',
        period: '1h',
        teamScope: 'match',
        dir: 'O',
        line: 0.5,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'second_half_total_over_0_5':
      return {
        kind: 'threshold',
        family: 'second_half_total_over_0_5',
        approvedMarketId: 'second_half_total_over_0_5',
        domain: 'goal',
        period: '2h',
        teamScope: 'match',
        dir: 'O',
        line: 0.5,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'btts_no':
      return {
        kind: 'btts',
        family: 'btts_no',
        approvedMarketId: 'btts_no',
        period: 'ft',
        side: 'N',
        canonicalOutcome: 'N',
      };
    case 'double_chance':
      return {
        kind: 'dc',
        family: 'double_chance',
        approvedMarketId: 'double_chance',
        period: 'ft',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'first_half_double_chance':
      return {
        kind: 'dc_1h',
        family: 'first_half_double_chance',
        approvedMarketId: 'first_half_double_chance',
        period: '1h',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'asian_handicap_plus_0_5':
    case 'asian_handicap_plus_1':
      return {
        kind: 'asian_handicap',
        family: apMatch.approvedMarketId,
        approvedMarketId: apMatch.approvedMarketId,
        period: 'ft',
        side: apMatch.side,
        hcp: apMatch.hcp != null ? apMatch.hcp : apMatch.line,
        line: apMatch.line,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'to_score_in_both_halves_no':
      return {
        kind: 'score_both_halves_no',
        family: 'to_score_in_both_halves_no',
        approvedMarketId: 'to_score_in_both_halves_no',
        period: 'halves',
        teamSide: apMatch.teamSide,
        side: apMatch.teamSide,
        yesNo: 'N',
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    case 'highest_scoring_half_second':
      return {
        kind: 'highest_scoring_half_second',
        family: 'highest_scoring_half_second',
        approvedMarketId: 'highest_scoring_half_second',
        period: 'halves',
        side: '2H',
        canonicalOutcome: '2H',
      };
    case 'corner_1x2':
      return {
        kind: 'metric_1x2',
        family: 'corner_1x2',
        approvedMarketId: 'corner_1x2',
        domain: 'corner',
        period: 'ft',
        side: apMatch.side,
        canonicalOutcome: apMatch.canonicalOutcome,
      };
    default:
      return null;
  }
}

function interpretMarketSemantics(m, ev, profile, preMatchedApproved = null) {
  const rawTitle = String(m.title || '');
  const rawLabel = String(m.label || '');

  // Authoritative 9-approved-market resolution FIRST (single source of truth shared with extract.js & book.js)
  const apMatch = preMatchedApproved || approvedMarkets.matchApprovedMarket(rawTitle, rawLabel, ev);
  const apSem = semanticFromApprovedMatch(apMatch);
  if (apSem) return apSem;

  const titleL = rawTitle.toLowerCase();
  const labelL = rawLabel.toLowerCase();
  const t = norm(rawTitle);
  const l = norm(rawLabel);

  // Exclude player/scorer/minute-interval props unless player/minute stats are supplied
  if (/\b(player|scorer|anytime|goalscorer|minute|interval|10 min|15 min|method|substitute|var)\b/.test(t)) {
    return { kind: 'unsupported', reason: 'no_player_or_interval_stats', family: 'player_props' };
  }

  // Explicitly skip booking points (different unit from card count — per Market Knowledge Library)
  if (/\bbooking\s*points?\b/.test(t)) {
    return { kind: 'unsupported', reason: 'missing_booking_points_stats', family: 'cards_bookings' };
  }

  // Half-Time / Full-Time (explicitly known family; unevaluable unless verified 1H & 2H team splits exist)
  if (/(half time full time|halftime fulltime|ht ft)/.test(t)) {
    const htftM = /^\s*(1|x|2|home|draw|away)\s*[/\-]\s*(1|x|2|home|draw|away)\s*$/i.exec(rawLabel.trim());
    if (htftM) {
      const tok = (s) => (/^(1|home)$/i.test(s) ? 'H' : (/^(2|away)$/i.test(s) ? 'A' : 'X'));
      return { kind: 'ht_ft', ht: tok(htftM[1]), ft: tok(htftM[2]), family: 'half_time_full_time' };
    }
    return { kind: 'unsupported', reason: 'unrecognized_htft_outcome', family: 'half_time_full_time' };
  }

  const period = /(1st half|first half|half time|halftime|\b1h\b|\bht\b)/.test(t)
    ? '1h'
    : (/(2nd half|second half|\b2h\b)/.test(t) ? '2h' : 'ft');

  let domain = null;
  if (/corner/.test(t) || /corner/.test(l)) domain = 'corner';
  else if (/\b(card|cards|booking|bookings|yellow)\b/.test(t)) domain = 'card';
  else if (/\b(shots?\s+on\s+target|shots?\s+on\s+goal|\bsot\b)\b/.test(t)) domain = 'shot_on_target';
  else if (/\b(shot|shots)\b/.test(t)) domain = 'total_shot';
  else if (/offside/.test(t)) domain = 'offside';
  else if (/\b(foul|fouls|freekick|free kick)\b/.test(t)) domain = 'foul';
  else {
    for (const mkKey of Object.keys(profile.metrics)) {
      if (!['goal', 'corner', 'card', 'shot_on_target', 'total_shot', 'offside', 'foul'].includes(mkKey) && t.includes(mkKey)) {
        domain = mkKey;
        break;
      }
    }
  }
  const teamInTitle = detectTeamSide(rawTitle, ev);
  const teamScope = teamInTitle === 'H' || teamInTitle === 'A' ? teamInTitle : 'match';

  // 1) Compound combo markets
  if (period === 'ft' && !domain) {
    const hasRes = /(1x2|result|winner)/.test(t) || m.type === 'RESULT_OU' || m.type === 'BTTS_RESULT';
    const hasDc = /double chance/.test(t) || m.type === 'DC_OU' || m.type === 'DC_BTTS';
    const hasBtts = /(both teams|btts|gg)/.test(t) || m.type === 'BTTS_RESULT' || m.type === 'DC_BTTS' || m.type === 'BTTS_OU';
    const ouCombo = /(over|under)\s*(\d+(?:\.\d+)?)/.exec(labelL) || /(over|under)\s*(\d+(?:\.\d+)?)/.exec(titleL);
    if ((hasRes || hasDc) && ouCombo) {
      const partBefore = labelL.split(/&|and|\+/)[0] || labelL;
      const side = hasDc
        ? (/1x|home or draw/.test(norm(partBefore)) ? '1X' : (/x2|draw or away/.test(norm(partBefore)) ? 'X2' : (/12|home or away/.test(norm(partBefore)) ? '12' : '')))
        : detectTeamSide(partBefore, ev);
      if (side) {
        return {
          kind: 'combo_result_ou',
          family: 'combo_markets',
          isDc: hasDc,
          side,
          dir: ouCombo[1] === 'over' ? 'O' : 'U',
          line: parseFloat(ouCombo[2]),
        };
      }
    }
    if ((hasRes || hasDc) && hasBtts) {
      const parts = labelL.split(/&|and|\+/);
      const side = hasDc
        ? (/1x|home or draw/.test(norm(parts[0] || '')) ? '1X' : (/x2|draw or away/.test(norm(parts[0] || '')) ? 'X2' : (/12|home or away/.test(norm(parts[0] || '')) ? '12' : '')))
        : detectTeamSide(parts[0] || '', ev);
      const bttsYes = /\b(yes|gg)\b/.test(norm(parts[1] || labelL)) ? 'Y' : (/\b(no|ng)\b/.test(norm(parts[1] || labelL)) ? 'N' : '');
      if (side && bttsYes) return { kind: 'combo_result_btts', family: 'combo_markets', isDc: hasDc, side, btts: bttsYes };
    }
    if (hasBtts && ouCombo) {
      const bttsYes = /\b(yes|gg)\b/.test(l) ? 'Y' : (/\b(no|ng)\b/.test(l) ? 'N' : '');
      if (bttsYes) return { kind: 'combo_btts_ou', family: 'combo_markets', btts: bttsYes, dir: ouCombo[1] === 'over' ? 'O' : 'U', line: parseFloat(ouCombo[2]) };
    }
  }

  // 2) Correct Score (strict colon scoreline e.g. "2:1" or "1-0")
  if (/(correct score|exact score)/.test(t) && !domain && period === 'ft') {
    const csM = /^\s*(\d{1,2})\s*[:-]\s*(\d{1,2})\s*$/.exec(rawLabel.trim());
    if (csM) {
      return { kind: 'correct_score', family: 'correct_score', hGoals: parseInt(csM[1], 10), aGoals: parseInt(csM[2], 10) };
    }
    return { kind: 'unsupported', reason: 'non_numeric_correct_score', family: 'correct_score' };
  }

  // 3) Winning Margin (e.g. "Home by 1", "Away by 2+", "Draw")
  if (/winning margin/.test(t) && !domain && period === 'ft') {
    if (/\b(draw|no goal)\b/.test(l)) return { kind: 'winning_margin', family: 'winning_margin', side: 'X', margin: 0, plus: false };
    const side = detectTeamSide(rawLabel, ev);
    const mm = /\bby\s*(\d{1,2})(\+?)\b/.exec(labelL) || /\b(\d{1,2})(\+?)\s*(?:goal|goals)?\b/.exec(labelL);
    if ((side === 'H' || side === 'A') && mm) {
      return { kind: 'winning_margin', family: 'winning_margin', side, margin: parseInt(mm[1], 10), plus: mm[2] === '+' || /or more/.test(labelL) };
    }
    return { kind: 'unsupported', reason: 'unparseable_winning_margin', family: 'winning_margin' };
  }

  // 4) Handicap / Spread (European 3-way Handicap "H:A" OR Asian Handicap half/integer/quarter)
  if (/(handicap|spread|puck line|run line)/.test(t) && !domain && period === 'ft') {
    const euMatch = /(\d+)\s*:\s*(\d+)/.exec(rawTitle) || /(\d+)\s*:\s*(\d+)/.exec(rawLabel);
    const side = m.side || detectTeamSide(rawLabel, ev);
    if (euMatch && (side === 'H' || side === 'X' || side === 'A')) {
      const startHome = parseInt(euMatch[1], 10);
      const startAway = parseInt(euMatch[2], 10);
      return { kind: 'eu_handicap', family: 'european_handicap', side, startHome, startAway, hBonus: startHome - startAway };
    }
    const ahMatch = /([+-]\d+(?:\.\d+)?)|\b(0(?:\.0)?)\b/.exec(rawLabel) || /([+-]\d+(?:\.\d+)?)/.exec(rawTitle);
    if (ahMatch && (side === 'H' || side === 'A')) {
      const val = parseFloat(ahMatch[1] != null ? ahMatch[1] : ahMatch[2]);
      if (Number.isFinite(val) && Math.abs(val) <= 10) {
        return { kind: 'asian_handicap', family: 'asian_handicap', side, hcp: val };
      }
    }
    return { kind: 'unsupported', reason: 'ambiguous_handicap', family: 'asian_handicap' };
  }

  // 5) Both Teams to Score (FT / 1H / 2H)
  if ((/(both teams to score|both teams score|btts|gg ng)/.test(t) || m.type === 'BTTS' || m.type === 'HALF_BTTS' || m.type === 'HALF2_BTTS') && !domain) {
    const side = /^(yes|gg)$/.test(l) ? 'Y' : (/^(no|ng)$/.test(l) ? 'N' : m.side);
    if (side === 'Y' || side === 'N') return { kind: 'btts', family: 'btts', period, side };
  }

  // 6) Clean Sheet / Win to Nil / Team to Score
  if (/clean sheet/.test(t) && /^(yes|no)$/.test(l)) {
    const ts = teamScope === 'A' ? 'A' : (teamScope === 'H' ? 'H' : detectTeamSide(rawLabel, ev));
    if (ts === 'H' || ts === 'A') {
      return { kind: 'clean_sheet', family: 'clean_sheet', period, teamSide: ts, side: l === 'no' ? 'N' : 'Y' };
    }
    return { kind: 'unsupported', reason: 'ambiguous_clean_sheet_team', family: 'clean_sheet' };
  }
  if (/win to nil/.test(t) && period === 'ft') {
    const ts = teamScope === 'A' ? 'A' : (teamScope === 'H' ? 'H' : detectTeamSide(rawLabel, ev));
    if (ts === 'H' || ts === 'A') {
      return { kind: 'win_to_nil', family: 'win_to_nil', teamSide: ts, side: /^no$/.test(l) ? 'N' : 'Y' };
    }
  }
  if (/to score/.test(t) && !/both teams|first|last/.test(t) && /^(yes|no)$/.test(l)) {
    const ts = teamScope === 'A' ? 'A' : (teamScope === 'H' ? 'H' : detectTeamSide(rawLabel, ev));
    if (ts === 'H' || ts === 'A') {
      return { kind: 'team_score', family: 'team_goals', period, teamSide: ts, side: l === 'no' ? 'N' : 'Y' };
    }
  }

  // 7) First / Last Team to Score
  if (/(first team to score|1st goal|first goal)/.test(t) && period === 'ft') {
    const s = /\b(no goal|none|neither)\b/.test(l) ? 'NONE' : (m.side || detectTeamSide(rawLabel, ev));
    if (s === 'H' || s === 'A' || s === 'NONE') return { kind: 'first_to_score', family: 'first_last_to_score', side: s };
  }
  if (/(last team to score|last goal)/.test(t) && period === 'ft') {
    const s = /\b(no goal|none|neither)\b/.test(l) ? 'NONE' : (m.side || detectTeamSide(rawLabel, ev));
    if (s === 'H' || s === 'A' || s === 'NONE') return { kind: 'last_to_score', family: 'first_last_to_score', side: s };
  }

  // 8) Odd / Even (Goals or any metric domain)
  if (/(odd even|odd\/even)/.test(t) && /^(odd|even)$/.test(l)) {
    return { kind: 'odd_even', family: 'odd_even', domain: domain || 'goal', period, side: l === 'odd' ? 'O' : 'E' };
  }

  // 9) Range / Multi-count market (e.g. "1-3", "2-4 goals", "8-10", "32-48")
  const rangeM = /\b(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\b/.exec(labelL);
  if (rangeM && !/handicap|score|ht|ft/.test(t) && !/:/.test(rawLabel)) {
    const lo = parseInt(rangeM[1], 10);
    const hi = parseInt(rangeM[2], 10);
    if (hi >= lo && hi <= 300) {
      const dom = domain || 'goal';
      return { kind: 'range', family: mkLib.familyForSemantic({ kind: 'range', domain: dom, teamScope }), domain: dom, period, teamScope, lo, hi };
    }
  }

  // 10) Plus / At-least threshold (e.g. "2+", "3+ goals", "10+ corners", "at least 2")
  const plusM = /\b(\d{1,2})\s*\+\b/.exec(labelL) || /\bat least\s*(\d{1,2})\b/.exec(labelL);
  if (plusM && !/handicap|score/.test(t)) {
    const kMin = parseInt(plusM[1], 10);
    if (kMin >= 1 && kMin <= 40) {
      const dom = domain || 'goal';
      return { kind: 'threshold', family: mkLib.familyForSemantic({ kind: 'threshold', domain: dom, teamScope }), domain: dom, period, teamScope, dir: 'O', line: kMin - 0.5 };
    }
  }

  // 11) General Over/Under threshold for ANY metric domain & half/integer/quarter lines
  const ouLabel = /\b(over|under|more than|less than|above|below)\s*(\d+(?:\.\d+)?)\b/.exec(labelL);
  const ouTitle = /\b(over|under)\b/.test(labelL) ? /\b(\d+(?:\.\d+)?)\b/.exec(titleL) : null;
  const line = ouLabel ? parseFloat(ouLabel[2]) : (ouTitle ? parseFloat(ouTitle[1]) : (m.line != null ? m.line : null));
  if (line != null && (ouLabel || /\b(over|under)\b/.test(l))) {
    const dir = /\b(over|more than|above)\b/.test(ouLabel ? ouLabel[1] : l) ? 'O' : 'U';
    const dom = domain || 'goal';
    return { kind: 'threshold', family: mkLib.familyForSemantic({ kind: 'threshold', domain: dom, teamScope }), domain: dom, period, teamScope, dir, line };
  }

  // 12) Exact count (e.g., "Exact goals" -> "0", "1", "2", "3")
  if (/exact\s+(?:total\s+)?(?:goals|corners|cards)/.test(t) && /^\d{1,2}$/.test(l)) {
    const dom = domain || 'goal';
    return { kind: 'exact', family: mkLib.familyForSemantic({ kind: 'exact', domain: dom, teamScope }), domain: dom, period, teamScope, exact: parseInt(l, 10) };
  }

  // 13) Metric comparison 1X2 (e.g., "Corner 1x2" / "Most corners")
  if (domain && /(1x2|most|winner|result)/.test(t) && period === 'ft') {
    const s = m.side || detectTeamSide(rawLabel, ev);
    if (s === 'H' || s === 'X' || s === 'A') {
      return { kind: 'metric_1x2', family: mkLib.familyForSemantic({ kind: 'metric_1x2', domain }), domain, side: s };
    }
  }

  // 14b) Double Chance (FT / 1H / 2H)
  if (/double chance/.test(t) || m.type === 'DC') {
    const s = l.replace(/\s/g, '');
    const side = m.side || approvedMarkets.parseDoubleChanceSide(rawLabel, ev) || (s === '1x' || /homeordraw/.test(s) ? '1X' : (s === 'x2' || /draworaway/.test(s) ? 'X2' : (s === '12' || /homeoraway/.test(s) ? '12' : '')));
    if (side) return { kind: 'dc', family: 'double_chance', period, side };
  }

  // 15) Draw No Bet (FT / 1H / 2H)
  if (/draw no bet/.test(t) || m.type === 'DNB') {
    const side = m.side || detectTeamSide(rawLabel, ev);
    if (side === 'H' || side === 'A') return { kind: 'dnb', family: 'draw_no_bet', period, side };
  }

  // 16) Match / Half Result 1X2 (excluding early-payout 1up/2up/3up)
  if (m.type === 'WIN' || (/(1x2|match result|match winner|moneyline|full time result|to win|^result$|^winner$|^full time$|regular time)/.test(t) && !/\b[123]up\b/.test(t))) {
    const side = m.side || detectTeamSide(rawLabel, ev);
    if (side === 'H' || side === 'X' || side === 'A') return { kind: 'win', family: 'match_result_1x2', period, side };
  }

  return { kind: 'unsupported', reason: 'unrecognized_market_semantics', family: mkLib.familyForSemantic(null, rawTitle, rawLabel) };
}

function lambdaFor(profile, domain, period, teamScope) {
  const met = profile.metrics[domain];
  if (!met) return null;
  if (period === '1h') {
    if (domain === 'goal' && met.p1Lambda != null && teamScope === 'match') return met.p1Lambda;
    return null;
  }
  if (period === '2h') {
    if (domain === 'goal' && met.p2Lambda != null && teamScope === 'match') return met.p2Lambda;
    return null;
  }
  if (teamScope === 'H') return met.homeLambda;
  if (teamScope === 'A') return met.awayLambda;
  return met.totalLambda;
}

// Step 4: Evaluate one dynamically interpreted market against the match's real evidence profile.
// Returns { p, why, domain } or null when required statistics are missing.
function evaluateSemanticMarket(sem, m, ev, profile) {
  const { st, outcome1x2, scoreGrid, lamH, lamA, hF, aF, h2n, sport, marketImplied } = profile;

  if (sem.kind === 'win') {
    if (sem.period !== 'ft' || !outcome1x2) return null;
    if (sem.side === 'X' && sport !== 'football' && sport !== 'hockey') return null;
    const p = outcome1x2[sem.side];
    if (p == null) return null;
    const imp = marketImplied ? ` Odds imply ${Math.round(100 * marketImplied[sem.side])}%,` : '';
    const why = sem.side === 'X'
      ? `Draw model probability ${Math.round(100 * p)}% from collected match statistics (${st.homeForm || 'n/a'} vs ${st.awayForm || 'n/a'}).`
      : `${sem.side === 'H' ? ev.home : ev.away} win: form ${hF.w}/${hF.n} vs ${aF.w}/${aF.n}` +
        (h2n ? `, H2H ${st.h2h.H}-${st.h2h.X}-${st.h2h.A}` : '') +
        `.${imp} Model probability ${Math.round(100 * p)}%.`;
    return { p, why, domain: 'result' };
  }

  if (sem.kind === 'dc') {
    if (sem.period !== 'ft' || !outcome1x2) return null;
    const p = sem.side === '1X' ? outcome1x2.H + outcome1x2.X : (sem.side === 'X2' ? outcome1x2.A + outcome1x2.X : outcome1x2.H + outcome1x2.A);
    return { p, why: `Double chance ${sem.side}: ${Math.round(100 * p)}% model probability from form, H2H and goal statistics.`, domain: 'result' };
  }

  if (sem.kind === 'dc_1h') {
    // Requires genuine 1st-half scoring splits (never fabricates 1H from FT goals)
    if (profile.p1LamH == null || profile.p1LamA == null) return null;
    const g1 = buildScoreMatrix(profile.p1LamH, profile.p1LamA, 6);
    const r1 = grid1x2(g1);
    if (!r1) return null;
    const p = sem.side === '1X' ? r1.H + r1.X : (sem.side === 'X2' ? r1.A + r1.X : r1.H + r1.A);
    return { p, why: `First-Half Double Chance ${sem.side}: ${Math.round(100 * p)}% from collected 1H scoring rates (${profile.p1LamH.toFixed(2)} vs ${profile.p1LamA.toFixed(2)}).`, domain: 'goal' };
  }

  if (sem.kind === 'score_both_halves_no') {
    if (profile.p1LamH == null || profile.p1LamA == null || profile.p2LamH == null || profile.p2LamA == null) return null;
    const l1 = sem.teamSide === 'H' ? profile.p1LamH : profile.p1LamA;
    const l2 = sem.teamSide === 'H' ? profile.p2LamH : profile.p2LamA;
    const pScoreBoth = (1 - Math.exp(-l1)) * (1 - Math.exp(-l2));
    const pNo = Math.max(0.01, Math.min(0.99, 1 - pScoreBoth));
    const teamLabel = sem.teamSide === 'H' ? ev.home : ev.away;
    return { p: pNo, why: `${teamLabel} to score in both halves — No: ${Math.round(100 * pNo)}% from 1H (${l1.toFixed(2)}) and 2H (${l2.toFixed(2)}) expected goals.`, domain: 'goal' };
  }

  if (sem.kind === 'highest_scoring_half_second') {
    if (profile.p1LamH == null || profile.p1LamA == null || profile.p2LamH == null || profile.p2LamA == null) return null;
    const lam1 = profile.p1LamH + profile.p1LamA;
    const lam2 = profile.p2LamH + profile.p2LamA;
    let p2Greater = 0;
    for (let g1 = 0; g1 <= 8; g1++) {
      const pg1 = pois(lam1, g1);
      for (let g2 = g1 + 1; g2 <= 10; g2++) {
        p2Greater += pg1 * pois(lam2, g2);
      }
    }
    return { p: Math.max(0.01, Math.min(0.99, p2Greater)), why: `Highest scoring half — Second Half: ${Math.round(100 * p2Greater)}% from 1H (${lam1.toFixed(2)}) vs 2H (${lam2.toFixed(2)}) expected goals.`, domain: 'goal' };
  }

  if (sem.kind === 'any_team_to_win') {
    if (sem.period !== 'ft' || !outcome1x2) return null;
    const pYes = Math.max(0, Math.min(1, outcome1x2.H + outcome1x2.A));
    const isAnyWin = sem.side === '12' || sem.side === 'Y';
    const p = isAnyWin ? pYes : Math.max(0, Math.min(1, outcome1x2.X));
    return {
      p,
      why: `Any team to win (${isAnyWin ? '12 / Yes' : 'No'}): ${Math.round(100 * p)}% model probability (non-draw ${Math.round(100 * pYes)}%, draw ${Math.round(100 * outcome1x2.X)}%).`,
      domain: 'result',
    };
  }

  if (sem.kind === 'win_early_payout') {
    if (!outcome1x2 || !scoreGrid) return null;
    if (sem.side === 'X' && sport !== 'football' && sport !== 'hockey') return null;
    const k = sem.leadThreshold || 1;
    // Draw (X) settles strictly on full-time draw with NO early-payout trigger.
    if (sem.side === 'X') {
      const p = outcome1x2.X;
      if (p == null) return null;
      return {
        p,
        why: `1X2 (${k}UP) Draw: ${Math.round(100 * p)}% full-time draw probability (no early-payout trigger on Draw).`,
        domain: 'result',
      };
    }
    const g1x2 = grid1x2(scoreGrid);
    const pEarlyGrid = probEarlyLeadFromScoreGrid(scoreGrid, sem.side, k);
    if (!g1x2 || pEarlyGrid == null) return null;
    // Exact early-lead increment above full-time win probability (strictly >= 0), anchored to outcome1x2
    const earlyBonus = Math.max(0, pEarlyGrid - g1x2[sem.side]);
    const pBase = outcome1x2[sem.side];
    if (pBase == null) return null;
    const p = Math.max(0.01, Math.min(0.985, pBase + earlyBonus));
    const teamLabel = sem.side === 'H' ? ev.home : ev.away;
    return {
      p,
      why: `1X2 (${k}UP) ${teamLabel}: ${Math.round(100 * p)}% (FT win ${Math.round(100 * pBase)}% + early ${k}-goal lead uplift +${Math.round(100 * earlyBonus)}% from expected goals ${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`,
      domain: 'result',
    };
  }

  if (sem.kind === 'win_either_half') {
    // Requires genuine 1H AND 2H statistics (never fabricates half splits from full-time goals).
    if (profile.p1LamH == null || profile.p1LamA == null || profile.p2LamH == null || profile.p2LamA == null) {
      return null;
    }
    const g1 = buildScoreMatrix(profile.p1LamH, profile.p1LamA, 6);
    const g2 = buildScoreMatrix(profile.p2LamH, profile.p2LamA, 6);
    const r1 = grid1x2(g1);
    const r2 = grid1x2(g2);
    if (!r1 || !r2) return null;
    const pWin1H = sem.teamSide === 'H' ? r1.H : r1.A;
    const pWin2H = sem.teamSide === 'H' ? r2.H : r2.A;
    let pEither = 1 - (1 - pWin1H) * (1 - pWin2H);
    // Conservative shrinkage blend with empirical half-win history if collected from Sportradar periods.p1
    const hs = st.halfStats && (sem.teamSide === 'H' ? st.halfStats.home : st.halfStats.away);
    if (hs && typeof hs.eitherHalfWinRate === 'number' && hs.sampleSize >= 3) {
      const w = hs.sampleSize / (hs.sampleSize + 6);
      pEither = w * hs.eitherHalfWinRate + (1 - w) * pEither;
    }
    const p = sem.yesNo === 'N' ? Math.max(0, Math.min(1, 1 - pEither)) : Math.max(0, Math.min(1, pEither));
    const teamLabel = sem.teamSide === 'H' ? ev.home : ev.away;
    return {
      p,
      why: `${teamLabel} to win either half${sem.yesNo === 'N' ? ' (No)' : ''}: ${Math.round(100 * p)}% from real 1H (${Math.round(100 * pWin1H)}%) and 2H (${Math.round(100 * pWin2H)}%) half-scoring rates.`,
      domain: 'goal',
    };
  }

  if (sem.kind === 'dnb') {
    if (sem.period !== 'ft' || !outcome1x2) return null;
    const denom = outcome1x2.H + outcome1x2.A;
    if (denom <= 0.1) return null;
    const p = sem.side === 'H' ? outcome1x2.H / denom : outcome1x2.A / denom;
    return { p, why: `Draw no bet (${sem.side === 'H' ? ev.home : ev.away}): ${Math.round(100 * p)}% conditional non-draw probability.`, domain: 'result' };
  }

  if (sem.kind === 'ht_ft') {
    // Only evaluate HT/FT if explicit 1H AND 2H team scoring splits were collected (never fabricate half splits)
    if (profile.p1LamH == null || profile.p1LamA == null || profile.p2LamH == null || profile.p2LamA == null) {
      return null;
    }
    const g1 = buildScoreMatrix(profile.p1LamH, profile.p1LamA, 6);
    const g2 = buildScoreMatrix(profile.p2LamH, profile.p2LamA, 6);
    let p = 0;
    for (let h1 = 0; h1 < g1.length; h1++) {
      for (let a1 = 0; a1 < g1[h1].length; a1++) {
        const htRes = h1 > a1 ? 'H' : (h1 < a1 ? 'A' : 'X');
        if (htRes !== sem.ht) continue;
        for (let h2 = 0; h2 < g2.length; h2++) {
          for (let a2 = 0; a2 < g2[h2].length; a2++) {
            const ftRes = (h1 + h2) > (a1 + a2) ? 'H' : ((h1 + h2) < (a1 + a2) ? 'A' : 'X');
            if (ftRes === sem.ft) p += g1[h1][a1] * g2[h2][a2];
          }
        }
      }
    }
    return { p, why: `HT/FT (${m.label}): ${Math.round(100 * p)}% from explicit 1H & 2H scoring rates.`, domain: 'result' };
  }

  if (sem.kind === 'btts') {
    if (sem.period !== 'ft') return null;
    const emp = pctFor(st, /(btts|both teams|gg)/);
    const poisP = lamH != null && lamA != null ? (1 - Math.exp(-lamH)) * (1 - Math.exp(-lamA)) : null;
    const base = blendEmpiricalAndPoisson(emp, poisP);
    if (base == null) return null;
    const p = sem.side === 'Y' ? base : 1 - base;
    return { p, why: `Both teams to score ${sem.side === 'Y' ? 'yes' : 'no'}: ${Math.round(100 * p)}% from collected scoring statistics.`, domain: 'goal' };
  }

  if (sem.kind === 'team_score') {
    if (sem.period !== 'ft' || lamH == null || lamA == null) return null;
    const lam = sem.teamSide === 'H' ? lamH : lamA;
    const pScore = 1 - Math.exp(-lam);
    const p = sem.side === 'N' ? 1 - pScore : pScore;
    return { p, why: `${sem.teamSide === 'H' ? ev.home : ev.away} to score (${sem.side === 'Y' ? 'yes' : 'no'}): ${Math.round(100 * p)}% from expected goals ${lam.toFixed(2)}.`, domain: 'goal' };
  }

  if (sem.kind === 'clean_sheet') {
    if (sem.period !== 'ft' || lamH == null || lamA == null) return null;
    const oppLam = sem.teamSide === 'H' ? lamA : lamH;
    const pClean = Math.exp(-oppLam);
    const p = sem.side === 'Y' ? pClean : 1 - pClean;
    return { p, why: `${sem.teamSide === 'H' ? ev.home : ev.away} clean sheet ${sem.side === 'Y' ? 'yes' : 'no'}: ${Math.round(100 * p)}% (opponent expected goals ${oppLam.toFixed(2)}).`, domain: 'goal' };
  }

  if (sem.kind === 'win_to_nil') {
    if (!scoreGrid) return null;
    let pYes = 0;
    for (let i = 0; i < scoreGrid.length; i++) {
      for (let j = 0; j < scoreGrid[i].length; j++) {
        if (sem.teamSide === 'H' && i > 0 && j === 0) pYes += scoreGrid[i][j];
        if (sem.teamSide === 'A' && j > 0 && i === 0) pYes += scoreGrid[i][j];
      }
    }
    const p = sem.side === 'Y' ? pYes : 1 - pYes;
    return { p, why: `${sem.teamSide === 'H' ? ev.home : ev.away} win to nil ${sem.side === 'Y' ? 'yes' : 'no'}: ${Math.round(100 * p)}% from expected goals (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`, domain: 'goal' };
  }

  if (sem.kind === 'first_to_score' || sem.kind === 'last_to_score') {
    if (lamH == null || lamA == null) return null;
    const tot = lamH + lamA;
    const pNone = Math.exp(-tot);
    const p = sem.side === 'NONE' ? pNone : (1 - pNone) * ((sem.side === 'H' ? lamH : lamA) / tot);
    const labelPrefix = sem.kind === 'last_to_score' ? 'Last' : 'First';
    return { p, why: `${labelPrefix} team to score (${m.label}): ${Math.round(100 * p)}% from goal rates (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`, domain: 'goal' };
  }

  if (sem.kind === 'correct_score') {
    if (!scoreGrid || sem.hGoals >= scoreGrid.length || sem.aGoals >= scoreGrid[0].length) return null;
    const p = scoreGrid[sem.hGoals][sem.aGoals];
    return { p, why: `Correct score (${sem.hGoals}:${sem.aGoals}): ${Math.round(100 * p)}% from bivariate goal distribution.`, domain: 'goal' };
  }

  if (sem.kind === 'winning_margin') {
    if (!scoreGrid) return null;
    let p = 0;
    for (let i = 0; i < scoreGrid.length; i++) {
      for (let j = 0; j < scoreGrid[i].length; j++) {
        const diff = i - j;
        if (sem.side === 'X' && diff === 0) p += scoreGrid[i][j];
        else if (sem.side === 'H' && (sem.plus ? diff >= sem.margin : diff === sem.margin)) p += scoreGrid[i][j];
        else if (sem.side === 'A' && (sem.plus ? -diff >= sem.margin : -diff === sem.margin)) p += scoreGrid[i][j];
      }
    }
    return { p, why: `Winning margin (${m.label}): ${Math.round(100 * p)}% from expected goals (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`, domain: 'goal' };
  }

  if (sem.kind === 'odd_even') {
    const lam = lambdaFor(profile, sem.domain, sem.period, 'match');
    if (lam == null) return null;
    const pEven = (1 + Math.exp(-2 * lam)) / 2;
    const p = sem.side === 'E' ? pEven : 1 - pEven;
    return { p, why: `${sem.domain} ${sem.side === 'E' ? 'even' : 'odd'}: ${Math.round(100 * p)}% from expected total ${lam.toFixed(2)}.`, domain: sem.domain };
  }

  if (sem.kind === 'threshold') {
    const lineStr = String(sem.line).replace('.', '\\s*');
    let emp = null;
    if (sem.domain === 'goal' && sem.teamScope === 'match') {
      if (sem.period === 'ft') emp = pctFor(st, new RegExp(`^over\\s*${lineStr}$`));
      else if (sem.period === '1h') emp = pctFor(st, new RegExp(`(?:first half|1st half|half time|halftime).*over\\s*${lineStr}|over\\s*${lineStr}.*(?:first half|1st half|half time|halftime)`));
      else if (sem.period === '2h') emp = pctFor(st, new RegExp(`(?:second half|2nd half).*over\\s*${lineStr}|over\\s*${lineStr}.*(?:second half|2nd half)`));
    } else if (sem.teamScope === 'match') {
      emp = pctFor(st, new RegExp(`${sem.domain}.*over\\s*${lineStr}`));
    }
    const lam = lambdaFor(profile, sem.domain, sem.period, sem.teamScope);
    const poisP = lam != null ? pOver(lam, sem.line) : null;
    const po = blendEmpiricalAndPoisson(emp, poisP);
    if (po == null) return null;
    const p = sem.dir === 'O' ? po : 1 - po;
    const rateNote = lam != null ? ` (expected ${sem.domain}: ${lam.toFixed(2)})` : '';
    return { p, why: `${m.title} — ${m.label}: ${Math.round(100 * p)}% from collected ${sem.domain} statistics${rateNote}.`, domain: sem.domain };
  }

  if (sem.kind === 'range') {
    const lam = lambdaFor(profile, sem.domain, sem.period, sem.teamScope);
    if (lam == null) return null;
    const p = pRange(lam, sem.lo, sem.hi);
    return { p, why: `${m.title} (${sem.lo}-${sem.hi} ${sem.domain}): ${Math.round(100 * p)}% from expected ${lam.toFixed(2)}.`, domain: sem.domain };
  }

  if (sem.kind === 'exact') {
    const lam = lambdaFor(profile, sem.domain, sem.period, sem.teamScope);
    if (lam == null) return null;
    const p = pois(lam, sem.exact);
    return { p, why: `${m.title} (exact ${sem.exact} ${sem.domain}): ${Math.round(100 * p)}% from expected ${lam.toFixed(2)}.`, domain: sem.domain };
  }

  if (sem.kind === 'metric_1x2') {
    const met = profile.metrics[sem.domain];
    if (!met || met.homeLambda == null || met.awayLambda == null) return null;
    const grid = buildScoreMatrix(met.homeLambda, met.awayLambda, 20);
    const m1x2 = grid1x2(grid);
    if (!m1x2) return null;
    const p = m1x2[sem.side];
    return { p, why: `${m.title} (${m.label}): ${Math.round(100 * p)}% from collected ${sem.domain} averages (${met.homeLambda.toFixed(2)} vs ${met.awayLambda.toFixed(2)}).`, domain: sem.domain };
  }

  if (sem.kind === 'eu_handicap') {
    if (!scoreGrid) return null;
    const sH = sem.startHome != null ? sem.startHome : Math.max(0, sem.hBonus || 0);
    const sA = sem.startAway != null ? sem.startAway : Math.max(0, -(sem.hBonus || 0));
    const { pWin } = mkLib.evaluateEuropeanHandicapGrid(scoreGrid, sH, sA, sem.side);
    return {
      p: pWin,
      why: `European 3-way Handicap (${sH}:${sA} ${sem.side}): ${Math.round(100 * pWin)}% from expected goals (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`,
      domain: 'goal',
    };
  }

  if (sem.kind === 'asian_handicap') {
    if (!scoreGrid) return null;
    const evAh = mkLib.evaluateAsianHandicapGrid(scoreGrid, sem.hcp, sem.side);
    return {
      p: evAh.effectiveWinProb,
      why: `Asian Handicap (${sem.side === 'H' ? ev.home : ev.away} ${sem.hcp >= 0 ? '+' : ''}${sem.hcp}): ${Math.round(100 * evAh.effectiveWinProb)}% effective non-push probability from expected goals (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`,
      domain: 'goal',
      handicapBreakdown: evAh,
    };
  }

  if (sem.kind === 'combo_result_ou' || sem.kind === 'combo_result_btts' || sem.kind === 'combo_btts_ou') {
    if (!scoreGrid) return null;
    let p = 0;
    for (let i = 0; i < scoreGrid.length; i++) {
      for (let j = 0; j < scoreGrid[i].length; j++) {
        const resOk = sem.kind === 'combo_btts_ou'
          ? true
          : (sem.isDc
            ? ((sem.side === '1X' && i >= j) || (sem.side === 'X2' && j >= i) || (sem.side === '12' && i !== j))
            : ((sem.side === 'H' && i > j) || (sem.side === 'X' && i === j) || (sem.side === 'A' && j > i)));
        const ouOk = sem.kind === 'combo_result_btts'
          ? true
          : (sem.dir === 'O' ? (i + j) > sem.line : (i + j) < sem.line);
        const bttsOk = sem.kind === 'combo_result_ou'
          ? true
          : (sem.btts === 'Y' ? (i > 0 && j > 0) : (i === 0 || j === 0));
        if (resOk && ouOk && bttsOk) p += scoreGrid[i][j];
      }
    }
    return { p, why: `${m.title} (${m.label}): ${Math.round(100 * p)}% from joint expected-goal distribution (${lamH.toFixed(2)} vs ${lamA.toFixed(2)}).`, domain: 'goal' };
  }

  return null;
}

function candidates(ev, req) {
  const out = [];
  const st = ev.stats || {};
  const mk = ev.markets || [];
  if (!mk.length) { ev.rejected = 'no markets could be read for this match'; return out; }
  if (!st.available) { ev.rejected = 'no statistics could be read for this match'; return out; }

  const profile = buildEvidenceProfile(ev);
  if (!profile.hasAnyEvidence) {
    ev.rejected = 'no usable form, probability, H2H or team-stat evidence';
    return out;
  }

  // Accurate per-match internal discovery & evaluation accounting (never inflates markets by outcomes!)
  const enforceApprovedOnly = !(req && req.allowUnapprovedMarkets === true);
  const familiesSet = new Set();
  const headingsSet = new Set();
  const linesSet = new Set();
  const interpretedHeadingsSet = new Set();
  const evaluatedHeadingsSet = new Set();
  const unknownHeadingsSet = new Set();
  const unapprovedHeadingsSet = new Set();
  const approvedMarketsOfferedSet = new Set();
  const approvedMarketsEvaluatedSet = new Set();
  const approvedMarketsMissingStatsSet = new Set();
  const approvedMarketsQualifyingSet = new Set();

  let outcomesCount = 0;
  let interpretedOutcomesCount = 0;
  let evaluatedOutcomesCount = 0;
  let rejectedInsufficientEvidenceCount = 0;
  let rejectedUninterpretableCount = 0;
  let rejectedUnapprovedCount = 0;
  let excludedMissingStatsCount = 0;
  const rejectedAlternatives = [];

  const isFootball = profile.sport === 'football';
  const expectedApprovedIds = isFootball
    ? approvedMarkets.APPROVED_MARKET_IDS
    : sportMarkets.getApprovedIdsForSport(profile.sport);
  const minProb = CFG.minProb[profile.sport] || 0.5;

  for (const m of mk) {
    if (!m || !Number.isFinite(m.odds) || !(m.odds > 1) || m.odds >= 1000) continue;
    outcomesCount++;
    const normTitle = norm(m.title || '') || 'untitled';
    headingsSet.add(normTitle);

    const ap = isFootball
      ? approvedMarkets.matchApprovedMarket(m.title, m.label, ev)
      : sportMarkets.matchSportMarket(profile.sport, m.title, m.label, ev);
    if (ap && ap.approved) {
      approvedMarketsOfferedSet.add(ap.approvedMarketId);
    }
    if (enforceApprovedOnly && (!ap || !ap.approved)) {
      rejectedUnapprovedCount++;
      if (m.title) unapprovedHeadingsSet.add(String(m.title).trim());
      continue;
    }

    let sem;
    let res;
    if (isFootball) {
      sem = interpretMarketSemantics(m, ev, profile, ap);
    } else {
      sem = ap && ap.approved
        ? {
            kind: ap.approvedMarketId,
            family: ap.approvedMarketId,
            domain: profile.sport,
            period: ap.period || 'ft',
            side: ap.side,
            teamSide: ap.teamSide,
            dir: ap.dir,
            line: ap.line,
            hcp: ap.hcp,
          }
        : { kind: 'unsupported', reason: (ap && ap.reason) || 'unapproved_sport_market' };
    }
    const family = (ap && ap.approved ? ap.approvedMarketId : '') || (sem && sem.family) || mkLib.familyForSemantic(sem, m.title, m.label);
    if (family && family !== 'unknown') familiesSet.add(family);

    // Distinct market line key: (heading, explicit numeric line/handicap if any)
    const lineKey = sem && sem.line != null
      ? `${normTitle}|line:${sem.line}`
      : (sem && sem.hcp != null
        ? `${normTitle}|hcp:${sem.hcp}`
        : (sem && sem.startHome != null
          ? `${normTitle}|eu:${sem.startHome}:${sem.startAway}`
          : (sem && sem.lo != null ? `${normTitle}|rng:${sem.lo}-${sem.hi}` : normTitle)));
    linesSet.add(lineKey);

    if (!sem || sem.kind === 'unsupported') {
      if (sem && (sem.reason === 'no_player_or_interval_stats' || sem.reason === 'missing_booking_points_stats')) {
        excludedMissingStatsCount++;
      } else {
        rejectedUninterpretableCount++;
        if (m.title) unknownHeadingsSet.add(String(m.title).trim());
      }
      continue;
    }

    interpretedOutcomesCount++;
    interpretedHeadingsSet.add(normTitle);

    res = isFootball
      ? evaluateSemanticMarket(sem, m, ev, profile)
      : sportMarkets.evaluateSportMarket(ap, m, ev, profile);
    if (!res) {
      excludedMissingStatsCount++;
      if (ap && ap.approved) approvedMarketsMissingStatsSet.add(ap.approvedMarketId);
      continue;
    }
    if (!(res.p > 0.01 && res.p < 0.99)) {
      rejectedInsufficientEvidenceCount++;
      continue;
    }

    evaluatedOutcomesCount++;
    evaluatedHeadingsSet.add(normTitle);
    if (ap && ap.approved) approvedMarketsEvaluatedSet.add(ap.approvedMarketId);

    const qualifies = res.p >= minProb && m.odds >= CFG.minOdds && m.odds <= CFG.maxOdds;
    if (qualifies && ap && ap.approved) approvedMarketsQualifyingSet.add(ap.approvedMarketId);
    if (!qualifies) {
      rejectedInsufficientEvidenceCount++;
      if (rejectedAlternatives.length < 12) {
        const whyNo = res.p < minProb
          ? `modelProbability ${res.p.toFixed(2)} < threshold ${minProb.toFixed(2)}`
          : `odds ${m.odds} outside [${CFG.minOdds}, ${CFG.maxOdds}]`;
        rejectedAlternatives.push({
          market: m.title,
          outcome: m.label,
          odds: m.odds,
          family,
          modelProbability: Math.round(res.p * 1000) / 1000,
          reason: whyNo,
        });
      }
    }

    const cand = {
      evKey: ev.key,
      fixtureId: (ev.stats && ev.stats.fixtureId) || ev.matchId || 0,
      matchId: ev.matchId || (ev.stats && ev.stats.fixtureId) || 0,
      sport: profile.sport,
      league: ev.league,
      country: ev.country,
      home: ev.home,
      away: ev.away,
      ts: ev.ts,
      url: ev.url,
      market: m.title,
      outcome: m.label,
      odds: m.odds,
      bb: m.i,
      p: res.p,
      modelProbability: Math.round(res.p * 1000) / 1000,
      confidenceScore: profile.confidenceScore,
      modelLimitation: MODEL_LIMITATION,
      n: profile.formN,
      approvedMarketId: ap && ap.approved ? ap.approvedMarketId : '',
      approvedMarketName: ap && ap.approved ? ap.marketName : '',
      canonicalOutcome: ap && ap.approved ? ap.canonicalOutcome : '',
      period: (ap && ap.approved ? ap.period : sem.period) || 'ft',
      dir: (ap && ap.approved && ap.dir) || sem.dir || undefined,
      yesNo: (ap && ap.approved && ap.yesNo) || sem.yesNo || undefined,
      marketFamily: family,
      marketType: m.type || sem.kind.toUpperCase(),
      semanticKind: sem.kind,
      semanticDomain: res.domain,
      stat: m.stat || (sem.domain && sem.domain !== 'goal' ? sem.domain : undefined),
      side: (ap && ap.approved && ap.side) || m.side || sem.side || sem.dir,
      teamSide: (ap && ap.approved && ap.teamSide) || m.teamSide || sem.teamSide || (sem.teamScope !== 'match' ? sem.teamScope : undefined),
      line: (ap && ap.approved && ap.line != null) ? ap.line : (m.line != null ? m.line : sem.line),
      catalogId: m.catalogId,
      // Evidence-first composite score: prioritizes modelProbability & confidenceScore over high odds
      score: res.p * (0.60 + 0.40 * profile.confidenceScore) + Math.min(0.12, 0.10 * Math.max(0, res.p * m.odds - 1)),
      requiresHighOddsVerification: m.odds >= HIGH_ODDS_THRESHOLD,
      reason: res.why,
      facts: profile.facts,
    };
    out.push(cand);
  }

  const qualifying = out
    .filter((c) => c.p >= minProb && c.odds >= CFG.minOdds && c.odds <= CFG.maxOdds)
    .sort((a, b) => b.score - a.score);
  const topPick = qualifying[0] || null;
  if (topPick && qualifying.length > 1) {
    for (const alt of qualifying.slice(1, 5)) {
      if (rejectedAlternatives.length >= 12) break;
      rejectedAlternatives.push({
        market: alt.market,
        outcome: alt.outcome,
        odds: alt.odds,
        family: alt.marketFamily,
        modelProbability: alt.modelProbability,
        reason: `lower composite score (${alt.score.toFixed(3)}) than top match candidate ${topPick.market}: ${topPick.outcome} (${topPick.score.toFixed(3)})`,
      });
    }
  }

  ev.marketEvaluation = {
    displayed: outcomesCount,
    interpreted: interpretedOutcomesCount,
    evaluated: evaluatedOutcomesCount,
    approvedMarketsOffered: [...approvedMarketsOfferedSet],
    approvedMarketsEvaluated: [...approvedMarketsEvaluatedSet],
    domainsWithStats: Object.keys(profile.metrics),
  };

  // Detailed internal-only discovery & evaluation report (stored in local job/recon JSON, never on normal UI)
  const approvedMissingOnly = [...approvedMarketsMissingStatsSet].filter((id) => !approvedMarketsEvaluatedSet.has(id));
  ev.marketDiscoveryReport = {
    approvedMarketsOnly: enforceApprovedOnly,
    approvedMarketsOffered: [...approvedMarketsOfferedSet],
    approvedMarketsEvaluated: [...approvedMarketsEvaluatedSet],
    approvedMarketsMissingStats: approvedMissingOnly,
    approvedMarketsQualifying: [...approvedMarketsQualifyingSet],
    approvedMarketsUnavailable: expectedApprovedIds.filter((id) => !approvedMarketsOfferedSet.has(id)),
    marketFamiliesCount: familiesSet.size,
    marketFamilies: [...familiesSet],
    distinctHeadingsCount: headingsSet.size,
    marketLinesCount: linesSet.size,
    outcomesCount,
    interpretedHeadingsCount: interpretedHeadingsSet.size,
    interpretedOutcomesCount,
    evaluatedHeadingsCount: evaluatedHeadingsSet.size,
    evaluatedOutcomesCount,
    rejectedUnapprovedCount,
    rejectedInsufficientEvidenceCount,
    rejectedUninterpretableCount,
    excludedMissingStatsCount,
    unknownHeadings: [...unknownHeadingsSet].slice(0, 20),
    unapprovedHeadings: [...unapprovedHeadingsSet].slice(0, 20),
    selected: topPick
      ? {
          market: topPick.market,
          outcome: topPick.outcome,
          odds: topPick.odds,
          approvedMarketId: topPick.approvedMarketId,
          family: topPick.marketFamily,
          modelProbability: topPick.modelProbability,
          confidenceScore: topPick.confidenceScore,
          reason: topPick.reason,
        }
      : null,
    rejectedAlternatives: rejectedAlternatives.slice(0, 8),
  };

  if (!out.length) {
    ev.rejected = 'no approved market on BangBet was supported by the collected statistics';
    return out;
  }

  if (req && req.markets && req.markets.length) {
    const keep = out.filter((c) => (c.approvedMarketId ? approvedMarkets.matchesApprovedFilter(c, req.markets) : false) || matchesMarketFilter(c, req.markets));
    if (!keep.length) ev.rejected = 'no offered market matched requested market filter';
    return keep;
  }
  return out;
}

// Section 3: Genuine independent second verification for high-odds markets (odds >= 5.00).
// Verifies match/competition identity, fresh re-checked statistics, sample-size adequacy,
// exact displayed market/line/outcome, unambiguous settlement rules, and odds-vs-evidence consistency.
function verifyHighOddsCandidate(cand, ev, freshStats, freshMarkets) {
  const checks = {
    identityMatch: false,
    competitionMatch: false,
    freshStatsAvailable: false,
    sampleSizeAdequate: false,
    marketConfirmed: false,
    settlementValid: false,
    recalculatedConsistent: false,
    oddsEvidenceConsistent: false,
  };
  if (!cand || cand.odds < HIGH_ODDS_THRESHOLD) {
    return { verified: true, skippedNotHighOdds: true, checks, reason: 'odds below 5.00 threshold' };
  }
  const st = freshStats || (ev && ev.stats) || null;
  if (!st || !st.available) {
    return { verified: false, checks, reason: 're-checked statistics unavailable for high-odds verification' };
  }
  checks.freshStatsAvailable = true;

  // 1) Verify fixture identity matches
  const expectedId = Number((ev && ev.matchId) || (ev && ev.stats && ev.stats.fixtureId) || 0);
  const freshId = Number(st.fixtureId || 0);
  checks.identityMatch = !expectedId || !freshId || expectedId === freshId;
  if (!checks.identityMatch) {
    return { verified: false, checks, reason: `fixtureId mismatch (${freshId} !== ${expectedId})` };
  }

  // 2) Verify competition/season context matches
  const expSeason = Number((ev && ev.stats && ev.stats.seasonId) || 0);
  const freshSeason = Number(st.seasonId || 0);
  checks.competitionMatch = !expSeason || !freshSeason || expSeason === freshSeason;
  if (!checks.competitionMatch) {
    return { verified: false, checks, reason: `competition/season mismatch (${freshSeason} !== ${expSeason})` };
  }

  // 3) Verify sample size & confidence adequacy (high-odds picks must never rest on tiny samples)
  const freshEv = { ...ev, stats: st, markets: freshMarkets || ev.markets || [] };
  const profile = buildEvidenceProfile(freshEv);
  const minSample = Math.max(
    profile.formN || 0,
    (st.homeFormSampleSize && st.awayFormSampleSize) ? Math.min(st.homeFormSampleSize, st.awayFormSampleSize) : 0,
    (st.teamStats && st.teamStats.home && st.teamStats.away)
      ? Math.min(st.teamStats.home.matches || 0, st.teamStats.away.matches || 0)
      : 0
  );
  checks.sampleSizeAdequate = profile.confidenceScore >= 0.70 && (minSample >= 4 || (st.probs != null && profile.formN >= 3));
  if (!checks.sampleSizeAdequate) {
    return {
      verified: false,
      checks,
      reason: `insufficient sample size or confidence for odds ${cand.odds} (conf=${profile.confidenceScore}, minSample=${minSample})`,
    };
  }

  // 4) Confirm exact market heading, line, and outcome exist in fresh markets
  const mkList = Array.isArray(freshMarkets) && freshMarkets.length ? freshMarkets : (ev.markets || []);
  const matchedMarket = mkList.find(
    (m) => norm(m.title) === norm(cand.market) && norm(m.label) === norm(cand.outcome)
  );
  checks.marketConfirmed = !!matchedMarket;
  if (!checks.marketConfirmed) {
    return { verified: false, checks, reason: `market "${cand.market} / ${cand.outcome}" not confirmed on recheck` };
  }

  // 5) Verify unambiguous market semantics and settlement rules via Approved Market Dictionary / Market Knowledge Library
  const apCheck = approvedMarkets.matchApprovedMarket(matchedMarket.title, matchedMarket.label, freshEv);
  const sem = interpretMarketSemantics(matchedMarket, freshEv, profile);
  const apDef = apCheck && apCheck.approved ? approvedMarkets.getApprovedMarket(apCheck.approvedMarketId) : null;
  const familyDef = sem && sem.family ? mkLib.getMarketDefinition(sem.family) : null;
  const activeDef = apDef || familyDef;
  checks.settlementValid = !!(sem && sem.kind !== 'unsupported' && activeDef && activeDef.settlementRules);
  if (!checks.settlementValid) {
    return { verified: false, checks, reason: 'market settlement rules not verified in Approved Market Dictionary' };
  }

  // 6) Independently recalculate probability from fresh stats and verify consistency
  const recalc = evaluateSemanticMarket(sem, matchedMarket, freshEv, profile);
  const minProb = CFG.minProb[profile.sport] || 0.5;
  checks.recalculatedConsistent = !!(recalc && recalc.p >= Math.max(minProb, 0.55) && Math.abs(recalc.p - cand.p) <= 0.12);
  if (!checks.recalculatedConsistent) {
    return {
      verified: false,
      checks,
      reason: `recalculated probability (${recalc ? recalc.p.toFixed(3) : 'null'}) did not consistently support high-odds pick`,
    };
  }

  // 7) Sanity-check odds vs evidence: extreme divergence (e.g., bookmaker implies <12% while model claims >70%
  // without corroborating provider probability or strong sample >= 6) indicates unmodelled class/injury gap
  const impliedProb = 1 / matchedMarket.odds;
  const maxAllowedRatio = minSample >= 6 ? 4.2 : 3.2;
  checks.oddsEvidenceConsistent = (recalc.p / Math.max(0.02, impliedProb)) <= maxAllowedRatio;
  if (!checks.oddsEvidenceConsistent) {
    return {
      verified: false,
      checks,
      reason: `extreme divergence between model (${(recalc.p * 100).toFixed(1)}%) and implied odds (${(impliedProb * 100).toFixed(1)}%) at ${matchedMarket.odds}`,
    };
  }

  return {
    verified: true,
    checks,
    recalculatedProbability: Math.round(recalc.p * 1000) / 1000,
    confidenceScore: profile.confidenceScore,
    impliedProbability: Math.round(impliedProb * 1000) / 1000,
    reason: 'high-odds selection passed independent second verification',
  };
}

module.exports = {
  candidates,
  buildEvidenceProfile,
  interpretMarketSemantics,
  evaluateSemanticMarket,
  calibrateLambdasWithProbs,
  probEarlyLeadFromScoreGrid,
  verifyHighOddsCandidate,
  HIGH_ODDS_THRESHOLD,
  CFG,
  MODEL_LIMITATION,
};
