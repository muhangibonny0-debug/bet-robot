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
const { sleep, norm, keyTok, walk, sameTeam } = require('./util');
const { GismoCache, GismoPageObserver } = require('./gismo');
const { resolveDateScope } = require('./dates');

const TEAM_ALIASES = {
  psg: 'paris saint germain',
  psv: 'psv eindhoven',
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  inter: 'inter milano',
  'inter milan': 'inter milano',
  atletico: 'atletico madrid',
  leverkusen: 'bayer leverkusen',
  dortmund: 'borussia dortmund',
  leipzig: 'rb leipzig',
  stuttgart: 'vfb stuttgart',
  barcelona: 'fc barcelona',
  bayern: 'bayern munich',
  liverpool: 'liverpool fc',
  villarreal: 'villarreal cf',
  lille: 'lille osc',
  dinamo: 'dinamo zagreb',
  spurs: 'tottenham hotspur',
  wolves: 'wolverhampton wanderers',
  athletic: 'athletic bilbao',
  feyenoord: 'feyenoord rotterdam',
  celta: 'celta vigo',
};

function canonicalTeam(name) {
  const n = norm(name);
  return TEAM_ALIASES[n] || n;
}

const CLUB_PREFIX_STRIP = new Set([
  'fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'bk', 'nk', 'hnk', 'pfc', 'rsc', 'tsg',
  'rc', 'cs', 'vv', 'sv', 'cd', 'ud', 'sd', 'ca', 'ac', 'as', 'ss', 'us', 'cp',
  'if', 'srl', 'ofi', 'gnk', 'sl', 'kks', 'azs', 'zkk', 'de', 'the', 'club',
]);

function stripClubPrefixes(name) {
  return norm(name).split(' ').filter((w) => w && !CLUB_PREFIX_STRIP.has(w)).join(' ');
}

function teamsMatchLoosely(a, b) {
  if (!a || !b) return false;
  if (sameTeam(a, b)) return true;
  const ca = canonicalTeam(a);
  const cb = canonicalTeam(b);
  if (ca === cb) return true;
  if (ca.length >= 4 && cb.length >= 4 && (ca.includes(cb) || cb.includes(ca))) return true;
  // Match after stripping standard club prefixes/fill words ("RC Celta de Vigo" <-> "Celta Vigo")
  const sa = stripClubPrefixes(ca);
  const sb = stripClubPrefixes(cb);
  if (sa.length >= 4 && sb.length >= 4 && (sa === sb || sa.includes(sb) || sb.includes(sa))) return true;
  // Match short 3-letter acronyms like "psv" <-> "psv eindhoven" or "aek" <-> "aek athens"
  if (ca.length >= 3 && cb.split(' ')[0] === ca) return true;
  if (cb.length >= 3 && ca.split(' ')[0] === cb) return true;
  return false;
}

function extractNumericMatchId(idOrUrl) {
  const s = decodeURIComponent(String(idOrUrl || ''));
  const m = s.match(/sr:match:(\d+)/i) || s.match(/matchId=(\d+)/i);
  return m ? Number(m[1]) : 0;
}

const VIRTUAL_TEXT_RE = /\b(srl|simulated\s+reality|virtual|e-?football|e-?soccer|esports?|cyber|instant\s+league|league\s+mode|london\s+guns|manchester\s+(?:reds|blue)|madrid\s+(?:white|red))\b/i;
const VIRTUAL_PREFIX_RE = /\bvl\s+[a-z]/i;
const VIRTUAL_ID_RE = /^(vf|vfl|vbl|vfc|vti|vbi|sr:v)/i;

function isVirtualOrNonRealFixture(ev) {
  if (!ev) return true;
  if (ev.isVirtual === true) return true;
  const id = String(ev.id || '').trim();
  const sportId = String(ev.sportId || '').trim();
  if (id && VIRTUAL_ID_RE.test(id)) return true;
  if (sportId && (VIRTUAL_ID_RE.test(sportId) || !/^sr:sport:[1-5]$/i.test(sportId))) return true;
  const text = `${ev.country || ''} ${ev.league || ''} ${ev.home || ''} ${ev.away || ''}`;
  if (VIRTUAL_TEXT_RE.test(text) || VIRTUAL_PREFIX_RE.test(text)) return true;
  // Network-sourced BangBet fixtures that lack a real Sportradar sr:match:<id> and match URL
  // (e.g. BangBet virtual Bundesliga / Champions Cup / World Championship feeds) are non-real.
  if (ev.source === 'network' && !(ev.matchId > 0) && !ev.url) return true;
  return false;
}

