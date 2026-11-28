'use strict';
const { CFG } = require('./analyze');
const { norm } = require('./util');

// Strict BangBet website ticket selection limit (applies ONLY to final ticket legs, NEVER to discovery/inspection).
const MAX_TICKET_SELECTIONS = 50;

function bandFor(target) {
  if (target <= 10) {
    return {
      min: target,
      preferredMax: Math.round(target * 1.15 * 100) / 100,
      hardMax: Math.round(target * 1.35 * 100) / 100,
    };
  }
  if (target <= 60) {
    return {
      min: target,
      preferredMax: Math.round((target + Math.min(2.9, target * 0.05)) * 100) / 100,
      hardMax: Math.round((target + Math.min(5, target * (5 / 60), 65 - target)) * 100) / 100,
    };
  }
  return {
    min: target,
    preferredMax: Math.round(target * 1.10 * 100) / 100,
    hardMax: Math.round(target * 1.25 * 100) / 100,
  };
}

// Correlation group for checking whether two approved markets on the same fixture are genuinely independent.
function exposureGroupForMarket(marketId) {
  const id = String(marketId || '').toLowerCase();
  if (
    id === 'match_result_1x2' ||
    id === 'match_result_1x2_1up' ||
    id === 'match_result_1x2_2up' ||
    id === 'double_chance' ||
    id === 'draw_no_bet' ||
    id === 'asian_handicap_plus_0_5' ||
    id === 'asian_handicap_plus_1' ||
    id === 'any_team_to_win'
  ) {
    return 'match_result';
  }
  if (id === 'total_goals' || id === 'total_over_0_5' || id === 'total_over_1_5') return 'total_goals';
  if (id === 'team_total' || id === 'team_total_over_0_5') return 'team_total';
  if (id === 'first_half_total_over_0_5' || id === 'first_half_double_chance') return 'first_half';
  if (id === 'second_half_total_over_0_5' || id === 'highest_scoring_half_second') return 'second_half';
  if (id === 'btts_no') return 'btts';
  if (id === 'to_win_either_half' || id === 'to_score_in_both_halves_no') return 'halves_team';
  if (id === 'corner_1x2') return 'corner_1x2';
  return id || 'other';
}

function fixtureIdentityKey(item) {
  if (!item || typeof item !== 'object') return '';
  const fid = Number(item.fixtureId || item.matchId || 0);
  if (fid > 0) return `id:${fid}`;
  const h = norm(item.home || '');
  const a = norm(item.away || '');
  if (h && a) return `teams:${h}|${a}`;
  return String(item.evKey || '');
}

// Return ALL valid identity keys for a fixture (both numeric Sportradar fixtureId AND normalized teams)
// so confirmed-used history ALWAYS matches candidates regardless of whether one record omitted fixtureId.
function fixtureIdentityKeys(item) {
  if (!item || typeof item !== 'object') return [];
  const keys = [];
  const fid = Number(item.fixtureId || item.matchId || 0);
  if (fid > 0) keys.push(`id:${fid}`);
  const h = norm(item.home || '');
  const a = norm(item.away || '');
  if (h && a) keys.push(`teams:${h}|${a}`);
  if (!keys.length && item.evKey) keys.push(String(item.evKey));
  return keys;
}

function _selectionParts(item) {
  const mKey = norm(item.approvedMarketId || item.market || '');
  const oKey = norm(item.canonicalOutcome || item.outcome || '');
  const lKey = item.line != null && item.line !== '' && Number.isFinite(Number(item.line)) ? String(Number(item.line)) : '';
  const gKey = exposureGroupForMarket(item.approvedMarketId || item.market);
  return { mKey, oKey, lKey, gKey };
}

function selectionIdentityKey(item) {
  const fKey = fixtureIdentityKey(item);
  const { mKey, oKey, lKey } = _selectionParts(item);
  return `${fKey}::${mKey}::${oKey}::${lKey}`;
}

function selectionIdentityKeys(item) {
  const { mKey, oKey, lKey } = _selectionParts(item);
  return fixtureIdentityKeys(item).map((fk) => `${fk}::${mKey}::${oKey}::${lKey}`);
}

function fixtureMarketKey(item) {
  return `${fixtureIdentityKey(item)}::${norm(item.approvedMarketId || item.market || '')}`;
}

