'use strict';
const fs = require('fs');
const path = require('path');
const ex = require('./lib/extract');
const an = require('./lib/analyze');
const tk = require('./lib/ticket');
const bk = require('./lib/book');
const gist = require('./lib/gist');
const { norm } = require('./lib/util');

const VALID_SPORTS = ['football', 'basketball', 'tennis', 'baseball', 'hockey'];
const VALID_SCOPES = ['today', 'tomorrow', 'weekend', 'next3days', 'next7days', 'week', 'next3hours', 'next6hours', 'all', 'date', 'range'];

// Parse YYYY-MM-DD in local timezone (TZ=Africa/Kampala in CI) without UTC midnight drift.
function parseLocalYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(y, mo - 1, da, 0, 0, 0, 0);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

function computeWindow(req, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = (n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0).getTime();
  switch (req.scope) {
    case 'next3hours': return [nowMs, nowMs + 3 * 60 * 60 * 1000];
    case 'next6hours': return [nowMs, nowMs + 6 * 60 * 60 * 1000];
    case 'today': return [nowMs - 5 * 60 * 1000, day(1)];
    case 'tomorrow': return [day(1), day(2)];
    case 'next3days': return [nowMs - 5 * 60 * 1000, day(3)];
    case 'next7days':
    case 'week': return [nowMs - 5 * 60 * 1000, day(7)];
    case 'weekend': {
      const dow = d.getDay(); // 0=Sun, 6=Sat
      if (dow === 0) return [nowMs - 5 * 60 * 1000, day(1)];
      const toSat = (6 - dow + 7) % 7;
      const start = toSat === 0 ? (nowMs - 5 * 60 * 1000) : day(toSat);
      return [start, day(toSat + 2)];
    }
    case 'date': {
      const target = parseLocalYmd(req.date);
      if (!target) return [nowMs, day(1)];
      const start = target.getTime();
      const end = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1, 0, 0, 0, 0).getTime();
      return [start, end];
    }
    case 'range': {
      const fromD = parseLocalYmd(req.dateFrom);
      const toD = parseLocalYmd(req.dateTo || req.dateFrom);
      if (!fromD || !toD) return [nowMs, day(7)];
      const start = fromD.getTime();
      const end = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1, 0, 0, 0, 0).getTime();
      return [start, Math.max(start + 86400000, end)];
    }
    case 'all': return [nowMs - 5 * 60 * 1000, day(30)];
    default: return [nowMs - 5 * 60 * 1000, day(1)];
  }
}

function validateRequest(P, req) {
  if (!Array.isArray(P.sports) || !req.sports.length || req.sports.some((s) => !VALID_SPORTS.includes(s))) {
    throw new Error('The request must name one or more supported sports. No default sport will be guessed.');
  }
  if (!VALID_SCOPES.includes(req.scope)) {
    throw new Error('Unsupported date period: ' + req.scope + '. Choose today, tomorrow, weekend, next 3 days, next 7 days, a specific date, a date range or all.');
  }
  if (req.scope === 'date' && !parseLocalYmd(req.date)) {
    throw new Error('Invalid specific date. Expected YYYY-MM-DD format.');
  }
  if (req.scope === 'range') {
    const f = parseLocalYmd(req.dateFrom);
    const t = parseLocalYmd(req.dateTo);
    if (!f || !t || t.getTime() < f.getTime()) {
      throw new Error('Invalid date range. Expected valid YYYY-MM-DD dateFrom and dateTo.');
    }
  }
  if (P.target != null && Number(P.target) !== 0 && (!Number.isFinite(Number(P.target)) || Number(P.target) < 1 || Number(P.target) > 10000)) {
    throw new Error('Invalid combined-odds target. The requested target must be between 1 and 10000.');
  }
  if (P.count != null && Number(P.count) !== 0 && (!Number.isInteger(Number(P.count)) || Number(P.count) < 1 || Number(P.count) > 100)) {
    throw new Error('Invalid selection count. It must be a whole number from 1 to 100.');
  }
  if (P.markets != null && (!Array.isArray(P.markets) || P.markets.some((m) => typeof m !== 'string'))) {
    throw new Error('Invalid market filter list. Markets must be an array of market names.');
  }
}