// Merge or insert a discovered fixture into a Map-backed dedupe registry.
// Matches by numeric Sportradar matchId first, then exact normalized team names,
// then alias/fuzzy team match (eliminating DOM-short-name vs network-full-name duplicates).
function mergeDiscoveredFixture(registry, candidate, sport) {
  if (!candidate || !candidate.home || !candidate.away) return { added: false, item: null };
  const matchId = candidate.matchId || extractNumericMatchId(candidate.id) || extractNumericMatchId(candidate.url) || 0;
  const exactKey = `${norm(candidate.home)}|${norm(candidate.away)}`;

  let existing = null;
  if (matchId > 0 && registry.byId.has(matchId)) {
    existing = registry.byId.get(matchId);
  } else if (registry.byKey.has(exactKey)) {
    existing = registry.byKey.get(exactKey);
  } else {
    for (const item of registry.list) {
      if (item.sport !== (candidate.sport || sport)) continue;
      // Distinct known Sportradar matchIds can NEVER be the same fixture
      if (matchId > 0 && item.matchId > 0 && matchId !== item.matchId) continue;
      if (teamsMatchLoosely(item.home, candidate.home) && teamsMatchLoosely(item.away, candidate.away)) {
        // Guard against matching two fixtures of the same pair on different days (> 12h apart)
        if (item.ts && candidate.ts && Math.abs(item.ts - candidate.ts) > 12 * 3600000) continue;
        existing = item;
        break;
      }
    }
  }

  if (!existing) {
    const item = {
      sport: candidate.sport || sport,
      ...candidate,
      matchId,
      source: candidate.source || 'dom',
    };
    registry.rawFound = (registry.rawFound || 0) + 1;
    registry.list.push(item);
    registry.byKey.set(exactKey, item);
    if (matchId > 0) registry.byId.set(matchId, item);
    if (item.url && registry.uniqueUrls) registry.uniqueUrls.add(item.url);
    return { added: true, item };
  }

  registry.rawFound = (registry.rawFound || 0) + 1;
  registry.duplicatesRemoved = (registry.duplicatesRemoved || 0) + 1;

  // Upgrade existing entry with richer network metadata (URL, matchId, full names, exact timestamp)
  if (matchId > 0 && !existing.matchId) {
    existing.matchId = matchId;
    registry.byId.set(matchId, existing);
  }
  if (candidate.source === 'network') {
    if (candidate.home && candidate.home.length > existing.home.length) existing.home = candidate.home;
    if (candidate.away && candidate.away.length > existing.away.length) existing.away = candidate.away;
    if (candidate.url) existing.url = candidate.url;
    if (candidate.id) existing.id = candidate.id;
    if (candidate.ts) existing.ts = candidate.ts;
  }
  if (candidate.leagueOrderIndex != null && (existing.leagueOrderIndex == null || candidate.leagueOrderIndex < existing.leagueOrderIndex)) {
    existing.leagueOrderIndex = candidate.leagueOrderIndex;
  }
  for (const f of ['ts', 'id', 'league', 'country', 'url']) {
    if (!existing[f] && candidate[f]) existing[f] = candidate[f];
  }
  if (existing.url && registry.uniqueUrls) registry.uniqueUrls.add(existing.url);
  if (candidate.source && existing.source && existing.source !== candidate.source && !existing.source.includes(candidate.source)) {
    existing.source = 'dom+network';
  }
  if ((!existing.odds || !existing.odds.length) && candidate.odds && candidate.odds.length) {
    existing.odds = candidate.odds;
  }
  registry.byKey.set(exactKey, existing);
  return { added: false, item: existing };
}

function createFixtureRegistry() {
  return {
    list: [],
    byKey: new Map(),
    byId: new Map(),
    uniqueUrls: new Set(),
    rawFound: 0,
    duplicatesRemoved: 0,
    apiTotalReported: 0,
    pagesFetched: 0,
  };
}

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
  const dtComboRe = /^(\d{1,2}[/. -]\d{1,2})\s+(\d{1,2}:\d{2})\b/;
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

