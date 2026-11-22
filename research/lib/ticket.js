'use strict';
const { CFG } = require('./analyze');
function bandFor(target) {
  if (target <= 10) {
    return {
      min: target,
      preferredMax: Math.round(target * 1.15 * 100) / 100,
      hardMax: Math.round(target * 1.35 * 100) / 100,
    };
  }
  if (target <= 65) {
    return {
      min: target,
      preferredMax: target + Math.min(2.9, target * 0.05),
      hardMax: target + Math.min(5, target * (5 / 60), 65 - target),
    };
  }
  return {
    min: target,
    preferredMax: Math.round(target * 1.10 * 100) / 100,
    hardMax: Math.round(target * 1.25 * 100) / 100,
  };
}
function build(cands, req) {
  const best = new Map();
  for (const c of cands) {
    if (!c || !c.evKey) continue;
    if (!Number.isFinite(c.p) || !Number.isFinite(c.odds)) continue;
    if (c.p < (CFG.minProb[c.sport] || 0.5) || c.odds < CFG.minOdds || c.odds > CFG.maxOdds) continue;
    const old = best.get(c.evKey);
    if (!old || c.score > old.score) best.set(c.evKey, c);
  }
  const pool = [...best.values()].sort((a, b) => b.score - a.score);
  const product = (legs) => legs.reduce((v, c) => v * c.odds, 1);
  const target = Number(req.target) || 0;
  const count = Number(req.count) || 0;
  let legs = [];
  let fallback = null;
  let note = '';
  if (target > 0) {
    const band = bandFor(target);
    for (const c of pool) {
      if (count && legs.length >= count) break;
      const next = [...legs, c];
      const total = product(next);
      if (total > band.hardMax) continue;
      if (total <= band.preferredMax) legs = next;
      else if (!fallback) fallback = next;
      if (product(legs) >= target) break;
    }
    if (product(legs) < target && fallback && product(fallback) >= target) legs = fallback;
    if (product(legs) < target)
      note = `Supported selections reached ${product(legs).toFixed(2)} odds; target ${target.toFixed(2)}. More matches need checking.`;
  } else if (count) {
    legs = pool.slice(0, count);
    if (legs.length < count) note = `Only ${legs.length} supported selections were found (asked for ${count}).`;
  } else {
    legs = pool.slice(0, 10);
  }
  legs.sort((a, b) => (a.ts || 9e15) - (b.ts || 9e15));
  const total = legs.length ? product(legs) : 0;
  const targetReached = target > 0 && total >= target && total <= bandFor(target).hardMax;
  const countReached = count <= 0 || legs.length === count;
  const complete = (target <= 0 || targetReached) && countReached && legs.length > 0;
  if (!countReached) note = `Only ${legs.length} selections were supported; ${count} were requested.`;
  const status = !legs.length ? 'empty' : (complete ? 'ready' : 'partial');
  return { legs, total, status, note, pool: pool.length, targetReached, countReached, complete, targetBand: target > 0 ? bandFor(target) : null };
}
module.exports = { build, bandFor };
