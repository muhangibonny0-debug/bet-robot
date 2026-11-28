'use strict';
const fs = require('fs');
const path = require('path');
const ex = require('./lib/extract');
const an = require('./lib/analyze');
const tk = require('./lib/ticket');
const bk = require('./lib/book');
const gist = require('./lib/gist');
const { norm } = require('./lib/util');
const dates = require('./lib/dates');
const approvedMarkets = require('./lib/approved_markets');
const sportMarkets = require('./lib/sport_markets');
const { orderFixturesByLeaguePriority } = require('./lib/league_priority');
const { isVirtualOrNonRealFixture } = require('./lib/site');
const cfClient = require('./lib/cloudflare_client');
const { buildStructuredStatsPacket } = require('./lib/stats_packet');
const aiAnalyst = require('./lib/ai_analyst');

const VALID_SPORTS = ['football', 'basketball', 'tennis', 'baseball', 'hockey'];
const VALID_SCOPES = ['today', 'tomorrow', 'weekend', 'next3days', 'next7days', 'week', 'next3hours', 'next6hours', 'all', 'date', 'range'];

// Parse YYYY-MM-DD in local timezone / Africa/Kampala without UTC midnight drift.
function parseLocalYmd(str) {
  const p = dates.parseYmdParts(str);
  if (!p) return null;
  const d = new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
  if (d.getFullYear() !== p.year || d.getMonth() !== p.month - 1 || d.getDate() !== p.day) return null;
  return d;
}

function computeWindow(req, nowMs = Date.now()) {
  const ds = dates.resolveDateScope(req, nowMs);
  return [ds.fromMs, ds.toMs];
}

function validateRequest(P, req) {
  if (!Array.isArray(P.sports) || !req.sports.length || req.sports.some((s) => !VALID_SPORTS.includes(s))) {
    throw new Error('The request must name one or more supported sports. No default sport will be guessed.');
  }
  if (!VALID_SCOPES.includes(req.scope)) {
    throw new Error('Unsupported date period: ' + req.scope + '. Choose today, tomorrow, weekend, next 3 days, next 7 days, a specific date, a date range or all.');
  }
  if (req.scope === 'date' && !parseLocalYmd(req.date)) {
    throw new Error('Invalid specific date. Expected YYYY-MM-DD format.');
  }
  if (req.scope === 'range') {
    const f = parseLocalYmd(req.dateFrom);
    const t = parseLocalYmd(req.dateTo);
    if (!f || !t || t.getTime() < f.getTime()) {
      throw new Error('Invalid date range. Expected valid YYYY-MM-DD dateFrom and dateTo.');
    }
    const spanDays = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
    if (spanDays > 70) {
      throw new Error('Date range cannot exceed 70 days.');
    }
  }
  if (P.target != null && Number(P.target) !== 0 && (!Number.isFinite(Number(P.target)) || Number(P.target) < 1 || Number(P.target) > 10000)) {
    throw new Error('Invalid combined-odds target. The requested target must be between 1 and 10000.');
  }
  if (P.count != null && Number(P.count) !== 0 && (!Number.isInteger(Number(P.count)) || Number(P.count) < 1 || Number(P.count) > 100)) {
    throw new Error('Invalid selection count. It must be a whole number from 1 to 100.');
  }
  if (P.markets != null && (!Array.isArray(P.markets) || P.markets.some((m) => typeof m !== 'string'))) {
    throw new Error('Invalid market filter list. Markets must be an array of market names.');
  }
}

const TOP = /(premier|champions|europa|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira|championship|nba|euroleague|atp|wta|nhl|mlb)/i;
function isVirtualFixture(ev) {
  return isVirtualOrNonRealFixture(ev);
}
const prio = (e) => (!isVirtualFixture(e) && TOP.test(`${e.country} ${e.league}`) ? 0 : 1);

// Validate whether a fixture's collected statistics are genuinely usable for market evaluation.
// Incomplete, missing, invalid, or evidence-free statistics NEVER count toward the 50-usable target.
function isUsableFixtureStats(ev) {
  if (!ev || !ev.stats || ev.stats.available !== true) return false;
  const profile = an.buildEvidenceProfile(ev);
  if (profile && profile.hasAnyEvidence) return true;
  const cats = ev.stats.categories;
  if (cats && typeof cats === 'object') {
    return !!(cats.recentMatches || cats.teamSeasonScoring || cats.overUnder || cats.winProbabilities || cats.seasonTeamStats);
  }
  return false;
}

// Classify a single checked fixture into one truthful, non-overlapping status category.
function classifyFixtureStatus(ev) {
  if (!ev) return 'excluded';
  if (ev.fixtureStatus === 'not_checked_early_stop' || ev.statsStatus === 'not_checked_early_stop') return 'not_checked_early_stop';
  if (ev.fixtureStatus === 'not_checked_limit_reached' || ev.statsStatus === 'not_checked_limit_reached') return 'not_checked_limit_reached';
  if (ev.fixtureStatus === 'not_checked_stopped' || ev.statsStatus === 'not_checked_stopped') return 'not_checked_stopped';
  if (ev.fixtureStatus === 'excluded') return 'excluded';
  if (ev.statsStatus === 'pending') return 'pending';
  if (ev.statsStatus === 'checking') return 'checking';
  if (ev.stats && ev.stats.available) {
    if (!isUsableFixtureStats(ev)) return 'partial_statistics';
    return ev.stats.status === 'complete' ? 'usable_statistics' : 'partial_statistics';
  }
  const s = String(ev.statsStatus || (ev.stats && ev.stats.status) || '').toLowerCase();
  if (s === 'match_page_unavailable') return 'match_page_unavailable';
  if (s === 'network_failure' || s === 'timeout' || s === 'request_failed' || s === 'body_read_failed') return 'network_failure';
  if (s === 'no_stats_after_retry' || s === 'no_data_returned' || s === 'unavailable' || s === 'request_not_triggered') return 'no_statistics_after_retry';
  if (s === 'association_failed' || s === 'captured_unparsed' || s === 'parse_failed' || s === 'unsupported_competition_data') return 'unsupported_competition_data';
  if (s === 'extraction_error') {
    if (/timed out|timeout|network|econn|socket|err_connection/i.test(String(ev.rejected || ''))) return 'network_failure';
    if (/open|verify the match page/i.test(String(ev.rejected || ''))) return 'match_page_unavailable';
    return 'network_failure';
  }
  return 'no_statistics_after_retry';
}

// Stage B/C controlled-concurrency pool with strict league-priority order and intelligent
// early stopping once `targetUsable` (default 50) genuinely usable fixtures are collected.
// Prevents unnecessary speculative scheduling when in-flight workers already cover the remaining
// usable slots, while safely preserving valid results from any already-running in-flight tasks.
async function runStatsCollectionPool(events, checkOne, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const disableEarlyStop = opts.disableEarlyStop === true;
  const maxAllowedTarget = Math.max(EXPANDED_MAX_FIXTURES_TO_CHECK, list.length, 1);
  const targetUsable = disableEarlyStop
    ? Math.max(1, list.length)
    : Math.max(1, Math.min(maxAllowedTarget, Number(opts.targetUsable) || TARGET_USABLE_FIXTURES));
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 1));
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => '';
  const onAfterFixture = typeof opts.onAfterFixture === 'function' ? opts.onAfterFixture : null;
  // Optional flag for testing in-flight completion overshoot behavior explicitly
  const allowSpeculativeInFlight = opts.allowSpeculativeInFlight === true;

  let cursor = 0;
  let scheduledCount = 0;
  let inFlightCount = 0;
  let checkedCount = 0;
  let usableCount = 0;
  let inFlightExtraUsableCount = 0;
  let stopReason = '';
  const checkedOrder = [];

  let slotWaiters = [];
  const notifySlotChange = () => {
    const w = slotWaiters;
    slotWaiters = [];
    for (const resolve of w) resolve();
  };
  const waitForSlotChange = () => new Promise((resolve) => slotWaiters.push(resolve));

  const worker = async (wIdx) => {
    while (true) {
      if (!disableEarlyStop && usableCount >= targetUsable) {
        if (!stopReason) stopReason = 'early_stop_usable_target';
        break;
      }
      const extStop = shouldStop();
      if (extStop) {
        if (!stopReason) stopReason = String(extStop);
        break;
      }
      if (cursor >= list.length) break;

      // Throttle near threshold (short ranges only): if currently in-flight workers already cover all remaining
      // needed usable slots, wait for one to finish before scheduling another fixture.
      if (!disableEarlyStop) {
        const remainingNeeded = targetUsable - usableCount;
        if (!allowSpeculativeInFlight && inFlightCount >= remainingNeeded) {
          await waitForSlotChange();
          continue;
        }
      }

      const idx = cursor++;
      if (idx >= list.length) break;

      const ev = list[idx];
      ev.statsStatus = 'checking';
      ev.fixtureStatus = 'checking';
      scheduledCount++;
      inFlightCount++;
      checkedOrder.push(idx);

      try {
        await checkOne(wIdx, ev, idx);
      } finally {
        inFlightCount--;
        checkedCount++;
        const usable = isUsableFixtureStats(ev);
        ev.statsUsable = usable;
        ev.fixtureStatus = classifyFixtureStatus(ev);
        if (usable) {
          if (!disableEarlyStop && usableCount >= targetUsable) {
            inFlightExtraUsableCount++;
          }
          usableCount++;
        }

        if (!disableEarlyStop && usableCount >= targetUsable && !stopReason) {
          stopReason = 'early_stop_usable_target';
        }
        notifySlotChange();
      }

      if (onAfterFixture) {
        await onAfterFixture(ev, idx, {
          scheduledCount,
          inFlightCount,
          checkedCount,
          usableCount,
          inFlightExtraUsableCount,
          targetUsable,
          disableEarlyStop,
          stopReason,
        }).catch(() => {});
      }
    }
    notifySlotChange();
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, (_, wIdx) => worker(wIdx)));

  let notCheckedEarlyStop = 0;
  let notCheckedOther = 0;
  for (const ev of list) {
    if (ev.statsStatus === 'pending' || ev.fixtureStatus === 'pending') {
      if (stopReason === 'early_stop_usable_target') {
        ev.statsStatus = 'not_checked_early_stop';
        ev.fixtureStatus = 'not_checked_early_stop';
        notCheckedEarlyStop++;
      } else {
        ev.statsStatus = 'not_checked_stopped';
        ev.fixtureStatus = 'not_checked_stopped';
        notCheckedOther++;
      }
    }
  }

  if (!stopReason) {
    stopReason = 'pool_exhausted';
  }

  const inFlightNote = inFlightExtraUsableCount > 0
    ? `; ${inFlightExtraUsableCount} extra usable fixture${inFlightExtraUsableCount === 1 ? '' : 's'} completed from work already in progress`
    : '';
  const stopExplanation = stopReason === 'early_stop_usable_target'
    ? `Stopped early after collecting ${usableCount} usable fixtures (target ${targetUsable}; ${scheduledCount} scheduled, ${checkedCount} checked, ${notCheckedEarlyStop} not checked in pool${inFlightNote}).`
    : (stopReason === 'pool_exhausted'
      ? (disableEarlyStop
        ? `Assessed complete expanded research pool (${checkedCount} fixtures checked; ${usableCount} usable collected).`
        : `Checked all ${checkedCount} eligible fixtures in the ordered pool (${usableCount} usable collected; target ${targetUsable}).`)
      : `Stopped fixture checking due to ${stopReason} (${scheduledCount} scheduled, ${checkedCount} checked, ${usableCount} usable, ${notCheckedOther} unchecked).`);

  return {
    scheduledCount,
    checkedCount,
    usableCount,
    inFlightExtraUsableCount,
    targetUsable,
    disableEarlyStop,
    notCheckedEarlyStop,
    notCheckedOther,
    stopReason,
    stopExplanation,
    checkedOrder,
  };
}

