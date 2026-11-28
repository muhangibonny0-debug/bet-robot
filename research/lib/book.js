'use strict';
// BangBet betslip: adds exact discovered markets/outcomes with confirmed betslip-count checks,
// opens the real full betslip container, verifies every leg strictly, and prepares a shareable code.
// All or nothing; never enters a stake or places a real bet.
const { sleep, norm, walk, toks } = require('./util');
const ex = require('./extract');
const approvedMarkets = require('./approved_markets');
const sportMarkets = require('./sport_markets');

// Normalise letter/number boundaries ("Under2.5" -> "under 2.5") while preserving decimal lines ("2.5").
function normalizeSlipText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/(\d)\.(\d)/g, '$1__dot__$2')
    .replace(/[^a-z0-9_ ]/g, ' ')
    .replace(/__dot__/g, '.')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExactPhrase(normalizedBody, normalizedPhrase) {
  if (!normalizedPhrase) return false;
  const re = new RegExp(`(?:^| )${escapeRe(normalizedPhrase)}(?:$| )`);
  return re.test(normalizedBody);
}

const SLIP_PREFIX_FILL = new Set([
  'fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'bk', 'nk', 'hnk', 'pfc', 'rsc', 'tsg',
  'rc', 'cs', 'vv', 'sv', 'cd', 'ud', 'sd', 'ca', 'ac', 'as', 'ss', 'us', 'cp',
  'if', 'srl', 'ofi', 'azs', 'zkk', 'club', 'the', 'de',
]);

function teamMatchesSlip(normalizedBody, teamName) {
  const full = normalizeSlipText(teamName);
  if (!full) return false;
  if (hasExactPhrase(normalizedBody, full)) return true;
  // Allow BangBet shortened club names that omit standard federation/club prefixes/suffixes
  const core = toks(teamName).join(' ');
  if (core && core !== full && core.length >= 3 && hasExactPhrase(normalizedBody, core)) return true;
  const stripped = full.split(' ').filter((w) => w && !SLIP_PREFIX_FILL.has(w)).join(' ');
  if (stripped && stripped !== full && stripped.length >= 3 && hasExactPhrase(normalizedBody, stripped)) return true;
  return false;
}

const DOUBLE_CHANCE_SYNONYMS = {
  '1 x': ['1 x', 'home or draw', 'homeordraw', '1 or draw', '1 or x'],
  'x 2': ['x 2', 'draw or away', 'draworaway', 'draw or 2', 'x or 2'],
  '1 2': ['1 2', 'home or away', 'homeoraway', '1 or 2'],
  'home or draw': ['home or draw', 'homeordraw', '1 x', '1 or draw', '1 or x'],
  'homeordraw': ['homeordraw', 'home or draw', '1 x', '1 or draw', '1 or x'],
  'draw or away': ['draw or away', 'draworaway', 'x 2', 'draw or 2', 'x or 2'],
  'draworaway': ['draworaway', 'draw or away', 'x 2', 'draw or 2', 'x or 2'],
  'home or away': ['home or away', 'homeoraway', '1 2', '1 or 2'],
  'homeoraway': ['homeoraway', 'home or away', '1 2', '1 or 2'],
};

function outcomeMatchesSlip(normalizedBody, outcomeOrLeg) {
  if (outcomeOrLeg && typeof outcomeOrLeg === 'object') {
    const leg = outcomeOrLeg;
    const rawTarget = normalizeSlipText(leg.outcome);
    if (rawTarget && hasExactPhrase(normalizedBody, rawTarget)) return true;
    const dcSyns = DOUBLE_CHANCE_SYNONYMS[rawTarget];
    if (dcSyns && dcSyns.some((s) => hasExactPhrase(normalizedBody, s))) return true;
    const isFootball = !leg.sport || String(leg.sport).toLowerCase() === 'football';
    if (isFootball) {
      const dictSyns = approvedMarkets.slipOutcomeSynonymsForLeg(leg, normalizeSlipText);
      if (dictSyns.some((s) => hasExactPhrase(normalizedBody, s))) return true;
    } else {
      // Non-football slip outcome synonyms (team name <-> home/away, handicap with team name, over/under line)
      const extra = [];
      if (leg.side === 'H') {
        extra.push('home', '1', normalizeSlipText(leg.home));
        if (leg.line != null) extra.push(normalizeSlipText(`${leg.home} ${leg.line}`), normalizeSlipText(`home ${leg.line}`));
      } else if (leg.side === 'A') {
        extra.push('away', '2', normalizeSlipText(leg.away));
        if (leg.line != null) extra.push(normalizeSlipText(`${leg.away} ${leg.line}`), normalizeSlipText(`away ${leg.line}`));
      } else if (leg.side === 'X') {
        extra.push('draw', 'x');
      } else if (leg.side === '1X' || leg.side === 'X2' || leg.side === '12') {
        const s = normalizeSlipText(leg.side);
        if (DOUBLE_CHANCE_SYNONYMS[s]) extra.push(...DOUBLE_CHANCE_SYNONYMS[s]);
      }
      if ((leg.dir === 'O' || leg.dir === 'U') && leg.line != null) {
        extra.push(normalizeSlipText(`${leg.dir === 'O' ? 'over' : 'under'} ${leg.line}`));
      }
      if (leg.canonicalOutcome) extra.push(normalizeSlipText(leg.canonicalOutcome));
      if (extra.filter(Boolean).some((s) => hasExactPhrase(normalizedBody, s))) return true;
    }
    return false;
  }
  const target = normalizeSlipText(outcomeOrLeg);
  if (!target) return false;
  if (hasExactPhrase(normalizedBody, target)) return true;
  const syns = DOUBLE_CHANCE_SYNONYMS[target];
  if (syns) {
    return syns.some((s) => hasExactPhrase(normalizedBody, s));
  }
  return false;
}

// Strict verification against the full betslip container text.
// Distinguishes e.g. "Over 2.5" from "Over 3.5" while matching "Under2.5" <-> "Under 2.5"
// and all 9 approved market outcome synonyms from approved_markets.js.
function verifySlipText(text, legs) {
  const body = normalizeSlipText(text);
  const verified = [];
  const missing = [];
  for (const leg of legs) {
    const okHome = teamMatchesSlip(body, leg.home);
    const okAway = teamMatchesSlip(body, leg.away);
    const okOutcome = outcomeMatchesSlip(body, leg);
    if (okHome && okAway && okOutcome) {
      verified.push(leg);
    } else {
      missing.push(leg);
    }
  }
  return { ok: missing.length === 0, verified, missing };
}

// Read the actual selection count shown on BangBet's betslip navigation button (never .rapid-betslip).
async function readSlipCount(page) {
  return page.evaluate(() => {
    const selectors = [
      '.betslip-nav-container',
      '[class*="betslip-nav" i]',
      '[class*="betslip-count" i]',
    ];
    for (const sel of selectors) {
      const nodes = [...document.querySelectorAll(sel)];
      for (const el of nodes) {
        if (el.closest('.rapid-betslip')) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
        const m = txt.match(/\b(\d{1,2})\b/);
        if (m) return Number(m[1]);
      }
    }
    return 0;
  }).catch(() => 0);
}

