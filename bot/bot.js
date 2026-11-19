'use strict';
// BangBet guest bot: builds a slip from the robot's picks and reads the share link / booking code.
// It never logs in and never places a bet.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://www.bangbet.com/ug-m';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('[bot]', ...a);

const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['football', 'club', 'team', 'the', 'and', 'real', 'united', 'city', 'athletic',
  'sporting', 'sport', 'fc', 'afc', 'cf', 'sc', 'ac', 'sv', 'fk', 'if', 'bk', 'ik', 'de', 'la']);
// the most distinctive word of a team name: used to search and to recognise the match
const keyTok = (s) => {
  const t = norm(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)).sort((a, b) => b.length - a.length);
  return t[0] || norm(s).split(' ').sort((a, b) => b.length - a.length)[0] || '';
};
const tag = (k) => String(k).replace(/[^a-z0-9]/gi, '_');

function walk(o, fn, d = 0) {
  if (d > 8 || o == null) return;
  if (Array.isArray(o)) { for (const x of o.slice(0, 500)) walk(x, fn, d + 1); return; }
  if (typeof o === 'object') { fn(o); for (const k of Object.keys(o)) walk(o[k], fn, d + 1); }
}

// events found inside the site's own JSON answers (home/away names)
function eventsFrom(body) {
  const out = [];
  walk(body, (o) => {
    const ks = Object.keys(o);
    const hk = ks.find((k) => /^(home|hometeam|homename|hometeamname|team1|host)/i.test(k) && typeof o[k] === 'string');
    const ak = ks.find((k) => /^(away|awayteam|awayname|awayteamname|team2|guest)/i.test(k) && typeof o[k] === 'string');
    if (hk && ak) out.push({ home: o[hk], away: o[ak] });
  });
  return out;
}

async function session() {
  const opt = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.BOT_PROXY) opt.proxy = { server: process.env.BOT_PROXY };
  const browser = await chromium.launch(opt);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    locale: 'en-UG', timezoneId: 'Africa/Kampala', permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const net = [];
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await res.json().catch(() => null);
      if (body == null) return;
      net.push({ url: res.url(), status: res.status(), method: res.request().method(), body });
      if (net.length > 300) net.shift();
    } catch (e) { /* ignore */ }
  });
  return { browser, ctx, page, net };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') }).catch(() => {});
}

async function dismiss(page) {
  const sels = ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("I agree")',
    'button:has-text("Later")', 'button:has-text("Not now")', 'button:has-text("Close")', '[aria-label="Close" i]'];
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 800 }); await sleep(300); }
    } catch (e) { /* ignore */ }
  }
}

async function goHome(page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await sleep(2500);
  await dismiss(page);
}