// Stage C helper: genuine single missing-statistics verification retry.
// Accepts injected statsFn/reloadFn so it is 100% unit-testable offline as well as live.
async function collectStatsWithRetry(ev, fetchOnce, reloadAndFetchOnce) {
  const first = await fetchOnce(ev);
  if (first && first.available) {
    return {
      stats: first,
      statsStatus: first.status || 'partial',
      retried: false,
      recoveredOnRetry: false,
    };
  }
  const firstStatus = (first && first.status) || 'unavailable';
  const retryable = ['no_data_returned', 'unavailable', 'request_not_triggered', 'timeout', 'temp_unavailable'].includes(firstStatus);
  if (!retryable || typeof reloadAndFetchOnce !== 'function') {
    return {
      stats: first || { available: false, status: 'extraction_error' },
      statsStatus: firstStatus === 'error' ? 'extraction_error' : firstStatus,
      retried: false,
      recoveredOnRetry: false,
    };
  }
  // Mark temporarily unavailable before performing ONE genuine second verification attempt
  ev.statsStatus = 'temp_unavailable';
  const second = await reloadAndFetchOnce(ev);
  if (second && second.available) {
    return {
      stats: { ...second, verifiedOnRetry: true },
      statsStatus: second.status || 'partial',
      retried: true,
      recoveredOnRetry: true,
    };
  }
  const finalErr = second && second.status === 'error';
  return {
    stats: { ...(second || first || {}), available: false, status: finalErr ? 'extraction_error' : 'no_stats_after_retry', retried: true },
    statsStatus: finalErr ? 'extraction_error' : 'no_stats_after_retry',
    retried: true,
    recoveredOnRetry: false,
  };
}

// Compute stage timing, operation counts, average, p50/p95, and slowest operations (Part C).
function createTelemetry() {
  const stages = {};
  const ensure = (key) => {
    if (!stages[key]) {
      stages[key] = {
        startedAt: null,
        completedAt: null,
        durationMs: 0,
        completedOps: 0,
        failedOps: 0,
        retries: 0,
        timeouts: 0,
        _durations: [],
        _slowest: [],
      };
    }
    return stages[key];
  };
  return {
    start(key) {
      const s = ensure(key);
      if (!s.startedAt) s.startedAt = Date.now();
    },
    end(key) {
      const s = ensure(key);
      if (!s.startedAt) s.startedAt = Date.now();
      s.completedAt = Date.now();
      s.durationMs = Math.max(0, s.completedAt - s.startedAt);
    },
    recordOp(key, label, durationMs, opts = {}) {
      const s = ensure(key);
      if (!s.startedAt) s.startedAt = Date.now();
      const d = Math.max(0, Math.round(durationMs || 0));
      if (opts.failed) s.failedOps++;
      else s.completedOps++;
      if (opts.retried) s.retries++;
      if (opts.timeout) s.timeouts++;
      s._durations.push(d);
      s._slowest.push({ label: String(label || ''), durationMs: d, failed: !!opts.failed, timeout: !!opts.timeout });
      s._slowest.sort((a, b) => b.durationMs - a.durationMs);
      if (s._slowest.length > 5) s._slowest.length = 5;
    },
    snapshot() {
      const out = {};
      for (const [k, s] of Object.entries(stages)) {
        const sorted = [...s._durations].sort((a, b) => a - b);
        const n = sorted.length;
        const pct = (p) => (n ? sorted[Math.min(n - 1, Math.floor(p * (n - 1)))] : 0);
        const avg = n ? Math.round(sorted.reduce((a, b) => a + b, 0) / n) : 0;
        const nowDuration = s.completedAt ? s.durationMs : (s.startedAt ? Math.max(0, Date.now() - s.startedAt) : 0);
        out[k] = {
          startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
          completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null,
          durationMs: nowDuration,
          completedOps: s.completedOps,
          failedOps: s.failedOps,
          retries: s.retries,
          timeouts: s.timeouts,
          avgOpMs: avg,
          p50OpMs: pct(0.50),
          p95OpMs: pct(0.95),
          slowestOps: s._slowest,
        };
      }
      return out;
    },
  };
}

const MAX_FIXTURES_TO_CHECK = 100;
const TARGET_USABLE_FIXTURES = 50;
const EXPANDED_MAX_FIXTURES_TO_CHECK = 200;
const EXPANDED_MAX_RANKED_CANDIDATES = 100;

// Read an updated target odds value written by local_server.js / cloud/server.js
// while the job is still in discovery/filtering/stats/market-evaluation (before selection starts).
function readPendingTargetUpdate(stateFile, currentTarget) {
  if (!stateFile) return currentTarget;
  try {
    const f = stateFile + '.target.json';
    if (!fs.existsSync(f)) return currentTarget;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const next = Number(d && d.target);
    if (Number.isFinite(next) && next > 1.0 && next <= 10000) return next;
  } catch (_) {}
  return currentTarget;
}

// Compute genuine backend progress object (never fabricates 100% before completion).
function buildProgress(stageKey, stageLabel, startedMs, counts, totalInventory = 0, percentOverride = null, extra = {}) {
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
  let percent = percentOverride;
  let estimatedRemainingSec = null;

  if (percent == null && totalInventory > 0) {
    const checked = counts.statsChecked || 0;
    const evalDone = counts.marketsEvaluatedFixtures || 0;
    const usable = counts.statsUsable || 0;
    const usableTarget = Math.min(totalInventory, counts.targetUsableFixtures || TARGET_USABLE_FIXTURES);
    if (stageKey === 'collecting_stats' || stageKey === 'verifying_missing_stats') {
      // Stage B/C spans 15%..70% proportionally to whichever comes first: 50 usable target or checking pool exhaustion
      const ratioByPool = checked / totalInventory;
      const ratioByTarget = usableTarget > 0 ? Math.min(1, usable / usableTarget) : 0;
      const effRatio = Math.min(1, Math.max(ratioByPool, ratioByTarget));
      percent = Math.min(70, Math.round(15 + effRatio * 55));
      if (checked >= 2 && effRatio < 1 && elapsedSec > 0) {
        const secPerFixture = elapsedSec / checked;
        const estRemainingByPool = Math.max(0, totalInventory - checked);
        const estRemainingByTarget = usable > 0
          ? Math.max(0, Math.ceil(((usableTarget - usable) / usable) * checked))
          : estRemainingByPool;
        const remainingFixtures = Math.max(1, Math.min(estRemainingByPool, estRemainingByTarget));
        estimatedRemainingSec = Math.max(1, Math.round(remainingFixtures * secPerFixture));
      }
    } else if (stageKey === 'evaluating_markets') {
      const denom = Math.max(1, usable);
      percent = Math.min(86, Math.round(70 + (evalDone / denom) * 16));
    }
  }

  // Never report 100% unless genuinely completed
  if (stageKey !== 'completed' && percent != null && percent >= 100) {
    percent = 99;
  }

  const targetLocked = !!extra.targetLocked;
  return {
    stageKey,
    stageLabel,
    percent: percent != null ? Math.max(0, Math.min(100, Math.round(percent))) : null,
    expandedResearchMode: counts.expandedResearchMode === true,
    researchPoolLimit: counts.researchPoolLimit || counts.maxFixturesToCheck || MAX_FIXTURES_TO_CHECK,
    rankedCandidatePoolLimit: counts.rankedCandidatePoolLimit || 0,
    fixturesDiscovered: counts.discovered || 0,
    fixturesMatchingDateRange: counts.fixturesMatchingDateRange ?? counts.inWindow ?? 0,
    fixturesWithIdentifiedLeagues: counts.fixturesWithIdentifiedLeagues || 0,
    fixturesLeagueOrdered: counts.fixturesLeagueOrdered ?? counts.fixturesAfterLeagueFilter ?? counts.inWindow ?? 0,
    fixturesAfterLeagueFilter: counts.fixturesAfterLeagueFilter ?? counts.inWindow ?? 0,
    maxFixturesToCheck: counts.maxFixturesToCheck || MAX_FIXTURES_TO_CHECK,
    targetUsableFixtures: counts.targetUsableFixtures || TARGET_USABLE_FIXTURES,
    fixturesSelectedForCheck: counts.fixturesSelectedForCheck ?? counts.inWindow ?? 0,
    fixturesExcludedByCap: counts.fixturesExcludedByCap || 0,
    notCheckedLimitReached: counts.notCheckedLimitReached ?? counts.fixturesExcludedByCap ?? 0,
    notCheckedEarlyStop: counts.notCheckedEarlyStop || 0,
    fixturesExcludedTotal: (counts.virtualExcluded || 0) + (counts.outOfWindowExcluded || 0) + (counts.fixturesExcludedByCap || 0),
    fixturesInWindow: counts.inWindow || 0,
    statsScheduled: counts.statsScheduled ?? counts.statsChecked ?? 0,
    statsChecked: counts.statsChecked || 0,
    statsUsable: counts.statsUsable || counts.withStats || 0,
    statsComplete: counts.withCompleteStats || 0,
    statsInFlightExtraUsable: counts.statsInFlightExtraUsable || 0,
    statsPartial: counts.withPartialStats || 0,
    noStatsAfterRetry: counts.noStatsAfterRetry || 0,
    statsNetworkFailures: counts.statsNetworkFailures || 0,
    statsPageUnavailable: counts.statsPageUnavailable || 0,
    statsSkippedUnavailable: counts.statsSkippedUnavailable || 0,
    statsRetried: counts.statsRetried || 0,
    statsRecovered: counts.statsRecoveredOnRetry || 0,
    statsStopReason: counts.statsStopReason || '',
    statsStopExplanation: counts.statsStopExplanation || '',
    marketsEvaluated: counts.marketsEvaluated || 0,
    aiAnalysesCompleted: counts.aiAnalysesCompleted || 0,
    aiRecommendationsProduced: counts.aiRecommendationsProduced || 0,
    aiNoSelectionCount: counts.aiNoSelectionCount || 0,
    aiTokensUsed: counts.aiTokensUsed || 0,
    rank1Attempts: counts.rank1Attempts || 0,
    rank2Fallbacks: counts.rank2Fallbacks || 0,
    rank3Fallbacks: counts.rank3Fallbacks || 0,
    candidatesQualified: counts.candidatesQualified || 0,
    strongestCandidatesRetained: counts.strongestCandidatesRetained || 0,
    approvedMarketsOffered: Array.isArray(counts.approvedMarketsOffered) ? counts.approvedMarketsOffered : [],
    approvedMarketsEvaluated: Array.isArray(counts.approvedMarketsEvaluated) ? counts.approvedMarketsEvaluated : [],
    approvedMarketsMissingStats: Array.isArray(counts.approvedMarketsMissingStats) ? counts.approvedMarketsMissingStats : [],
    approvedMarketsNotOffered: Array.isArray(counts.approvedMarketsNotOffered) ? counts.approvedMarketsNotOffered : [],
    approvedMarketsUnavailable: Array.isArray(counts.approvedMarketsUnavailable) ? counts.approvedMarketsUnavailable : [],
    approvedMarketsStatus: counts.approvedMarketsStatus || null,
    selectionStarted: counts.selectionStarted === true,
    selectionsChosen: counts.selectionStarted ? (counts.selections || 0) : 0,
    selectionsAdded: counts.selectionsAdded || 0,
    selectionsVerified: counts.selectionsVerified || 0,
    selectionsUnavailable: counts.selectionsUnavailable || 0,
    // Part 4: Never expose combinedOdds before actual selection has begun!
    combinedOdds: counts.selectionStarted ? (counts.combinedOdds || 0) : 0,
    liveBetslipCombinedOdds: counts.liveBetslipCombinedOdds || 0,
    qualifyingCandidatesRemaining: counts.qualifyingCandidatesRemaining ?? 0,
    projectedCombinedOdds: counts.projectedCombinedOdds ?? null,
    targetReached: counts.selectionStarted && counts.targetReached === true,
    selectionStopReason: counts.selectionStopReason || '',
    selectionFrozen: counts.selectionFrozen === true,
    selectionCheckpoints: Array.isArray(counts.selectionCheckpoints) ? counts.selectionCheckpoints : [],
    shareCodeVerified: counts.shareCodeVerified === true,
    targetOdds: extra.targetOdds ?? counts.targetOdds ?? 0,
    targetLocked,
    targetEditable: !targetLocked && stageKey !== 'completed' && stageKey !== 'incomplete',
    lastCompletedStage: extra.lastCompletedStage || '',
    failedStage: extra.failedStage || '',
    elapsedSec,
    estimatedRemainingSec,
  };
}