// Scroll the target odds element cleanly into the unobstructed centre of the viewport,
// shifting further up if a fixed bottom overlay (.rapid-betslip) still overlaps its centre.
async function scrollTargetUnobstructed(page, dataBbIdx) {
  return page.evaluate((idx) => {
    const target = document.querySelector(`[data-bb="${idx}"]`);
    if (!target) return { found: false, unobstructed: false };
    target.scrollIntoView({ block: 'center', inline: 'center' });
    const check = () => {
      const tr = target.getBoundingClientRect();
      const cx = tr.left + tr.width / 2;
      const cy = tr.top + tr.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const rapid = document.querySelector('.rapid-betslip');
      const blockedByRapid = !!(rapid && hit && rapid.contains(hit));
      const inTarget = !!(hit && (hit === target || target.contains(hit) || hit.contains(target)));
      return { tr, blockedByRapid, inTarget };
    };
    let st = check();
    if (st.blockedByRapid || !st.inTarget) {
      // Nudge scroll downward so the element moves higher above any fixed bottom bar
      window.scrollBy(0, 180);
      st = check();
    }
    return {
      found: true,
      unobstructed: st.inTarget && !st.blockedByRapid,
      blockedByRapid: st.blockedByRapid,
      top: Math.round(st.tr.top),
      bottom: Math.round(st.tr.bottom),
    };
  }, dataBbIdx).catch(() => ({ found: false, unobstructed: false }));
}

async function waitForSlipCount(page, expectedCount, maxWaitMs = 2600) {
  const started = Date.now();
  let last = await readSlipCount(page);
  while (Date.now() - started < maxWaitMs) {
    if (last === expectedCount) return { ok: true, count: last };
    await sleep(200);
    last = await readSlipCount(page);
  }
  return { ok: last === expectedCount, count: last };
}

// Wait for BangBet's Vue betslip nav badge to hydrate from localStorage after navigating to a new match page.
// Without this, readSlipCount() returns 0 on a freshly loaded page even when N > 0 legs are already in the slip.
async function waitForHydratedSlipCount(page, expectedMinCount, maxWaitMs = 3500) {
  const started = Date.now();
  let last = await readSlipCount(page);
  if (expectedMinCount <= 0) return { ok: true, count: last };
  while (Date.now() - started < maxWaitMs) {
    if (last >= expectedMinCount) return { ok: last === expectedMinCount, count: last };
    await sleep(200);
    last = await readSlipCount(page);
  }
  return { ok: last === expectedMinCount, count: last };
}

async function addLeg(site, page, leg, scope = 'today', req = null, expectedBeforeCount = null) {
  const diag = {
    home: leg.home,
    away: leg.away,
    market: leg.market,
    outcome: leg.outcome,
    approvedMarketId: leg.approvedMarketId || '',
    canonicalOutcome: leg.canonicalOutcome || '',
    oddsBefore: leg.odds,
    oddsAfter: null,
    expectedBeforeCount,
    hydratedBefore: null,
    afterCount: null,
    attempts: 0,
    ok: false,
    unavailable: false,
    fatalSlipState: false,
    why: '',
  };

  // Authoritative market check: NEVER book an unapproved market or guess its meaning.
  const isFootballLeg = !leg.sport || String(leg.sport).toLowerCase() === 'football';
  const legApproved = isFootballLeg
    ? (leg.approvedMarketId
      ? (approvedMarkets.isApprovedMarketId(leg.approvedMarketId)
        ? { approved: true, approvedMarketId: leg.approvedMarketId }
        : { approved: false, reason: 'unapproved_market_id' })
      : approvedMarkets.matchApprovedMarket(leg.market, leg.outcome, { home: leg.home, away: leg.away }))
    : (leg.approvedMarketId
      ? (sportMarkets.isApprovedSportMarketId(leg.sport, leg.approvedMarketId)
        ? { approved: true, approvedMarketId: leg.approvedMarketId }
        : { approved: false, reason: 'unapproved_sport_market_id' })
      : sportMarkets.matchSportMarket(leg.sport, leg.market, leg.outcome, { home: leg.home, away: leg.away }));
  if (!legApproved || !legApproved.approved) {
    diag.why = `market "${leg.market} / ${leg.outcome}" is not an approved market`;
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }
  diag.approvedMarketId = legApproved.approvedMarketId;

  const findLive = (mktList) => (isFootballLeg
    ? approvedMarkets.findMatchingLiveMarket(mktList, leg)
    : sportMarkets.findMatchingLiveSportMarket(mktList, leg));

  const ev = { sport: leg.sport, home: leg.home, away: leg.away, url: leg.url, league: leg.league };
  if (!(await site.openEvent(page, ev, scope, req))) {
    diag.why = 'could not open or verify the match page';
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }
  let list = await ex.markets(page, ev, { domOnly: true });
  let m = findLive(list);
  // If the approved market lives on a non-default BangBet tab (e.g. Goals for Team Total,
  // Corner for Corner 1X2, All for To Win Either Half / Any Team To Win), try each preferred tab
  // and re-read DOM markets until the exact clickable outcome is found.
  if ((!m || m.i < 0) && typeof ex.switchMarketTab === 'function') {
    const tabs = typeof ex.preferredMarketTabsForLeg === 'function'
      ? ex.preferredMarketTabsForLeg(leg)
      : ['All'];
    for (const tab of tabs) {
      const switched = await ex.switchMarketTab(page, tab).catch(() => false);
      if (!switched) continue;
      diag.switchedMarketTab = tab;
      list = await ex.markets(page, ev, { domOnly: true });
      m = findLive(list);
      if (m && m.i >= 0) break;
      if (typeof ex.expandAll === 'function') {
        await ex.expandAll(page).catch(() => {});
        list = await ex.markets(page, ev, { domOnly: true });
        m = approvedMarkets.findMatchingLiveMarket(list, leg);
        if (m && m.i >= 0) break;
      }
    }
  }
  if (!m) {
    diag.why = `the exact approved market "${leg.market} / ${leg.outcome}" is unavailable or suspended on BangBet`;
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }
  diag.oddsAfter = m.odds;
  if (!Number.isFinite(m.odds) || m.odds <= 1.0 || m.odds >= 1000) {
    diag.why = `displayed odds (${m.odds}) are invalid or suspended`;
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }
  const r = m.odds / leg.odds;
  if (r < 0.7 || r > 1.4) {
    diag.why = `the odds changed a lot: ${leg.odds} to ${m.odds}`;
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }
  if (m.i < 0) {
    diag.why = 'the price was found in data, not on the page, so it cannot be clicked';
    diag.unavailable = true;
    return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, diag };
  }

  let beforeCount;
  if (Number.isInteger(expectedBeforeCount) && expectedBeforeCount >= 0) {
    const hyd = await waitForHydratedSlipCount(page, expectedBeforeCount, 3500);
    diag.hydratedBefore = hyd.count;
    if (expectedBeforeCount > 0 && hyd.count !== expectedBeforeCount) {
      diag.why = `betslip state mismatch before adding "${leg.market} / ${leg.outcome}" (expected prior legs=${expectedBeforeCount}, hydrated badge=${hyd.count})`;
      diag.fatalSlipState = true;
      return { ok: false, unavailable: false, fatalSlipState: true, why: diag.why, diag };
    }
    beforeCount = expectedBeforeCount;
  } else {
    beforeCount = await readSlipCount(page);
    diag.hydratedBefore = beforeCount;
  }
  const expectedCount = beforeCount + 1;
  let lastCount = beforeCount;

  // Normal attempt + at most ONE controlled retry if the actual betslip count does not increment by 1.
  // Never re-click if the slip count already reached expectedCount (would toggle/remove the selection).
  for (let attempt = 1; attempt <= 2; attempt++) {
    diag.attempts = attempt;
    const preCheck = await readSlipCount(page);
    if (preCheck === expectedCount) {
      diag.afterCount = preCheck;
      diag.ok = true;
      return {
        ok: true,
        odds: m.odds,
        changed: Math.abs(m.odds - leg.odds) > 0.005,
        slipCount: preCheck,
        attempts: attempt,
        diag,
      };
    }
    const geom = await scrollTargetUnobstructed(page, m.i);
    await sleep(220);
    if (!geom.found) {
      diag.why = 'the target odds element disappeared before clicking';
      diag.unavailable = true;
      return { ok: false, unavailable: true, fatalSlipState: false, why: diag.why, attempts: attempt, diag };
    }
    const loc = page.locator(`[data-bb="${m.i}"]`).first();
    // Normal Playwright click (respects visibility & hit-target actionability — never blindly clicks through overlays)
    const clicked = await loc.click({ timeout: 4000 }).then(() => true).catch(() => false);
    if (clicked) {
      const waited = await waitForSlipCount(page, expectedCount, 3000);
      lastCount = waited.count;
      diag.afterCount = lastCount;
      if (waited.ok) {
        diag.ok = true;
        return {
          ok: true,
          odds: m.odds,
          changed: Math.abs(m.odds - leg.odds) > 0.005,
          slipCount: waited.count,
          attempts: attempt,
          diag,
        };
      }
    } else {
      lastCount = await readSlipCount(page);
      diag.afterCount = lastCount;
    }
    if (attempt === 1) await sleep(500);
  }

  diag.why = `betslip count did not increase by 1 after clicking "${leg.market} / ${leg.outcome}" (before=${beforeCount}, after=${lastCount}, expected=${expectedCount})`;
  diag.fatalSlipState = true;
  return {
    ok: false,
    unavailable: false,
    fatalSlipState: true,
    why: diag.why,
    attempts: 2,
    diag,
  };
}

