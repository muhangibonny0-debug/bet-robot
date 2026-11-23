'use strict';
// BangBet as a guest: finds matches, opens them. Never logs in, never places a bet.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  try {
    ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core'));
  } catch (e) {
    chromium = null;
  }
}
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

const SPORT_URL_INFO = {
  football: { seg: 'Football', sid: 'sr:sport:1' },
  basketball: { seg: 'Basketball', sid: 'sr:sport:2' },
  baseball: { seg: 'Baseball', sid: 'sr:sport:3' },
  hockey: { seg: 'Ice Hockey', sid: 'sr:sport:4' },
  tennis: { seg: 'Tennis', sid: 'sr:sport:5' },
};

// match rows found on the page: two team names, 2 to 7 decimal prices, and optional combined date/time ("22/11 19:30")
const ROWS_JS = () => {
  const priceRe = /^\d{1,3}\.\d{2}$/;
  const timeRe = /^\d{1,2}:\d{2}$/;
  const dtComboRe = /^(\d{1,2}[/. -]\d{1,2})\s+(\d{1,2}:\d{2})$/;
  const dateRe = /^(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*[ ,.]*(\d{1,2})?[ ,.]*([a-z]{3,9})?[ ,.]*(\d{4})?$|^\d{1,2}[/. -]\d{1,2}([/. -]\d{2,4})?$|^\d{1,2}\s+[A-Za-z]{3,9}(\s+\d{4})?$/i;
  const noiseRe = /^(live|stats?|1x2|h2h|vs|best odds|follow the team|\+\d+\s*(markets?|predictions?)?)$/i;
  const els = Array.from(document.querySelectorAll('a,li,div,section,article'));
  const cand = [];
  for (const el of els) {
    const raw = (el.innerText || '').trim();
    if (raw.length < 8 || raw.length > 320) continue;
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const prices = lines.filter((l) => priceRe.test(l));
    if (prices.length < 2 || prices.length > 7) continue;
    const words = lines.filter((l) =>
      !priceRe.test(l) && !timeRe.test(l) && !dtComboRe.test(l) && !dateRe.test(l) &&
      /[A-Za-z]{2,}/.test(l) && l.length < 48 && !noiseRe.test(l) && !/ - /.test(l));
    if (words.length < 2) continue;
    cand.push({ el, lines, prices, words });
  }
  const keep = cand.filter((c) => !cand.some((o) => o !== c && c.el.contains(o.el)));
  const heads = [];
  for (const el of els) {
    const t = (el.innerText || '').trim();
    if (t.length < 3 || t.length > 75 || t.includes('\n') || priceRe.test(t) || el.children.length > 2) continue;
    const cls = String(el.className || '');
    if (/league|compet|tourn|categ|country|header|title|group|date|day/i.test(cls) || /^H[1-6]$/.test(el.tagName) || / - /.test(t)) {
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
    const combo = c.lines.map((l) => dtComboRe.exec(l)).find(Boolean);
    const dateVal = combo ? combo[1] : (c.lines.find((l) => dateRe.test(l)) || dt);
    const timeVal = combo ? combo[2] : (c.lines.find((l) => timeRe.test(l)) || '');
    const leagueLine = c.lines.find((l) => / - /.test(l) && !noiseRe.test(l)) || lg;
    const a = c.el.closest('a') || c.el.querySelector('a');
    rows.push({
      i, home: c.words[0], away: c.words[1], odds: c.prices.map(Number),
      time: timeVal, date: dateVal,
      league: leagueLine, href: a ? a.href : '',
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
    if (!t || t.length > 420 || !t.includes(h) || !t.includes(a)) continue;
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

// matches found inside the site's own JSON answers (e.g. /api/bet/match/list)
function eventsFromNet(net, sport = 'football') {
  const out = [];
  const spInfo = SPORT_URL_INFO[sport] || SPORT_URL_INFO.football;
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
      const kId = ks.find((k) => /^(matchid|eventid|id|gameid|fixtureid|event_id|match_id)$/i.test(k));
      const kL = ks.find((k) => /(league|competition|tournament)(name)?$/i.test(k) && strOf(o[k]));
      const kC = ks.find((k) => /(country|region|nation|category)(name)?$/i.test(k) && strOf(o[k]));
      const id = kId ? String(o[kId]) : '';
      const sportId = typeof o.sportId === 'string' ? o.sportId : spInfo.sid;
      const producer = o.producer != null ? String(o.producer) : '3';
      const url = /^sr:match:\d+$/i.test(id)
        ? `https://www.bangbet.com/ug-m/sport/${encodeURIComponent(spInfo.seg)}/match?matchId=${encodeURIComponent(id)}&sportId=${encodeURIComponent(sportId)}&producer=${encodeURIComponent(producer)}`
        : '';
      out.push({
        home, away, ts: kT ? tsOf(o[kT]) : 0, id,
        league: kL ? strOf(o[kL]) : '', country: kC ? strOf(o[kC]) : '', url,
      });
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
  constructor() {
    this.browser = null; this.ctx = null; this.notes = [];
    this.apis = new Set(); this.discovery = {};
    this.blockedRequests = 0;
  }

  async start(opts = {}) {
    if (!chromium) throw new Error('Playwright browser runtime is not installed.');
    const opt = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.CHROME_PATH) opt.executablePath = process.env.CHROME_PATH;
    const proxyServer = opts.proxyServer || process.env.BOT_PROXY || '';
    if (proxyServer) opt.proxy = { server: proxyServer };
    this.browser = await chromium.launch(opt);
    this.ctx = await this.browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      locale: 'en-UG', timezoneId: 'Africa/Kampala', permissions: ['clipboard-read', 'clipboard-write'],
    });
    // Mobile data optimization: block unnecessary heavy media/images/fonts/trackers/ads
    // while ALWAYS allowing required scripts, APIs, HTML, and Sportradar/BangBet statistics widgets.
    if (opts.optimizeData !== false) {
      const blockedDomains = /(adjust\.com|zendesk\.com|zdassets\.com|googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.net|connect\.facebook|hotjar\.com|tiktok\.com|sentry\.io|firebaseinstallations\.googleapis\.com|googlesyndication\.com)/i;
      const blockedTypes = new Set(['image', 'media', 'font']);
      await this.ctx.route('**/*', (route) => {
        const req = route.request();
        const rtype = req.resourceType();
        const url = req.url();
        if (blockedTypes.has(rtype) || blockedDomains.test(url)) {
          this.blockedRequests++;
          return route.abort().catch(() => {});
        }
        return route.continue().catch(() => {});
      });
    }
  }

  async close() { if (this.browser) await this.browser.close().catch(() => {}); }

  async newPage() {
    const page = await this.ctx.newPage();
    page.net = [];
    page.pendingMatchList = 0;
    page.lastMatchListEmpty = false;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('request', (req) => {
      if (/\/api\/bet\/match\/list/i.test(req.url())) page.pendingMatchList++;
    });
    page.on('requestfinished', (req) => {
      if (/\/api\/bet\/match\/list/i.test(req.url())) page.pendingMatchList = Math.max(0, page.pendingMatchList - 1);
    });
    page.on('requestfailed', (req) => {
      if (/\/api\/bet\/match\/list/i.test(req.url())) page.pendingMatchList = Math.max(0, page.pendingMatchList - 1);
    });
    page.on('response', async (res) => {
      try {
        if (!(res.headers()['content-type'] || '').includes('json')) return;
        const txt = await res.text();
        if (txt.length > 3e6) return;
        const body = JSON.parse(txt);
        page.net.push({ url: res.url(), body });
        this.apis.add(res.url().split('?')[0]);
        if (/\/api\/bet\/match\/list/i.test(res.url())) {
          const arr = (body && body.data && (body.data.data || body.data.list || body.data.matches)) || (Array.isArray(body && body.data) ? body.data : null);
          if (Array.isArray(arr)) page.lastMatchListEmpty = arr.length === 0;
        }
      } catch (e) { /* not json */ }
    });
    return page;
  }

  async shot(page, name) {
    await page.screenshot({ path: path.join(OUT, name.replace(/[^a-z0-9_-]/gi, '_') + '.png') }).catch(() => {});
  }

  async dismiss(page) {
    for (const s of ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("I agree")',
      'button:has-text("Later")', 'button:has-text("Not now")', '[aria-label="Close" i]', '[class*="close" i]']) {
      try {
        const el = page.locator(s).first();
        if ((await el.count()) && (await el.isVisible())) { await el.click({ timeout: 1200, force: true }); await sleep(300); }
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
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await sleep(1600);
    await this.dismiss(page);
    const b = await this.blocked(page);
    if (b) this.notes.push(`BangBet shows a block or check page ("${b}") to this server`);
  }

  // Fast, readiness-driven loader for individual match pages: avoids 20s networkidle stalls on analytics sockets
  // and waits specifically for BangBet's Markets/Stats tabs to render.
  async loadMatch(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await Promise.race([
      page.getByText(/^markets$/i).first().waitFor({ state: 'visible', timeout: 8000 }),
      page.getByText(/^stats/i).first().waitFor({ state: 'visible', timeout: 8000 }),
    ]).catch(() => {});
    await sleep(500);
    const b = await this.blocked(page);
    if (b) this.notes.push(`BangBet shows a block or check page ("${b}") to this server`);
  }

  async clickText(page, re) {
    const loc = page.getByText(re);
    const n = Math.min(await loc.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const ok = await el.click({ timeout: 5000, force: true }).then(() => true).catch(() => false);
        if (ok) return true;
      }
    }
    return false;
  }

  async goSport(page, sport) {
    await this.load(page, SITE);
    const re = SPORT_RE[sport];
    await page.getByText(re).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await this.dismiss(page);

    const hasTime = async () => page.getByText(/^time$/i).first().isVisible().catch(() => false);
    const isListing = () => /\/sports?\//i.test(page.url()) && !/\/match\b/i.test(page.url());
    const tryClickSport = async () => {
      const loc = page.getByText(re);
      const n = Math.min(await loc.count().catch(() => 0), 4);
      for (let i = 0; i < n; i++) {
        if (isListing() && await hasTime()) return true;
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        // Only click top sport menu icons (y < 240) so we never click Top Matches pills or Live tabs
        const box = await el.boundingBox().catch(() => null);
        if (box && box.y > 240) continue;
        page.net.splice(0);
        await el.click({ timeout: 6000, force: true }).catch(() => {});
        await page.getByText(/^time$/i).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
        if (await hasTime()) return true;
        if (isListing()) {
          await page.getByText(/^time$/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          if (await hasTime()) return true;
          return false;
        }
      }
      return false;
    };

    if (await tryClickSport()) { await sleep(1200); return true; }
    // Direct fallback to BangBet's public /sports/<Sport> listing route
    const info = SPORT_URL_INFO[sport];
    if (info) {
      page.net.splice(0);
      await this.load(page, `https://www.bangbet.com/sports/${encodeURIComponent(info.seg)}`);
      await page.getByText(/^time$/i).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      if (await hasTime()) return true;
    }
    say('goSport failed; URL=', page.url());
    return false;
  }

  async _scrollDown(page) {
    return page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'))
        .filter((e) => e.scrollHeight > e.clientHeight + 80)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      let moved = false;
      if (els.length) {
        const before = els[0].scrollTop;
        els[0].scrollTop += Math.max(600, els[0].clientHeight * 0.9);
        moved = els[0].scrollTop > before;
      }
      const wy = window.scrollY;
      window.scrollBy(0, Math.round(innerHeight * 0.9));
      return moved || window.scrollY > wy;
    }).catch(() => false);
  }

  // Maps a specific calendar date or range to the BangBet Time menu tab that covers it.
  effectiveScope(scope, req) {
    if (scope !== 'date' && scope !== 'range') return scope;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const parseYmd = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
    };
    const endStr = scope === 'date' ? (req && req.date) : (req && req.dateTo);
    const startStr = scope === 'date' ? (req && req.date) : (req && req.dateFrom);
    const startMs = parseYmd(startStr);
    const endMs = parseYmd(endStr || startStr);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'all';
    const diffStart = Math.round((startMs - todayStart) / 86400000);
    const diffEnd = Math.round((endMs - todayStart) / 86400000);
    if (diffStart === 0 && diffEnd === 0) return 'today';
    if (diffStart === 1 && diffEnd === 1) return 'tomorrow';
    if (diffEnd <= 3) return 'next3days';
    if (diffEnd <= 7) return 'next7days';
    return 'all';
  }

  // BangBet's Time bottom sheet owns date/period selection:
  // All, Next 3 Hours, Next 6 Hours, Today, Tomorrow, Next 3 Days, Next 7 Days, This Weekend.
  async selectScope(page, scope, req = null) {
    const targetScope = this.effectiveScope(scope, req);
    const choices = {
      all: [/^all$/i, /^all\s*dates?$/i],
      next3hours: [/^next\s*3\s*hours?$/i, /^today$/i],
      next6hours: [/^next\s*6\s*hours?$/i, /^today$/i],
      today: [/^today$/i],
      tomorrow: [/^tomorrow$/i],
      next3days: [/^next\s*3\s*days?$/i, /^next\s*three\s*days?$/i, /^3\s*days?$/i],
      next7days: [/^next\s*7\s*days?$/i, /^next\s*seven\s*days?$/i, /^7\s*days?$/i, /^week$/i],
      week: [/^next\s*7\s*days?$/i, /^next\s*seven\s*days?$/i, /^7\s*days?$/i, /^week$/i],
      weekend: [/^this\s*weekend$/i, /^weekend$/i],
    };
    const wanted = choices[targetScope] || choices.today;
    const time = page.getByText(/^time$/i);
    let opened = false;
    const count = Math.min(await time.count().catch(() => 0), 5);
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      for (let i = 0; i < count; i++) {
        const item = time.nth(i);
        if (await item.isVisible().catch(() => false)) {
          await item.click({ timeout: 5000, force: true }).catch(() => {});
          await page.getByText(/^tomorrow$/i).first().waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
          if (await page.getByText(/^tomorrow$/i).first().isVisible().catch(() => false)) {
            opened = true;
            break;
          }
        }
      }
      if (!opened) await sleep(800);
    }
    if (!opened) throw new Error('BangBet Time selector was not found; no fixture scan was started.');
    await sleep(500);
    for (const re of wanted) {
      await page.getByText(re).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      page.net.splice(0);
      if (await this.clickText(page, re)) {
        await sleep(1600);
        say('BangBet Time period selected:', targetScope, scope !== targetScope ? `(for ${scope})` : '');
        return true;
      }
    }
    if (targetScope === 'all') {
      say('Time option "all" not directly matched; proceeding with current view.');
      return false;
    }
    throw new Error(`BangBet Time option "${targetScope}" was not found; no fixture scan was started.`);
  }

  // Opens a persistent listing tab for target-driven incremental batch discovery (no artificial match-count cap).
  async openListing(sport, req) {
    const page = await this.newPage();
    if (!(await this.goSport(page, sport))) {
      await page.close().catch(() => {});
      throw new Error(`${sport}: the sport was not found in the BangBet menu`);
    }
    await this.selectScope(page, req.scope, req);
    await this.shot(page, `discover_${sport}_selected_time`);
    return { sport, page, seen: new Map(), exhausted: false, still: 0, passes: 0, stopReason: '' };
  }

  // Harvests the next batch of unique fixtures from an open listing tab via DOM + network + progressive scrolling.
  // Has NO artificial fixture-count ceiling: stops only when batchTarget is collected (for target-driven inspection),
  // when the listing is genuinely exhausted, or when the execution deadline is reached.
  async collectNextBatch(listing, deadline, batchTarget = 30) {
    const { page, seen, sport } = listing;
    const fresh = [];
    const add = (e) => {
      if (!e.home || !e.away) return false;
      const k = `${norm(e.home)}|${norm(e.away)}`;
      const existing = seen.get(k);
      if (!existing) {
        const item = { sport, ...e, source: e.source || 'dom' };
        seen.set(k, item);
        fresh.push(item);
        return true;
      }
      for (const f of ['ts', 'id', 'league', 'country', 'url']) {
        if (!existing[f] && e[f]) existing[f] = e[f];
      }
      if (e.source && existing.source && existing.source !== e.source && !existing.source.includes(e.source)) {
        existing.source = 'dom+network';
      }
      if ((!existing.odds || !existing.odds.length) && e.odds && e.odds.length) existing.odds = e.odds;
      return false;
    };

    while (Date.now() < deadline && !listing.exhausted && fresh.length < batchTarget) {
      listing.passes++;
      let addedThisPass = 0;
      const rows = await page.evaluate(ROWS_JS).catch(() => []);
      for (const r of rows) {
        const parts = String(r.league || '').split(/\s*[·\-|>/]\s*/).filter(Boolean);
        if (add({
          home: r.home, away: r.away, ts: parseWhen(r.date, r.time), id: '', url: r.href || '',
          league: parts.length ? parts[parts.length - 1] : '', country: parts.length > 1 ? parts[0] : '',
          odds: r.odds || [], source: 'dom',
        })) {
          addedThisPass++;
        }
      }
      for (const e of eventsFromNet(page.net.splice(0), sport)) {
        if (add({ ...e, odds: [], source: 'network' })) {
          addedThisPass++;
        }
      }
      if (fresh.length >= batchTarget) break;

      if (addedThisPass === 0) {
        // Never count a pass as "still" while BangBet's match/list API request is still in flight
        if (page.pendingMatchList > 0) {
          await sleep(1200);
          continue;
        }
        listing.still++;
        if (listing.still === 1 || listing.still === 2) {
          const clickedMore = await this.clickText(page, /^(load\s*more|show\s*more|more\s*matches|more\s*events|view\s*more)$/i);
          if (clickedMore) {
            await sleep(1200);
            continue;
          }
        }
      } else {
        listing.still = 0;
        page.lastMatchListEmpty = false;
      }

      const moved = await this._scrollDown(page);
      await page.mouse.wheel(0, 1000).catch(() => {});
      // Progressive backoff when no new fixtures appeared so slow network batches are never mistaken for exhaustion
      const waitMs = listing.still === 0 ? 850 : (listing.still <= 2 ? 1200 : (listing.still <= 4 ? 1800 : 2400));
      await sleep(waitMs);

      // Genuine exhaustion: API confirmed empty page, OR 6 consecutive idle passes with no pending requests & no scroll movement
      if (page.lastMatchListEmpty && page.pendingMatchList === 0 && listing.still >= 2) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
      if (page.pendingMatchList === 0 && listing.still >= 6 && !moved) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
      // Safety if page is virtualized/non-scrollable and 9 consecutive idle passes with no pending requests yield nothing
      if (page.pendingMatchList === 0 && listing.still >= 9) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
    }

    if (Date.now() >= deadline && !listing.exhausted) {
      listing.stopReason = 'deadline';
    }
    this.discovery[sport] = {
      discovered: seen.size,
      exhausted: listing.exhausted,
      stopReason: listing.stopReason || 'batch',
      passes: listing.passes,
    };
    return fresh;
  }

  // Full discovery across all requested sports with NO artificial match-count cap.
  async discover(req, deadline) {
    const all = [];
    for (const sport of req.sports) {
      if (Date.now() > deadline) break;
      let listing = null;
      try {
        listing = await this.openListing(sport, req);
        while (Date.now() < deadline && !listing.exhausted) {
          await this.collectNextBatch(listing, deadline, 60);
        }
        await this.shot(listing.page, `discover_${sport}_fixtures`);
        all.push(...listing.seen.values());
        say(`${sport}: ${listing.seen.size} fixtures discovered for ${req.scope} (exhausted=${listing.exhausted})`);
      } catch (e) {
        this.notes.push(`${sport}: ${e.message}`);
      } finally {
        if (listing && listing.page) await listing.page.close().catch(() => {});
      }
    }
    return all;
  }

  // opens a match: by its own address, or by finding its row again and clicking it
  async openEvent(page, ev, scope = 'today', req = null) {
    const verified = async (strict = false) => {
      const body = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      const t = norm(body);
      const hasHome = t.includes(keyTok(ev.home));
      const hasAway = t.includes(keyTok(ev.away));
      const hasTabs = /markets?/i.test(body);
      return strict ? (hasHome && hasAway && hasTabs) : ((hasHome || hasAway) && hasTabs);
    };
    if (ev.url && /^https?:/.test(ev.url)) {
      try {
        await this.loadMatch(page, ev.url);
        if (await verified(false)) return true;
        await sleep(1200);
        if (await verified(false)) return true;
        this.notes.push(`Fixture URL did not verify as ${ev.home} v ${ev.away}`);
      } catch (e) {
        this.notes.push(`Could not load ${ev.home} v ${ev.away}: ${e.message}`);
      }
    }
    if (!(await this.goSport(page, ev.sport))) return false;
    await this.selectScope(page, scope, req);
    const h = keyTok(ev.home);
    const a = keyTok(ev.away);
    let still = 0;
    while (still < 6) {
      const found = await page.evaluate(FIND_JS, { h, a }).catch(() => false);
      if (found) {
        await page.locator('[data-bbgo="1"]').first().click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(2500);
        return await verified();
      }
      const moved = await this._scrollDown(page);
      await page.mouse.wheel(0, 900).catch(() => {});
      await sleep(700);
      still = moved ? 0 : still + 1;
    }
    return false;
  }
}

module.exports = { Site, parseWhen, eventsFromNet, SITE, OUT };
