'use strict';
// BangBet as a guest: finds matches, opens them. Never logs in, never places a bet.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { sleep, norm, keyTok, walk } = require('./util');

const SITE = process.env.BANGBET_URL || 'https://www.bangbet.com/ug-m';
const OUT = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const say = (...a) => console.log('[site]', ...a);

const SPORT_RE = {
  football: /^(football|soccer)$/i,
  basketball: /^basketball$/i,
  tennis: /^tennis$/i,
  baseball: /^baseball$/i,
  hockey: /^(ice hockey|hockey)$/i,
};

// match rows found on the page: two names and 2 to 7 prices
const ROWS_JS = () => {
  const priceRe = /^\d{1,3}\.\d{2}$/;
  const timeRe = /^\d{1,2}:\d{2}$/;
  const dateRe = /^(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*[ ,.]*(\d{1,2})?[ ,.]*([a-z]{3,9})?[ ,.]*(\d{4})?$|^\d{1,2}[/. -]\d{1,2}([/. -]\d{2,4})?$|^\d{1,2}\s+[A-Za-z]{3,9}(\s+\d{4})?$/i;
  const els = Array.from(document.querySelectorAll('a,li,div,section,article'));
  const cand = [];
  for (const el of els) {
    const raw = (el.innerText || '').trim();
    if (raw.length < 8 || raw.length > 280) continue;
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const prices = lines.filter((l) => priceRe.test(l));
    if (prices.length < 2 || prices.length > 7) continue;
    const words = lines.filter((l) => !priceRe.test(l) && !timeRe.test(l) && !dateRe.test(l) &&
      /[A-Za-z]{3,}/.test(l) && l.length < 45 && !/^(live|stats?|1x2|h2h|\+\d+)$/i.test(l));
    if (words.length < 2) continue;
    cand.push({ el, lines, prices, words });
  }
  const keep = cand.filter((c) => !cand.some((o) => o !== c && c.el.contains(o.el)));
  const heads = [];
  for (const el of els) {
    const t = (el.innerText || '').trim();
    if (t.length < 3 || t.length > 70 || t.includes('\n') || priceRe.test(t) || el.children.length > 2) continue;
    const cls = String(el.className || '');
    if (/league|compet|tourn|categ|country|header|title|group|date|day/i.test(cls) || /^H[1-6]$/.test(el.tagName)) {
      heads.push({ t, y: el.getBoundingClientRect().top + scrollY, date: dateRe.test(t) });
    }
  }
  heads.sort((a, b) => a.y - b.y);
  const rows = [];
  keep.forEach((c, i) => {
    const y = c.el.getBoundingClientRect().top + scrollY;
    let lg = '';
    let dt = '';
    for (const h of heads) { if (h.y > y) break; if (h.date) dt = h.t; else lg = h.t; }
    const a = c.el.closest('a') || c.el.querySelector('a');
    rows.push({
      i, home: c.words[0], away: c.words[1], odds: c.prices.map(Number),
      time: c.lines.find((l) => timeRe.test(l)) || '', date: c.lines.find((l) => dateRe.test(l)) || dt,
      league: lg, href: a ? a.href : '',
    });
  });
  return rows;
};

// finds a match row by two distinctive words and marks the part to click
const FIND_JS = ({ h, a }) => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const priceRe = /^\d{1,3}\.\d{2}$/;
  let best = null;
  let len = 1e9;
  for (const el of document.querySelectorAll('a,li,div,section,article')) {
    const t = norm(el.innerText);
    if (!t || t.length > 400 || !t.includes(h) || !t.includes(a)) continue;
    const prices = (el.innerText || '').split('\n').filter((l) => priceRe.test(l.trim())).length;
    if (prices < 2) continue;
    if (t.length < len) { best = el; len = t.length; }
  }
  if (!best) return false;
  document.querySelectorAll('[data-bbgo]').forEach((e) => e.removeAttribute('data-bbgo'));
  let target = best;
  for (const el of best.querySelectorAll('*')) {
    const t = norm(el.innerText);
    if (t && t.includes(h) && !/\d\.\d\d/.test(t) && el.children.length === 0) { target = el; break; }
  }
  target.setAttribute('data-bbgo', '1');
  return true;
};

const strOf = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return strOf(v.name || v.title || v.teamName || v.shortName);
  return '';
};
const tsOf = (v) => {
  if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : 0);
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isNaN(n) ? 0 : n; }
  return 0;
};