function tallyRejections(allEvents, cands, state) {
  const why = {};
  const categoryInterpreted = {};
  const categoryUnavailable = {};
  let responsesObserved = 0;
  let gismoResponsesReceived = 0;
  let bodiesRead = 0;
  let bodyReadFailures = 0;
  let jsonParsed = 0;
  let jsonParseFailures = 0;
  let relevantStatResponses = 0;
  let unknownRelevantResponses = 0;
  let parseFailures = 0;
  let associationFailures = 0;
  let statsRequestsObserved = 0;
  let withCompleteStats = 0;
  let withPartialStats = 0;
  let noStatsAfterRetry = 0;
  let statsExtractionErrors = 0;
  let statsNetworkFailures = 0;
  let statsPageUnavailable = 0;
  let statsUnsupportedData = 0;
  let notCheckedEarlyStop = 0;
  let notCheckedStopped = 0;
  let statsCheckedCount = 0;
  let statsUsableCount = 0;
  let marketsEvaluatedOutcomes = 0;
  const approvedOfferedSet = new Set();
  const approvedEvaluatedSet = new Set();

  const approvedOfferedCounts = {};
  const approvedEvaluatedCounts = {};
  const approvedMissingStatsCounts = {};
  const approvedQualifyingCounts = {};
  for (const id of approvedMarkets.APPROVED_MARKET_IDS) {
    approvedOfferedCounts[id] = 0;
    approvedEvaluatedCounts[id] = 0;
    approvedMissingStatsCounts[id] = 0;
    approvedQualifyingCounts[id] = 0;
  }

  for (const e of allEvents) {
    if (e.rejected) why[e.rejected] = (why[e.rejected] || 0) + 1;
    const fStatus = classifyFixtureStatus(e);
    e.fixtureStatus = fStatus;
    if (fStatus === 'not_checked_early_stop') {
      notCheckedEarlyStop++;
      continue;
    }
    if (fStatus === 'not_checked_stopped' || fStatus === 'pending') {
      notCheckedStopped++;
      continue;
    }
    statsCheckedCount++;
    if (fStatus === 'no_statistics_after_retry' || e.statsStatus === 'no_stats_after_retry') noStatsAfterRetry++;
    if (fStatus === 'network_failure') statsNetworkFailures++;
    if (fStatus === 'match_page_unavailable') statsPageUnavailable++;
    if (fStatus === 'unsupported_competition_data') statsUnsupportedData++;
    if (e.statsStatus === 'extraction_error') statsExtractionErrors++;
    if (isUsableFixtureStats(e)) statsUsableCount++;
    if (e.marketDiscoveryReport) {
      if (typeof e.marketDiscoveryReport.evaluatedOutcomesCount === 'number') {
        marketsEvaluatedOutcomes += e.marketDiscoveryReport.evaluatedOutcomesCount;
      }
      for (const id of (e.marketDiscoveryReport.approvedMarketsOffered || [])) {
        approvedOfferedSet.add(id);
        if (approvedOfferedCounts[id] != null) approvedOfferedCounts[id]++;
      }
      for (const id of (e.marketDiscoveryReport.approvedMarketsEvaluated || [])) {
        approvedEvaluatedSet.add(id);
        if (approvedEvaluatedCounts[id] != null) approvedEvaluatedCounts[id]++;
      }
      for (const id of (e.marketDiscoveryReport.approvedMarketsMissingStats || [])) {
        if (approvedMissingStatsCounts[id] != null) approvedMissingStatsCounts[id]++;
      }
      for (const id of (e.marketDiscoveryReport.approvedMarketsQualifying || [])) {
        if (approvedQualifyingCounts[id] != null) approvedQualifyingCounts[id]++;
      }
    }
    const st = e.stats;
    if (!st) continue;
    const d = st.diagnostics || {};
    if ((d.gismoResponsesReceived || 0) > 0 || (st.responseCount || 0) > 0) statsRequestsObserved++;
    responsesObserved += d.responsesObserved || d.gismoResponsesReceived || st.responseCount || 0;
    gismoResponsesReceived += d.gismoResponsesReceived || st.responseCount || 0;
    bodiesRead += d.bodiesRead || 0;
    bodyReadFailures += d.bodyReadFailures || 0;
    jsonParsed += d.jsonParsed || 0;
    jsonParseFailures += d.jsonParseFailures || 0;
    relevantStatResponses += d.relevantStatResponses || st.responseCount || 0;
    unknownRelevantResponses += Array.isArray(d.unknownRelevant) ? d.unknownRelevant.length : 0;
    parseFailures += Array.isArray(st.parseFailures) ? st.parseFailures.length : 0;
    associationFailures += Array.isArray(st.associationFailures) ? st.associationFailures.length : 0;
    if (st.status === 'complete' && isUsableFixtureStats(e)) withCompleteStats++;
    else if (st.status === 'partial' || fStatus === 'partial_statistics') withPartialStats++;
    if (st.categories && typeof st.categories === 'object') {
      for (const [k, v] of Object.entries(st.categories)) {
        if (v) categoryInterpreted[k] = (categoryInterpreted[k] || 0) + 1;
        else categoryUnavailable[k] = (categoryUnavailable[k] || 0) + 1;
      }
    }
  }

  state.counts.opened = allEvents.filter((e) => e.opened).length;
  state.counts.statsChecked = statsCheckedCount;
  state.counts.withStatsRequestsObserved = statsRequestsObserved;
  state.counts.statsResponsesReceived = responsesObserved;
  state.counts.gismoResponsesReceived = gismoResponsesReceived;
  state.counts.statsBodiesRead = bodiesRead;
  state.counts.statsBodyReadFailures = bodyReadFailures;
  state.counts.statsJsonParsed = jsonParsed;
  state.counts.statsJsonParseFailures = jsonParseFailures;
  state.counts.statsRelevantResponses = relevantStatResponses;
  state.counts.statsCaptured = relevantStatResponses;
  state.counts.unknownRelevantResponses = unknownRelevantResponses;
  state.counts.statsCategoriesInterpreted = categoryInterpreted;
  state.counts.statsCategoriesUnavailable = categoryUnavailable;
  state.counts.parseFailures = parseFailures;
  state.counts.associationFailures = associationFailures;
  state.counts.teamsIdentified = allEvents.filter((e) => e.stats && e.stats.categories && e.stats.categories.teamIdentity).length;
  state.counts.historicalExtracted = allEvents.filter((e) => e.stats && e.stats.categories && (e.stats.categories.recentMatches || e.stats.categories.headToHead)).length;
  state.counts.withStats = statsUsableCount;
  state.counts.statsUsable = statsUsableCount;
  state.counts.withCompleteStats = withCompleteStats;
  state.counts.withPartialStats = withPartialStats;
  state.counts.noStatsAfterRetry = noStatsAfterRetry;
  state.counts.statsNetworkFailures = statsNetworkFailures;
  state.counts.statsPageUnavailable = statsPageUnavailable;
  state.counts.statsUnsupportedData = statsUnsupportedData;
  state.counts.notCheckedEarlyStop = notCheckedEarlyStop;
  state.counts.notCheckedStopped = notCheckedStopped;
  state.counts.notCheckedLimitReached = state.counts.fixturesExcludedByCap || 0;
  // Truthful skipped count: strictly checked fixtures that lacked usable stats (NEVER includes unchecked fixtures!)
  state.counts.statsSkippedUnavailable = noStatsAfterRetry + statsNetworkFailures + statsPageUnavailable + statsUnsupportedData;
  state.counts.statsExtractionErrors = statsExtractionErrors;
  state.counts.withMarkets = allEvents.filter((e) => e.markets && e.markets.length).length;
  state.counts.evaluated = allEvents.filter((e) => e.evaluated).length;
  state.counts.marketsEvaluated = marketsEvaluatedOutcomes;
  state.counts.approvedMarketsOffered = [...approvedOfferedSet];
  state.counts.approvedMarketsEvaluated = [...approvedEvaluatedSet];
  state.counts.approvedMarketsMissingStats = approvedMarkets.APPROVED_MARKET_IDS.filter(
    (id) => approvedOfferedSet.has(id) && !approvedEvaluatedSet.has(id)
  );
  state.counts.approvedMarketsNotOffered = approvedMarkets.APPROVED_MARKET_IDS.filter((id) => !approvedOfferedSet.has(id));
  state.counts.approvedMarketsUnavailable = approvedMarkets.APPROVED_MARKET_IDS.filter((id) => !approvedEvaluatedSet.has(id));
  state.counts.approvedMarketsStatus = approvedMarkets.APPROVED_MARKET_IDS.reduce((acc, id) => {
    const def = approvedMarkets.getApprovedMarket(id);
    const offered = approvedOfferedCounts[id] || 0;
    const evaluated = approvedEvaluatedCounts[id] || 0;
    const missingStats = approvedMissingStatsCounts[id] || 0;
    const qualifying = approvedQualifyingCounts[id] || 0;
    acc[id] = {
      id,
      name: def ? def.name : id,
      offeredFixtures: offered,
      evaluatedFixtures: evaluated,
      missingStatsFixtures: missingStats,
      qualifyingFixtures: qualifying,
      status: evaluated > 0 ? 'evaluated' : (offered > 0 ? 'offered_missing_stats' : 'not_offered'),
    };
    return acc;
  }, {});
  state.counts.candidates = cands.length;
  state.counts.rejected = allEvents.filter((e) => !!e.rejected).length;
  state.counts.rejectionReasons = why;

  const discoveredByDate = {};
  const openedByDate = {};
  for (const e of allEvents) {
    const dayKey = e.ts ? dates.kampalaYmd(e.ts) : 'unknown';
    discoveredByDate[dayKey] = (discoveredByDate[dayKey] || 0) + 1;
    if (e.opened) openedByDate[dayKey] = (openedByDate[dayKey] || 0) + 1;
  }
  state.counts.inWindowByDate = discoveredByDate;
  state.counts.openedByDate = openedByDate;
  state.counts.eligibleRemaining = allEvents.filter((e) => !e.opened && !e.rejected).length;

  state.fixturesSummary = allEvents.slice(0, 100).map((e) => {
    const st = e.stats || {};
    const cats = st.categories || {};
    return {
      fixtureId: st.fixtureId || e.matchId || 0,
      competitionId: st.competitionId || 0,
      seasonId: st.seasonId || 0,
      stage: st.stage || '',
      home: e.home,
      away: e.away,
      league: st.competition || e.league || '',
      country: st.country || e.country || '',
      kampalaDate: e.ts ? dates.kampalaYmd(e.ts) : '',
      kickoffTs: e.ts || 0,
      opened: !!e.opened,
      marketsCount: Array.isArray(e.markets) ? e.markets.length : 0,
      marketDiscoveryReport: e.marketDiscoveryReport || null,
      fixtureStatus: e.fixtureStatus || classifyFixtureStatus(e),
      statsStatus: e.statsStatus || st.status || 'unavailable',
      statsUsable: !!e.statsUsable,
      statsRetried: !!e.statsRetried,
      statsRecoveredOnRetry: !!e.statsRecoveredOnRetry,
      statsSource: st.source || '',
      categoriesAvailable: Object.entries(cats).filter(([, v]) => v).map(([k]) => k),
      categoriesMissing: Object.entries(cats).filter(([, v]) => !v).map(([k]) => k),
      parseFailures: Array.isArray(st.parseFailures) ? st.parseFailures.length : 0,
      rejected: e.rejected || '',
    };
  });
  return why;
}