function fixtureMarketKeys(item) {
  const mKey = norm(item.approvedMarketId || item.market || '');
  return fixtureIdentityKeys(item).map((fk) => `${fk}::${mKey}`);
}

function fixtureGroupKey(item) {
  return `${fixtureIdentityKey(item)}::${exposureGroupForMarket(item.approvedMarketId || item.market)}`;
}

function fixtureGroupKeys(item) {
  const gKey = exposureGroupForMarket(item.approvedMarketId || item.market);
  return fixtureIdentityKeys(item).map((fk) => `${fk}::${gKey}`);
}

// Build diversification context ONLY from explicitly confirmed-used selections.
// Indexes BOTH fixtureId and normalized team-pair keys so confirmed-used history never misses a repeat.
function buildUsedHistoryContext(usedSelections) {
  const list = Array.isArray(usedSelections) ? usedSelections.filter((x) => x && typeof x === 'object') : [];
  const exactKeys = new Set();
  const fixtureMarkets = new Set();
  const fixtureGroups = new Set();
  const usedFixtures = new Set();
  const usedMarketCounts = {};

  for (const s of list) {
    const fKeys = fixtureIdentityKeys(s);
    if (!fKeys.length) continue;
    for (const fk of fKeys) usedFixtures.add(fk);
    for (const ek of selectionIdentityKeys(s)) exactKeys.add(ek);
    for (const mk of fixtureMarketKeys(s)) fixtureMarkets.add(mk);
    for (const gk of fixtureGroupKeys(s)) fixtureGroups.add(gk);
    const mId = norm(s.approvedMarketId || s.market || '');
    if (mId) usedMarketCounts[mId] = (usedMarketCounts[mId] || 0) + 1;
  }

  return {
    active: list.length > 0,
    confirmedSelectionCount: list.length,
    exactKeys,
    fixtureMarkets,
    fixtureGroups,
    usedFixtures,
    usedMarketCounts,
  };
}

// Target-aware accumulator survival efficiency for a qualifying candidate:
// To reach target combined odds T, using legs with (p, odds) yields total win probability
// proportional to p^(ln(T)/ln(odds)) = [exp(ln(p)/ln(odds))]^ln(T).
// Ultra-low @1.05 picks require 28-50 legs and actually yield LOWER accumulator survival probability
// than strong @1.25-@1.85 picks with solid statistical support.
// Returns a bounded composite selection score that preserves evidence-first discipline
// while avoiding degenerate 30-leg @1.05 slips when strong higher-value qualifying picks exist.
function selectionUtilityScore(c, target = 0) {
  const base = Number(c.score) || 0;
  const p = Math.max(0.05, Math.min(0.98, Number(c.p) || 0.5));
  const o = Math.max(1.03, Number(c.odds) || 1.05);
  const conf = Number.isFinite(Number(c.confidenceScore)) ? Number(c.confidenceScore) : 0.7;
  if (!(target > 1.5)) return base;

  // Survival probability per e (2.718x) of combined odds achieved: higher is mathematically superior!
  const perUnitSurvival = Math.exp(Math.log(p) / Math.log(o));
  // Mild penalty for ultra-low filler odds (< 1.12) when building multi-leg targets >= 3.0
  // so the engine prefers strong @1.20-@2.00 picks over piling up 30+ @1.05 legs.
  const fillerPenalty = (target >= 3.0 && o < 1.12) ? (1.12 - o) * 1.4 : 0;
  const confFactor = 0.70 + 0.30 * conf;
  return (0.50 * base + 0.50 * (perUnitSurvival * confFactor)) - fillerPenalty;
}