const BAD_CODES = new Set([
  'ACCEPT', 'REMOVE', 'MULTIPLE', 'SINGLES', 'SHARE', 'PLACE', 'BETSLIP', 'TOTAL',
  'STAKE', 'BOOST', 'LOGIN', 'CANCEL', 'CLOSE', 'COPY', 'LINK', 'CODE', 'LOAD', 'NONE',
  'BOOKING', 'DETAILS', 'MARKETS', 'STATS',
]);
function isPlausibleCode(v, trustedSource = false) {
  const s = String(v || '').trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(s)) return false;
  if (BAD_CODES.has(s.toUpperCase())) return false;
  // Generic DOM regex matches outside BangBet's explicit /bookcode/ modal must contain a digit
  // so English UI words are never mistaken for booking codes; explicit /bookcode/ & modal matches
  // allow valid all-letter BangBet codes such as "Mmptud".
  if (!trustedSource && !/\d/.test(s)) return false;
  return true;
}

// Open BangBet's real full betslip drawer (never clicking .rapid-betslip Place Bet or delete-leg icons)
// and read ONLY that container's text.
async function openFullBetslip(page) {
  // On a 1-leg slip, BangBet shows the floating .rapid-betslip banner with an overlay minimize icon
  // (<img src="/static/img/black-close...">) sitting directly over .betslip-nav-container.
  // Clicking that specific minimize icon collapses .rapid-betslip WITHOUT deleting the leg.
  // NEVER click close/trash icons inside .wageitem (those delete the selection from the slip!).
  try {
    const rapidClose = page.locator('img[src*="black-close"]:visible').first();
    if (await rapidClose.count().catch(() => 0)) {
      await rapidClose.click({ timeout: 2500, force: true }).catch(() => {});
      await sleep(500);
    }
  } catch (_) {}

  const openSelectors = [
    '.betslip-nav-container:visible',
    '[class*="betslip-nav" i]:visible',
  ];
  let clickedNav = false;
  for (const sel of openSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 3500, force: true }).catch(() => {});
        clickedNav = true;
        break;
      }
    } catch (_) {}
  }
  if (clickedNav) {
    // Wait briefly to see if the click opened the drawer; if BangBet's animation swallowed it, trigger a direct DOM click
    await sleep(350);
    const hasDrawer = await page.evaluate(() => {
      for (const sel of ['.betslip-container', '.betslip-wrapper']) {
        const el = document.querySelector(sel);
        if (el && !el.closest('.rapid-betslip') && el.getBoundingClientRect().height > 200) return true;
      }
      return false;
    }).catch(() => false);
    if (!hasDrawer) {
      await page.evaluate(() => {
        const nav = document.querySelector('.betslip-nav-container') || document.querySelector('[class*="betslip-nav" i]');
        if (nav) nav.click();
      }).catch(() => {});
    }
  }
  if (!clickedNav) {
    // Fallback: visible element matching /bet\s*slip/i that is NOT inside .rapid-betslip
    try {
      const found = await page.evaluate(() => {
        const els = [...document.querySelectorAll('div,button,a,span')].filter((e) => {
          if (e.closest('.rapid-betslip')) return false;
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return /\bbet\s*slip\b/i.test((e.innerText || '').trim());
        });
        if (!els.length) return false;
        els[0].setAttribute('data-bb-navslip', '1');
        return true;
      }).catch(() => false);
      if (found) {
        await page.locator('[data-bb-navslip="1"]').first().click({ timeout: 3500 }).catch(() => {});
        clickedNav = true;
      }
    } catch (_) {}
  }
  if (!clickedNav) {
    return { opened: false, containerText: '', why: 'BangBet full betslip navigation button (.betslip-nav-container) could not be opened.' };
  }

  // Wait for the real full betslip container (.betslip-container or .betslip-wrapper) to become visible
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const res = await page.evaluate(() => {
      for (const sel of ['.betslip-container', '.betslip-wrapper']) {
        const els = [...document.querySelectorAll(sel)];
        for (const el of els) {
          if (el.closest('.rapid-betslip')) continue;
          const r = el.getBoundingClientRect();
          const txt = (el.innerText || '').trim();
          if (r.width > 150 && r.height > 200 && txt.length > 20) {
            return { opened: true, selector: sel, containerText: txt };
          }
        }
      }
      return { opened: false, selector: '', containerText: '' };
    }).catch(() => ({ opened: false, selector: '', containerText: '' }));
    if (res.opened) return res;
    await sleep(250);
  }
  return { opened: false, containerText: '', why: 'BangBet full betslip container (.betslip-container / .betslip-wrapper) did not become visible.' };
}

function sanitizeUrlForDiag(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    for (const k of [...u.searchParams.keys()]) {
      if (/token|auth|key|secret|password|session|cookie/i.test(k)) {
        u.searchParams.set(k, '[REDACTED]');
      }
    }
    return u.toString().slice(0, 220);
  } catch (_) {
    return String(rawUrl || '').replace(/(token|auth|key|secret|password)=[^&\s]+/gi, '$1=[REDACTED]').slice(0, 220);
  }
}

