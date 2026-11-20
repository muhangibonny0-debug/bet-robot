'use strict';
const { CFG } = require('./analyze');

// one selection per match, then the best fit to the number of selections and the odds asked for
function build(cands, req) {
  const best = new Map();
  for (const c of cands) {
    if (c.p < (CFG.minProb[c.sport] || 0.5) || c.odds < CFG.minOdds || c.odds > CFG.maxOdds) continue;
    const b = best.get(c.evKey);
    if (!b || c.score > b.score) best.set(c.evKey, c);
  }
  let pool = [...best.values()].sort((a, b) => b.score - a.score);
  if (req.sports.length > 1) {
    const by = {};
    for (const c of pool) (by[c.sport] = by[c.sport] || []).push(c);
    const mix = [];
    for (let i = 0; mix.length < pool.length; i++) {
      let any = false;
      for (const s of Object.keys(by)) if (by[s][i]) { mix.push(by[s][i]); any = true; }
      if (!any) break;
    }
    pool = mix;
  }
  const prod = (l) => l.reduce((t, c) => t * c.odds, 1);
  const target = req.target || 0;
  const count = req.count || 0;
  let legs = [];
  let note = '';

  if (count) {
    legs = pool.slice(0, count);
    if (target && legs.length) {
      // swap selections to bring the total odds closer to the target, keeping the best evidence
      const J = (l) => l.reduce((s, c) => s + c.score, 0) - 2 * Math.abs(Math.log(prod(l) / target));
      for (let it = 0; it < 300; it++) {
        let bestJ = J(legs);
        let move = null;
        for (let i = 0; i < legs.length; i++) {
          for (const c of pool) {
            if (legs.includes(c)) continue;
            const t = legs.slice(); t[i] = c;
            const j = J(t);
            if (j > bestJ + 1e-9) { bestJ = j; move = t; }
          }
        }
        if (!move) break;
        legs = move;
      }
    }
    if (legs.length < count) note = `Only ${legs.length} selections have enough evidence (asked for ${count}).`;
  } else if (target) {
    for (const c of pool) {
      if (prod(legs) >= target * 0.9) break;
      if (prod(legs) * c.odds > target * 1.25 && legs.length) continue;
      legs.push(c);
    }
    if (prod(legs) < target * 0.85) note = `The selections with enough evidence only reach ${prod(legs).toFixed(1)} odds.`;
  } else {
    legs = pool.slice(0, 10);
  }
  legs.sort((a, b) => (a.ts || 9e15) - (b.ts || 9e15));
  const total = legs.length ? prod(legs) : 0;
  let status = legs.length ? 'ready' : 'empty';
  if (note && legs.length) status = 'partial';
  return { legs, total, status, note, pool: pool.length };
}

module.exports = { build };