async function searchInput(page) {
  const sel = 'input[type="search"], input[placeholder*="earch" i], input[type="text"]:visible';
  let inp = page.locator(sel).first();
  if ((await inp.count()) && (await inp.isVisible().catch(() => false))) return inp;
  const icons = ['[class*="search" i]', '[aria-label*="search" i]', '[data-testid*="search" i]',
    'img[alt*="search" i]', 'a[href*="search" i]'];
  for (const s of icons) {
    try {
      const els = page.locator(s);
      const n = Math.min(await els.count(), 4);
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 1500 }).catch(() => {});
        await sleep(700);
        inp = page.locator(sel).first();
        if ((await inp.count()) && (await inp.isVisible().catch(() => false))) return inp;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

// finds the match in the search results and opens it. Returns the scope to pick odds from.
async function openMatch(page, leg) {
  const h = keyTok(leg.home);
  const a = keyTok(leg.away);
  const urlBefore = page.url();
  const ok = await page.evaluate(({ h, a }) => {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    let best = null; let len = 1e9;
    for (const el of document.querySelectorAll('a, li, div, section, article')) {
      const t = norm(el.innerText);
      if (!t || t.length > 500) continue;
      if (t.includes(h) && t.includes(a) && t.length < len) { best = el; len = t.length; }
    }
    if (!best) return false;
    best.setAttribute('data-botscope', '1');
    // the team name inside it: clicking a name opens the match, clicking the middle could hit a price
    let name = null; let nl = 1e9;
    for (const el of best.querySelectorAll('*')) {
      const t = norm(el.innerText);
      if (t && t.includes(h) && !/\d\.\d\d/.test(t) && t.length < nl) { name = el; nl = t.length; }
    }
    (name || best).setAttribute('data-botname', '1');
    return true;
  }, { h, a });
  if (!ok) return null;
  await page.locator('[data-botname="1"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('[data-botname]').forEach((e) => e.removeAttribute('data-botname')));
  await sleep(1800);
  const stillThere = await page.locator('[data-botscope="1"]').count();
  if (page.url() !== urlBefore || !stillThere) {
    await page.evaluate(() => document.querySelectorAll('[data-botscope]').forEach((e) => e.removeAttribute('data-botscope')));
    return 'body'; // a match page opened: look at the whole page
  }
  return '[data-botscope="1"]'; // prices are inline in the result row
}

async function pickOdds(page, leg, scope) {
  const sel = scope === 'body' ? '' : scope;
  const r = await page.evaluate(({ sel, mk, s, line, want }) => {
    const root = sel ? document.querySelector(sel) : document.body;
    if (!root) return { ok: false, why: 'result row disappeared' };
    const cells = [];
    for (const el of root.querySelectorAll('*')) {
      const raw = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (!raw || raw.length > 40) continue;
      const m = raw.match(/^(.*?)(\d{1,3}\.\d{2})$/);
      if (!m) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 12 || b.height < 12) continue;
      cells.push({ el, label: m[1].trim(), odds: parseFloat(m[2]), top: Math.round(b.top / 8), left: b.left, text: raw });
    }
    // keep the outer element when a parent has the same text, so the click hits the whole price cell
    const cs = cells.filter((c) => !cells.some((o) => o !== c && o.el.contains(c.el) && o.text === c.text));
    const okr = (o) => o >= want * 0.7 && o <= want * 1.4;
    let pick = null;
    if (mk === '1X2' || mk === 'HA') {
      const need = mk === '1X2' ? 3 : 2;
      const rows = {};
      for (const c of cs) (rows[c.top] = rows[c.top] || []).push(c);
      const ks = Object.keys(rows).map(Number).sort((x, y) => x - y);
      for (const k of ks) {
        const row = rows[k].sort((x, y) => x.left - y.left);
        if (row.length === need) {
          const idx = mk === '1X2' ? { '1': 0, X: 1, '2': 2 }[s] : (s === '1' ? 0 : 1);
          const c = row[idx];
          if (c && okr(c.odds)) pick = c;
          else if (c) return { ok: false, why: 'price differs: BangBet ' + c.odds + ' vs ours ' + want };
          break;
        }
      }
    } else if (mk === 'DC') {
      const names = { '1X': /^(1x|home or draw)$/i, X2: /^(x2|draw or away)$/i, '12': /^(12|home or away)$/i }[s];
      pick = cs.find((c) => names && names.test(c.label.replace(/\s+/g, ' ')) && okr(c.odds)) || null;
    } else if (mk === 'OU') {
      const re = new RegExp('^(' + (s === 'O' ? 'over|o' : 'under|u') + ')\\s*' + String(line).replace('.', '\\.') + '$', 'i');
      pick = cs.find((c) => re.test(c.label.trim()) && okr(c.odds)) || null;
    }
    if (!pick) return { ok: false, why: 'price not found for ' + mk + ' ' + s + (line ? ' ' + line : '') };
    pick.el.setAttribute('data-botpick', '1');
    return { ok: true, odds: pick.odds };
  }, { sel, mk: leg.mk, s: String(leg.sel), line: leg.line == null ? '' : leg.line, want: Number(leg.odds) });
  if (!r.ok) return r;
  await page.locator('[data-botpick="1"]').first().click({ timeout: 4000 }).catch(() => { r.ok = false; r.why = 'click failed'; });
  await page.evaluate(() => document.querySelectorAll('[data-botpick],[data-botscope]').forEach((e) => { e.removeAttribute('data-botpick'); e.removeAttribute('data-botscope'); }));
  await sleep(800);
  return r;
}

async function addLeg(s, leg, i, tg) {
  const { page } = s;
  if (!['1X2', 'DC', 'OU', 'HA'].includes(leg.mk)) return { ok: false, why: 'market ' + leg.mk + ' is not supported by the bot' };
  let inp = await searchInput(page);
  if (!inp) { await goHome(page); inp = await searchInput(page); }
  if (!inp) { await shot(page, `${tg}_leg${i}_nosearch`); return { ok: false, why: 'no search box found' }; }
  await inp.fill('').catch(() => {});
  await inp.fill(keyTok(leg.home));
  await inp.press('Enter').catch(() => {});
  await sleep(2300);
  if (i === 0) await shot(page, `${tg}_leg0_search`);
  const scope = await openMatch(page, leg);
  if (!scope) { await shot(page, `${tg}_leg${i}_nomatch`); return { ok: false, why: 'match not found in BangBet search' }; }
  if (i === 0) await shot(page, `${tg}_leg0_match`);
  const r = await pickOdds(page, leg, scope);
  if (!r.ok) await shot(page, `${tg}_leg${i}_noprice`);
  // back to a page with the search box
  for (let k = 0; k < 2; k++) {
    if (await searchInput(page)) break;
    await page.goBack({ timeout: 8000 }).catch(() => {});
    await sleep(900);
  }
  return r;
}

async function share(s, tg) {
  const { page, net } = s;
  const out = { code: '', link: '' };
  for (const sel of ['[class*="slip" i]:visible', '[class*="cart" i]:visible']) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 2000 }); await sleep(1200); break; }
    } catch (e) { /* ignore */ }
  }
  await shot(page, `${tg}_91_slip`);
  const mark = net.length;
  const btns = [/book(ing)?\s*(a\s*)?bet/i, /booking\s*code/i, /generate\s*code/i, /share/i, /\bbook\b/i];
  for (const re of btns) {
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
  const c = hay.match(/[Cc]ode\s*[:\-]?\s*([A-Z0-9]{4,10})\b/);
  if (c) out.code = c[1];
  for (const r of net.slice(mark)) {
    walk(r.body, (o) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        if (/code/i.test(k) && /^[A-Za-z0-9]{4,10}$/.test(v) && !out.code) out.code = v.toUpperCase();
        if (/(link|url)/i.test(k) && /bangbet/i.test(v) && !out.link) out.link = v;
      }
    });
  }
  if (!out.link) {
    try {
      const cp = page.getByText(/copy/i).first();
      if (await cp.count()) {
        await cp.click({ timeout: 2000 }); await sleep(600);
        const clip = String(await page.evaluate(() => navigator.clipboard.readText()).catch(() => ''));
        const m = clip.match(/https?:\/\/\S+/);
        if (m) out.link = m[0];
        else if (!out.code && /^[A-Za-z0-9]{4,10}$/.test(clip.trim())) out.code = clip.trim().toUpperCase();
      }
    } catch (e) { /* ignore */ }
  }
  await shot(page, `${tg}_92_after_share`);
  return out;
}

