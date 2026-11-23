'use strict';
// BangBet betslip: the exact market and outcome that were discovered. All or nothing; no bet is placed.
const { sleep, norm, walk } = require('./util');
const ex = require('./extract');

async function addLeg(site, page, leg, scope = 'today', req = null) {
  const ev = { sport: leg.sport, home: leg.home, away: leg.away, url: leg.url, league: leg.league };
  if (!(await site.openEvent(page, ev, scope, req))) return { ok: false, why: 'could not open the match' };
  const list = await ex.markets(page, ev);
  const same = (a, b) => norm(a) === norm(b);
  const m = list.find((x) => same(x.title, leg.market) && same(x.label, leg.outcome) && x.i >= 0) ||
    list.find((x) => same(x.title, leg.market) && same(x.label, leg.outcome));
  if (!m) return { ok: false, why: `the market "${leg.market} / ${leg.outcome}" is not shown any more` };
  const r = m.odds / leg.odds;
  if (r < 0.7 || r > 1.4) return { ok: false, why: `the odds changed a lot: ${leg.odds} to ${m.odds}` };
  if (m.i < 0) return { ok: false, why: 'the price was found in data, not on the page, so it cannot be clicked' };
  await page.locator(`[data-bb="${m.i}"]`).first().click({ timeout: 4000, force: true }).catch(() => { m.i = -1; });
  if (m.i < 0) return { ok: false, why: 'the price could not be clicked' };
  await sleep(900);
  return { ok: true, odds: m.odds, changed: Math.abs(m.odds - leg.odds) > 0.005 };
}

function verifySlipText(text, legs) {
  const body = norm(text);
  const missing = legs.filter((leg) =>
    !body.includes(norm(leg.home)) ||
    !body.includes(norm(leg.away)) ||
    !body.includes(norm(leg.outcome)));
  return { ok: missing.length === 0, missing };
}

const BAD_CODES = new Set([
  'ACCEPT', 'REMOVE', 'MULTIPLE', 'SINGLES', 'SHARE', 'PLACE', 'BETSLIP', 'TOTAL',
  'STAKE', 'BOOST', 'LOGIN', 'CANCEL', 'CLOSE', 'COPY', 'LINK', 'CODE', 'LOAD', 'NONE',
]);
function isPlausibleCode(v, fromJson = false) {
  const s = String(v || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(s)) return false;
  if (BAD_CODES.has(s)) return false;
  // DOM regex matches must contain at least one digit so UI words are never mistaken for booking codes
  if (!fromJson && !/\d/.test(s)) return false;
  return true;
}

async function share(site, page, legs) {
  const out = { code: '', link: '', why: '' };
  let opened = false;
  for (const sel of ['[class*="betslip" i]:visible', '[class*="slip" i]:visible', '[class*="cart" i]:visible']) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 3000, force: true });
        await sleep(1200);
        opened = true;
        break;
      }
    } catch (e) { /* try another betslip selector */ }
  }
  if (!opened) {
    try {
      const el = page.getByText(/bet\s*slip/i).first();
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 3000, force: true });
        await sleep(1200);
        opened = true;
      }
    } catch (e) { /* betslip panel not available */ }
  }
  if (!opened) return { ...out, why: 'BangBet betslip panel could not be opened; no booking code was requested.' };
  const slipText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const verified = verifySlipText(slipText, legs);
  if (!verified.ok) {
    const names = verified.missing.map((l) => l.home + ' v ' + l.away).join(', ');
    return { ...out, why: 'Betslip verification failed; these selections were not visible in the slip: ' + names };
  }
  await site.shot(page, 'book_slip_verified');
  // Ensure the combined "Multiple" tab is active when booking >= 2 selections
  if (legs.length >= 2) {
    try {
      const mult = page.getByText(/^multiple$/i).first();
      if ((await mult.count()) && (await mult.isVisible())) {
        await mult.click({ timeout: 2500, force: true }).catch(() => {});
        await sleep(500);
      }
    } catch (_) {}
  }
  const mark = page.net.length;
  for (const re of [/^share\s*bet$/i, /share\s*(bet|slip|code)/i, /book(ing)?\s*(a\s*)?bet/i, /booking\s*code/i, /generate\s*code/i]) {
    try {
      const el = page.getByText(re).last();
      if ((await el.count()) && (await el.isVisible())) {
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await el.click({ timeout: 4000, force: true });
        }
        await sleep(3500);
        break;
      }
    } catch (e) { /* ignore */ }
  }
  // If BangBet shows a "Copy Link" button inside the Share Bet modal, click it to populate clipboard as well
  try {
    const cp = page.getByText(/^copy\s*link$/i).first();
    if ((await cp.count()) && (await cp.isVisible())) {
      await cp.click({ timeout: 2000, force: true }).catch(() => {});
      await sleep(500);
    }
  } catch (_) {}
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const vals = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => i.value).filter(Boolean)).catch(() => []);
  const clip = await page.evaluate(() => navigator.clipboard ? navigator.clipboard.readText().catch(() => '') : '').catch(() => '');
  const hay = [text, ...vals, clip].join('\n');
  const u = hay.match(/https?:\/\/[^\s"'<>]*bangbet[^\s"'<>]*/i);
  if (u) out.link = u[0];
  for (const r of page.net.slice(mark)) {
    walk(r.body, (o) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        if (/^(booking|bet|share)_?code$|^shareCode$|^bookCode$/i.test(k) && isPlausibleCode(v, true) && !out.code) out.code = v.toUpperCase();
        if (/(link|url|shareUrl)/i.test(k) && /bangbet/i.test(v) && !out.link) out.link = v;
      }
    });
  }
  if (!out.code) {
    const c = hay.match(/(?:booking|bet|share)\s*code\s*[:-]?\s*([A-Z0-9]{4,12})\b/i);
    if (c && isPlausibleCode(c[1], false)) out.code = c[1].toUpperCase();
  }
  if (!out.code && out.link) {
    const qm = out.link.match(/[?&](?:shareCode|bookingCode|code)=([A-Za-z0-9]{4,12})\b/i);
    if (qm && isPlausibleCode(qm[1], true)) out.code = qm[1].toUpperCase();
  }
  await site.shot(page, 'book_after_share');
  return out;
}

async function book(site, legs, deadline, scope = 'today', req = null) {
  const res = { ok: false, code: '', link: '', added: 0, total: 1, why: '', changes: [] };
  const page = await site.newPage();
  try {
    for (const leg of legs) {
      if (Date.now() > deadline) { res.why = 'time ran out while building the betslip'; break; }
      const r = await addLeg(site, page, leg, scope, req).catch((e) => ({ ok: false, why: 'error ' + e.message }));
      console.log(`[book] ${leg.home} v ${leg.away}: ${r.ok ? 'added @' + r.odds : 'FAILED ' + r.why}`);
      if (!r.ok) { res.why = `${leg.home} v ${leg.away}: ${r.why}`; break; }
      res.added++;
      res.total *= r.odds;
      if (r.changed) res.changes.push(`${leg.home} v ${leg.away}: ${leg.odds} to ${r.odds}`);
    }
    if (res.added === legs.length) {
      const s = await share(site, page, legs);
      res.code = s.code;
      res.link = s.link;
      res.ok = !!s.code;
      if (!res.ok) res.why = s.why || 'every selection was added, but BangBet did not return a booking code. A share link alone is not confirmation.';
    } else if (!res.why) res.why = `${res.added} of ${legs.length} selections added`;
  } finally {
    await page.close().catch(() => {});
  }
  res.total = Math.round(res.total * 100) / 100;
  return res;
}

module.exports = { book, verifySlipText };