const TOP = /(premier|champions|europa|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira|championship|nba|euroleague|atp|wta|nhl|mlb)/i;
const VIRTUAL_RE = /\b(srl|simulated\s+reality|virtual|e-?football|e-?soccer|esports?|cyber)\b/i;
function isVirtualFixture(ev) {
  if (!ev) return false;
  const text = `${ev.country || ''} ${ev.league || ''} ${ev.home || ''} ${ev.away || ''}`;
  return VIRTUAL_RE.test(text);
}
const prio = (e) => (!isVirtualFixture(e) && TOP.test(`${e.country} ${e.league}`) ? 0 : 1);

function tallyRejections(allEvents, cands, state) {
  const why = {};
  for (const e of allEvents) if (e.rejected) why[e.rejected] = (why[e.rejected] || 0) + 1;
  state.counts.opened = allEvents.filter((e) => e.opened).length;
  state.counts.statsCaptured = allEvents.reduce((acc, e) => acc + ((e.stats && e.stats.responseCount) || 0), 0);
  state.counts.teamsIdentified = allEvents.filter((e) => e.stats && e.stats.categories && e.stats.categories.teamIdentity).length;
  state.counts.historicalExtracted = allEvents.filter((e) => e.stats && e.stats.categories && (e.stats.categories.recentMatches || e.stats.categories.headToHead)).length;
  state.counts.withStats = allEvents.filter((e) => e.stats && e.stats.available).length;
  state.counts.withMarkets = allEvents.filter((e) => e.markets && e.markets.length).length;
  state.counts.evaluated = allEvents.filter((e) => e.evaluated).length;
  state.counts.candidates = cands.length;
  state.counts.rejected = allEvents.filter((e) => !!e.rejected).length;
  state.counts.rejectionReasons = why;
  return why;
}