// Inspect any visible overlays/banners/changes state inside BangBet's betslip drawer.
async function inspectBetslipState(page, fallbackOpen = false) {
  const res = await page.evaluate(() => {
    const slip = document.querySelector('.betslip-container') || document.querySelector('.betslip-wrapper');
    const slipRect = slip ? slip.getBoundingClientRect() : null;
    const slipOpen = !!(slipRect && slipRect.width > 150 && slipRect.height > 200);
    const slipText = slipOpen ? (slip.innerText || '').trim() : '';
    const hasChangesBanner = /changes\s+in\s+odds\s+or\s+availability/i.test(slipText);
    const overlays = [];
    for (const el of document.querySelectorAll('[class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="overlay" i], [class*="toast" i], [class*="banner" i]')) {
      if (el.closest('.betslip-container') || el.closest('.betslip-wrapper') || el.classList.contains('betslip-wrapper')) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width > 40 && r.height > 20 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05) {
        overlays.push({
          cls: String(el.className || '').slice(0, 80),
          txt: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          zIndex: st.zIndex,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }
    return {
      slipOpen,
      hasChangesBanner,
      overlays: overlays.slice(0, 8),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }).catch(() => null);
  if (res && typeof res === 'object' && typeof res.slipOpen === 'boolean') return res;
  return { slipOpen: fallbackOpen, hasChangesBanner: false, overlays: [], viewport: { w: 0, h: 0 } };
}

async function locatorEntries(loc, maxItems = 10) {
  if (!loc) return [];
  if (typeof loc.count === 'function' && typeof loc.nth === 'function') {
    const cnt = Math.min(await loc.count().catch(() => 0), maxItems);
    const out = [];
    for (let i = 0; i < cnt; i++) out.push({ idx: i, el: loc.nth(i) });
    return out;
  }
  if (typeof loc.first === 'function') {
    const first = loc.first();
    const cnt = typeof first.count === 'function' ? await first.count().catch(() => 0) : 0;
    return cnt > 0 ? [{ idx: 0, el: first }] : [];
  }
  return [];
}

// Find ANY genuinely visible "Accept Changes" action button (never blindly relying on .first(),
// which can match a hidden 0x0 element in .rapid-betslip or inactive Singles tab, and never
// clicking the header "Accept odds changes" toggle label or Place Bet).
async function findVisibleAcceptChanges(page) {
  const scopes = [
    { name: 'slip_accept_text', loc: page.locator('.betslip-container, .betslip-wrapper').getByText(/^accept\s+changes$/i) },
    { name: 'slip_footer_accept', loc: page.locator('.betslip-container .place-info-box, .betslip-wrapper .place-info-box, .betslip-container .wager-submit, .betslip-wrapper .wager-submit').getByText(/accept\s+changes/i) },
    { name: 'page_accept_text', loc: page.getByText(/^accept\s+changes$/i) },
  ];
  for (const s of scopes) {
    const entries = await locatorEntries(s.loc, 10);
    for (const { idx, el } of entries) {
      const vis = typeof el.isVisible === 'function' ? await el.isVisible().catch(() => false) : false;
      if (!vis) continue;
      let meta = { ok: true, disabled: false, txt: 'Accept Changes', rect: null };
      if (typeof el.evaluate === 'function') {
        meta = await el.evaluate((node) => {
          if (node.closest('.rapid-betslip') || node.closest('.switch_center')) return { ok: false };
          const txt = (node.innerText || '').trim().replace(/\s+/g, ' ');
          if (/place\s*bet/i.test(txt)) return { ok: false };
          const r = node.getBoundingClientRect();
          const st = getComputedStyle(node);
          const disabled = !!(node.disabled || node.getAttribute('disabled') !== null || node.getAttribute('aria-disabled') === 'true');
          return {
            ok: r.width >= 40 && r.height >= 20 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.1,
            disabled,
            txt,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
        }).catch(() => ({ ok: false }));
      }
      if (meta.ok && !meta.disabled) {
        return { found: true, locator: el, locatorUsed: `${s.name}[${idx}]`, rect: meta.rect, text: meta.txt };
      }
    }
  }
  return { found: false, locator: null, locatorUsed: '', rect: null, text: '' };
}

// Clear any visible "Accept Changes" prompt inside the open betslip (max 4 rounds, never clicking Place Bet).
async function acceptBetslipChanges(page) {
  let clicks = 0;
  const attempts = [];
  for (let round = 0; round < 4; round++) {
    const hit = await findVisibleAcceptChanges(page);
    if (!hit.found) break;
    if (typeof hit.locator.scrollIntoViewIfNeeded === 'function') {
      await hit.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    }
    let clicked = await hit.locator.click({ timeout: 4000 }).then(() => true).catch(() => false);
    if (!clicked) {
      clicked = await hit.locator.click({ timeout: 3000, force: true }).then(() => true).catch(() => false);
    }
    if (!clicked && typeof hit.locator.evaluate === 'function') {
      clicked = await hit.locator.evaluate((node) => { node.click(); return true; }).catch(() => false);
    }
    attempts.push({ round: round + 1, locatorUsed: hit.locatorUsed, rect: hit.rect, clicked });
    if (!clicked) break;
    clicks++;
    await sleep(1200);
  }
  const remaining = await findVisibleAcceptChanges(page);
  return { clicks, stillVisible: remaining.found, remainingLocator: remaining.locatorUsed, attempts };
}

// Locate BangBet's genuine Share Bet control with visibility, enabled, viewport, and hit-test verification.
// Explicitly excludes hidden 0x0 .code-close/.book-code/.share-cont modal nodes, .rapid-betslip, and Place Bet.
async function locateShareBetControl(page) {
  const diag = {
    found: false,
    visible: false,
    enabled: false,
    unobstructed: false,
    coveredBy: '',
    locatorUsed: '',
    rect: null,
    candidatesChecked: 0,
    locator: null,
  };

  const strategies = [
    { name: '.betslip-container .share-btn', loc: page.locator('.betslip-container .share-btn') },
    { name: '.betslip-wrapper .share-btn', loc: page.locator('.betslip-wrapper .share-btn') },
    { name: '.share-btn', loc: page.locator('.share-btn') },
    { name: 'slip text /^share bet$/i', loc: page.locator('.betslip-container, .betslip-wrapper').getByText(/^share\s*bet$/i) },
    { name: 'slip text /share (bet|slip|code)/i', loc: page.locator('.betslip-container, .betslip-wrapper').getByText(/share\s*(bet|slip|code)/i) },
    { name: 'slip text /book(ing)? (a )?bet|booking code|generate code/i', loc: page.locator('.betslip-container, .betslip-wrapper').getByText(/book(ing)?\s*(a\s*)?bet|booking\s*code|generate\s*code/i) },
    { name: 'page text /^share bet$/i', loc: page.getByText(/^share\s*bet$/i) },
  ];

  for (const strat of strategies) {
    const entries = await locatorEntries(strat.loc, 8);
    for (const { idx, el } of entries) {
      diag.candidatesChecked++;
      const isVis = typeof el.isVisible === 'function' ? await el.isVisible().catch(() => false) : false;
      if (!isVis) continue;

      if (typeof el.scrollIntoViewIfNeeded === 'function') {
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      }
      let inspect = { skip: false, visible: true, enabled: true, unobstructed: true, coveredBy: '', rect: null, txt: 'Share Bet' };
      if (typeof el.evaluate === 'function') {
        inspect = await el.evaluate((node) => {
          if (node.closest('.rapid-betslip') || node.closest('.book-code') || node.closest('.share-cont') || node.closest('.code-close')) {
            return { skip: true };
          }
          const txt = (node.innerText || '').trim().replace(/\s+/g, ' ');
          if (/place\s*bet/i.test(txt) && !/share/i.test(txt)) return { skip: true };
          let r = node.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            node.scrollIntoView({ block: 'center', inline: 'center' });
            r = node.getBoundingClientRect();
          }
          const st = getComputedStyle(node);
          const visible = r.width >= 10 && r.height >= 10 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.1;
          const disabled = !!(node.disabled || node.getAttribute('disabled') !== null || node.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(String(node.className || '')));
          let unobstructed = false;
          let coveredBy = '';
          if (visible) {
            const cx = Math.max(1, Math.min(window.innerWidth - 1, r.left + r.width / 2));
            const cy = Math.max(1, Math.min(window.innerHeight - 1, r.top + r.height / 2));
            const hit = document.elementFromPoint(cx, cy);
            unobstructed = !!(hit && (hit === node || node.contains(hit) || hit.contains(node)));
            if (!unobstructed && hit) {
              coveredBy = `${hit.tagName}.${String(hit.className || '').slice(0, 60)} ("${(hit.innerText || '').trim().slice(0, 40)}")`;
            }
          }
          return {
            skip: false,
            visible,
            enabled: !disabled,
            unobstructed,
            coveredBy,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            txt,
          };
        }).catch(() => ({ skip: true }));
      } else if (typeof el.boundingBox === 'function') {
        const box = await el.boundingBox().catch(() => null);
        if (box && (box.width < 10 || box.height < 10)) inspect.skip = true;
        else if (box) inspect.rect = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
      }

      if (inspect.skip || !inspect.visible) continue;
      diag.found = true;
      diag.visible = inspect.visible;
      diag.enabled = inspect.enabled;
      diag.unobstructed = inspect.unobstructed;
      diag.coveredBy = inspect.coveredBy || '';
      diag.locatorUsed = `${strat.name}[${idx}]`;
      diag.rect = inspect.rect;
      diag.locator = el;
      if (inspect.enabled && inspect.unobstructed) return diag;
    }
  }
  return diag;
}

async function readFullSlipText(page) {
  return page.evaluate(() => {
    for (const sel of ['.betslip-container', '.betslip-wrapper']) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 200) return (el.innerText || '').trim();
    }
    return '';
  }).catch(() => '');
}

async function share(site, page, legs) {
  const out = {
    code: '',
    link: '',
    why: '',
    verifiedLegs: [],
    missingLegs: [],
    acceptChangesClicks: 0,
    clickedShare: false,
    shareDiag: {
      betslipState: null,
      acceptChanges: null,
      shareButtonDiscovery: null,
      overlaysDetected: [],
      shareBetResponse: null,
      codeExtraction: { ok: false, source: '', code: '', link: '' },
    },
  };
  const panel = await openFullBetslip(page);
  if (!panel.opened) {
    out.shareDiag.betslipState = { opened: false, selector: '' };
    return { ...out, why: panel.why || 'BangBet full betslip panel could not be opened; no booking code was requested.' };
  }

  // Ensure the combined "Multiple" tab is active when booking >= 2 selections BEFORE final verification
  let tabMode = legs.length >= 2 ? 'multiple' : 'singles';
  if (legs.length >= 2) {
    try {
      const mult = page.locator('.betslip-container, .betslip-wrapper').getByText(/^multiple$/i).first();
      if ((await mult.count()) && (await mult.isVisible())) {
        await mult.click({ timeout: 2500 }).catch(() => {});
        await sleep(500);
      }
    } catch (_) {}
  }

  // Re-read the full betslip container text strictly (never whole document.body)
  const slipText = (await readFullSlipText(page)) || panel.containerText;
  const verified = verifySlipText(slipText, legs);
  const currentSlipCount = await readSlipCount(page);
  const unexpectedCount = (currentSlipCount > legs.length);
  out.verifiedLegs = verified.verified.map((l) => `${l.home} v ${l.away} (${l.outcome})`);
  out.missingLegs = verified.missing.map((l) => `${l.home} v ${l.away} (${l.outcome})`);
  out.unexpectedSelectionsDetected = unexpectedCount;
  out.slipCountChecked = currentSlipCount;

  if (!verified.ok || unexpectedCount) {
    await site.shot(page, 'book_slip_verify_failed');
    out.shareDiag.betslipState = {
      opened: true,
      selector: panel.selector,
      tabMode,
      verifiedCount: verified.verified.length,
      slipCount: currentSlipCount,
      expectedCount: legs.length,
      unexpectedSelectionsDetected: unexpectedCount,
    };
    const names = verified.missing.map((l) => `${l.home} v ${l.away}`).join(', ');
    return {
      ...out,
      why: !verified.ok
        ? `Full betslip verification failed (${verified.verified.length}/${legs.length} verified); missing from full betslip: ${names}`
        : `Betslip contains unexpected selections (slip count ${currentSlipCount}, expected ${legs.length}); refused to generate Share Bet code.`,
    };
  }
  await site.shot(page, 'book_slip_verified');

  const mark = page.net.length;
  let clickedShare = false;
  let lastShareCtrl = null;
  let lastSlipState = null;
  const allAcceptAttempts = [];

  // Controlled bounded retry sequence (max 3 rounds):
  // 1) Clear any visible "Accept Changes" bar (scanning ALL visible matches, never .first() blindly!)
  // 2) Re-verify the complete betslip if any odds changes were accepted
  // 3) Check for any covering overlays/banners and dismiss if safe
  // 4) Locate, scroll into view, verify visibility/enabled/unobstructed, and click Share Bet
  for (let round = 1; round <= 3; round++) {
    const acc = await acceptBetslipChanges(page);
    out.acceptChangesClicks += acc.clicks;
    allAcceptAttempts.push(...acc.attempts);
    out.shareDiag.acceptChanges = {
      clicks: out.acceptChangesClicks,
      stillVisible: acc.stillVisible,
      attempts: allAcceptAttempts,
    };

    if (acc.clicks > 0) {
      const updatedSlipText = await readFullSlipText(page);
      if (updatedSlipText) {
        const recheck = verifySlipText(updatedSlipText, legs);
        out.verifiedLegs = recheck.verified.map((l) => `${l.home} v ${l.away} (${l.outcome})`);
        out.missingLegs = recheck.missing.map((l) => `${l.home} v ${l.away} (${l.outcome})`);
        if (!recheck.ok) {
          await site.shot(page, 'book_slip_verify_failed');
          const names = recheck.missing.map((l) => `${l.home} v ${l.away}`).join(', ');
          return {
            ...out,
            why: `Betslip verification failed after Accept Changes (${recheck.verified.length}/${legs.length} verified); missing: ${names}`,
          };
        }
      }
    }

    lastSlipState = await inspectBetslipState(page, panel.opened);
    out.shareDiag.overlaysDetected = lastSlipState.overlays;
    out.shareDiag.betslipState = {
      opened: lastSlipState.slipOpen,
      selector: panel.selector,
      tabMode,
      hasChangesBanner: lastSlipState.hasChangesBanner,
      acceptChangesClicks: out.acceptChangesClicks,
      stillShowingAcceptChanges: acc.stillVisible,
    };

    if (!lastSlipState.slipOpen) {
      const reopened = await openFullBetslip(page);
      if (!reopened.opened) break;
      await sleep(400);
    }

    if (acc.stillVisible) {
      if (round < 3) { await sleep(800); continue; }
      await site.shot(page, 'book_after_share');
      return {
        ...out,
        why: 'BangBet betslip still displayed "Accept Changes" (live odds/availability kept changing) after repeated attempts; Share Bet was not available.',
      };
    }

    lastShareCtrl = await locateShareBetControl(page);
    if (lastShareCtrl.found && !lastShareCtrl.unobstructed && typeof site.dismiss === 'function') {
      await site.dismiss(page).catch(() => {});
      await sleep(350);
      lastShareCtrl = await locateShareBetControl(page);
    }

    out.shareDiag.shareButtonDiscovery = {
      found: lastShareCtrl.found,
      visible: lastShareCtrl.visible,
      enabled: lastShareCtrl.enabled,
      unobstructed: lastShareCtrl.unobstructed,
      coveredBy: lastShareCtrl.coveredBy,
      locatorUsed: lastShareCtrl.locatorUsed,
      rect: lastShareCtrl.rect,
      candidatesChecked: lastShareCtrl.candidatesChecked,
      round,
    };

    if (lastShareCtrl.found && lastShareCtrl.visible && lastShareCtrl.enabled && lastShareCtrl.locator) {
      let okClick = await lastShareCtrl.locator.click({ timeout: 4500 }).then(() => true).catch(() => false);
      if (!okClick && lastShareCtrl.unobstructed) {
        okClick = await lastShareCtrl.locator.evaluate((node) => { node.click(); return true; }).catch(() => false);
      }
      if (okClick) {
        clickedShare = true;
        break;
      }
    }

    // Before retrying, wait briefly for any in-flight odds tick or DOM update to settle
    if (round < 3) await sleep(900);
  }
  out.clickedShare = clickedShare;

  if (!clickedShare) {
    await site.shot(page, 'book_after_share');
    const detailParts = [];
    if (lastSlipState && !lastSlipState.slipOpen) detailParts.push('betslip drawer collapsed');
    if (lastShareCtrl && lastShareCtrl.found && !lastShareCtrl.enabled) detailParts.push(`button disabled (${lastShareCtrl.locatorUsed})`);
    if (lastShareCtrl && lastShareCtrl.found && !lastShareCtrl.unobstructed) detailParts.push(`button covered by ${lastShareCtrl.coveredBy || 'overlay'}`);
    if (lastSlipState && lastSlipState.hasChangesBanner) detailParts.push('betslip showed odds/availability change banner');
    const suffix = detailParts.length ? ` (${detailParts.join('; ')})` : '';
    return {
      ...out,
      why: `Every selection was verified in the betslip, but the BangBet Share Bet button was not visible or clickable${suffix}.`,
    };
  }

  // Poll up to 8s for the .book-code modal OR BangBet share-code network response to appear
  const waitShareStart = Date.now();
  while (Date.now() - waitShareStart < 8000) {
    const hasModal = await page.evaluate(() => {
      const m = document.querySelector('.book-code');
      if (!m) return false;
      const r = m.getBoundingClientRect();
      return r.width > 50 && r.height > 50 && (m.innerText || '').trim().length > 4;
    }).catch(() => false);
    if (hasModal) break;
    const netHit = page.net.slice(mark).some((r) => /bookcode|share|booking/i.test(String(r.url || '')));
    if (netHit) {
      await sleep(500);
      break;
    }
    await sleep(300);
  }

  // If BangBet shows a "Copy Link" button inside the Share Bet modal, click it to populate clipboard as well
  try {
    const cp = page.getByText(/^copy\s*link$/i).first();
    if ((await cp.count()) && (await cp.isVisible())) {
      await cp.click({ timeout: 2000 }).catch(() => {});
      await sleep(500);
    }
  } catch (_) {}

  const rawModalText = await page.evaluate(() => {
    const m = document.querySelector('.book-code');
    if (!m) return '';
    const r = m.getBoundingClientRect();
    return (r.width > 50 && r.height > 50) ? (m.innerText || '').trim() : '';
  }).catch(() => '');
  const modalText = typeof rawModalText === 'string' ? rawModalText : '';
  const rawBodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const text = typeof rawBodyText === 'string' ? rawBodyText : '';
  const rawVals = await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea')).map((i) => i.value).filter(Boolean)).catch(() => []);
  const vals = Array.isArray(rawVals) ? rawVals : [];
  const rawClip = await page.evaluate(() => navigator.clipboard ? navigator.clipboard.readText().catch(() => '') : '').catch(() => '');
  const clip = typeof rawClip === 'string' ? rawClip : '';
  const hay = [modalText, text, ...vals, clip].join('\n');

  let codeSource = '';
  // 1) Match BangBet's canonical share URL (both with and without https:// scheme, e.g. www.bangbet.com/bookcode/Mmptud)
  const bookUrlM = hay.match(/(?:https?:\/\/)?(?:www\.)?bangbet\.com\/bookcode\/([A-Za-z0-9]{4,12})\b/i);
  if (bookUrlM) {
    out.link = bookUrlM[0].startsWith('http') ? bookUrlM[0] : `https://${bookUrlM[0]}`;
    if (isPlausibleCode(bookUrlM[1], true)) {
      out.code = bookUrlM[1];
      codeSource = 'bookcode_url';
    }
  }
  if (!out.link) {
    const u = hay.match(/https?:\/\/[^\s"'<>]*bangbet[^\s"'<>]*/i);
    if (u) out.link = u[0];
  }
  // 2) Match inside BangBet's visible .book-code modal (preserves exact case & allows valid all-alpha codes)
  if (!out.code && modalText) {
    const mc = modalText.match(/booking\s*code\s*[:-]?\s*([A-Za-z0-9]{4,12})\b/i);
    if (mc && isPlausibleCode(mc[1], true)) {
      out.code = mc[1];
      codeSource = 'book_code_modal';
    }
  }
  // 3) Check network JSON responses triggered by Share Bet
  const shareNetEntries = [];
  for (const r of page.net.slice(mark)) {
    const u = sanitizeUrlForDiag(r.url || '');
    if (/book|share|slip|bet/i.test(u)) shareNetEntries.push({ url: u, status: r.status || 200 });
    walk(r.body, (o) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        if (/^(booking|bet|share)_?code$|^shareCode$|^bookCode$/i.test(k) && isPlausibleCode(v, true) && !out.code) {
          out.code = v.trim();
          codeSource = `network_json:${k}`;
        }
        if (/(link|url|shareUrl)/i.test(k) && /bangbet/i.test(v) && !out.link) out.link = v.trim();
      }
    });
  }
  out.shareDiag.shareBetResponse = shareNetEntries.slice(0, 6);
  // 4) Fallback generic text regex (requires digit to avoid false UI word matches)
  if (!out.code) {
    const c = hay.match(/(?:booking|bet|share)\s*code\s*[:-]?\s*([A-Za-z0-9]{4,12})\b/i);
    if (c && isPlausibleCode(c[1], false)) {
      out.code = c[1];
      codeSource = 'body_text_regex';
    }
  }
  if (!out.code && out.link) {
    const qm = out.link.match(/[?&](?:shareCode|bookingCode|code)=([A-Za-z0-9]{4,12})\b/i);
    if (qm && isPlausibleCode(qm[1], true)) {
      out.code = qm[1];
      codeSource = 'link_query_param';
    }
  }
  out.shareDiag.codeExtraction = {
    ok: !!out.code,
    source: codeSource,
    code: out.code,
    link: out.link,
    modalVisible: modalText.length > 0,
  };
  await site.shot(page, 'book_after_share');
  return out;
}

const MAX_TICKET_SELECTIONS = 50;

// Independently verify a returned BangBet share code in a clean isolated browser context
// (no shared localStorage betslip) by loading https://www.bangbet.com/bookcode/<code>
// and confirming the loaded betslip count and selections match the intended ticket.
async function verifyBookingCode(site, code, legs) {
  if (!code || !site || !site.browser) {
    return { ok: false, loadedCount: 0, verifiedCount: 0, missingLegs: [], why: 'no browser or code available for independent verification' };
  }
  let ctx = null;
  try {
    ctx = await site.browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      locale: 'en-UG',
      timezoneId: 'Africa/Kampala',
    });
    // Block heavy images/media/fonts/trackers in the isolated verification context so BangBet's SPA boots rapidly
    const blockedDomains = /(adjust\.com|zendesk\.com|zdassets\.com|googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.net|connect\.facebook|hotjar\.com|tiktok\.com|sentry\.io|firebaseinstallations\.googleapis\.com|googlesyndication\.com)/i;
    const blockedTypes = new Set(['image', 'media', 'font']);
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (blockedTypes.has(req.resourceType()) || blockedDomains.test(req.url())) {
        return route.abort().catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    const page = await ctx.newPage();
    // Load BangBet Uganda mobile directly with ?bookingCode=<code> (canonical target of /bookcode/<code>)
    await page.goto(`https://www.bangbet.com/ug-m/?bookingCode=${encodeURIComponent(code)}`, { waitUntil: 'commit', timeout: 35000 }).catch(() => {});
    await page.locator('.betslip-container:visible, .betslip-wrapper:visible, .betslip-nav-container:visible, [class*="betslip-nav" i]:visible').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
    await sleep(1000);
    if (typeof site.dismiss === 'function') await site.dismiss(page).catch(() => {});
    const readFullSlipText = async () => page.evaluate(() => {
      for (const sel of ['.betslip-container', '.betslip-wrapper']) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().height > 200) return (el.innerText || '').trim();
      }
      return '';
    }).catch(() => '');

    // Wait up to 8s for ?bookingCode=<code> to auto-populate the betslip count or drawer
    let loadedCount = 0;
    let slipText = '';
    const autoWaitStart = Date.now();
    while (Date.now() - autoWaitStart < 8000) {
      loadedCount = await readSlipCount(page);
      slipText = await readFullSlipText();
      if (loadedCount > 0 || slipText.length > 40) break;
      await sleep(400);
    }

    // If ?bookingCode= populated the badge (loadedCount > 0) while drawer is closed, open the full betslip drawer now
    if (loadedCount > 0 && slipText.length < 40) {
      await openFullBetslip(page);
      await sleep(700);
      slipText = await readFullSlipText();
    }

    // If ?bookingCode= did not auto-populate the slip, open betslip and submit via BangBet's "Load Code" input
    let preCheck = verifySlipText(slipText, legs);
    if (!preCheck.ok && loadedCount === 0) {
      if (!slipText) {
        await openFullBetslip(page);
        await sleep(600);
      }
      try {
        const loadTab = page.getByText(/^load\s*code$/i).first();
        if ((await loadTab.count().catch(() => 0)) && (await loadTab.isVisible().catch(() => false))) {
          await loadTab.click({ timeout: 3000 }).catch(() => {});
          await sleep(600);
        }
      } catch (_) {}
      const input = page.locator('input[placeholder*="code" i]:visible, .betslip-container input:visible, .betslip-wrapper input:visible').first();
      await input.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      if (await input.count().catch(() => 0)) {
        await input.fill(code).catch(() => {});
        await sleep(400);
        const loadBtn = page.locator('.betslip-container, .betslip-wrapper').getByText(/^load(\s*code)?$/i).last();
        if (await loadBtn.count().catch(() => 0)) {
          await loadBtn.click({ timeout: 4000 }).catch(() => {});
        } else {
          await page.getByText(/^load$/i).first().click({ timeout: 4000 }).catch(() => {});
        }
      }
    }

    // Wait up to 15s for BangBet to finish rendering all loaded selections in the full betslip drawer
    const waitStart = Date.now();
    let openedDrawerInWait = false;
    while (Date.now() - waitStart < 15000) {
      loadedCount = await readSlipCount(page);
      slipText = await readFullSlipText();
      if (loadedCount > 0 && slipText.length < 40 && !openedDrawerInWait) {
        openedDrawerInWait = true;
        await openFullBetslip(page);
        await sleep(600);
        slipText = await readFullSlipText();
      }
      const checkNow = verifySlipText(slipText, legs);
      if (checkNow.ok && (loadedCount === legs.length || slipText.length > 30)) break;
      await sleep(500);
    }
    const bodyText = slipText || await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (loadedCount === 0 && slipText) {
      const hm = slipText.match(/\bbetslip\s+(\d{1,2})\b/i);
      if (hm) loadedCount = Number(hm[1]);
    }
    const v = verifySlipText(bodyText, legs);
    const countOk = loadedCount === legs.length || (loadedCount === 0 && v.ok && slipText.length > 20);
    return {
      ok: !!(v.ok && countOk),
      loadedCount,
      verifiedCount: v.verified.length,
      missingLegs: v.missing.map((l) => `${l.home} v ${l.away} (${l.outcome})`),
      why: v.ok && countOk
        ? ''
        : `Independent code check failed for ${code}: loadedCount=${loadedCount} (expected ${legs.length}), verified=${v.verified.length}/${legs.length}`,
    };
  } catch (e) {
    return { ok: false, loadedCount: 0, verifiedCount: 0, missingLegs: [], why: `Independent code check error: ${e.message}` };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function book(site, legs, deadline, scope = 'today', req = null, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const res = {
    ok: false, code: '', link: '', added: 0, total: 1, why: '', changes: [],
    addedLegs: [],
    unavailableLegs: [],
    failedLegs: [],
    verifiedLegs: [], missingLegs: [],
    codeVerifiedIndependently: false,
    diagnostics: {
      startedAt: new Date().toISOString(),
      expectedLegs: Array.isArray(legs) ? legs.length : 0,
      finalSelectedCount: Array.isArray(legs) ? legs.length : 0,
      actualCombinedOdds: 0,
      selectionsAdded: 0,
      selectionsVerified: 0,
      legAttempts: [],
      slipCountBeforeShare: 0,
      betslipState: null,
      acceptChangesClicks: 0,
      clickedShare: false,
      shareButtonDiscovery: null,
      overlaysDetected: [],
      browserErrors: [],
      networkErrors: [],
      shareBetResponse: null,
      codeExtraction: null,
      independentCheck: null,
      failureStage: '',
    },
  };
  if (!Array.isArray(legs) || !legs.length) {
    res.why = 'no selections to book';
    res.diagnostics.failureStage = 'validation';
    return res;
  }
  if (legs.length > MAX_TICKET_SELECTIONS) {
    res.why = `selection count ${legs.length} exceeds BangBet maximum of ${MAX_TICKET_SELECTIONS}`;
    res.diagnostics.failureStage = 'validation';
    return res;
  }
  const page = await site.newPage();
  const addedLegObjs = [];
  let abortedUnsafe = false;
  // Capture sanitized browser & network diagnostics (never exposing auth tokens or credentials)
  if (typeof page.on === 'function') {
    page.on('pageerror', (err) => {
      if (res.diagnostics.browserErrors.length < 20) {
        res.diagnostics.browserErrors.push(String(err && err.message ? err.message : err).slice(0, 200));
      }
    });
    page.on('console', (msg) => {
      if (msg && typeof msg.type === 'function' && msg.type() === 'error' && res.diagnostics.browserErrors.length < 20) {
        res.diagnostics.browserErrors.push(String(msg.text ? msg.text() : '').slice(0, 200));
      }
    });
    page.on('requestfailed', (request) => {
      if (res.diagnostics.networkErrors.length < 20 && request && typeof request.url === 'function') {
        const u = sanitizeUrlForDiag(request.url());
        if (/bangbet/i.test(u)) {
          const failure = request.failure ? request.failure() : null;
          res.diagnostics.networkErrors.push({ url: u, error: (failure && failure.errorText) || 'requestfailed' });
        }
      }
    });
    page.on('response', (response) => {
      if (res.diagnostics.networkErrors.length < 20 && response && typeof response.status === 'function' && response.status() >= 400) {
        const u = sanitizeUrlForDiag(response.url ? response.url() : '');
        if (/bangbet/i.test(u)) {
          res.diagnostics.networkErrors.push({ url: u, status: response.status() });
        }
      }
    });
  }
  try {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (Date.now() > deadline) {
        res.why = 'time ran out while building the betslip';
        res.diagnostics.failureStage = 'deadline';
        abortedUnsafe = true;
        break;
      }
      if (onProgress) {
        const liveOdds = addedLegObjs.length ? Math.round(res.total * 100) / 100 : 0;
        await onProgress(
          'preparing_betslip',
          `Adding selections to betslip (${res.added}/${legs.length} added${liveOdds > 0 ? ` · odds ${liveOdds.toFixed(2)}` : ''}${res.unavailableLegs.length ? `, ${res.unavailableLegs.length} unavailable` : ''})`,
          res.added,
          legs.length,
          res.unavailableLegs.length,
          liveOdds,
          0
        ).catch(() => {});
      }
      const r = await addLeg(site, page, leg, scope, req, res.added).catch((e) => ({
        ok: false, unavailable: false, fatalSlipState: true, why: 'error ' + e.message,
      }));
      if (r.diag) res.diagnostics.legAttempts.push(r.diag);
      console.log(`[book] ${leg.home} v ${leg.away}: ${r.ok ? `added @${r.odds} (slip=${r.slipCount})` : (r.unavailable ? 'UNAVAILABLE ' : 'FAILED ') + r.why}`);
      if (!r.ok) {
        const entry = {
          home: leg.home,
          away: leg.away,
          market: leg.market,
          outcome: leg.outcome,
          approvedMarketId: leg.approvedMarketId || (r.diag && r.diag.approvedMarketId) || '',
          reason: r.why,
        };
        res.missingLegs.push(`${leg.home} v ${leg.away} (${leg.outcome})`);
        if (r.unavailable && !r.fatalSlipState) {
          // Selection unavailable/suspended before clicking -> betslip state remains clean;
          // record exact failure reason without substituting and safely continue remaining legs.
          res.unavailableLegs.push(entry);
          continue;
        }
        // Betslip count confirmation failed or hydrated state mismatch -> unsafe to continue.
        res.failedLegs.push(entry);
        res.why = `${leg.home} v ${leg.away}: ${r.why}`;
        res.diagnostics.failureStage = 'adding_leg';
        abortedUnsafe = true;
        break;
      }
      res.added++;
      res.total *= r.odds;
      addedLegObjs.push({ ...leg, odds: r.odds });
      res.addedLegs.push(`${leg.home} v ${leg.away} — ${leg.market}: ${leg.outcome} @${r.odds}`);
      if (r.changed) res.changes.push(`${leg.home} v ${leg.away}: ${leg.odds} to ${r.odds}`);
    }

    res.diagnostics.selectionsAdded = res.added;
    res.diagnostics.actualCombinedOdds = addedLegObjs.length ? Math.round(res.total * 100) / 100 : 0;

    if (!abortedUnsafe && addedLegObjs.length > 0) {
      const liveOdds = Math.round(res.total * 100) / 100;
      res.diagnostics.slipCountBeforeShare = await readSlipCount(page);
      if (onProgress) {
        await onProgress(
          'verifying_betslip',
          `Verifying betslip (${res.added}/${legs.length} added · live odds ${liveOdds.toFixed(2)})`,
          res.added,
          legs.length,
          res.unavailableLegs.length,
          liveOdds,
          0
        ).catch(() => {});
      }
      const s = await share(site, page, addedLegObjs);
      res.diagnostics.acceptChangesClicks = s.acceptChangesClicks || 0;
      res.diagnostics.clickedShare = !!s.clickedShare;
      res.diagnostics.unexpectedSelectionsDetected = !!s.unexpectedSelectionsDetected;
      if (s.shareDiag) {
        res.diagnostics.betslipState = s.shareDiag.betslipState;
        res.diagnostics.shareButtonDiscovery = s.shareDiag.shareButtonDiscovery;
        res.diagnostics.overlaysDetected = s.shareDiag.overlaysDetected || [];
        res.diagnostics.shareBetResponse = s.shareDiag.shareBetResponse;
        res.diagnostics.codeExtraction = s.shareDiag.codeExtraction;
      }
      res.code = s.code;
      res.link = s.link;
      res.verifiedLegs = s.verifiedLegs || [];
      res.diagnostics.selectionsVerified = res.verifiedLegs.length;
      const slipMissing = s.missingLegs || [];
      for (const m of slipMissing) {
        if (!res.missingLegs.includes(m)) res.missingLegs.push(m);
      }

      if (s.code && slipMissing.length === 0 && !s.unexpectedSelectionsDetected) {
        if (onProgress) {
          await onProgress(
            'verifying_share_code',
            `Independently verifying share code ${s.code} (${res.verifiedLegs.length}/${addedLegObjs.length} verified)`,
            res.added,
            legs.length,
            res.unavailableLegs.length,
            liveOdds,
            res.verifiedLegs.length
          ).catch(() => {});
        }
        const ind = await verifyBookingCode(site, s.code, addedLegObjs);
        res.diagnostics.independentCheck = ind;
        res.codeVerifiedIndependently = !!ind.ok;
        if (ind.ok) {
          res.ok = true;
        } else {
          res.ok = false;
          res.code = '';
          res.diagnostics.failureStage = 'independent_code_verification';
          res.why = ind.why || `Independent verification failed for code ${s.code}`;
        }
      } else {
        res.ok = false;
        res.diagnostics.failureStage = slipMissing.length > 0 ? 'slip_verification' : 'share_code_extraction';
        res.why = s.why || 'every added selection was verified in the betslip, but BangBet did not return a booking code. A share link alone is not confirmation.';
      }
    } else if (!res.why) {
      res.diagnostics.failureStage = 'all_selections_unavailable';
      res.why = res.unavailableLegs.length > 0
        ? `0 of ${legs.length} selections could be added (${res.unavailableLegs.length} unavailable: ${res.unavailableLegs[0].reason})`
        : `${res.added} of ${legs.length} selections added`;
    }
  } finally {
    res.diagnostics.finishedAt = new Date().toISOString();
    await page.close().catch(() => {});
  }
  res.total = addedLegObjs.length ? Math.round(res.total * 100) / 100 : 0;
  return res;
}

module.exports = {
  book,
  addLeg,
  share,
  verifyBookingCode,
  openFullBetslip,
  readSlipCount,
  waitForHydratedSlipCount,
  scrollTargetUnobstructed,
  findVisibleAcceptChanges,
  acceptBetslipChanges,
  locateShareBetControl,
  inspectBetslipState,
  normalizeSlipText,
  verifySlipText,
};