// matches found inside the site's own JSON answers
function eventsFromNet(net) {
  const out = [];
  for (const r of net) {
    walk(r.body, (o) => {
      const ks = Object.keys(o);
      const kH = ks.find((k) => /^(home|hometeam|home_team|homename|hometeamname|team1|host|participant1|competitor1)$/i.test(k));
      const kA = ks.find((k) => /^(away|awayteam|away_team|awayname|awayteamname|team2|guest|participant2|competitor2)$/i.test(k));
      let home = kH ? strOf(o[kH]) : '';
      let away = kA ? strOf(o[kA]) : '';
      const arr = o.competitors || o.teams || o.participants;
      if ((!home || !away) && Array.isArray(arr) && arr.length === 2) { home = strOf(arr[0]); away = strOf(arr[1]); }
      if (!home || !away || home === away) return;
      const kT = ks.find((k) => /(time|date|ts|timestamp)$/i.test(k) && tsOf(o[k]));
      const kId = ks.find((k) => /^(id|eventid|matchid|gameid|fixtureid|event_id|match_id)$/i.test(k));
      const kL = ks.find((k) => /(league|competition|tournament)(name)?$/i.test(k) && strOf(o[k]));
      const kC = ks.find((k) => /(country|region|nation|category)(name)?$/i.test(k) && strOf(o[k]));
      out.push({ home, away, ts: kT ? tsOf(o[kT]) : 0, id: kId ? String(o[kId]) : '',
        league: kL ? strOf(o[kL]) : '', country: kC ? strOf(o[kC]) : '', url: '' });
    });
  }
  return out;
}

function parseWhen(dateText, timeText) {
  const tm = /(\d{1,2}):(\d{2})/.exec(timeText || '');
  if (!tm) return 0;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const t = String(dateText || '').toLowerCase();
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  if (/tomorrow/.test(t)) d.setDate(d.getDate() + 1);
  else if (t && !/today/.test(t)) {
    const m = /(\d{1,2})\s*([a-z]{3})/.exec(t);
    const m2 = /([a-z]{3})[a-z]*\s*(\d{1,2})/.exec(t);
    const m3 = /(\d{1,2})[/. -](\d{1,2})/.exec(t);
    if (m && mon.includes(m[2])) d.setMonth(mon.indexOf(m[2]), +m[1]);
    else if (m2 && mon.includes(m2[1])) d.setMonth(mon.indexOf(m2[1]), +m2[2]);
    else if (m3) d.setMonth(+m3[2] - 1, +m3[1]);
    else {
      const w = wd.findIndex((x) => t.startsWith(x));
      if (w >= 0) d.setDate(d.getDate() + ((w - d.getDay() + 7) % 7));
    }
    if (d.getTime() < Date.now() - 200 * 86400000) d.setFullYear(d.getFullYear() + 1);
  }
  d.setHours(+tm[1], +tm[2], 0, 0);
  return d.getTime();
}

class Site {
  constructor() { this.browser = null; this.ctx = null; this.notes = []; this.apis = new Set(); }