async function book(inFile, outFile) {
  const input = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const result = { tickets: [] };
  const deadline = Date.now() + 9 * 60 * 1000;
  try {
    for (const t of input.tickets) {
      const tg = tag(t.key);
      const r = { key: t.key, ok: false, code: '', link: '', added: 0, total: 0, why: '', missing: [] };
      let s;
      try {
        s = await session();
        await goHome(s.page);
        await shot(s.page, `${tg}_00_home`);
        let total = 1;
        let fails = 0;
        for (let i = 0; i < t.legs.length; i++) {
          if (Date.now() > deadline) { r.missing.push('time ran out'); break; }
          const leg = t.legs[i];
          const res = await addLeg(s, leg, i, tg).catch((e) => ({ ok: false, why: 'error ' + e.message }));
          say(`leg ${i + 1}/${t.legs.length} ${leg.home} v ${leg.away} (${leg.mk} ${leg.sel}): ${res.ok ? 'added @' + res.odds : 'FAILED ' + res.why}`);
          if (res.ok) { r.added++; total *= res.odds; } else { r.missing.push(`${leg.home} v ${leg.away}: ${res.why}`); fails++; }
          if (fails >= 3) break; // it is all or nothing: no point going on
        }
        r.total = Math.round(total * 100) / 100;
        if (r.added === t.legs.length) {
          const sh = await share(s, tg);
          r.code = sh.code; r.link = sh.link;
          r.ok = !!(r.code || r.link);
          if (!r.ok) r.why = 'all matches were added but no code or link could be read after pressing share';
        } else {
          r.why = `${r.added} of ${t.legs.length} matches added. Missing: ${r.missing.slice(0, 3).join(' | ')}`;
        }
      } catch (e) {
        r.why = 'bot error: ' + e.message;
      } finally {
        if (s) await s.browser.close().catch(() => {});
      }
      say(`ticket ${t.key}: ${r.ok ? 'OK code ' + r.code + ' link ' + r.link : 'not booked: ' + r.why}`);
      result.tickets.push(r);
    }
  } finally {
    fs.writeFileSync(outFile, JSON.stringify(result));
  }
}