// matches found inside the site's own JSON answers (strictly /api/bet/match/list for real sports).
function eventsFromNet(net, sport = 'football') {
  const out = [];
  const spInfo = SPORT_URL_INFO[sport] || SPORT_URL_INFO.football;
  for (const r of net) {
    // Only ingest genuine sports match-list responses — never featured AI promos, tags, virtual feeds,
    // jackpots, or recommendation payloads that contain synthetic/non-sr:match fixtures.
    if (r.url) {
      if (/\/api\/bet\/match\/list(AiMatch|Tags)/i.test(r.url)) continue;
      if (/virtual|jackpot|casino|predictions|recommend|operation|bonus/i.test(r.url)) continue;
      if (/bangbet\.com\/api\//i.test(r.url) && !/\/api\/bet\/match\/list(\?|$)/i.test(r.url)) continue;
    }
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
      // Skip non-Sportradar virtual match IDs (e.g. vf:match:...) or mismatched sportIds
      if (id && !/^sr:match:\d+$/i.test(id)) return;
      if (o.sportId && typeof o.sportId === 'string' && o.sportId !== spInfo.sid) return;
      const url = /^sr:match:\d+$/i.test(id)
        ? `https://www.bangbet.com/ug-m/sport/${encodeURIComponent(spInfo.seg)}/match?matchId=${encodeURIComponent(id)}&sportId=${encodeURIComponent(sportId)}&producer=${encodeURIComponent(producer)}`
        : '';
      const matchId = extractNumericMatchId(id || url);
      const rawLeague = kL ? strOf(o[kL]) : '';
      let country = kC ? strOf(o[kC]) : '';
      let league = rawLeague;
      if (!country && rawLeague.includes(' - ')) {
        const dashIdx = rawLeague.indexOf(' - ');
        country = rawLeague.slice(0, dashIdx).trim();
        league = rawLeague.slice(dashIdx + 3).trim();
      }
      const tournamentWeight = Number.isFinite(Number(o.tournamentWeight)) && Number(o.tournamentWeight) > 0
        ? Number(o.tournamentWeight)
        : null;
      const countryWeight = Number.isFinite(Number(o.countryWeight)) && Number(o.countryWeight) > 0
        ? Number(o.countryWeight)
        : null;
      const item = {
        home, away, ts: kT ? tsOf(o[kT]) : 0, id, matchId, sportId, producer,
        league, country, url,
        tournamentWeight,
        countryWeight,
        highLight: !!o.highLight,
        popular: !!o.popular,
        marketNumber: Number.isFinite(Number(o.marketNumber)) ? Number(o.marketNumber) : 0,
      };
      if (isVirtualOrNonRealFixture({ ...item, source: 'network' })) return;
      out.push(item);
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
    this.gismoCache = new GismoCache();
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
    page.lastMatchListMeta = null;
    page.gismo = new GismoPageObserver(page, this.gismoCache, {
      saveEvidenceDir: process.env.EVIDENCE_DIR || '',
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('request', (req) => {
      if (/\/api\/bet\/match\/list(\?|$)/i.test(req.url())) page.pendingMatchList++;
    });
    page.on('requestfinished', (req) => {
      if (/\/api\/bet\/match\/list(\?|$)/i.test(req.url())) page.pendingMatchList = Math.max(0, page.pendingMatchList - 1);
    });
    page.on('requestfailed', (req) => {
      if (/\/api\/bet\/match\/list(\?|$)/i.test(req.url())) page.pendingMatchList = Math.max(0, page.pendingMatchList - 1);
    });
    page.on('response', async (res) => {
      try {
        if (!(res.headers()['content-type'] || '').includes('json')) return;
        const txt = await res.text();
        if (txt.length > 3e6) return;
        const body = JSON.parse(txt);
        page.net.push({ url: res.url(), body });
        this.apis.add(res.url().split('?')[0]);
        if (/\/api\/bet\/match\/list(\?|$)/i.test(res.url())) {
          const d = body && body.data;
          const arr = (d && (d.data || d.list || d.matches)) || (Array.isArray(d) ? d : null);
          if (Array.isArray(arr)) page.lastMatchListEmpty = arr.length === 0;
          const reqObj = res.request();
          if (reqObj && reqObj.method() === 'POST' && reqObj.postData()) {
            try {
              const postJson = JSON.parse(reqObj.postData());
              const total = Number((d && (d.total ?? d.totalCount ?? d.count ?? d.totalNum ?? d.totalSize)) || 0);
              const pageSize = Number((d && (d.pageSize ?? d.size)) || postJson.pageSize || (Array.isArray(arr) ? arr.length : 30) || 30);
              const pageNo = Number((d && (d.pageNo ?? d.page)) || postJson.pageNo || postJson.page || 1);
              const reqHeaders = reqObj.headers() || {};
              const safeHeaders = {};
              for (const [hk, hv] of Object.entries(reqHeaders)) {
                if (/^(content-type|accept|authorization|x-|token|platform|country|lang|client|app|device|sign|timestamp|nonce)/i.test(hk)) {
                  safeHeaders[hk] = hv;
                }
              }
              if (!safeHeaders['content-type'] && !safeHeaders['Content-Type']) safeHeaders['content-type'] = 'application/json';
              page.lastMatchListMeta = {
                url: res.url(),
                headers: safeHeaders,
                postJson,
                total,
                pageSize,
                pageNo,
                arrLen: Array.isArray(arr) ? arr.length : 0,
              };
            } catch (_) { /* non-json post */ }
          }
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
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
    await sleep(1600);
    await this.dismiss(page);
    const b = await this.blocked(page);
    if (b) this.notes.push(`BangBet shows a block or check page ("${b}") to this server`);
  }

  // Fast, readiness-driven loader for individual match pages: clears any previous match SPA/iframe
  // state via about:blank first so stale Markets tabs never cause false readiness on the next match.
  async loadMatch(page, url) {
    if (/\/match\b/i.test(page.url())) {
      await page.goto('about:blank', { waitUntil: 'commit', timeout: 4000 }).catch(() => {});
    }
    await page.goto(url, { waitUntil: 'commit', timeout: 18000 });
    await Promise.race([
      page.getByText(/^markets$/i).first().waitFor({ state: 'visible', timeout: 14000 }),
      page.getByText(/^stats/i).first().waitFor({ state: 'visible', timeout: 14000 }),
    ]).catch(() => {});
    await sleep(600);
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
    const info = SPORT_URL_INFO[sport];
    const hasFilterBar = async () => {
      const hasTimeOrLeague = await page.getByText(/^(time|league)$/i).first().isVisible().catch(() => false);
      return hasTimeOrLeague;
    };
    const isListing = () => /\/sports?\//i.test(page.url()) && !/\/match\b/i.test(page.url());

    // Fast primary path: navigate directly to BangBet's mobile /ug-m/sports/<Sport> listing
    // using commit + explicit UI readiness wait (avoids false domcontentloaded timeouts on cold JS bundle downloads).
    if (info) {
      try {
        page.net.splice(0);
        await page.goto(`${SITE}/sports/${encodeURIComponent(info.seg)}`, { waitUntil: 'commit', timeout: 35000 });
        await Promise.race([
          page.getByText(/^time$/i).first().waitFor({ state: 'visible', timeout: 50000 }),
          page.getByText(/^league$/i).first().waitFor({ state: 'visible', timeout: 50000 }),
        ]).catch(() => {});
        await sleep(1000);
        await this.dismiss(page);
        const b = await this.blocked(page);
        if (b) this.notes.push(`BangBet shows a block or check page ("${b}") to this server`);
        if (await hasFilterBar()) return true;
      } catch (e) {
        this.notes.push(`Direct mobile sport route failed (${sport}): ${e.message}`);
      }
    }

    // Fallback: load Ugandan mobile homepage and click the top sport icon
    await this.load(page, SITE);
    const re = SPORT_RE[sport];
    await page.getByText(re).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await this.dismiss(page);

    const tryClickSport = async () => {
      const loc = page.getByText(re);
      const n = Math.min(await loc.count().catch(() => 0), 4);
      for (let i = 0; i < n; i++) {
        if (isListing() && await hasFilterBar()) return true;
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const box = await el.boundingBox().catch(() => null);
        if (box && box.y > 240) continue;
        page.net.splice(0);
        await el.click({ timeout: 6000, force: true }).catch(() => {});
        await page.getByText(/^(time|league)$/i).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
        if (await hasFilterBar()) return true;
      }
      return false;
    };

    if (await tryClickSport()) { await sleep(1000); return true; }
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

  // Maps a specific calendar date or range to the primary BangBet Time menu tab.
  // Multi-day ranges use dateScope.bangbetTabs in openListing / run.js so every day is covered.
  effectiveScope(scope, req) {
    if (scope !== 'date' && scope !== 'range') return scope;
    const ds = resolveDateScope({ ...(req || {}), scope });
    if (ds.bangbetTabs && ds.bangbetTabs.length === 1) return ds.bangbetTabs[0];
    if (ds.dates && ds.dates.length <= 3) return 'next3days';
    if (ds.dates && ds.dates.length <= 7) return 'next7days';
    return 'all';
  }

  // BangBet's Time bottom sheet owns date/period selection:
  // All, Next 3 Hours, Next 6 Hours, Today, Tomorrow, Next 3 Days, Next 7 Days, This Weekend.
  // Once a period is selected, BangBet replaces the trigger button text ("Time") with the active
  // period name (e.g. "Today", "Tomorrow", "Next 3 Days", "This Weekend"), so subsequent tab switches
  // MUST locate the Time filter trigger by its filter-bar position/label set rather than /^time$/i alone.
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

    // Ensure the listing is scrolled back to top so the sticky/top Time & League filter bar is in view
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollTop > 0) el.scrollTop = 0;
      }
    }).catch(() => {});
    await sleep(300);

    const isSheetOpen = async () => page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div,span,li,button')];
      let hasNext3 = false;
      let hasWeekend = false;
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14 || r.top < 320) continue;
        const t = (el.innerText || '').trim().toLowerCase();
        if (t === 'next 3 days') hasNext3 = true;
        if (t === 'this weekend') hasWeekend = true;
      }
      return hasNext3 && hasWeekend;
    }).catch(() => false);

    let opened = await isSheetOpen();
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      // Find the Time filter trigger on the filter bar (same horizontal band as "League", left of "League")
      const marked = await page.evaluate(() => {
        document.querySelectorAll('[data-bb-time-trigger]').forEach((e) => e.removeAttribute('data-bb-time-trigger'));
        const triggerRe = /^(time|all|today|tomorrow|next\s*3\s*hours?|next\s*6\s*hours?|next\s*3\s*days?|next\s*7\s*days?|this\s*weekend)$/i;
        let leagueY = null;
        let leagueX = null;
        for (const el of document.querySelectorAll('div,span,button,a,p')) {
          const t = (el.innerText || '').trim().replace(/[^\w\s]/g, '').trim();
          const r = el.getBoundingClientRect();
          if (/^league$/i.test(t) && r.width > 20 && r.height > 10 && r.height < 60 && r.top > 120 && r.top < 380) {
            leagueY = r.top + r.height / 2;
            leagueX = r.left;
            break;
          }
        }
        const candidates = [];
        for (const el of document.querySelectorAll('div,span,button,a,p')) {
          const raw = (el.innerText || '').trim();
          if (!raw || raw.length > 26 || raw.includes('\n')) continue;
          const clean = raw.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          if (!triggerRe.test(clean)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 18 || r.height < 12 || r.height > 65 || r.top < 120 || r.top > 380) continue;
          if (leagueY != null && Math.abs((r.top + r.height / 2) - leagueY) > 35) continue;
          if (leagueX != null && r.left >= leagueX) continue;
          candidates.push({ el, area: r.width * r.height, x: r.left });
        }
        if (!candidates.length) return false;
        candidates.sort((a, b) => a.x - b.x || a.area - b.area);
        candidates[0].el.setAttribute('data-bb-time-trigger', '1');
        return true;
      }).catch(() => false);

      if (marked) {
        await page.locator('[data-bb-time-trigger="1"]').first().click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(700);
        opened = await isSheetOpen();
      }
      if (!opened) {
        // Fallback to literal /^time$/i click
        const time = page.getByText(/^time$/i).first();
        if (await time.isVisible().catch(() => false)) {
          await time.click({ timeout: 4000, force: true }).catch(() => {});
          await sleep(700);
          opened = await isSheetOpen();
        }
      }
      if (!opened) await sleep(600);
    }

    if (!opened) throw new Error('BangBet Time selector was not found; no fixture scan was started.');
    await sleep(300);

    // Click the matching option strictly INSIDE the open bottom sheet (y > 320), never the top filter bar!
    for (const re of wanted) {
      const prevNet = page.net.slice();
      page.net.splice(0);
      const clicked = await page.evaluate((src) => {
        const rx = new RegExp(src.source, src.flags);
        document.querySelectorAll('[data-bb-time-opt]').forEach((e) => e.removeAttribute('data-bb-time-opt'));
        const opts = [];
        for (const el of document.querySelectorAll('div,span,li,button,p')) {
          const raw = (el.innerText || '').trim();
          if (!raw || raw.includes('\n') || !rx.test(raw)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 14 || r.height > 80 || r.top < 320) continue;
          opts.push({ el, area: r.width * r.height });
        }
        if (!opts.length) return false;
        opts.sort((a, b) => a.area - b.area);
        opts[0].el.setAttribute('data-bb-time-opt', '1');
        return true;
      }, { source: re.source, flags: re.flags }).catch(() => false);

      if (clicked) {
        await page.locator('[data-bb-time-opt="1"]').first().click({ timeout: 5000, force: true }).catch(() => {});
        const waitEnd = Date.now() + 3500;
        await sleep(1200);
        while (Date.now() < waitEnd && page.pendingMatchList > 0) await sleep(250);
        // If BangBet was already on this tab (e.g. default "All") and issued no new XHR,
        // preserve the initial match-list network responses so direct fixture URLs are not lost.
        if (page.net.length === 0 && prevNet.length > 0) {
          page.net.push(...prevNet);
        }
        say('BangBet Time period selected:', targetScope, scope !== targetScope ? `(for ${scope})` : '', 'url=', page.url());
        return true;
      }
      if (prevNet.length > 0 && page.net.length === 0) {
        page.net.push(...prevNet);
      }
    }
    if (targetScope === 'all') {
      say('Time option "all" not directly matched; proceeding with current view.');
      return false;
    }
    throw new Error(`BangBet Time option "${targetScope}" was not found; no fixture scan was started.`);
  }

  // Opens a persistent listing tab for target-driven incremental batch discovery.
  // Supports explicit multi-day tab scanning (e.g. 'today' then 'tomorrow') sharing one dedupe registry.
  async openListing(sport, req, opts = {}) {
    const page = await this.newPage();
    if (!(await this.goSport(page, sport))) {
      await page.close().catch(() => {});
      throw new Error(`${sport}: the sport was not found in the BangBet menu`);
    }
    const tabScope = opts.tabScope || req.scope;
    await this.selectScope(page, tabScope, req);
    await this.shot(page, `discover_${sport}_${tabScope}`);
    const registry = opts.registry || createFixtureRegistry();
    return {
      sport,
      tabScope,
      page,
      registry,
      seen: registry.byKey,
      exhausted: false,
      still: 0,
      passes: 0,
      stopReason: '',
    };
  }

  // Switches an already-open listing tab to another BangBet Time period (e.g. Today -> Tomorrow)
  // without reloading the sport page from scratch, keeping the shared cross-tab dedupe registry.
  async switchListingTab(listing, tabScope, req) {
    listing.page.net.splice(0);
    listing.page.lastMatchListMeta = null;
    listing._apiNextPage = 0;
    listing._leagueApiInit = false;
    await this.selectScope(listing.page, tabScope, req);
    listing.tabScope = tabScope;
    listing.exhausted = false;
    listing.still = 0;
    listing.stopReason = '';
    listing.page.lastMatchListEmpty = false;
    await this.shot(listing.page, `discover_${listing.sport}_${tabScope}`);
  }

  // Directly paginate BangBet's own authenticated /api/bet/match/list POST endpoint using
  // BangBet's native League sort (sortType: 3) so fixtures preserve BangBet's real league ordering.
  // Respects [fromMs, toMs] date bounds without hardcoding favourite competitions.
  async _paginateMatchListApi(listing, deadline, add, opts = {}) {
    const { page, registry, sport } = listing;
    const meta = page.lastMatchListMeta;
    if (!meta || !meta.url || !meta.postJson) return { used: false };

    const fromMs = Number(opts.fromMs || 0);
    const toMs = Number(opts.toMs || 0);
    const desiredEligibleCap = Number(opts.desiredEligibleCap || 0);

    // On first call for this listing tab, switch to BangBet's native League sort (sortType: 3)
    // starting from page 1 so leagueOrderIndex strictly reflects BangBet's league ordering.
    if (!listing._leagueApiInit) {
      listing._leagueApiInit = true;
      listing._apiNextPage = 1;
      listing._leagueSortMode = 'bangbet_api_sortType_3';
      listing._leagueOrderCounter = listing._leagueOrderCounter || 0;
      listing._apiMaxPages = 0;
      listing._useServerTimeFilter = !!(fromMs > 0 && toMs > fromMs);
    }

    let consecutiveEmpty = 0;
    let fetched = 0;

    while (Date.now() < deadline) {
      if (listing._apiMaxPages > 0 && listing._apiNextPage > listing._apiMaxPages) {
        return { used: true, done: true, reason: 'api_exhausted' };
      }
      const pageNum = listing._apiNextPage;
      const reqBody = {
        ...meta.postJson,
        sortType: 3, // BangBet native League sort (verified live: 1=Highlights, 2=Time, 3=League)
        page: pageNum,
        pageNo: pageNum,
        ...(listing._useServerTimeFilter ? { beginTime: fromMs, endTime: toMs } : { beginTime: null, endTime: null }),
      };

      let resp;
      try {
        const apiResp = await page.request.post(meta.url, {
          headers: meta.headers,
          data: reqBody,
          timeout: 15000,
        });
        if (!apiResp.ok()) {
          resp = { ok: false, status: apiResp.status(), err: `HTTP ${apiResp.status()}` };
        } else {
          resp = { ok: true, status: apiResp.status(), data: await apiResp.json() };
        }
      } catch (e) {
        resp = { ok: false, status: 0, err: String(e && e.message || e) };
      }

      if (!resp || !resp.ok) {
        return { used: true, done: false, reason: `api_error: ${(resp && resp.err) || 'unknown'}` };
      }

      const d = resp.data && resp.data.data;
      const rawArr = (d && (d.data || d.list || d.matches)) || (Array.isArray(d) ? d : []);
      const rawArrLen = Array.isArray(rawArr) ? rawArr.length : 0;
      const apiTotal = Number((d && (d.total ?? d.totalCount ?? d.count ?? d.totalNum ?? d.totalSize)) || 0);
      const pageSize = Math.max(1, Number((d && (d.pageSize ?? d.size)) || meta.pageSize || 30));
      const items = eventsFromNet([{ url: meta.url, body: resp.data }], sport);

      // If BangBet returned 0 raw items with server beginTime/endTime on page 1, retry page 1 without
      // server beginTime/endTime and apply strict local [fromMs, toMs] filtering while preserving sortType=3 order.
      if (pageNum === 1 && listing._useServerTimeFilter && rawArrLen === 0) {
        listing._useServerTimeFilter = false;
        listing._leagueSortMode = 'bangbet_api_sortType_3_local_date_filter';
        continue;
      }

      if (apiTotal > 0) {
        if (apiTotal > (registry.apiTotalReported || 0)) registry.apiTotalReported = apiTotal;
        listing._apiMaxPages = Math.ceil(apiTotal / pageSize);
      }

      registry.pagesFetched = (registry.pagesFetched || 0) + 1;
      listing._apiNextPage = pageNum + 1;
      fetched++;

      // Distinguish a genuinely empty API page (rawArrLen === 0) from a page whose items were all virtual/filtered.
      if (rawArrLen === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2 || (listing._apiMaxPages > 0 && listing._apiNextPage > listing._apiMaxPages)) {
          return { used: true, done: true, reason: 'api_empty_page' };
        }
        continue;
      }
      consecutiveEmpty = 0;
      if (!items.length) {
        if (listing._apiMaxPages > 0 && listing._apiNextPage > listing._apiMaxPages) {
          return { used: true, done: true, reason: 'api_exhausted' };
        }
        continue;
      }

      for (const e of items) {
        const orderIdx = listing._leagueOrderCounter++;
        const res = add({ ...e, odds: [], source: 'network', leagueOrderIndex: orderIdx });
        if (!res && e.matchId && registry.byId.has(e.matchId)) {
          const existing = registry.byId.get(e.matchId);
          if (existing && (existing.leagueOrderIndex == null || orderIdx < existing.leagueOrderIndex)) {
            existing.leagueOrderIndex = orderIdx;
          }
        }
      }

      // If we have a maximum eligible checking cap (e.g., 100) and we are scanning in strict
      // BangBet league order (sortType=3), once we already have >= desiredEligibleCap REAL,
      // non-virtual, in-window fixtures with valid Sportradar URLs in league order, we can stop
      // fetching lower-ranked leagues.
      if (desiredEligibleCap > 0 && fromMs > 0 && toMs > fromMs) {
        let inWinEligible = 0;
        for (const item of registry.list) {
          if (item.leagueOrderIndex == null) continue;
          if (!(item.matchId > 0) || !item.url) continue;
          if (isVirtualOrNonRealFixture(item)) continue;
          if (item.ts && (item.ts < fromMs || item.ts >= toMs)) continue;
          inWinEligible++;
        }
        if (inWinEligible >= desiredEligibleCap) {
          return { used: true, done: true, reason: 'league_order_cap_satisfied' };
        }
      }

      if (typeof opts.onPage === 'function') {
        await opts.onPage(registry.list.length, pageNum, listing._apiMaxPages || pageNum).catch(() => {});
      }
      await sleep(200);
      if (fetched >= 5) {
        const exhaustedNow = listing._apiMaxPages > 0 && listing._apiNextPage > listing._apiMaxPages;
        return { used: true, done: exhaustedNow, reason: exhaustedNow ? 'api_exhausted' : 'batch' };
      }
    }

    return { used: true, done: false, reason: 'deadline' };
  }

  // Harvests the next batch of unique fixtures from an open listing tab via network + API pagination + DOM.
  async collectNextBatch(listing, deadline, batchTarget = 30, opts = {}) {
    const { page, registry, sport } = listing;
    const fresh = [];
    const add = (e) => {
      const res = mergeDiscoveredFixture(registry, e, sport);
      if (res.added && res.item) {
        fresh.push(res.item);
        return true;
      }
      return false;
    };

    while (Date.now() < deadline && !listing.exhausted && fresh.length < batchTarget) {
      listing.passes++;
      let addedThisPass = 0;

      // 1) Ingest network JSON (/api/bet/match/list) FIRST so full team names, matchId, ts & direct URL are canonical
      for (const e of eventsFromNet(page.net.splice(0), sport)) {
        if (add({ ...e, odds: [], source: 'network' })) {
          addedThisPass++;
        }
      }

      // 2) Paginate BangBet's match/list API directly using BangBet's native League sort (sortType: 3)
      //    when API metadata is available (avoids scraping virtual/promo DOM rows without sr:match URLs).
      if (page.lastMatchListMeta && page.lastMatchListMeta.url) {
        const apiRes = await this._paginateMatchListApi(listing, deadline, add, opts);
        if (apiRes.used) {
          if (apiRes.done) {
            listing.exhausted = true;
            listing.stopReason = apiRes.reason || 'api_exhausted';
            break;
          }
          if (apiRes.reason && apiRes.reason.startsWith('api_error')) {
            listing.stopReason = apiRes.reason;
            this.notes.push(`${sport} pagination stopped early: ${apiRes.reason}`);
            break;
          }
          if (fresh.length >= batchTarget) break;
          continue;
        }
      }

      // 3) Fallback to visible DOM rows ONLY when BangBet match/list API pagination is unavailable
      const rows = await page.evaluate(ROWS_JS).catch(() => []);
      for (const r of rows) {
        const parts = String(r.league || '').split(/\s*[·\-|>/]\s*/).filter(Boolean);
        const domEv = {
          home: r.home, away: r.away, ts: parseWhen(r.date, r.time), id: '', url: r.href || '',
          league: parts.length ? parts[parts.length - 1] : '', country: parts.length > 1 ? parts[0] : '',
          odds: r.odds || [], source: 'dom',
        };
        if (isVirtualOrNonRealFixture(domEv)) continue;
        if (add(domEv)) {
          addedThisPass++;
        }
      }

      if (fresh.length >= batchTarget) break;

      if (addedThisPass === 0) {
        if (page.pendingMatchList > 0) {
          await sleep(1000);
          continue;
        }
        listing.still++;
        if (listing.still === 1 || listing.still === 2) {
          const clickedMore = await this.clickText(page, /^(load\s*more|show\s*more|more\s*matches|more\s*events|view\s*more)$/i);
          if (clickedMore) {
            await sleep(1000);
            continue;
          }
        }
      } else {
        listing.still = 0;
        page.lastMatchListEmpty = false;
      }

      const moved = await this._scrollDown(page);
      await page.mouse.wheel(0, 1000).catch(() => {});
      const waitMs = listing.still === 0 ? 750 : (listing.still <= 2 ? 1000 : 1500);
      await sleep(waitMs);

      if (page.lastMatchListEmpty && page.pendingMatchList === 0 && listing.still >= 2) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
      if (page.pendingMatchList === 0 && listing.still >= 5 && !moved) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
      if (page.pendingMatchList === 0 && listing.still >= 8) {
        listing.exhausted = true;
        listing.stopReason = 'exhausted';
        break;
      }
    }

    if (Date.now() >= deadline && !listing.exhausted) {
      listing.stopReason = 'deadline';
    }
    this.discovery[sport] = {
      discovered: registry.list.length,
      rawFound: registry.rawFound || registry.list.length,
      uniqueUrls: registry.uniqueUrls ? registry.uniqueUrls.size : 0,
      duplicatesRemoved: registry.duplicatesRemoved || 0,
      apiTotalReported: registry.apiTotalReported || 0,
      pagesFetched: registry.pagesFetched || 1,
      leagueSortMode: listing._leagueSortMode || 'dom_default',
      exhausted: listing.exhausted,
      stopReason: listing.stopReason || 'batch',
      passes: listing.passes,
      tabScope: listing.tabScope,
    };
    return fresh;
  }

  // Full discovery across all requested sports & required date tabs with NO artificial match-count cap.
  async discover(req, deadline) {
    const all = [];
    const ds = resolveDateScope(req);
    const tabs = ds.bangbetTabs && ds.bangbetTabs.length ? ds.bangbetTabs : [req.scope || 'today'];
    for (const sport of req.sports) {
      if (Date.now() > deadline) break;
      const registry = createFixtureRegistry();
      let listing = null;
      try {
        listing = await this.openListing(sport, req, { tabScope: tabs[0], registry });
        for (let t = 0; t < tabs.length && Date.now() < deadline; t++) {
          if (t > 0) await this.switchListingTab(listing, tabs[t], req);
          while (Date.now() < deadline && !listing.exhausted) {
            await this.collectNextBatch(listing, deadline, 60);
          }
        }
        await this.shot(listing.page, `discover_${sport}_fixtures`);
        all.push(...registry.list);
        say(`${sport}: ${registry.list.length} unique fixtures discovered across [${tabs.join(', ')}] (exhausted=${listing.exhausted})`);
      } catch (e) {
        this.notes.push(`${sport}: ${e.message}`);
      } finally {
        if (listing && listing.page) await listing.page.close().catch(() => {});
      }
    }
    return all;
  }

  // opens a match: by its own direct URL (with 1 bounded retry on transient load issue),
  // falling back to listing search only when no direct URL exists.
  async openEvent(page, ev, scope = 'today', req = null) {
    if (page.gismo) page.gismo.beginFixture(ev);
    const verified = async (strict = false) => {
      const body = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      const t = norm(body);
      const hasHome = t.includes(keyTok(ev.home));
      const hasAway = t.includes(keyTok(ev.away));
      const hasTabs = /markets?/i.test(body);
      return strict ? (hasHome && hasAway && hasTabs) : ((hasHome || hasAway) && hasTabs);
    };
    if (ev.url && /^https?:/.test(ev.url)) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt > 1 && page.gismo) page.gismo.beginFixture(ev);
          await this.loadMatch(page, ev.url);
          for (let waitPoll = 0; waitPoll < 6; waitPoll++) {
            if (await verified(false)) return true;
            await sleep(650);
          }
        } catch (e) {
          if (attempt === 2) {
            this.notes.push(`Could not load ${ev.home} v ${ev.away}: ${e.message}`);
          } else {
            await sleep(800);
          }
        }
      }
      // Do not waste 25s running goSport fallback when the fixture already had a direct Sportradar URL
      this.notes.push(`Fixture URL did not verify as ${ev.home} v ${ev.away}`);
      return false;
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

module.exports = {
  Site,
  parseWhen,
  eventsFromNet,
  createFixtureRegistry,
  mergeDiscoveredFixture,
  teamsMatchLoosely,
  extractNumericMatchId,
  isVirtualOrNonRealFixture,
  SITE,
  OUT,
};