  async start() {
    const opt = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.BOT_PROXY) opt.proxy = { server: process.env.BOT_PROXY };
    this.browser = await chromium.launch(opt);
    this.ctx = await this.browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      locale: 'en-UG', timezoneId: 'Africa/Kampala', permissions: ['clipboard-read', 'clipboard-write'],
    });
  }

  async close() { if (this.browser) await this.browser.close().catch(() => {}); }

  async newPage() {
    const page = await this.ctx.newPage();
    page.net = [];
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('response', async (res) => {
      try {
        if (!(res.headers()['content-type'] || '').includes('json')) return;
        const txt = await res.text();
        if (txt.length > 3e6) return;
        page.net.push({ url: res.url(), body: JSON.parse(txt) });
        this.apis.add(res.url().split('?')[0]);
        if (page.net.length > 200) page.net.shift();
      } catch (e) { /* not json */ }
    });
    return page;
  }

  async shot(page, name) {
    await page.screenshot({ path: path.join(OUT, name.replace(/[^a-z0-9_-]/gi, '_') + '.png') }).catch(() => {});
  }

  async dismiss(page) {
    for (const s of ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("I agree")',
      'button:has-text("Later")', 'button:has-text("Not now")', '[aria-label="Close" i]']) {
      try {
        const el = page.locator(s).first();
        if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 800 }); await sleep(300); }
      } catch (e) { /* ignore */ }
    }
  }

  async blocked(page) {
    const t = (await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 600) : '')).catch(() => '')).toLowerCase();
    return ['captcha', 'verify you are human', 'access denied', 'forbidden', 'not available in your country',
      'attention required', 'unusual traffic'].find((k) => t.includes(k)) || '';
  }

  async load(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(2200);
    await this.dismiss(page);
    const b = await this.blocked(page);
    if (b) this.notes.push(`BangBet shows a block or check page ("${b}") to this server`);
  }

  async clickText(page, re) {
    const loc = page.getByText(re);
    const n = Math.min(await loc.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2500 }).catch(() => {});
        return true;
      }
    }
    return false;
  }

  async goSport(page, sport) {
    await this.load(page, SITE);
    if (await this.clickText(page, SPORT_RE[sport])) { await sleep(2000); return true; }
    for (const s of ['[aria-label*="menu" i]', '[class*="burger" i]', '[class*="menu" i]']) {
      try {
        const el = page.locator(s).first();
        if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 1500 }); await sleep(900); break; }
      } catch (e) { /* ignore */ }
    }
    if (await this.clickText(page, SPORT_RE[sport])) { await sleep(2000); return true; }
    return false;
  }

  // scrolls the list and collects every match row and every match found in the site's JSON
  async collect(page, add) {
    let lastH = 0;
    let still = 0;
    for (let i = 0; i < 40; i++) {
      const rows = await page.evaluate(ROWS_JS).catch(() => []);
      for (const r of rows) {
        const parts = String(r.league || '').split(/\s*[·\-|>/]\s*/).filter(Boolean);
        add({ home: r.home, away: r.away, ts: parseWhen(r.date, r.time), id: '', url: r.href || '',
          league: parts.length ? parts[parts.length - 1] : '', country: parts.length > 1 ? parts[0] : '', odds: r.odds || [] });
      }
      for (const e of eventsFromNet(page.net.splice(0))) add({ ...e, odds: [] });
      const h = await page.evaluate(() => { window.scrollBy(0, Math.round(innerHeight * 0.9)); return document.body.scrollHeight; }).catch(() => 0);
      await page.mouse.wheel(0, 900).catch(() => {});
      await sleep(850);
      if (h === lastH) { if (++still >= 4) break; } else still = 0;
      lastH = h;
    }
  }

  async discover(req, deadline) {
    const all = [];
    for (const sport of req.sports) {
      if (Date.now() > deadline) break;
      const page = await this.newPage();
      const seen = new Map();
      const add = (e) => {
        if (!e.home || !e.away) return;
        const k = `${norm(e.home)}|${norm(e.away)}`;
        const o = seen.get(k);
        if (!o) { seen.set(k, { sport, ...e }); return; }
        for (const f of ['ts', 'id', 'league', 'country', 'url']) if (!o[f]) o[f] = e[f] || o[f];
        if ((!o.odds || !o.odds.length) && e.odds && e.odds.length) o.odds = e.odds;
      };
      try {
        if (!(await this.goSport(page, sport))) this.notes.push(`${sport}: the sport was not found in the BangBet menu`);
        await this.shot(page, `discover_${sport}_1`);
        await this.collect(page, add);
        for (const re of [/^today$/i, /^tomorrow$/i]) {
          if (await this.clickText(page, re)) { await sleep(1500); await this.collect(page, add); }
        }
        if (['week','weekend','next3days','next7days'].includes(req.scope)) {
          const labels = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
            .filter((e) => e.children.length === 0).map((e) => (e.innerText || '').trim())
            .filter((t) => t.length < 20 && /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[ .,]*\d{1,2}/i.test(t))).catch(() => []);
          for (const lb of [...new Set(labels)].slice(0, 8)) {
            const re = new RegExp('^' + lb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
            if (await this.clickText(page, re)) { await sleep(1500); await this.collect(page, add); }
          }
        }
        await this.shot(page, `discover_${sport}_2`);
      } catch (e) {
        this.notes.push(`${sport}: discovery error ${e.message}`);
      } finally {
        await page.close().catch(() => {});
      }
      all.push(...seen.values());
      say(`${sport}: ${seen.size} matches discovered`);
    }
    return all;
  }

  // opens a match: by its own address, or by finding its row again and clicking it
  async openEvent(page, ev) {
    if (ev.url && /^https?:/.test(ev.url)) { await this.load(page, ev.url); return true; }
    if (!(await this.goSport(page, ev.sport))) return false;
    const h = keyTok(ev.home);
    const a = keyTok(ev.away);
    for (let i = 0; i < 22; i++) {
      const found = await page.evaluate(FIND_JS, { h, a }).catch(() => false);
      if (found) {
        await page.locator('[data-bbgo="1"]').first().click({ timeout: 4000 }).catch(() => {});
        await sleep(2500);
        return true;
      }
      await page.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 0.9))).catch(() => {});
      await page.mouse.wheel(0, 900).catch(() => {});
      await sleep(700);
    }
    return false;
  }
}

module.exports = { Site, parseWhen, SITE, OUT };