// a look at the site: the log lines show what the bot can see
async function discover() {
  const s = await session();
  try {
    await goHome(s.page);
    await shot(s.page, '01_home');
    const info = await s.page.evaluate(() => ({
      title: document.title,
      url: location.href,
      buttons: Array.from(document.querySelectorAll('button,a,[role=button]')).map((e) => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 40),
      inputs: Array.from(document.querySelectorAll('input')).map((i) => i.type + ':' + (i.placeholder || '')).slice(0, 10),
      priceCells: Array.from(document.querySelectorAll('*')).filter((e) => e.children.length <= 2 && /^\d{1,3}\.\d{2}$/.test((e.innerText || '').trim())).length,
      text: document.body.innerText.slice(0, 700).replace(/\s+/g, ' '),
    }));
    say('PAGE', JSON.stringify(info));
    const calls = s.net.map((n) => `${n.method} ${n.status} ${n.url.split('?')[0]}`);
    say('JSON calls (' + calls.length + '):', calls.slice(0, 25).join(' | '));
    let ev = 0;
    for (const n of s.net) ev += eventsFrom(n.body).length;
    say('matches found inside the site data: ' + ev);
    const inp = await searchInput(s.page);
    say('search box found: ' + !!inp);
    if (inp) {
      await inp.fill('Arsenal');
      await inp.press('Enter').catch(() => {});
      await sleep(2500);
      await shot(s.page, '02_search');
      say('SEARCH TEXT', (await s.page.evaluate(() => document.body.innerText.slice(0, 500))).replace(/\s+/g, ' '));
    }
    fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(s.net.map((n) => ({ url: n.url, status: n.status, method: n.method, keys: n.body && typeof n.body === 'object' ? Object.keys(n.body).slice(0, 12) : [] })), null, 1));
    fs.writeFileSync(path.join(OUT, 'home.html'), (await s.page.content()).slice(0, 400000));
  } finally {
    await s.browser.close().catch(() => {});
  }
}

(async () => {
  const [mode, a, b] = process.argv.slice(2);
  try {
    if (mode === 'discover') await discover();
    else if (mode === 'book') await book(a, b);
    else say('usage: node bot.js discover | node bot.js book in.json out.json');
  } catch (e) {
    say('fatal', e.stack || e.message);
    process.exitCode = 1;
  }
})();
