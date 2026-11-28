'use strict';
// Single-pass live zero-stake 50-selection guest Share Bet verification (post SLIP_PREFIX_FILL repair).
// Uses production site.openEvent, ex.markets, bk.scrollTargetUnobstructed, bk.readSlipCount, and bk.share.
// Never enters a stake or places a bet. Saves to a NEW timestamped evidence JSON file.
const fs = require('fs');
const path = require('path');
const { Site } = require('../lib/site');
const ex = require('../lib/extract');
const bk = require('../lib/book');
const { sleep } = require('../lib/util');

const wt = (p, ms) => {
  let t;
  return Promise.race([
    p,
    new Promise((_, r) => { t = setTimeout(() => r(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
};

const TARGET = Number(process.env.LEGS || 50);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(__dirname, '..', 'out', `live_50_verified_${stamp}.json`);
const res = {
  startedAt: new Date().toISOString(),
  target: TARGET,
  stage: 'init',
  poolSize: 0,
  attempted: 0,
  skipped: [],
  addedLegs: [],
  combinedOdds: 1,
  slipCountBeforeShare: 0,
  share: null,
  slipTextDiagnostics: '',
  finalVerdict: '',
};
const save = () => fs.writeFileSync(outFile, JSON.stringify(res, null, 2));

(async () => {
  const site = new Site();
  try {
    await site.start({ optimizeData: true });
    res.stage = 'discover';
    save();

    // Seed from the 50 fresh URLs just discovered 20 minutes ago, then top up with ~40 backups from 'all'
    const pool = [];
    const seen = new Set();
    const addPool = (f) => {
      if (!f || !f.url || !/^https?:/.test(f.url)) return;
      const k = f.url;
      if (seen.has(k)) return;
      seen.add(k);
      pool.push({ sport: 'football', home: f.home, away: f.away, url: f.url, league: f.league || '' });
    };

    const verifiedSeed = path.join(__dirname, '..', 'out', 'live_50_verified_2026-11-25T19-04-45-790Z.json');
    if (fs.existsSync(verifiedSeed)) {
      const prev = JSON.parse(fs.readFileSync(verifiedSeed, 'utf8'));
      for (const l of prev.addedLegs || []) addPool(l);
    }

    // Quick 90s discovery on 'all' + 'next3days' so we have 70+ backup URLs beyond the 46 verified seed fixtures
    const extra1 = await site.discover({ sports: ['football'], scope: 'all' }, Date.now() + 90 * 1000);
    for (const f of extra1) addPool(f);
    if (pool.length < TARGET + 20) {
      const extra2 = await site.discover({ sports: ['football'], scope: 'next3days' }, Date.now() + 90 * 1000);
      for (const f of extra2) addPool(f);
    }

    res.poolSize = pool.length;
    console.log(`[50-singlepass] fixture URL pool=${pool.length}`);
    res.stage = 'adding';
    save();

    let page = await site.newPage();
    try {
      const req = { sports: ['football'], scope: 'all' };
      for (const f of pool) {
        if (res.addedLegs.length >= TARGET) break;
        res.attempted++;
        try {
          const opened = await wt(site.openEvent(page, f, 'all', req), 45000);
          if (!opened) {
            res.skipped.push(`${f.home} v ${f.away}: openEvent failed`);
            console.log(`[skip] ${f.home} v ${f.away}: openEvent failed`);
            continue;
          }
          const list = await wt(ex.markets(page, f), 35000);
          const m =
            list.find((x) => /total/i.test(x.title) && /^over\s*1\.5$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 2.5) ||
            list.find((x) => /total/i.test(x.title) && /^over\s*2\.5$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 2.5) ||
            list.find((x) => /total/i.test(x.title) && /^over\s*\d+(\.\d)?$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 3.0) ||
            list.find((x) => /^(1x2|double chance)$/i.test(String(x.title).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 3.5);
          if (!m) {
            res.skipped.push(`${f.home} v ${f.away}: no clickable target market`);
            continue;
          }

          const beforeCount = await wt(bk.readSlipCount(page), 8000);
          const expectedCount = beforeCount + 1;
          let addedOk = false;
          let afterCount = beforeCount;

          for (let attempt = 1; attempt <= 2 && !addedOk; attempt++) {
            const geom = await wt(bk.scrollTargetUnobstructed(page, m.i), 8000);
            await sleep(250);
            if (!geom.found) break;
            const loc = page.locator(`[data-bb="${m.i}"]`).first();
            const clicked = await wt(loc.click({ timeout: 4000 }), 6000).then(() => true).catch(() => false);
            if (clicked) {
              const t0 = Date.now();
              while (Date.now() - t0 < 2800) {
                afterCount = await wt(bk.readSlipCount(page), 5000);
                if (afterCount === expectedCount) { addedOk = true; break; }
                await sleep(200);
              }
            }
            if (!addedOk && attempt === 1) await sleep(500);
          }

          if (!addedOk) {
            res.skipped.push(`${f.home} v ${f.away}: click did not increment slip (${beforeCount}->${afterCount})`);
            continue;
          }

          res.addedLegs.push({
            sport: 'football',
            home: f.home,
            away: f.away,
            url: f.url,
            league: f.league,
            market: m.title,
            outcome: m.label,
            odds: m.odds,
          });
          res.combinedOdds = Math.round(res.combinedOdds * m.odds * 100) / 100;
          console.log(`[add] ${res.addedLegs.length}/${TARGET} (slip=${afterCount}) ${f.home} v ${f.away} | ${m.title}: ${m.label} @${m.odds}`);
          if (res.addedLegs.length % 5 === 0 || res.addedLegs.length === TARGET) save();
        } catch (e) {
          res.skipped.push(`${f.home} v ${f.away}: ${e.message}`);
          console.log(`[skip] ${f.home} v ${f.away}: ${e.message}`);
          if (/timeout/i.test(e.message)) {
            await page.close().catch(() => {});
            page = await site.newPage();
          }
        }
      }

      res.slipCountBeforeShare = await bk.readSlipCount(page);
      res.stage = 'share';
      save();

      if (res.addedLegs.length < TARGET) {
        res.finalVerdict = `SAFE REFUSAL: only added ${res.addedLegs.length}/${TARGET} legs (slip=${res.slipCountBeforeShare})`;
      } else {
        console.log(`[50-singlepass] Calling production bk.share() on ${res.addedLegs.length} legs (slip=${res.slipCountBeforeShare}, zero stakes)...`);
        const s = await bk.share(site, page, res.addedLegs);
        res.share = s;
        if (s.missingLegs && s.missingLegs.length > 0) {
          res.slipTextDiagnostics = await page.evaluate(() => {
            for (const sel of ['.betslip-container', '.betslip-wrapper']) {
              const el = document.querySelector(sel);
              if (el && el.getBoundingClientRect().height > 200) return (el.innerText || '').trim();
            }
            return '';
          }).catch(() => '');
        }
        res.finalVerdict =
          s.code && s.missingLegs.length === 0 && s.verifiedLegs.length === TARGET
            ? `PASS: ${s.verifiedLegs.length}/${TARGET} verified, genuine code ${s.code} (${s.link || 'no link'}), slipCount=${res.slipCountBeforeShare}, combinedOdds=${res.combinedOdds}`
            : `SAFE REFUSAL: verified=${(s.verifiedLegs || []).length}/${TARGET}, missing=${(s.missingLegs || []).length}, code=${s.code || 'none'}; reason: ${s.why}`;
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    res.finalVerdict = 'ERROR: ' + e.message;
  } finally {
    res.finishedAt = new Date().toISOString();
    res.stage = 'done';
    save();
    await site.close().catch(() => {});
    console.log(res.finalVerdict, '->', outFile);
  }
})();
