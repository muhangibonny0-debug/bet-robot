'use strict';
// Fast, zero-stake live 50-selection guest Share Bet verification (post SLIP_PREFIX_FILL repair).
// Adds 50 distinct real BangBet football fixtures (1X2 Home) from the live Football listing page
// with strict slip-count confirmation (1..50), then calls production bk.share(site, page, legs)
// which opens the full betslip drawer, verifies 50/50 legs strictly (home, away, outcome),
// and generates a genuine BangBet Share Bet booking code ONLY if 50/50 pass.
const fs = require('fs');
const path = require('path');
const { Site } = require('../lib/site');
const bk = require('../lib/book');
const { sleep } = require('../lib/util');

const TARGET = Number(process.env.LEGS || 50);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(__dirname, '..', 'out', `live_50_postrepair_verified_${stamp}.json`);
const res = {
  startedAt: new Date().toISOString(),
  target: TARGET,
  stage: 'init',
  addedLegs: [],
  combinedOdds: 1,
  slipCountBeforeShare: 0,
  share: null,
  slipTextSample: '',
  finalVerdict: '',
};
const save = () => fs.writeFileSync(outFile, JSON.stringify(res, null, 2));

(async () => {
  const site = new Site();
  try {
    await site.start({ optimizeData: true });
    res.stage = 'listing';
    save();

    const page = await site.newPage();
    try {
      const okSport = await site.goSport(page, 'football');
      if (!okSport) throw new Error('Could not open BangBet Football listing');
      await sleep(2000);

      const used = new Set();
      const tabQueue = ['tomorrow', 'next3days', 'next7days', 'today'];
      let noNewPasses = 0;

      while (res.addedLegs.length < TARGET && (noNewPasses < 8 || tabQueue.length > 0)) {
        // Find visible match cards on the listing page with team names + clickable 1X2 odds button
        const batch = await page.evaluate((alreadyUsed) => {
          const usedSet = new Set(alreadyUsed);
          const priceRe = /^\d{1,3}\.\d{2}$/;
          const timeRe = /^\d{1,2}:\d{2}$/;
          const dateRe = /^(today|tomorrow|\d{1,2}\/\d{1,2}|\d{1,2}\s+[a-z]{3})/i;
          const noiseRe = /^(1|x|2|1x|x2|12|more|live|ht|ft|all|time|league|markets|\+\d+)$/i;

          document.querySelectorAll('[data-bb-pick]').forEach((el) => el.removeAttribute('data-bb-pick'));

          const cards = [];
          const allEls = [...document.querySelectorAll('div,li,section,article')];
          for (const el of allEls) {
            if (el.closest('.rapid-betslip, .betslip-container, .betslip-wrapper')) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 220 || r.height < 48 || r.height > 230 || r.top < 60 || r.top > window.innerHeight - 90) continue;
            const raw = (el.innerText || '').trim();
            if (raw.length < 10 || raw.length > 320) continue;
            const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
            const prices = lines.filter((l) => priceRe.test(l));
            if (prices.length < 3 || prices.length > 7) continue;
            const words = lines.filter((l) =>
              !priceRe.test(l) && !timeRe.test(l) && !dateRe.test(l) &&
              /[A-Za-z]{2,}/.test(l) && l.length < 52 && !noiseRe.test(l) && !/ - /.test(l) && !/^\d+$/.test(l)
            );
            if (words.length < 2) continue;
            cards.push({ el, home: words[0], away: words[1], top: r.top });
          }

          // Keep innermost match cards only
          const keep = cards.filter((c) => !cards.some((o) => o !== c && c.el.contains(o.el)));
          keep.sort((a, b) => a.top - b.top);

          const out = [];
          let idx = 0;
          for (const c of keep) {
            const key = `${c.home.toLowerCase()}|${c.away.toLowerCase()}`;
            if (usedSet.has(key)) continue;
            // Find the FIRST odds button inside this card (1X2 -> Home / 1)
            const priceNodes = [...c.el.querySelectorAll('div,span,button')].filter((n) => {
              const t = (n.innerText || '').trim();
              if (!priceRe.test(t) || n.children.length > 1) return false;
              const nr = n.getBoundingClientRect();
              return nr.width >= 24 && nr.height >= 16 && nr.top >= 70 && nr.bottom <= window.innerHeight - 85;
            });
            if (priceNodes.length < 3) continue;
            priceNodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
            const btn = priceNodes[0];
            const odds = Number((btn.innerText || '').trim());
            if (!Number.isFinite(odds) || odds < 1.01 || odds > 100) continue;
            idx++;
            btn.setAttribute('data-bb-pick', String(idx));
            out.push({ idx, key, home: c.home, away: c.away, odds });
          }
          return out;
        }, [...used]);

        let addedThisPass = 0;
        for (const item of batch) {
          if (res.addedLegs.length >= TARGET) break;
          used.add(item.key);
          const before = await bk.readSlipCount(page);
          const expected = before + 1;
          const loc = page.locator(`[data-bb-pick="${item.idx}"]`).first();
          const clicked = await loc.click({ timeout: 3000 }).then(() => true).catch(() => false);
          if (!clicked) continue;
          let after = before;
          const t0 = Date.now();
          while (Date.now() - t0 < 2200) {
            after = await bk.readSlipCount(page);
            if (after === expected) break;
            await sleep(150);
          }
          if (after === expected) {
            addedThisPass++;
            res.addedLegs.push({
              sport: 'football',
              home: item.home,
              away: item.away,
              market: '1X2',
              outcome: 'Home',
              odds: item.odds,
            });
            res.combinedOdds = Math.round(res.combinedOdds * item.odds * 100) / 100;
            if (res.addedLegs.length <= 3 || res.addedLegs.length % 5 === 0 || res.addedLegs.length === TARGET) {
              console.log(`[add] ${res.addedLegs.length}/${TARGET} (slip=${after}) ${item.home} v ${item.away} | 1X2: Home @${item.odds}`);
            }
          }
        }

        if (addedThisPass === 0) {
          noNewPasses++;
        } else {
          noNewPasses = 0;
          save();
        }

        if (res.addedLegs.length < TARGET) {
          if (noNewPasses >= 3 && tabQueue.length > 0) {
            const nextTab = tabQueue.shift();
            noNewPasses = 0;
            await site.selectScope(page, nextTab).catch(() => {});
            await sleep(1500);
          } else {
            if (noNewPasses === 1) {
              await site.clickText(page, /^(load\s*more|show\s*more|more\s*matches|more\s*events|view\s*more)$/i).catch(() => {});
            }
            await site._scrollDown(page).catch(() => {});
            await page.mouse.wheel(0, 700).catch(() => {});
            await sleep(1200);
          }
        }
      }

      res.slipCountBeforeShare = await bk.readSlipCount(page);
      res.stage = 'share';
      save();

      if (res.addedLegs.length < TARGET) {
        res.finalVerdict = `SAFE REFUSAL: only added ${res.addedLegs.length}/${TARGET} legs (slip=${res.slipCountBeforeShare})`;
      } else {
        console.log(`[50-listing] Calling production bk.share() on ${res.addedLegs.length} legs (slip=${res.slipCountBeforeShare}, zero stakes)...`);
        const s = await bk.share(site, page, res.addedLegs);
        res.share = s;
        if (s.missingLegs && s.missingLegs.length > 0) {
          res.slipTextSample = await page.evaluate(() => {
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
