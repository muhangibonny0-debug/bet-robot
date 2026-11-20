'use strict';
// BangBet betslip: the exact market and outcome that were discovered. All or nothing; no bet is placed.
const { sleep, norm, walk } = require('./util');
const ex = require('./extract');

async function addLeg(site, page, leg) {
  const ev = { sport: leg.sport, home: leg.home, away: leg.away, url: leg.url, league: leg.league };
  if (!(await site.openEvent(page, ev))) return { ok: false, why: 'could not open the match' };
  const list = await ex.markets(page, ev);
  const same = (a, b) => norm(a) === norm(b);
  const m = list.find((x) => same(x.title, leg.market) && same(x.label, leg.outcome) && x.i >= 0) ||
    list.find((x) => same(x.title, leg.market) && same(x.label, leg.outcome));
  if (!m) return { ok: false, why: `the market "${leg.market} / ${leg.outcome}" is not shown any more` };
  const r = m.odds / leg.odds;
  if (r < 0.7 || r > 1.4) return { ok: false, why: `the odds changed a lot: ${leg.odds} to ${m.odds}` };
  if (m.i < 0) return { ok: false, why: 'the price was found in data, not on the page, so it cannot be clicked' };
  await page.locator(`[data-bb="${m.i}"]`).first().click({ timeout: 4000 }).catch(() => { m.i = -1; });
  if (m.i < 0) return { ok: false, why: 'the price could not be clicked' };
  await sleep(900);
  return { ok: true, odds: m.odds, changed: Math.abs(m.odds - leg.odds) > 0.005 };
}

async function share(site, page) {
  const out = { code: '', link: '' };
  for (const sel of ['[class*="slip" i]:visible', '[class*="cart" i]:visible']) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 2000 }); await sleep(1200); break; }
    } catch (e) { /* ignore */ }
  }
  await site.shot(page, 'book_slip');
  const mark = page.net.length;
  for (const re of [/book(ing)?\s*(a\s*)?bet/i, /booking\s*code/i, /generate\s*code/i, /share/i, /\bbook\b/i]) {
    try {
      const el = page.getByText(re).first();
      if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 3000 }); await sleep(2500); break; }
    } catch (e) { /* ignore */ }
  }
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const vals = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => i.value).filter(Boolean)).catch(() => []);
  const hay = [text, ...vals].join('\n');
  const u = hay.match(/https?:\/\/[^\s"'<>]*bangbet[^\s"'<>]*/i);
  if (u) out.link = u[0];
  const c = hay.match(/[Cc]ode\s*[:-]?\s*([A-Z0-9]{4,10})\b/);
  if (c) out.code = c[1];
  for (const r of page.net.slice(mark)) {
    walk(r.body, (o) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        if (/code/i.test(k) && /^[A-Za-z0-9]{4,10}$/.test(v) && !out.code) out.code = v.toUpperCase();
        if (/(link|url)/i.test(k) && /bangbet/i.test(v) && !out.link) out.link = v;
      }
    });
  }
  await site.shot(page, 'book_after_share');
  return out;
}

async function book(site, legs, deadline) {
  const res = { ok: false, code: '', link: '', added: 0, total: 1, why: '', changes: [] };
  const page = await site.newPage();
  try {
    for (const leg of legs) {
      if (Date.now() > deadline) { res.why = 'time ran out while building the betslip'; break; }
      const r = await addLeg(site, page, leg).catch((e) => ({ ok: false, why: 'error ' + e.message }));
      console.log(`[book] ${leg.home} v ${leg.away}: ${r.ok ? 'added @' + r.odds : 'FAILED ' + r.why}`);
      if (!r.ok) { res.why = `${leg.home} v ${leg.away}: ${r.why}`; break; }
      res.added++;
      res.total *= r.odds;
      if (r.changed) res.changes.push(`${leg.home} v ${leg.away}: ${leg.odds} to ${r.odds}`);
    }
    if (res.added === legs.length) {
      const s = await share(site, page);
      res.code = s.code;
      res.link = s.link;
      res.ok = !!(s.code || s.link);
      if (!res.ok) res.why = 'every selection was added, but no code or link could be read after pressing share';
    } else if (!res.why) res.why = `${res.added} of ${legs.length} selections added`;
  } finally {
    await page.close().catch(() => {});
  }
  res.total = Math.round(res.total * 100) / 100;
  return res;
}

module.exports = { book };