// Retain the strongest N qualifying candidates (Part 5: 100 strongest candidates on long ranges)
// strictly ranked by statistical evidence quality (modelProbability, confidenceScore, score).
// Preserves at least the strongest pick per distinct fixture first so candidate diversity is maintained.
function selectStrongestCandidatePool(cands, maxRetained = 100) {
  const list = Array.isArray(cands) ? cands : [];
  const qualifying = list.filter((c) => (
    c && c.evKey &&
    Number.isFinite(c.p) && Number.isFinite(c.odds) &&
    c.p >= (CFG.minProb[c.sport] || 0.5) &&
    c.odds >= CFG.minOdds && c.odds < CFG.maxOdds &&
    !(c.odds >= 5.0 && c.highOddsVerification && c.highOddsVerification.verified === false)
  ));

  const sorted = [...qualifying].sort((a, b) => {
    const sa = Number(a.score) || 0;
    const sb = Number(b.score) || 0;
    if (Math.abs(sb - sa) > 1e-9) return sb - sa;
    return (Number(b.p) || 0) - (Number(a.p) || 0);
  });

  if (!(maxRetained > 0) || sorted.length <= maxRetained) {
    return {
      totalQualifying: sorted.length,
      retained: sorted,
      retainedCount: sorted.length,
    };
  }

  // First take the strongest qualifying candidate per fixture (up to maxRetained),
  // then fill any remaining slots up to maxRetained with the next strongest alternatives.
  const retained = [];
  const pickedSet = new Set();
  const seenFixture = new Set();
  for (const c of sorted) {
    if (retained.length >= maxRetained) break;
    if (!seenFixture.has(c.evKey)) {
      seenFixture.add(c.evKey);
      retained.push(c);
      pickedSet.add(c);
    }
  }
  for (const c of sorted) {
    if (retained.length >= maxRetained) break;
    if (!pickedSet.has(c)) {
      retained.push(c);
      pickedSet.add(c);
    }
  }
  return {
    totalQualifying: sorted.length,
    retained,
    retainedCount: retained.length,
  };
}