async function notify(title, body, data = null) {
  const f = path.join(__dirname, '..', 'notify', 'out.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([{ title, body, ...(data ? { data } : {}) }]));
}

// Merge confirmed-used ticket selections from both the request payload and the persisted
// backend confirmed-used file (NEVER including unconfirmed/generated-only tickets).
function loadConfirmedUsedSelections(filePath, requestUsedSelections) {
  const out = [];
  const seen = new Set();
  const pushOne = (s) => {
    if (!s || typeof s !== 'object') return;
    const key = tk.selectionIdentityKey(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  if (Array.isArray(requestUsedSelections)) {
    for (const s of requestUsedSelections) pushOne(s);
  }
  if (filePath && fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const tickets = Array.isArray(raw && raw.tickets) ? raw.tickets : (Array.isArray(raw) ? raw : []);
      for (const t of tickets) {
        if (!t || t.confirmedUsed !== true) continue;
        const legs = Array.isArray(t.selections) ? t.selections : (Array.isArray(t.legs) ? t.legs : []);
        for (const l of legs) pushOne(l);
      }
    } catch (_) {}
  }
  return out;
}

async function main() {
  const { Site, OUT, createFixtureRegistry } = require('./lib/site');
  const { PhoneGatewayServer } = require('./lib/gateway');
  const job = JSON.parse(process.env.JOB || '{}');
  const ID = process.env.JOB_ID || job.id || 'manual';
  const P = job.params || job;
  const started = Date.now();
  const usedSelections = loadConfirmedUsedSelections(process.env.CONFIRMED_USED_FILE || '', P.usedSelections);
  const req = {
    sports: Array.isArray(P.sports) ? P.sports : [],
    scope: P.scope || 'today',
    date: P.date || '',
    dateFrom: P.dateFrom || '',
    dateTo: P.dateTo || '',
    dates: Array.isArray(P.dates) ? P.dates : [],
    markets: Array.isArray(P.markets) ? P.markets.filter((m) => typeof m === 'string' && m.trim()) : [],
    usedSelections,
    target: Number(P.target) || 0,
    count: Number(P.count) || 0,
    minutes: Math.min(180, Math.max(5, Number(P.minutes) || 105)),
    // Default 0 = NO arbitrary fixture discovery/inspection limit (50-selection cap applies ONLY to final ticket!)
    maxFixtures: Number(P.maxFixtures || process.env.MAX_FIXTURES) > 0
      ? Math.max(1, Number(P.maxFixtures || process.env.MAX_FIXTURES))
      : 0,
    noBook: !!P.noBook,
    usePhoneGateway: P.usePhoneGateway === true || process.env.USE_PHONE_GATEWAY === '1',
    dataLimitMb: Number(P.dataLimitMb) > 0 ? Math.min(2000, Math.max(1, Number(P.dataLimitMb))) : 200,
    text: job.text || '',
  };
  const dateScope = dates.resolveDateScope(req, started);
  req.scope = dateScope.scope;
  req.startDate = dateScope.startDate;
  req.endDate = dateScope.endDate;
  req.dates = dateScope.dates;
  req.timezone = dateScope.timezone;
  if (req.scope === 'range') {
    req.dateFrom = dateScope.startDate;
    req.dateTo = dateScope.endDate;
  } else if (req.scope === 'date') {
    req.date = dateScope.startDate;
  }
  const deadline = started + req.minutes * 60000;
  // Reserve a dedicated booking buffer so Stage B fixture checking never starves Stage G/H betslip preparation.
  const bookingReserveMs = req.noBook ? 0 : Math.min(4 * 60000, Math.max(90000, Math.round(req.minutes * 60000 * 0.2)));
  const statsDeadline = Math.max(started + 60000, deadline - bookingReserveMs);
  const log = (...a) => console.log('[run]', ...a);

  const expandedResearchMode = dateScope.expandedResearchPool === true;
  const researchPoolLimit = expandedResearchMode ? EXPANDED_MAX_FIXTURES_TO_CHECK : MAX_FIXTURES_TO_CHECK;
  const rankedCandidatePoolLimit = expandedResearchMode ? EXPANDED_MAX_RANKED_CANDIDATES : 0;
  const isFootballRun = req.sports.length === 1 && req.sports[0] === 'football';
  const expectedApprovedIds = isFootballRun
    ? approvedMarkets.APPROVED_MARKET_IDS
    : [...new Set(req.sports.flatMap((sp) => (sp === 'football' ? approvedMarkets.APPROVED_MARKET_IDS : sportMarkets.getApprovedIdsForSport(sp))))];

  const state = {
    id: ID,
    status: 'running',
    stage: 'Discovering fixtures',
    stages: [],
    request: req,
    dateScope,
    started,
    updated: started,
    progress: buildProgress('discovering_fixtures', 'Discovering fixtures', started, {}, 0, null),
    counts: {
      expandedResearchMode,
      researchPoolLimit,
      rankedCandidatePoolLimit,
      discovered: 0, virtualExcluded: 0, inWindow: 0, displayed: 0, opened: 0,
      statsChecked: 0, statsUsable: 0, statsSkippedUnavailable: 0, statsRetried: 0,
      statsRecoveredOnRetry: 0, noStatsAfterRetry: 0, statsExtractionErrors: 0,
      statsNetworkFailures: 0, statsPageUnavailable: 0, statsUnsupportedData: 0,
      withCompleteStats: 0, withPartialStats: 0,
      notCheckedEarlyStop: 0, notCheckedStopped: 0, notCheckedLimitReached: 0,
      statsStopReason: '', statsStopExplanation: '',
      statsInspected: 0, statsCaptured: 0, teamsIdentified: 0, historicalExtracted: 0, withStats: 0,
      marketsInspected: 0, withMarkets: 0, marketsEvaluated: 0, marketsEvaluatedFixtures: 0,
      aiAnalysesCompleted: 0, aiRecommendationsProduced: 0, aiNoSelectionCount: 0, aiTokensUsed: 0, aiSource: '',
      rank1Attempts: 0, rank2Fallbacks: 0, rank3Fallbacks: 0, fallbackSkipped: 0,
      approvedMarketsOffered: [], approvedMarketsEvaluated: [], approvedMarketsUnavailable: [...expectedApprovedIds],
      highOddsChecked: 0, highOddsPassed: 0, highOddsRejected: 0,
      rawFixturesFound: 0, uniqueFixtureUrls: 0, uniqueNormalizedFixtures: 0,
      duplicatesRemoved: 0, outOfWindowExcluded: 0, apiTotalReported: 0, pagesFetched: 0,
      fixturesMatchingDateRange: 0,
      fixturesWithIdentifiedLeagues: 0,
      fixturesLeagueOrdered: 0,
      fixturesAfterLeagueFilter: 0,
      leaguePriorityTopSample: [],
      fixturesSelectedForCheck: 0, fixturesExcludedByCap: 0,
      maxFixturesToCheck: researchPoolLimit,
      targetUsableFixtures: expandedResearchMode
        ? researchPoolLimit
        : (Number(P.targetUsableFixtures || process.env.TARGET_USABLE_FIXTURES) > 0
          ? Math.max(1, Math.min(MAX_FIXTURES_TO_CHECK, Number(P.targetUsableFixtures || process.env.TARGET_USABLE_FIXTURES)))
          : TARGET_USABLE_FIXTURES),
      evaluated: 0, candidates: 0, candidatesQualified: 0, strongestCandidatesRetained: 0,
      selectionStarted: false, accepted: 0, selections: 0,
      selectionsAdded: 0, selectionsVerified: 0, selectionsUnavailable: 0,
      liveBetslipCombinedOdds: 0, selectionCheckpoints: [],
      shareCodeVerified: false,
      rejected: 0, rejectionReasons: {},
      combinedOdds: 0, targetOdds: req.target, maxTicketSelections: tk.MAX_TICKET_SELECTIONS,
      exhaustedAllFixtures: false, timedOut: false,
      eligibleRemaining: 0, limitReachedReason: '', tabsScanned: [], failedTabs: [],
    },
    targetLocked: false,
    lastCompletedStage: '',
    failedStage: '',
    canResume: false,
    canRetry: true,
    telemetry: {},
    gateway: null,
    ticket: null,
    booking: null,
    error: '',
    notes: [],
  };

  const telemetry = createTelemetry();
  let gw = null;
  let lastSave = 0;
  let cancelRequested = false;
  let lastCfTarget = null;
  async function save(force) {
    state.updated = Date.now();
    state.telemetry = telemetry.snapshot();
    const mem = process.memoryUsage();
    state.resourceUsage = {
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      elapsedSec: Math.max(0, Math.round((state.updated - started) / 1000)),
      aiTokensUsed: state.counts.aiTokensUsed || 0,
    };
    if (gw) {
      const s = gw.status();
      state.gateway = { ...(state.gateway || {}), ...s };
    }
    if (!force && state.updated - lastSave < 2500) return;
    lastSave = state.updated;
    if (process.env.LOCAL_STATE_FILE) {
      try {
        const tmp = process.env.LOCAL_STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, process.env.LOCAL_STATE_FILE);
      } catch (e) { log('local-state', e.message); }
    }
    if (cfClient.getConfig().enabled) {
      const cfRes = await cfClient.reportProgress(ID, state).catch((e) => ({ ok: false, error: e.message }));
      if (cfRes && cfRes.cancelRequested) cancelRequested = true;
      if (cfRes && cfRes.pendingTarget && !state.targetLocked) {
        lastCfTarget = Number(cfRes.pendingTarget);
      }
    }
    if (process.env.LOCAL_NO_GIST !== '1' && process.env.GH_TOKEN) {
      await gist.save(ID, state).catch((e) => log('gist', e.message));
    }
  }

  function syncEditableTarget() {
    if (state.targetLocked) return;
    let next = readPendingTargetUpdate(process.env.LOCAL_STATE_FILE, req.target);
    if (lastCfTarget && Number.isFinite(lastCfTarget) && lastCfTarget > 1.0 && lastCfTarget <= 10000) {
      next = lastCfTarget;
    }
    if (next !== req.target) {
      log(`target odds updated live before selection: ${req.target} -> ${next}`);
      req.target = next;
      state.request.target = next;
      state.counts.targetOdds = next;
    }
  }

  async function setProgress(stageKey, stageLabel, totalInventory = 0, percentOverride = null, force = false) {
    syncEditableTarget();
    state.progress = buildProgress(stageKey, stageLabel, started, state.counts, totalInventory, percentOverride, {
      targetOdds: req.target,
      targetLocked: state.targetLocked,
      lastCompletedStage: state.lastCompletedStage,
      failedStage: state.failedStage,
    });
    state.stage = stageLabel;
    await save(force);
  }

  async function stage(s, stageKey = null, percentOverride = null) {
    syncEditableTarget();
    if (state.stages.length) {
      state.stages[state.stages.length - 1].ok = true;
      state.lastCompletedStage = state.stages[state.stages.length - 1].s;
    }
    state.stage = s;
    state.stages.push({ s, ok: false, t: Date.now() });
    if (stageKey) {
      state.progress = buildProgress(stageKey, s, started, state.counts, state.counts.inWindow, percentOverride, {
        targetOdds: req.target,
        targetLocked: state.targetLocked,
        lastCompletedStage: state.lastCompletedStage,
        failedStage: state.failedStage,
      });
    }
    log(s);
    await save(true);
  }

  const withTimeout = (p, ms, msg) => {
    let timer;
    return Promise.race([
      p,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); }),
    ]).finally(() => clearTimeout(timer));
  };

  const site = new Site();
  try {
    await save(true);
    await stage('Understanding request', 'discovering_fixtures', 2);
    validateRequest(P, req);
    log('request:', JSON.stringify(req));

    let proxyServer = '';
    if (req.usePhoneGateway) {
      await stage('Starting phone gateway tunnel', 'discovering_fixtures', 3);
      gw = new PhoneGatewayServer({ limitMb: req.dataLimitMb });
      const info = await gw.start({ useCloudflared: process.env.GATEWAY_LOCAL_ONLY !== '1' });
      proxyServer = info.proxyUrl;
      state.gateway = { ...gw.status(), gatewayUrl: info.gatewayUrl, gatewayToken: info.gatewayToken };
      await stage('Waiting for phone gateway connection', 'discovering_fixtures', 4);
      const connected = await gw.waitForPhone(120000);
      if (!connected) {
        state.status = 'gateway_disconnected';
        state.error = 'Phone gateway did not connect within 120 seconds.';
        state.progress = buildProgress('incomplete', 'Phone gateway disconnected', started, state.counts, 0, null);
        return;
      }
    }

    await site.start({ proxyServer, optimizeData: true });

    // =========================================================================
    // STAGE A — COMPLETE FIXTURE DISCOVERY & INVENTORY (NO ARBITRARY LIMIT)
    // =========================================================================
    telemetry.start('discovering_fixtures');
    await stage('Discovering fixtures', 'discovering_fixtures', 5);
    const [from, to] = [dateScope.fromMs, dateScope.toMs];
    const tabsToScan = dateScope.bangbetTabs && dateScope.bangbetTabs.length ? dateScope.bangbetTabs : [req.scope];
    const allEvents = [];
    let evIdx = 0;
    let limitReachedReason = '';

    for (const sport of req.sports) {
      if (Date.now() >= deadline) { limitReachedReason = 'deadline'; break; }
      const registry = createFixtureRegistry();
      let listing = null;
      let sportExhaustedAllTabs = true;
      const sportDiscT0 = Date.now();
      try {
        listing = await site.openListing(sport, req, { tabScope: tabsToScan[0], registry });
        for (let tabIdx = 0; tabIdx < tabsToScan.length; tabIdx++) {
          if (Date.now() >= deadline) { sportExhaustedAllTabs = false; limitReachedReason = 'deadline'; break; }
          const activeTab = tabsToScan[tabIdx];
          try {
            if (tabIdx > 0) await site.switchListingTab(listing, activeTab, req);
            if (!state.counts.tabsScanned.includes(activeTab)) state.counts.tabsScanned.push(activeTab);
            while (Date.now() < deadline && !listing.exhausted) {
              await site.collectNextBatch(listing, deadline, 60, {
                fromMs: from,
                toMs: to,
                desiredEligibleCap: researchPoolLimit,
                onPage: async (count, pageNum, maxPages) => {
                  state.counts.discovered = count;
                  await setProgress('discovering_fixtures', `Discovering fixtures (${count} found, page ${pageNum}/${maxPages})`, 0, null, false);
                },
              });
              state.counts.discovered = registry.list.length;
              await setProgress('discovering_fixtures', `Discovering fixtures (${registry.list.length} found)`, 0, null, false);
              if (listing.stopReason && listing.stopReason.startsWith('api_error')) {
                sportExhaustedAllTabs = false;
                break;
              }
            }
            if (!listing.exhausted) sportExhaustedAllTabs = false;
          } catch (tabErr) {
            sportExhaustedAllTabs = false;
            state.counts.failedTabs.push({ sport, tab: activeTab, error: tabErr.message });
            site.notes.push(`${sport}/${activeTab}: ${tabErr.message}`);
          }
        }
        if (site.discovery[sport]) {
          site.discovery[sport].exhausted = sportExhaustedAllTabs && state.counts.failedTabs.length === 0;
          site.discovery[sport].tabsScanned = [...state.counts.tabsScanned];
        }
        telemetry.recordOp('discovering_fixtures', `${sport} (${registry.list.length} unique)`, Date.now() - sportDiscT0, { failed: !sportExhaustedAllTabs });
      } catch (e) {
        sportExhaustedAllTabs = false;
        state.counts.failedTabs.push({ sport, tab: tabsToScan[0], error: e.message });
        site.notes.push(`${sport}: ${e.message}`);
        telemetry.recordOp('discovering_fixtures', `${sport} failed`, Date.now() - sportDiscT0, { failed: true });
      } finally {
        if (listing && listing.page) await listing.page.close().catch(() => {});
      }

      state.counts.rawFixturesFound += registry.rawFound || registry.list.length;
      state.counts.uniqueFixtureUrls += registry.uniqueUrls ? registry.uniqueUrls.size : 0;
      state.counts.uniqueNormalizedFixtures += registry.list.length;
      state.counts.duplicatesRemoved += registry.duplicatesRemoved || 0;
      state.counts.apiTotalReported += registry.apiTotalReported || 0;
      state.counts.pagesFetched += registry.pagesFetched || 0;

      for (const e of registry.list) {
        if (e.ts && (e.ts < from || e.ts >= to)) {
          state.counts.outOfWindowExcluded++;
          continue;
        }
        state.counts.fixturesMatchingDateRange++;
        if (isVirtualFixture(e)) {
          state.counts.virtualExcluded++;
          continue;
        }
        allEvents.push({
          ...e,
          key: `${e.sport}:${e.matchId || norm(e.home)}:${norm(e.away)}:${evIdx++}`,
          statsStatus: 'pending',
        });
      }
    }
    telemetry.end('discovering_fixtures');

    // Stage B — Transparent, auditable league-priority ordering (Part 6).
    // Uses real BangBet competition metadata + documented established-competition hierarchy
    // with a documented fallback that preserves unranked fixtures (never discards them).
    await stage(`Filtering by sport & date (${allEvents.length} in range)`, 'filtering_fixtures', 11);
    const leagueOrderRes = orderFixturesByLeaguePriority(allEvents);
    allEvents.length = 0;
    allEvents.push(...leagueOrderRes.ordered);
    state.counts.fixturesWithIdentifiedLeagues = leagueOrderRes.identifiedCount;
    state.counts.fixturesLeagueOrdered = leagueOrderRes.total;
    state.counts.fixturesAfterLeagueFilter = allEvents.length;
    state.counts.leaguePriorityTopSample = leagueOrderRes.topCompetitionsSample;
    await stage(`Ordering by league (${leagueOrderRes.identifiedCount}/${allEvents.length} leagues identified)`, 'ordering_by_league', 13);

    // Stage C — Select eligible research pool (100 for short ranges; up to 200 for Weekend / >2-day ranges)
    const effectiveCap = req.maxFixtures > 0 ? Math.min(req.maxFixtures, researchPoolLimit) : researchPoolLimit;
    if (allEvents.length > effectiveCap) {
      state.counts.fixturesExcludedByCap = allEvents.length - effectiveCap;
      state.counts.notCheckedLimitReached = state.counts.fixturesExcludedByCap;
      allEvents.length = effectiveCap;
    }
    state.counts.fixturesSelectedForCheck = allEvents.length;
    state.counts.inWindow = allEvents.length;
    state.counts.displayed = allEvents.length;
    const poolSummaryLabel = expandedResearchMode
      ? `Selected ${allEvents.length} fixtures (expanded long-range pool, max ${effectiveCap}, top ${rankedCandidatePoolLimit} candidates)`
      : `Selected ${allEvents.length} fixtures (league-ordered, max ${effectiveCap}, stop at ${state.counts.targetUsableFixtures} usable)`;
    await stage(poolSummaryLabel, 'building_inventory', 15);

    if (!allEvents.length) {
      tallyRejections(allEvents, [], state);
      throw new Error('BangBet displayed no fixtures for the selected date range. ' + site.notes.join(' | '));
    }

    // =========================================================================
    // STAGE B & C — STATISTICS COLLECTION + MISSING-STATS VERIFICATION RETRY
    // (Single-visit optimization: captures raw visible Markets DOM before clicking Stats,
    //  while strictly performing ZERO market evaluation or selection until Stage B/C ends.)
    // =========================================================================
    telemetry.start('collecting_stats');
    await stage('Collecting statistics', 'collecting_stats', 15);
    const CONCURRENCY = req.usePhoneGateway ? 1 : Math.max(1, Math.min(4, Number(process.env.BOT_CONCURRENCY) || 2));
    const workerPages = [];
    for (let w = 0; w < CONCURRENCY; w++) workerPages.push(await site.newPage());

    const workerFixtureCounts = Array(CONCURRENCY).fill(0);
    const checkStatsOne = async (wIdx, ev) => {
      let page = workerPages[wIdx];
      let timedOut = false;
      let shouldRecycle = false;
      const opT0 = Date.now();
      let didRetry = false;
      let failedOp = false;
      try {
        const opened = await withTimeout(
          site.openEvent(page, ev, req.scope, req),
          42000,
          'match page navigation timed out after 42s'
        );
        if (!opened) {
          ev.rejected = 'match page unavailable (could not open or verify)';
          ev.statsStatus = 'match_page_unavailable';
          ev.fixtureStatus = 'match_page_unavailable';
          state.counts.statsPageUnavailable++;
          state.counts.statsSkippedUnavailable++;
          failedOp = true;
          shouldRecycle = true;
          return;
        }
        ev.opened = true;
        ev.url = ev.url || page.url();
        state.counts.statsInspected++;

        // Capture raw Markets list while already on the Markets tab (saves a full second page navigation in Stage E).
        // No market evaluation or selection occurs during Stage B/C.
        ev._capturedMarkets = await withTimeout(
          ex.markets(page, ev),
          12000,
          'raw markets capture timed out'
        ).catch(() => []);

        const fetchOnce = async () => withTimeout(
          ex.stats(page, ev, { viaPhoneGateway: req.usePhoneGateway }),
          req.usePhoneGateway ? 22000 : 15000,
          'stats inspection timed out'
        ).catch((e) => {
          if (/timed out/i.test(e.message)) timedOut = true;
          return { available: false, status: /timed out/i.test(e.message) ? 'timeout' : 'error', err: e.message };
        });

        const reloadAndFetchOnce = async () => {
          didRetry = true;
          telemetry.start('verifying_missing_stats');
          await setProgress('verifying_missing_stats', 'Retrying unavailable statistics', allEvents.length, null, false);
          const retryT0 = Date.now();
          if (ev.url) {
            await withTimeout(site.openEvent(page, ev, req.scope, req), 25000, 'retry navigation timed out').catch(() => false);
          }
          const r = await fetchOnce();
          telemetry.recordOp('verifying_missing_stats', `${ev.home} v ${ev.away}`, Date.now() - retryT0, { failed: !(r && r.available), retried: true });
          telemetry.end('verifying_missing_stats');
          return r;
        };

        const res = await collectStatsWithRetry(ev, fetchOnce, reloadAndFetchOnce);
        ev.stats = res.stats;
        ev.statsStatus = res.statsStatus;
        ev.statsRetried = res.retried;
        ev.statsRecoveredOnRetry = res.recoveredOnRetry;
        if (res.retried) state.counts.statsRetried++;
        if (res.recoveredOnRetry) state.counts.statsRecoveredOnRetry++;

        if (isUsableFixtureStats(ev)) {
          state.counts.statsUsable++;
          state.counts.withStats++;
          if (ev.stats.status === 'complete') state.counts.withCompleteStats++;
          else state.counts.withPartialStats++;
        } else if (ev.stats && ev.stats.available) {
          failedOp = true;
          ev.statsStatus = 'partial_insufficient';
          state.counts.withPartialStats++;
          ev.rejected = 'partial statistics insufficient for approved market evaluation';
        } else {
          failedOp = true;
          const cat = classifyFixtureStatus(ev);
          if (cat === 'network_failure') state.counts.statsNetworkFailures++;
          else if (cat === 'no_statistics_after_retry') state.counts.noStatsAfterRetry++;
          else if (cat === 'unsupported_competition_data') state.counts.statsUnsupportedData++;
          state.counts.statsSkippedUnavailable++;
          ev.rejected = `statistics unavailable (${ev.statsStatus})`;
        }
        page.net.splice(0);
      } catch (e) {
        failedOp = true;
        const isNet = /timed out|timeout|network|econn|socket|err_/i.test(e.message);
        ev.statsStatus = isNet ? 'network_failure' : 'extraction_error';
        ev.rejected = (isNet ? 'network failure: ' : 'error: ') + e.message;
        state.counts.statsNetworkFailures++;
        state.counts.statsSkippedUnavailable++;
        if (/timed out/i.test(e.message)) timedOut = true;
      } finally {
        state.counts.statsChecked++;
        telemetry.recordOp('collecting_stats', `${ev.home} v ${ev.away}`, Date.now() - opT0, { failed: failedOp, retried: didRetry, timeout: timedOut });
      }
      workerFixtureCounts[wIdx]++;
      if (timedOut || shouldRecycle || workerFixtureCounts[wIdx] % 10 === 0) {
        await page.close().catch(() => {});
        workerPages[wIdx] = await site.newPage();
      }
    };

    try {
      const poolRes = await runStatsCollectionPool(allEvents, checkStatsOne, {
        concurrency: CONCURRENCY,
        targetUsable: state.counts.targetUsableFixtures,
        disableEarlyStop: expandedResearchMode,
        shouldStop: () => {
          if (cancelRequested) return 'cancelled';
          if (Date.now() >= statsDeadline) return 'deadline';
          if (gw && (gw.limitReached || (!gw.connected && gw.disconnectedAt && Date.now() - gw.disconnectedAt > 45000))) {
            limitReachedReason = gw.limitReached ? 'data_limit' : 'gateway_disconnected';
            return limitReachedReason;
          }
          return '';
        },
        onAfterFixture: async (_ev, _idx, ps) => {
          state.counts.statsScheduled = ps.scheduledCount;
          state.counts.statsInFlightExtraUsable = ps.inFlightExtraUsableCount || 0;
          const lbl = expandedResearchMode
            ? `Collecting statistics (${ps.checkedCount}/${allEvents.length} checked, ${ps.usableCount} usable)`
            : `Collecting statistics (${ps.usableCount}/${ps.targetUsable} usable, ${ps.checkedCount}/${allEvents.length} checked)`;
          await setProgress('collecting_stats', lbl, allEvents.length, null, false);
        },
      });
      state.counts.statsScheduled = poolRes.scheduledCount;
      state.counts.statsInFlightExtraUsable = poolRes.inFlightExtraUsableCount || 0;
      state.counts.notCheckedEarlyStop = poolRes.notCheckedEarlyStop;
      state.counts.notCheckedStopped = poolRes.notCheckedOther;
      state.counts.statsStopReason = poolRes.stopReason;
      state.counts.statsStopExplanation = poolRes.stopExplanation;
      if (poolRes.stopReason === 'deadline' || poolRes.stopReason === 'data_limit' || poolRes.stopReason === 'gateway_disconnected') {
        limitReachedReason = poolRes.stopReason;
      }
      log(poolRes.stopExplanation);
      telemetry.end('collecting_stats');

      // =========================================================================
      // STAGE D & E — MARKET EVALUATION & HIGH-ODDS INDEPENDENT VERIFICATION
      // (Strictly begins AFTER Stage B/C statistics collection completes.)
      // =========================================================================
      telemetry.start('evaluating_markets');
      const eligibleWithStats = allEvents.filter((e) => isUsableFixtureStats(e));
      await stage(`Evaluating approved markets (${eligibleWithStats.length} usable fixtures)`, 'evaluating_markets', 70);

      const cands = [];
      let mktCursor = 0;
      const runMarketWorker = async (wIdx) => {
        while (true) {
          if (gw && (gw.limitReached || !gw.connected)) {
            limitReachedReason = gw.limitReached ? 'data_limit' : 'gateway_disconnected';
            break;
          }
          const idx = mktCursor++;
          if (idx >= eligibleWithStats.length) break;
          const ev = eligibleWithStats[idx];
          const hasCaptured = Array.isArray(ev._capturedMarkets) && ev._capturedMarkets.length > 0;
          // Always evaluate already-captured markets in memory even if Stage B ended near deadline;
          // only skip reopening browser pages when deadline has passed.
          if (!hasCaptured && Date.now() >= deadline) break;
          let page = workerPages[wIdx];
          const opT0 = Date.now();
          let failedOp = false;
          try {
            // Reuse raw markets captured during initial page visit; only navigate if not yet captured
            if (hasCaptured) {
              ev.markets = ev._capturedMarkets;
              delete ev._capturedMarkets;
              state.counts.marketsInspected++;
            } else {
              const reopened = await withTimeout(
                site.openEvent(page, ev, req.scope, req),
                25000,
                'market stage navigation timed out'
              );
              if (!reopened) {
                ev.rejected = 'could not reopen match for market evaluation';
                failedOp = true;
                continue;
              }
              state.counts.marketsInspected++;
              ev.markets = await withTimeout(ex.markets(page, ev), 14000, 'markets inspection timed out').catch(() => []);
            }
            if (!ev.markets.length) {
              ev.rejected = 'statistics extracted, but no readable markets were offered';
              failedOp = true;
              continue;
            }
            ev.evaluated = true;
            ev.statsPacket = buildStructuredStatsPacket(ev);
            let matchCands = an.candidates(ev, req);
            if (ev.marketDiscoveryReport) {
              state.counts.marketsEvaluated += ev.marketDiscoveryReport.evaluatedOutcomesCount || 0;
            }

            // Phase 5, 7, 8 — Groq AI Analyst with 3-Ranked Recommendations & Availability Fallback
            const aiT0 = Date.now();
            const aiRes = await aiAnalyst.analyzeFixtureWithAi(ev, {
              statsPacket: ev.statsPacket,
              deterministicCandidates: matchCands,
            }).catch((err) => ({ ok: false, aiSource: 'error', error: err.message, tokens: { total: 0 }, analysis: null }));
            telemetry.recordOp('ai_analysis', `${ev.home} v ${ev.away}`, Date.now() - aiT0, { failed: !aiRes.ok });
            if (aiRes && aiRes.ok && aiRes.analysis) {
              ev.aiAnalysis = aiRes.analysis;
              state.counts.aiAnalysesCompleted++;
              if (!state.counts.aiSource && aiRes.aiSource) state.counts.aiSource = aiRes.aiSource;
              if (aiRes.tokens && aiRes.tokens.total) state.counts.aiTokensUsed += aiRes.tokens.total;
              if (aiRes.analysis.noSelection) {
                state.counts.aiNoSelectionCount++;
                // When Groq AI explicitly determines NO SELECTION on live evidence, respect it.
                if (aiRes.aiSource === 'groq') {
                  ev.rejected = `AI analyst: NO SELECTION (${aiRes.analysis.noSelectionReason || 'insufficient evidence'})`;
                  matchCands = [];
                }
              } else if (Array.isArray(aiRes.analysis.recommendations) && aiRes.analysis.recommendations.length) {
                state.counts.aiRecommendationsProduced += aiRes.analysis.recommendations.length;
                const fb = aiAnalyst.resolveRankedSelectionWithFallback(aiRes.analysis, ev.markets, ev);
                if (fb.trace.rank1Attempted) state.counts.rank1Attempts++;
                if (fb.trace.rank2Fallback) state.counts.rank2Fallbacks++;
                if (fb.trace.rank3Fallback) state.counts.rank3Fallbacks++;
                if (fb.trace.skipped) state.counts.fallbackSkipped++;
                ev.aiFallbackTrace = fb.trace;
                for (const rec of aiRes.analysis.recommendations) {
                  const matchedCand = matchCands.find((c) =>
                    c.approvedMarketId === rec.approvedMarketId &&
                    norm(c.canonicalOutcome || c.outcome) === norm(rec.canonicalOutcome || rec.outcome)
                  );
                  if (matchedCand) {
                    matchedCand.aiRank = rec.rank;
                    matchedCand.aiExplanation = rec.explanation;
                    matchedCand.aiConfidence = rec.confidenceAssessment;
                    matchedCand.aiEvidenceStrength = rec.evidenceStrength;
                    matchedCand.rankedAlternatives = aiRes.analysis.recommendations;
                    // Gentle evidence-preserving boost for AI-ranked picks (Rank 1 > Rank 2 > Rank 3)
                    matchedCand.score = (matchedCand.score || 0) + (rec.rank === 1 ? 0.04 : (rec.rank === 2 ? 0.02 : 0.01));
                  }
                }
              }
            }

            // Section 3: Genuine second verification for any candidate with odds >= 5.00.
            // Pre-screen in memory first; only perform AT MOST ONE live fresh stats+markets reload
            // per fixture when a >= 5.00 candidate actually passes the statistical/model pre-check.
            const highOddsCands = matchCands.filter((c) => c.odds >= an.HIGH_ODDS_THRESHOLD);
            const liveContenders = [];
            for (const c of highOddsCands) {
              state.counts.highOddsChecked++;
              const pre = an.verifyHighOddsCandidate(c, ev, ev.stats, ev.markets);
              if (pre.verified) {
                liveContenders.push(c);
              } else {
                c.highOddsVerification = pre;
                state.counts.highOddsRejected++;
              }
            }
            if (liveContenders.length > 0) {
              await withTimeout(site.openEvent(page, ev, req.scope, req), 22000, 'high-odds live reload timed out').catch(() => false);
              const freshMarkets = await withTimeout(ex.markets(page, ev), 10000, 'high-odds markets recheck timed out').catch(() => ev.markets);
              const freshStats = await withTimeout(
                ex.stats(page, ev, { viaPhoneGateway: req.usePhoneGateway }),
                14000,
                'high-odds stats recheck timed out'
              ).catch(() => ev.stats);
              for (const c of liveContenders) {
                const v = an.verifyHighOddsCandidate(c, ev, freshStats, freshMarkets);
                c.highOddsVerification = v;
                if (v.verified) state.counts.highOddsPassed++;
                else state.counts.highOddsRejected++;
              }
            }

            cands.push(...matchCands);
            page.net.splice(0);
          } catch (e) {
            failedOp = true;
            ev.rejected = 'market stage error: ' + e.message;
          } finally {
            state.counts.marketsEvaluatedFixtures++;
            telemetry.recordOp('evaluating_markets', `${ev.home} v ${ev.away}`, Date.now() - opT0, { failed: failedOp });
            if (state.counts.marketsEvaluatedFixtures % 5 === 0 || state.counts.marketsEvaluatedFixtures === eligibleWithStats.length) {
              // Part 4: NEVER compute or display final/running ticket combinedOdds during market evaluation
              // before the selection stage has actually begun! Report only candidate pool counts here.
              const qualifiedNow = cands.filter((c) => c && Number.isFinite(c.p) && Number.isFinite(c.odds) && c.p >= (an.CFG.minProb[c.sport] || 0.5) && c.odds >= an.CFG.minOdds && c.odds < an.CFG.maxOdds).length;
              state.counts.candidates = cands.length;
              state.counts.candidatesQualified = qualifiedNow;
              state.counts.selectionStarted = false;
              state.counts.selections = 0;
              state.counts.combinedOdds = 0;
              state.counts.projectedCombinedOdds = null;
              state.counts.targetReached = false;
              state.counts.selectionFrozen = false;
              await setProgress('evaluating_markets', `Evaluating markets (${state.counts.marketsEvaluatedFixtures}/${eligibleWithStats.length} fixtures · ${qualifiedNow} qualified)`, allEvents.length, null, false);
            }
          }
        }
      };
      await Promise.all(workerPages.map((_, wIdx) => runMarketWorker(wIdx)));
      telemetry.end('evaluating_markets');

      // Persist allCandidates for ticket construction
      state._cands = cands;
    } finally {
      await Promise.all(workerPages.map((p) => p.close().catch(() => {})));
    }

    const cands = state._cands || [];
    delete state._cands;

    if (gw && gw.limitReached) {
      tallyRejections(allEvents, cands, state);
      state.status = 'data_limit_reached';
      state.error = `Stopped at mobile data limit (${gw.usedMb} / ${gw.limitMb} MB).`;
      state.progress = buildProgress('incomplete', 'Stopped — mobile data limit reached', started, state.counts, allEvents.length, null);
      return;
    }
    if (gw && !gw.connected) {
      tallyRejections(allEvents, cands, state);
      state.status = 'gateway_disconnected';
      state.error = `Phone gateway disconnected after ${gw.usedMb} MB.`;
      state.progress = buildProgress('incomplete', 'Stopped — phone gateway disconnected', started, state.counts, allEvents.length, null);
      return;
    }

    state.counts.timedOut = Date.now() >= deadline;
    state.counts.exhaustedAllFixtures = !state.counts.timedOut && !limitReachedReason &&
      state.counts.failedTabs.length === 0 &&
      Object.values(site.discovery).length > 0 &&
      Object.values(site.discovery).every((d) => d.exhausted);
    state.counts.limitReachedReason = limitReachedReason ||
      (state.counts.statsStopReason === 'early_stop_usable_target'
        ? 'early_stop_usable_target'
        : (state.counts.timedOut ? 'deadline' : (state.counts.exhaustedAllFixtures ? 'exhausted' : 'incomplete')));

    const why = tallyRejections(allEvents, cands, state);

    // =========================================================================
    // STAGE F — RANKING CANDIDATES, STRONGEST-100 POOL (LONG RANGE),
    // COMBINED-ODDS SELECTION (EVERY-2 CHECKPOINTS) & FREEZING CHOSEN SET
    // =========================================================================
    syncEditableTarget();
    state.targetLocked = true;
    await save(true);
    telemetry.start('ranking_selections');
    await stage(`Ranking qualifying candidates (target ${req.target} locked)`, 'ranking_selections', 86);

    const poolSelection = tk.selectStrongestCandidatePool(
      cands,
      expandedResearchMode ? EXPANDED_MAX_RANKED_CANDIDATES : 0
    );
    state.counts.candidatesQualified = poolSelection.totalQualifying;
    state.counts.strongestCandidatesRetained = poolSelection.retainedCount;
    const selectionInputPool = poolSelection.retained;

    if (expandedResearchMode) {
      await stage(
        `Prepared strongest ${poolSelection.retainedCount} candidates (from ${poolSelection.totalQualifying} qualified)`,
        'preparing_candidate_pool',
        87
      );
    }

    state.counts.selectionStarted = true;
    await stage(`Selecting legs toward target ${req.target}`, 'selecting_legs', 88);
    const checkpoints = [];
    const t = tk.build(selectionInputPool, req, {
      onCheckpoint: (cp) => {
        checkpoints.push(cp);
        state.counts.selections = cp.afterSelections;
        state.counts.combinedOdds = Math.round(cp.combinedOdds * 100) / 100;
        state.counts.qualifyingCandidatesRemaining = cp.qualifyingCandidatesRemaining;
        state.counts.targetReached = cp.targetReached === true;
        state.counts.selectionCheckpoints = checkpoints.slice(-25);
      },
    });
    const frozenLegs = Object.freeze(t.legs.map((c) => Object.freeze({ ...c })));
    state.counts.accepted = frozenLegs.length;
    state.counts.selections = frozenLegs.length;
    state.counts.combinedOdds = Math.round(t.total * 100) / 100;
    state.counts.qualifyingCandidatesRemaining = t.selectionProgress ? t.selectionProgress.qualifyingCandidatesRemaining : 0;
    state.counts.projectedCombinedOdds = t.selectionProgress ? t.selectionProgress.projectedNextOdds : null;
    state.counts.targetReached = t.targetReached === true;
    state.counts.selectionStopReason = t.selectionProgress ? t.selectionProgress.stopReason : '';
    state.counts.selectionCheckpoints = checkpoints.slice(-25);
    state.counts.selectionFrozen = true;
    telemetry.recordOp('ranking_selections', `ranked ${poolSelection.totalQualifying} qualified -> ${poolSelection.retainedCount} retained -> ${frozenLegs.length} legs @ ${state.counts.combinedOdds} (${state.counts.selectionStopReason})`, 1);
    telemetry.end('ranking_selections');
    await stage(`Selections frozen (${frozenLegs.length} chosen · combined odds ${state.counts.combinedOdds})`, 'verifying_selections', 90);

    if (!frozenLegs.length) {
      const reasonsText = Object.entries(why).map(([k, v]) => `${v}x ${k}`).join('; ') || 'no fixtures satisfied evidence thresholds';
      state.status = 'no_qualifying';
      state.error = t.note || ('No qualifying selections found. Reasons: ' + reasonsText);
      state.ticket = {
        status: 'empty',
        note: state.error,
        total: 0,
        legs: [],
        targetReached: false,
        limitReached50: false,
        selectionProgress: t.selectionProgress || null,
        diversification: t.diversification || null,
      };
      state.booking = { ok: false, why: 'no qualifying selections to book' };
      state.progress = buildProgress('incomplete', 'No complete ticket available', started, state.counts, allEvents.length, null);
      await notify('BETBRAIN | RESEARCH STATUS', 'No complete ticket available.', { route: 'chat', jobId: ID });
      return;
    }

    const evByKey = new Map(allEvents.map((e) => [e.key, e]));
    state.ticket = {
      status: t.status,
      note: t.note || '',
      total: Math.round(t.total * 100) / 100,
      targetReached: t.targetReached,
      limitReached50: t.limitReached50,
      selectionProgress: t.selectionProgress || null,
      diversification: t.diversification || null,
      legs: frozenLegs.map((c) => {
        const srcEv = evByKey.get(c.evKey);
        const st = (srcEv && srcEv.stats) || {};
        const cats = st.categories || {};
        return {
          sport: c.sport, league: c.league, country: c.country, home: c.home, away: c.away, ts: c.ts,
          fixtureId: st.fixtureId || (srcEv && srcEv.matchId) || 0,
          seasonId: st.seasonId || 0,
          market: c.market, outcome: c.outcome, marketFamily: c.marketFamily || '',
          approvedMarketId: c.approvedMarketId || '',
          approvedMarketName: c.approvedMarketName || '',
          canonicalOutcome: c.canonicalOutcome || '',
          period: c.period || 'ft',
          side: c.side || '',
          teamSide: c.teamSide || '',
          dir: c.dir || '',
          line: c.line != null ? c.line : null,
          yesNo: c.yesNo || '',
          odds: c.odds,
          p: Math.round(c.p * 100),
          modelProbability: c.modelProbability != null ? c.modelProbability : Math.round(c.p * 1000) / 1000,
          confidenceScore: c.confidenceScore != null ? c.confidenceScore : null,
          modelLimitation: c.modelLimitation || '',
          highOddsVerification: c.highOddsVerification || null,
          reason: c.reason, facts: c.facts, url: c.url,
          statsStatus: (srcEv && srcEv.statsStatus) || st.status || 'unavailable',
          statsSource: st.source || '',
          categoriesAvailable: Object.entries(cats).filter(([, v]) => v).map(([k]) => k),
          categoriesMissing: Object.entries(cats).filter(([, v]) => !v).map(([k]) => k),
        };
      }),
    };
    await save(true);

    // Situation C: fewer than 50 qualifying selections and target not reached
    if (!t.bookable) {
      state.status = 'partial';
      state.booking = {
        ok: false,
        why: `Only ${t.legs.length} qualifying selections found (combined odds ${state.ticket.total}; target ${req.target} not reached).`,
      };
      state.progress = buildProgress('incomplete', 'No complete ticket available', started, state.counts, allEvents.length, null);
      await notify('BETBRAIN | RESEARCH STATUS', 'No complete ticket available.', { route: 'chat', jobId: ID });
      return;
    }

    if (req.noBook) {
      state.status = 'booking_failed';
      state.booking = { ok: false, why: 'betslip preparation was switched off for this job' };
      state.progress = buildProgress('incomplete', 'Booking code unavailable', started, state.counts, allEvents.length, null);
      return;
    }

    // =========================================================================
    // STAGE G & H — PREPARING BETSLIP, GENERATING & VERIFYING SHARE CODE
    // =========================================================================
    telemetry.start('preparing_betslip');
    await stage(`Preparing betslip (0/${state.ticket.legs.length} added)`, 'preparing_betslip', 91);
    const bookT0 = Date.now();
    const bookDeadline = Math.max(deadline, Date.now() + 4 * 60000);
    state.booking = await bk.book(site, state.ticket.legs, bookDeadline, req.scope, req, {
      onProgress: async (bStageKey, bLabel, addedCount, totalLegs, unavailCount = 0, liveOdds = 0, verifiedCount = 0) => {
        state.counts.selectionsAdded = addedCount || 0;
        state.counts.selectionsUnavailable = unavailCount || 0;
        if (verifiedCount > 0) state.counts.selectionsVerified = verifiedCount;
        if (liveOdds > 0) state.counts.liveBetslipCombinedOdds = liveOdds;
        let pct = 91;
        if (bStageKey === 'preparing_betslip' && totalLegs > 0) {
          pct = Math.min(95, Math.round(91 + (addedCount / totalLegs) * 4));
        } else if (bStageKey === 'verifying_betslip') {
          pct = 96;
        } else if (bStageKey === 'generating_share_code') {
          pct = 97;
        } else if (bStageKey === 'verifying_share_code') {
          pct = 98;
        }
        await setProgress(bStageKey, bLabel, allEvents.length, pct, true);
      },
    });
    state.counts.selectionsAdded = state.booking.added || 0;
    state.counts.selectionsVerified = Array.isArray(state.booking.verifiedLegs) ? state.booking.verifiedLegs.length : 0;
    if (state.booking.total > 0) state.counts.liveBetslipCombinedOdds = state.booking.total;
    state.counts.selectionsUnavailable = Array.isArray(state.booking.unavailableLegs)
      ? state.booking.unavailableLegs.length
      : (Array.isArray(state.booking.missingLegs) ? state.booking.missingLegs.length : 0);
    state.counts.shareCodeVerified = !!(state.booking.ok && state.booking.codeVerifiedIndependently);
    telemetry.recordOp('preparing_betslip', `${state.booking.added}/${state.ticket.legs.length} legs`, Date.now() - bookT0, { failed: !state.booking.ok });
    telemetry.end('preparing_betslip');
    log('booking:', JSON.stringify(state.booking));
    await stage('Verifying share code', 'verifying_share_code', 98);

    if (state.booking.ok && state.booking.code) {
      state.status = 'done';
      state.progress = buildProgress('completed', 'Booking code ready', started, state.counts, allEvents.length, 100);
      await stage('Booking code confirmed', 'completed', 100);
      state.stages[state.stages.length - 1].ok = true;
      await notify('BETBRAIN | BOOKING CODE', `Booking code ready: ${state.booking.code}`, { route: 'home', jobId: ID, code: state.booking.code });
    } else {
      state.status = 'booking_failed';
      state.failedStage = (state.booking && state.booking.diagnostics && state.booking.diagnostics.failureStage) || 'verifying_share_code';
      state.error = (state.booking && state.booking.why) || 'Booking code unavailable.';
      state.canResume = false;
      state.canRetry = true;
      state.progress = buildProgress('incomplete', `Booking failed: ${state.error}`, started, state.counts, allEvents.length, null, {
        targetOdds: req.target,
        targetLocked: true,
        lastCompletedStage: state.lastCompletedStage,
        failedStage: state.failedStage,
      });
      await notify('BETBRAIN | RESEARCH STATUS', 'Booking code unavailable.', { route: 'chat', jobId: ID });
    }
  } catch (e) {
    state.status = 'failed';
    state.failedStage = state.stage || 'unknown';
    state.error = e.message;
    state.canResume = false;
    state.canRetry = true;
    state.progress = buildProgress('incomplete', `Research failed: ${e.message}`, started, state.counts, state.counts.inWindow, null, {
      targetOdds: req.target,
      targetLocked: state.targetLocked,
      lastCompletedStage: state.lastCompletedStage,
      failedStage: state.failedStage,
    });
    log('FAILED', e.message);
    await notify('BETBRAIN | RESEARCH STATUS', 'Research incomplete.', { route: 'chat', jobId: ID });
  } finally {
    state.notes = site.notes;
    if (gw) state.gateway = gw.status();
    const recon = {
      dateScope: state.dateScope,
      progress: state.progress,
      counts: state.counts,
      telemetry: state.telemetry,
      discovery: site.discovery,
      gateway: state.gateway,
      gismoCache: site.gismoCache ? site.gismoCache.summary() : null,
      blockedRequests: site.blockedRequests,
      notes: site.notes,
      apis: [...site.apis].slice(0, 40),
      fixturesSummary: state.fixturesSummary || [],
    };
    fs.writeFileSync(path.join(OUT, 'recon.json'), JSON.stringify(recon, null, 1));
    log('SUMMARY', JSON.stringify({ dateScope: recon.dateScope, progress: recon.progress, counts: recon.counts }).slice(0, 2500));
    await save(true);
    if (process.env.LOCAL_NO_GIST !== '1') await gist.prune(20).catch(() => {});
    await site.close();
    if (gw) await gw.close().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseLocalYmd,
  computeWindow,
  validateRequest,
  isVirtualFixture,
  isUsableFixtureStats,
  classifyFixtureStatus,
  runStatsCollectionPool,
  loadConfirmedUsedSelections,
  tallyRejections,
  collectStatsWithRetry,
  buildProgress,
  createTelemetry,
  readPendingTargetUpdate,
  MAX_FIXTURES_TO_CHECK,
  TARGET_USABLE_FIXTURES,
  EXPANDED_MAX_FIXTURES_TO_CHECK,
  EXPANDED_MAX_RANKED_CANDIDATES,
  VALID_SPORTS,
  VALID_SCOPES,
};
