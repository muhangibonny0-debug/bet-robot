'use strict';
// Live zero-stake 50-selection guest Share Bet verification (post SLIP_PREFIX_FILL repair).
// Never places a bet. Writes a NEW timestamped evidence file; never overwrites history.
const fs = require('fs');
const path = require('path');
const { Site } = require('../lib/site');
const ex = require('../lib/extract');
const bk = require('../lib/book');

const wt = (p, ms) => {
  let t;
  return Promise.race([
    p,
    new Promise((_, r) => { t = setTimeout(() => r(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
};

const TARGET = Number(process.env.LEGS || 50);
const SCOPE = process.env.SCOPE || 'tomorrow';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(__dirname, '..', 'out', `live_50_postrepair_${stamp}.json`);
const res = {
  startedAt: new Date().toISOString(),
  target: TARGET,
  scope: SCOPE,
  stage: 'init',
  fixturesDiscovered: 0,
  fixturesWithUrl: 0,
  candidatesScanned: 0,
  legs: [],
  book: null,
  finalVerdict: '',
  siteNotes: [],
};
const save = () => fs.writeFileSync(outFile, JSON.stringify(res, null, 2));

(async () => {
  const site = new Site();
  try {
    await site.start({ optimizeData: true });
    res.stage = 'discover';
    save();
    const req = { sports: ['football'], scope: SCOPE };
    let fixtures = await site.discover(req, Date.now() + 5 * 60 * 1000);
    let withUrl = fixtures.filter((f) => f.url && /^https?:/.test(f.url));
    if (withUrl.length < TARGET + 10 && SCOPE !== 'all') {
      console.log(`[50-verify] ${SCOPE} yielded ${withUrl.length} URL fixtures; also scanning all`);
      const extra = await site.discover({ sports: ['football'], scope: 'all' }, Date.now() + 5 * 60 * 1000);
      const seen = new Set(withUrl.map((f) => f.matchId || f.url));
      for (const f of extra) {
        if (f.url && /^https?:/.test(f.url) && !seen.has(f.matchId || f.url)) {
          seen.add(f.matchId || f.url);
          withUrl.push(f);
        }
      }
      fixtures = [...fixtures, ...extra];
    }
    res.fixturesDiscovered = fixtures.length;
    res.fixturesWithUrl = withUrl.length;
    res.siteNotes = [...(site.notes || [])];
    console.log(`[50-verify] discovered=${fixtures.length}, withUrl=${withUrl.length}`);
    res.stage = 'select';
    save();

    const page = await site.newPage();
    const used = new Set();
    for (const f of withUrl) {
      if (res.legs.length >= TARGET) break;
      const key = f.matchId || `${f.home}|${f.away}`;
      if (used.has(key)) continue;
      used.add(key);
      res.candidatesScanned++;
      try {
        if (!(await wt(site.openEvent(page, f, SCOPE, req), 35000))) continue;
        const list = await wt(ex.markets(page, f), 30000);
        const m =
          list.find((x) => /total/i.test(x.title) && /^over\s*1\.5$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 2.5) ||
          list.find((x) => /total/i.test(x.title) && /^over\s*2\.5$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 2.5) ||
          list.find((x) => /total/i.test(x.title) && /^over\s*\d+(\.\d)?$/i.test(String(x.label).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 3.0) ||
          list.find((x) => /^(1x2|double chance)$/i.test(String(x.title).trim()) && x.i >= 0 && x.odds >= 1.05 && x.odds <= 3.5);
        if (!m) continue;
        res.legs.push({
          sport: 'football',
          home: f.home,
          away: f.away,
          url: f.url,
          league: f.league,
          market: m.title,
          outcome: m.label,
          odds: m.odds,
        });
        if (res.legs.length % 5 === 0 || res.legs.length === TARGET) {
          console.log(`[select] ${res.legs.length}/${TARGET} (scanned=${res.candidatesScanned})`);
          save();
        }
      } catch (e) {
        /* skip fixture */
      }
    }
    await page.close().catch(() => {});

    res.stage = 'book';
    save();
    if (res.legs.length < TARGET) {
      res.finalVerdict = `SAFE REFUSAL (not attempted): only ${res.legs.length}/${TARGET} bookable fixtures found`;
    } else {
      console.log(`[50-verify] Starting bk.book() for ${res.legs.length} legs (zero stakes)...`);
      res.book = await bk.book(site, res.legs, Date.now() + 25 * 60 * 1000, SCOPE, req);
      const b = res.book;
      res.finalVerdict =
        b.ok && b.code && b.verifiedLegs.length === TARGET && b.added === TARGET && b.missingLegs.length === 0
          ? `PASS: ${b.verifiedLegs.length}/${TARGET} verified, genuine code ${b.code} (${b.link || 'no link'}), combined odds ${b.total}`
          : `SAFE REFUSAL: added=${b.added}/${TARGET}, verified=${b.verifiedLegs.length}, missing=${b.missingLegs.length}, code=${b.code || 'none'}; reason: ${b.why}`;
    }
  } catch (e) {
    res.finalVerdict = 'ERROR: ' + e.message;
  } finally {
    res.siteNotes = [...(site.notes || [])];
    res.finishedAt = new Date().toISOString();
    res.stage = 'done';
    save();
    await site.close().catch(() => {});
    console.log(res.finalVerdict, '->', outFile);
  }
})();