function build(cands, req = {}, opts = {}) {
  const onCheckpoint = typeof opts.onCheckpoint === 'function' ? opts.onCheckpoint : null;
  const usedCtx = buildUsedHistoryContext(req.usedSelections);
  const target = Number(req.target) || 0;

  // Filter strictly for statistically qualifying candidates (never force weak picks).
  const validCands = [];
  const seenCandKey = new Set();
  let excludedExactRepeats = 0;

  for (const c of cands || []) {
    if (!c || !c.evKey) continue;
    if (!Number.isFinite(c.p) || !Number.isFinite(c.odds)) continue;
    if (c.p < (CFG.minProb[c.sport] || 0.5) || c.odds < CFG.minOdds || c.odds >= CFG.maxOdds) continue;
    // Reject any high-odds candidate (>= 5.00) that failed independent second verification
    if (c.odds >= 5.0 && c.highOddsVerification && c.highOddsVerification.verified === false) continue;

    // Part 10: Strictly exclude exact (fixture, market, outcome, line) combinations from confirmed-used tickets
    // checking BOTH fixtureId and normalized team-pair keys!
    if (usedCtx.active && selectionIdentityKeys(c).some((k) => usedCtx.exactKeys.has(k))) {
      excludedExactRepeats++;
      continue;
    }

    const dedupeKey = `${c.evKey}::${selectionIdentityKey(c)}`;
    if (seenCandKey.has(dedupeKey)) continue;
    seenCandKey.add(dedupeKey);
    validCands.push(c);
  }

  // Group qualifying candidates by fixture (evKey) and compute diversification tier + target-aware quality rank.
  const rankCandidate = (c) => {
    let divTier = 0;
    let divBonus = 0;
    if (usedCtx.active) {
      const reusedFixture = fixtureIdentityKeys(c).some((k) => usedCtx.usedFixtures.has(k));
      const reusedMarketOnFixture = fixtureMarketKeys(c).some((k) => usedCtx.fixtureMarkets.has(k));
      const reusedGroupOnFixture = fixtureGroupKeys(c).some((k) => usedCtx.fixtureGroups.has(k));
      if (!reusedFixture) {
        divTier = 0;
      } else if (!reusedMarketOnFixture && !reusedGroupOnFixture) {
        divTier = 1;
      } else if (!reusedMarketOnFixture) {
        divTier = 2;
      } else {
        divTier = 3;
      }
      const mId = norm(c.approvedMarketId || c.market || '');
      const priorUses = usedCtx.usedMarketCounts[mId] || 0;
      divBonus = priorUses === 0 ? 0.03 : (priorUses === 1 ? 0.01 : 0);
    }
    const baseScore = selectionUtilityScore(c, target);
    return {
      cand: c,
      divTier,
      effectiveScore: baseScore + divBonus,
      baseScore,
      rawEvidenceScore: Number(c.score) || 0,
    };
  };

  const rankedAll = validCands.map(rankCandidate).sort((a, b) => {
    if (a.divTier !== b.divTier) return a.divTier - b.divTier;
    if (Math.abs(b.effectiveScore - a.effectiveScore) > 1e-9) return b.effectiveScore - a.effectiveScore;
    return b.baseScore - a.baseScore;
  });

  // Group per fixture preserving ranked order (best qualifying candidate first per fixture)
  const byFixture = new Map();
  for (const item of rankedAll) {
    const k = item.cand.evKey;
    if (!byFixture.has(k)) byFixture.set(k, []);
    byFixture.get(k).push(item);
  }

  // Distinct qualifying fixtures count
  const uniqueFixtureCount = byFixture.size;
  const product = (arr) => arr.reduce((v, c) => v * c.odds, 1);
  const requestedCount = Number(req.count) || 0;
  const maxLegs = requestedCount > 0
    ? Math.min(MAX_TICKET_SELECTIONS, requestedCount)
    : MAX_TICKET_SELECTIONS;

  const legs = [];
  const usedEvKeys = new Set();
  const recalculations = [];
  let runningOdds = 1;
  let stopReason = 'no_qualifying_candidates';
  let projectedNextOdds = null;

  const getAvailablePool = () => {
    const out = [];
    for (const [evKey, items] of byFixture.entries()) {
      if (usedEvKeys.has(evKey)) continue;
      out.push(items[0]); // strongest qualifying pick for this fixture
    }
    out.sort((a, b) => {
      if (a.divTier !== b.divTier) return a.divTier - b.divTier;
      if (Math.abs(b.effectiveScore - a.effectiveScore) > 1e-9) return b.effectiveScore - a.effectiveScore;
      return b.baseScore - a.baseScore;
    });
    return out;
  };

  const getAllAvailableAlternatives = () => {
    const out = [];
    for (const [evKey, items] of byFixture.entries()) {
      if (usedEvKeys.has(evKey)) continue;
      for (const it of items) out.push(it);
    }
    return out;
  };

  if (target > 0) {
    const band = bandFor(target);
    let fallbackChoice = null;

    while (legs.length < maxLegs) {
      if (runningOdds >= target) {
        stopReason = 'target_reached';
        break;
      }
      const availFixtures = getAvailablePool();
      if (!availFixtures.length) {
        stopReason = 'candidates_exhausted';
        break;
      }

      const top = availFixtures[0];
      const topProjected = runningOdds * top.cand.odds;
      projectedNextOdds = Math.round(topProjected * 100) / 100;

      let chosen = null;

      if (topProjected < target) {
        // Have not reached target yet — accept strongest qualifying fixture candidate
        chosen = top;
      } else {
        // Adding `top` reaches or exceeds target!
        // Look across remaining high-quality qualifying candidates (within strict quality floor of `top`)
        // to minimise unnecessary overshoot WITHOUT sacrificing evidence quality.
        const allAlts = getAllAvailableAlternatives();
        const qualityFloor = top.baseScore - 0.12;
        const strongTargetReachers = allAlts.filter((it) => {
          if (it.divTier > top.divTier) return false;
          if (it.baseScore < qualityFloor) return false;
          const proj = runningOdds * it.cand.odds;
          return proj >= target;
        });

        // 1) Prefer strong target-reachers inside preferredMax, choosing closest to target (minimum overshoot)
        const inPreferred = strongTargetReachers
          .filter((it) => runningOdds * it.cand.odds <= band.preferredMax)
          .sort((a, b) => {
            const ovA = runningOdds * a.cand.odds - target;
            const ovB = runningOdds * b.cand.odds - target;
            if (Math.abs(ovA - ovB) > 0.02 * target) return ovA - ovB;
            return b.effectiveScore - a.effectiveScore;
          });

        if (inPreferred.length) {
          chosen = inPreferred[0];
        } else {
          // 2) Check strong target-reachers inside hardMax (closest to target)
          const inHard = strongTargetReachers
            .filter((it) => runningOdds * it.cand.odds <= band.hardMax)
            .sort((a, b) => {
              const ovA = runningOdds * a.cand.odds - target;
              const ovB = runningOdds * b.cand.odds - target;
              if (Math.abs(ovA - ovB) > 0.02 * target) return ovA - ovB;
              return b.effectiveScore - a.effectiveScore;
            });

          // Also check if a smaller strong candidate (below target) lets us step closer without huge overshoot
          const smallerStrong = availFixtures.filter((it) => {
            if (it.divTier > top.divTier) return false;
            if (it.baseScore < qualityFloor) return false;
            return runningOdds * it.cand.odds < target;
          });

          if (inHard.length) {
            if (!fallbackChoice) fallbackChoice = { legs: [...legs, inHard[0].cand], total: runningOdds * inHard[0].cand.odds };
            // If smaller strong picks exist and we still have leg room, try stepping smoothly closer first
            if (smallerStrong.length && legs.length + 1 < maxLegs && (runningOdds * inHard[0].cand.odds > band.preferredMax)) {
              chosen = smallerStrong[0];
            } else {
              chosen = inHard[0];
            }
          } else {
            // Even the smallest strong target-reacher exceeds hardMax.
            // Pick a smaller strong candidate to creep closer if one exists; otherwise pick minimal-overshoot
            // strong candidate only if within reasonable discrete tolerance, else record fallback.
            if (smallerStrong.length && legs.length + 1 < maxLegs) {
              chosen = smallerStrong[0];
            } else {
              // Find the absolute smallest-overshoot strong candidate
              const minOvershoot = strongTargetReachers.sort((a, b) => (runningOdds * a.cand.odds) - (runningOdds * b.cand.odds))[0];
              if (minOvershoot && runningOdds * minOvershoot.cand.odds <= band.hardMax) {
                chosen = minOvershoot;
              } else {
                // Skip overly large single jump and check if any remaining qualifying fixture fits below hardMax
                const anyFit = availFixtures.find((it) => runningOdds * it.cand.odds <= band.hardMax);
                if (anyFit) {
                  chosen = anyFit;
                } else if (minOvershoot && requestedCount <= 0) {
                  // Discrete odds product cannot land below hardMax without stopping short of target;
                  // accept the minimal-overshoot strong candidate so target is genuinely reached with lowest overshoot.
                  chosen = minOvershoot;
                } else {
                  stopReason = 'candidates_exhausted';
                  break;
                }
              }
            }
          }
        }
      }

      if (!chosen) {
        stopReason = 'candidates_exhausted';
        break;
      }

      legs.push(chosen.cand);
      usedEvKeys.add(chosen.cand.evKey);
      runningOdds = product(legs);

      // Part 4: After every two accepted selections, recalculate and evaluate the combined odds
      if (legs.length % 2 === 0 || runningOdds >= target) {
        const cp = {
          afterSelections: legs.length,
          combinedOdds: Math.round(runningOdds * 10000) / 10000,
          targetOdds: target,
          targetReached: runningOdds >= target,
          qualifyingCandidatesRemaining: Math.max(0, uniqueFixtureCount - legs.length),
        };
        recalculations.push(cp);
        if (onCheckpoint) onCheckpoint(cp);
      }

      if (runningOdds >= target) {
        stopReason = 'target_reached';
        projectedNextOdds = null;
        break;
      }
    }

    if (runningOdds < target && fallbackChoice && fallbackChoice.total >= target && fallbackChoice.legs.length <= maxLegs) {
      legs.length = 0;
      legs.push(...fallbackChoice.legs);
      runningOdds = product(legs);
      stopReason = 'target_reached';
      projectedNextOdds = null;
    }

    if (runningOdds < target) {
      stopReason = legs.length >= MAX_TICKET_SELECTIONS ? 'limit_50_reached' : (legs.length ? 'candidates_exhausted' : 'no_qualifying_candidates');
      projectedNextOdds = null;
    }
  } else if (requestedCount > 0) {
    const avail = getAvailablePool();
    for (const item of avail.slice(0, maxLegs)) {
      legs.push(item.cand);
      usedEvKeys.add(item.cand.evKey);
    }
    runningOdds = legs.length ? product(legs) : 0;
    stopReason = legs.length >= maxLegs ? 'count_reached' : (legs.length ? 'candidates_exhausted' : 'no_qualifying_candidates');
  } else {
    const avail = getAvailablePool();
    for (const item of avail.slice(0, Math.min(10, MAX_TICKET_SELECTIONS))) {
      legs.push(item.cand);
      usedEvKeys.add(item.cand.evKey);
    }
    runningOdds = legs.length ? product(legs) : 0;
    stopReason = legs.length ? 'count_reached' : 'no_qualifying_candidates';
  }

  legs.sort((a, b) => (a.ts || 9e15) - (b.ts || 9e15));
  const total = legs.length ? product(legs) : 0;
  const band = target > 0 ? bandFor(target) : null;
  const targetReached = target > 0 && total >= target;
  const limitReached50 = legs.length >= MAX_TICKET_SELECTIONS;
  const countReached = requestedCount <= 0 || legs.length === maxLegs;

  // Diversification telemetry for Part 10
  const marketTypesUsed = [...new Set(legs.map((l) => l.approvedMarketId || l.market).filter(Boolean))];
  const freshFixturesCount = usedCtx.active
    ? legs.filter((l) => !fixtureIdentityKeys(l).some((k) => usedCtx.usedFixtures.has(k))).length
    : legs.length;
  const reusedFixturesDifferentMarketCount = usedCtx.active ? (legs.length - freshFixturesCount) : 0;

  // Exact 4 Situations:
  // A) Target reached before 50 selections -> complete & bookable ('ready')
  // B) Target not reached, but 50-selection BangBet limit reached -> complete & bookable ('limit_50_reached')
  // C) Fewer than 50 qualifying selections and target not reached -> 'partial' (honest actual odds, no forced picks)
  // D) Zero qualifying selections -> 'empty'
  let status = 'empty';
  let complete = false;
  let bookable = false;
  let note = '';

  if (!legs.length) {
    status = 'empty';
    complete = false;
    bookable = false;
    if (usedCtx.active && excludedExactRepeats > 0) {
      note = `No fresh qualifying alternatives remained after excluding ${excludedExactRepeats} selection(s) from confirmed-used tickets.`;
    }
  } else if (target > 0 && targetReached && countReached) {
    status = 'ready';
    complete = true;
    bookable = true;
  } else if (target > 0 && !targetReached && limitReached50 && countReached) {
    status = 'limit_50_reached';
    complete = true;
    bookable = true;
    note = `Maximum ${MAX_TICKET_SELECTIONS} selections reached (combined odds ${total.toFixed(2)}; requested target ${target.toFixed(2)} not reached).`;
  } else if (target <= 0 && countReached) {
    status = 'ready';
    complete = true;
    bookable = true;
  } else {
    status = 'partial';
    complete = false;
    bookable = false;
    if (target > 0 && !targetReached) {
      const divNote = usedCtx.active && excludedExactRepeats > 0
        ? ` (${excludedExactRepeats} previously confirmed-used selection(s) were excluded to diversify exposure.)`
        : '';
      note = `Supported selections reached ${total.toFixed(2)} odds across ${legs.length} selections; target ${target.toFixed(2)} not reached.${divNote}`;
    } else if (!countReached) {
      note = `Only ${legs.length} selections were supported; ${requestedCount} were requested.`;
    }
  }

  const remainingQualifying = Math.max(0, uniqueFixtureCount - legs.length);
  const selectionProgress = {
    requestedTargetOdds: target,
    currentCombinedOdds: legs.length ? Math.round(total * 100) / 100 : 0,
    selectionsAccepted: legs.length,
    qualifyingCandidatesRemaining: remainingQualifying,
    projectedNextOdds,
    targetReached,
    stopReason,
    recalculations,
    frozen: true,
  };

  const diversification = {
    applied: usedCtx.active,
    confirmedUsedSelectionsCount: usedCtx.confirmedSelectionCount,
    excludedExactRepeats,
    freshFixturesCount,
    reusedFixturesDifferentMarketCount,
    marketTypesUsed,
    limitationNote: (usedCtx.active && !targetReached && excludedExactRepeats > 0)
      ? `Diversification excluded ${excludedExactRepeats} selection(s) from confirmed-used tickets; remaining qualifying alternatives reached ${total.toFixed(2)} odds.`
      : '',
  };

  return {
    legs,
    total,
    status,
    note,
    pool: uniqueFixtureCount,
    maxSelections: MAX_TICKET_SELECTIONS,
    targetReached,
    limitReached50,
    countReached,
    complete,
    bookable,
    targetBand: band,
    selectionProgress,
    diversification,
  };
}

module.exports = {
  build,
  bandFor,
  MAX_TICKET_SELECTIONS,
  fixtureIdentityKey,
  fixtureIdentityKeys,
  selectionIdentityKey,
  selectionIdentityKeys,
  exposureGroupForMarket,
  buildUsedHistoryContext,
  selectionUtilityScore,
  selectStrongestCandidatePool,
};