async function notify(title, body, data = null) {
  const f = path.join(__dirname, '..', 'notify', 'out.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([{ title, body, ...(data ? { data } : {}) }]));
}

async function main() {
  const { Site, OUT } = require('./lib/site');
  const { PhoneGatewayServer } = require('./lib/gateway');
  const job = JSON.parse(process.env.JOB || '{}');
  const ID = process.env.JOB_ID || job.id || 'manual';
  const P = job.params || job;
  const req = {
    sports: Array.isArray(P.sports) ? P.sports : [],
    scope: P.scope || 'today',
    date: P.date || '',
    dateFrom: P.dateFrom || '',
    dateTo: P.dateTo || '',
    markets: Array.isArray(P.markets) ? P.markets.filter((m) => typeof m === 'string' && m.trim()) : [],
    target: Number(P.target) || 0,
    count: Number(P.count) || 0,
    minutes: Math.min(105, Math.max(5, Number(P.minutes) || 105)),
    noBook: !!P.noBook,
    usePhoneGateway: P.usePhoneGateway === true || process.env.USE_PHONE_GATEWAY === '1',
    dataLimitMb: Number(P.dataLimitMb) > 0 ? Math.min(2000, Math.max(1, Number(P.dataLimitMb))) : 200,
    text: job.text || '',
  };
  const started = Date.now();
  const deadline = started + req.minutes * 60000;
  const log = (...a) => console.log('[run]', ...a);

  const state = {
    id: ID, status: 'running', stage: 'Understanding request', stages: [], request: req, started, updated: started,
    counts: {
      discovered: 0, virtualExcluded: 0, inWindow: 0, displayed: 0, opened: 0,
      statsInspected: 0, statsCaptured: 0, teamsIdentified: 0, historicalExtracted: 0, withStats: 0,
      marketsInspected: 0, withMarkets: 0,
      evaluated: 0, candidates: 0, accepted: 0, selections: 0,
      rejected: 0, rejectionReasons: {},
      combinedOdds: 0, targetOdds: req.target,
      exhaustedAllFixtures: false, timedOut: false,
    },
    gateway: null,
    ticket: null, booking: null, error: '', notes: [],
  };
  let gw = null;
  let lastSave = 0;
  async function save(force) {
    state.updated = Date.now();
    if (gw) {
      const s = gw.status();
      state.gateway = { ...(state.gateway || {}), ...s };
    }
    if (!force && state.updated - lastSave < 4000) return;
    lastSave = state.updated;
    await gist.save(ID, state).catch((e) => log('gist', e.message));
  }
  async function stage(s) {
    if (state.stages.length) state.stages[state.stages.length - 1].ok = true;
    state.stage = s;
    state.stages.push({ s, ok: false, t: Date.now() });
    log(s);
    await save(true);
  }

  const withTimeout = (p, ms, msg) => {
    let timer;
    return Promise.race([
      p,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); }),
    ]).finally(() => clearTimeout(timer));
  };

  const site = new Site();
  try {
    await save(true);
    await stage('Understanding request');
    validateRequest(P, req);
    log('request:', JSON.stringify(req));

    let proxyServer = '';
    if (req.usePhoneGateway) {
      await stage('Starting phone gateway tunnel');
      gw = new PhoneGatewayServer({ limitMb: req.dataLimitMb });
      const info = await gw.start({ useCloudflared: process.env.GATEWAY_LOCAL_ONLY !== '1' });
      proxyServer = info.proxyUrl;
      state.gateway = {
        ...gw.status(),
        gatewayUrl: info.gatewayUrl,
        gatewayToken: info.gatewayToken,
      };
      await stage('Waiting for phone gateway connection');
      const connected = await gw.waitForPhone(120000);
      if (!connected) {
        state.status = 'gateway_disconnected';
        state.error = 'Phone gateway did not connect within 120 seconds. Research stopped without falling back to direct cloud browsing.';
        await notify(
          'BETBRAIN | EXECUTION ALERT',
          'Research could not complete.\nThe research engine encountered a connection or data extraction problem. Review the execution report.',
          { route: 'chat', jobId: ID }
        );
        return;
      }
      log('Phone gateway connected via zero-cost tunnel.');
    }

    await site.start({ proxyServer, optimizeData: true });

    // Target-driven interleaved discovery & inspection:
    // Loads fixtures in progressive batches (no artificial 30-match or 500-match cap),
    // inspects each fixture (Stats -> Markets -> Analysis -> Combined Odds), stops early
    // as soon as a low target is reached, and keeps scrolling beyond 30+ fixtures for larger targets.
    await stage('Discovering & inspecting matches');
    const [from, to] = computeWindow(req, started);
    const allEvents = [];
    const cands = [];
    let evIdx = 0;
    let targetMet = false;
    // Use concurrency=1 over PhoneGateway to preserve mobile tunnel stability and latency;
    // preserve concurrency=3 for Cloud Direct.
    const CONCURRENCY = req.usePhoneGateway ? 1 : 3;
    const workerPages = [];
    for (let w = 0; w < CONCURRENCY; w++) workerPages.push(await site.newPage());

    const inspectOne = async (wIdx, ev) => {
      let page = workerPages[wIdx];
      let timedOut = false;
      try {
        const opened = await withTimeout(
          site.openEvent(page, ev, req.scope, req),
          25000,
          'match page navigation timed out after 25s'
        );
        if (!opened) {
          ev.rejected = 'could not open or verify the match page';
          ev.statsStatus = 'navigation_failed';
          ev.marketsStatus = 'navigation_failed';
        } else {
          ev.opened = true;
          ev.url = ev.url || page.url();

          // Inspect Markets FIRST (BangBet lands on Markets by default) and Stats SECOND — INDEPENDENTLY.
          // A match can have readable markets even when stats are unavailable, and vice versa.
          state.counts.marketsInspected++;
          ev.markets = await withTimeout(
            ex.markets(page, ev),
            15000,
            'markets inspection timed out'
          ).catch((e) => {
            if (/timed out/i.test(e.message)) timedOut = true;
            ev.marketsStatus = /timed out/i.test(e.message) ? 'timeout' : 'error';
            return [];
          });
          if (!ev.marketsStatus) ev.marketsStatus = ev.markets.length > 0 ? 'available' : 'empty';

          state.counts.statsInspected++;
          ev.stats = await withTimeout(
            ex.stats(page, ev, { viaPhoneGateway: req.usePhoneGateway }),
            req.usePhoneGateway ? 20000 : 15000,
            'stats inspection timed out'
          ).catch((e) => {
            if (/timed out/i.test(e.message)) timedOut = true;
            return { available: false, err: e.message };
          });
          ev.statsStatus = (ev.stats && ev.stats.available)
            ? 'available'
            : (ev.stats && ev.stats.err && /timed out/i.test(ev.stats.err)
              ? 'timeout'
              : (ev.stats && ev.stats.tab === false ? 'tab_missing' : 'unavailable'));

          if (ev.stats && ev.stats.available && ev.markets.length > 0) {
            ev.evaluated = true;
            cands.push(...an.candidates(ev, req));
          } else if (!ev.stats || !ev.stats.available) {
            ev.rejected = ev.markets.length > 0
              ? 'markets extracted, but BangBet Stats tab did not provide readable statistics'
              : 'neither readable statistics nor markets were available on BangBet';
          } else {
            ev.rejected = 'statistics extracted, but no readable markets were offered';
          }
          page.net.splice(0);
        }
      } catch (e) {
        ev.rejected = 'error: ' + e.message;
        if (/timed out/i.test(e.message)) timedOut = true;
      }
      if (timedOut) {
        await page.close().catch(() => {});
        workerPages[wIdx] = await site.newPage();
      }
    };

    try {
      for (const sport of req.sports) {
        if (Date.now() > deadline || targetMet) break;
        let listing = null;
        try {
          listing = await site.openListing(sport, req);
          while (Date.now() < deadline && !targetMet) {
            const rawBatch = await site.collectNextBatch(listing, deadline, 30);
            state.counts.discovered += rawBatch.length;

            const realBatch = rawBatch.filter((e) => {
              if (isVirtualFixture(e)) {
                state.counts.virtualExcluded++;
                return false;
              }
              return true;
            });
            const windowBatch = realBatch
              .filter((e) => !e.ts || (e.ts >= from && e.ts < to))
              .map((e) => ({ ...e, key: `${e.sport}:${norm(e.home)}:${norm(e.away)}:${evIdx++}` }));
            windowBatch.sort((a, b) => prio(a) - prio(b) || (a.ts || 9e15) - (b.ts || 9e15));
            allEvents.push(...windowBatch);
            state.counts.inWindow = allEvents.length;
            state.counts.displayed = allEvents.length;

            // Parallel worker pool: each worker uses its own isolated page and stops as soon as targetMet is true
            let cursor = 0;
            const runWorker = async (wIdx) => {
              while (!targetMet && Date.now() < deadline) {
                if (gw && (gw.limitReached || (!gw.connected && gw.disconnectedAt && Date.now() - gw.disconnectedAt > 45000))) {
                  break;
                }
                const idx = cursor++;
                if (idx >= windowBatch.length) break;
                await inspectOne(wIdx, windowBatch[idx]);

                state.counts.opened = allEvents.filter((x) => x.opened).length;
                state.counts.withStats = allEvents.filter((x) => x.stats && x.stats.available).length;
                state.counts.withMarkets = allEvents.filter((x) => x.markets && x.markets.length).length;
                state.counts.evaluated = allEvents.filter((x) => x.evaluated).length;
                const progressTicket = tk.build(cands, req);
                state.counts.candidates = cands.length;
                state.counts.accepted = progressTicket.legs.length;
                state.counts.selections = progressTicket.legs.length;
                state.counts.combinedOdds = Math.round(progressTicket.total * 100) / 100;

                state.stage = `Inspected ${state.counts.opened}/${state.counts.inWindow} (${state.counts.discovered} found); stats ${state.counts.withStats}, markets ${state.counts.withMarkets}, ${progressTicket.legs.length} picks, odds ${state.counts.combinedOdds}${req.target ? '/' + req.target : ''}`;
                await save(false);

                if ((req.target > 0 || req.count > 0) && progressTicket.complete) {
                  state.counts.targetReachedAfter = state.counts.opened;
                  targetMet = true;
                  break;
                }
              }
            };
            await Promise.all(workerPages.map((_, wIdx) => runWorker(wIdx)));

            if (targetMet || listing.exhausted || rawBatch.length === 0) break;
          }
        } catch (e) {
          site.notes.push(`${sport}: ${e.message}`);
        } finally {
          if (listing && listing.page) await listing.page.close().catch(() => {});
        }
      }
    } finally {
      await Promise.all(workerPages.map((p) => p.close().catch(() => {})));
    }

    if (gw && gw.limitReached) {
      tallyRejections(allEvents, cands, state);
      state.status = 'data_limit_reached';
      state.error = `Stopped forwarding research traffic at the configured mobile data limit (${gw.usedMb} / ${gw.limitMb} MB). Research did not complete.`;
      await stage('Stopped — mobile data limit reached');
      await notify(
        'BETBRAIN | EXECUTION ALERT',
        'Research could not complete.\nThe research engine encountered a connection or data extraction problem. Review the execution report.',
        { route: 'chat', jobId: ID }
      );
      return;
    }
    if (gw && !gw.connected && !targetMet) {
      tallyRejections(allEvents, cands, state);
      state.status = 'gateway_disconnected';
      state.error = `Phone gateway disconnected after transferring ${gw.usedMb} MB and did not reconnect. Research stopped without falling back to direct cloud browsing.`;
      await stage('Stopped — phone gateway disconnected');
      await notify(
        'BETBRAIN | EXECUTION ALERT',
        'Research could not complete.\nThe research engine encountered a connection or data extraction problem. Review the execution report.',
        { route: 'chat', jobId: ID }
      );
      return;
    }

    if (!allEvents.length) {
      tallyRejections(allEvents, cands, state);
      throw new Error('BangBet displayed no fixtures for the selected Time period. ' + site.notes.join(' | '));
    }

    state.counts.timedOut = Date.now() >= deadline && !targetMet;
    state.counts.exhaustedAllFixtures = !targetMet && !state.counts.timedOut &&
      Object.values(site.discovery).length > 0 &&
      Object.values(site.discovery).every((d) => d.exhausted);

    await stage('Evaluating candidate selections');
    const why = tallyRejections(allEvents, cands, state);

    await stage('Constructing ticket');
    const t = tk.build(cands, req);
    state.counts.accepted = t.legs.length;
    state.counts.selections = t.legs.length;
    state.counts.combinedOdds = Math.round(t.total * 100) / 100;

    if (!t.legs.length) {
      const reasonsText = Object.entries(why).map(([k, v]) => `${v}x ${k}`).join('; ') || 'no fixtures satisfied eligibility thresholds';
      const limitNote = state.counts.timedOut ? ' (execution time limit reached before all fixtures were exhausted)' : '';
      state.status = 'no_qualifying';
      state.error = 'No qualifying selections found' + limitNote + '. Reasons: ' + reasonsText;
      state.ticket = { status: 'empty', note: state.error, total: 0, legs: [] };
      state.booking = { ok: false, why: 'no qualifying selections to book' };
      await stage('Completed — no qualifying selections found');
      state.stages[state.stages.length - 1].ok = true;
      await notify(
        'BETBRAIN | RESEARCH STATUS',
        'Research execution completed.\nNo qualifying ticket was produced because the available selections did not satisfy the evidence requirements.',
        { route: 'chat', jobId: ID }
      );
      return;
    }

    const timeoutNote = state.counts.timedOut ? ' Execution time limit was reached before all fixtures were exhausted.' : '';
    state.ticket = {
      status: t.status, note: `${t.note || ''}${timeoutNote}`.trim(), total: Math.round(t.total * 100) / 100,
      legs: t.legs.map((c) => ({ sport: c.sport, league: c.league, country: c.country, home: c.home, away: c.away, ts: c.ts,
        market: c.market, outcome: c.outcome, odds: c.odds, p: Math.round(c.p * 100), reason: c.reason, facts: c.facts, url: c.url })),
    };
    await save(true);

    if (!t.complete) {
      state.status = 'partial';
      state.booking = {
        ok: false,
        why: state.counts.timedOut
          ? 'execution time limit reached before target/count was met; partial tickets are not booked'
          : 'all available qualifying fixtures were exhausted without reaching target/count; partial tickets are not booked',
      };
      await stage(state.counts.timedOut
        ? 'Partial result — execution time limit reached'
        : 'Partial result — qualifying fixtures exhausted before target');
      state.stages[state.stages.length - 1].ok = true;
      await notify(
        'BETBRAIN | RESEARCH STATUS',
        'Research execution completed.\nNo qualifying ticket was produced because the available selections did not satisfy the evidence requirements.',
        { route: 'chat', jobId: ID }
      );
    } else if (req.noBook) {
      state.status = 'booking_failed';
      state.booking = { ok: false, why: 'betslip preparation was switched off for this job' };
      await stage('Research complete — betslip preparation disabled');
      state.stages[state.stages.length - 1].ok = true;
      await notify(
        'BETBRAIN | RESEARCH STATUS',
        'Research execution completed.\nSelections were researched, but betslip booking was disabled for this job.',
        { route: 'chat', jobId: ID }
      );
    } else {
      await stage('Preparing BangBet betslip');
      state.booking = await bk.book(site, t.legs.map((c, i) => ({ ...state.ticket.legs[i] })), deadline, req.scope, req);
      log('booking:', JSON.stringify(state.booking));
      if (state.booking.ok && state.booking.code) {
        state.status = 'done';
        await stage('Booking code confirmed');
        state.stages[state.stages.length - 1].ok = true;
        await notify(
          'BETBRAIN | RESEARCH PROTOCOL',
          'Research execution completed.\nThe analysis pipeline has completed successfully. A qualifying ticket has been generated and saved. Combined odds and booking reference are ready for retrieval.',
          { route: 'home', jobId: ID, code: state.booking.code }
        );
      } else {
        state.status = 'booking_failed';
        await stage('Selections researched — booking code not confirmed');
        state.stages[state.stages.length - 2].ok = false;
        state.stages[state.stages.length - 1].ok = false;
        await notify(
          'BETBRAIN | EXECUTION ALERT',
          'Research could not complete.\nThe research engine encountered a connection or data extraction problem. Review the execution report.',
          { route: 'chat', jobId: ID }
        );
      }
    }
  } catch (e) {
    state.status = 'failed';
    state.error = e.message;
    log('FAILED', e.message);
    await notify(
      'BETBRAIN | EXECUTION ALERT',
      'Research could not complete.\nThe research engine encountered a connection or data extraction problem. Review the execution report.',
      { route: 'chat', jobId: ID }
    );
  } finally {
    state.notes = site.notes;
    if (gw) {
      const s = gw.status();
      // Remove ephemeral tunnel secret from final persisted state
      state.gateway = s;
    }
    const recon = {
      counts: state.counts, discovery: site.discovery, gateway: state.gateway,
      gismoCache: site.gismoCache ? site.gismoCache.summary() : null,
      blockedRequests: site.blockedRequests, notes: site.notes, apis: [...site.apis].slice(0, 40),
    };
    fs.writeFileSync(path.join(OUT, 'recon.json'), JSON.stringify(recon, null, 1));
    log('SUMMARY', JSON.stringify(recon).slice(0, 2500));
    await save(true);
    await gist.prune(20).catch(() => {});
    await site.close();
    if (gw) await gw.close().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseLocalYmd, computeWindow, validateRequest, isVirtualFixture, tallyRejections, VALID_SPORTS, VALID_SCOPES };
