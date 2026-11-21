'use strict';
const fs = require('fs');
const path = require('path');
const { Site, OUT } = require('./lib/site');
const ex = require('./lib/extract');
const an = require('./lib/analyze');
const tk = require('./lib/ticket');
const bk = require('./lib/book');
const gist = require('./lib/gist');
const { norm, pool } = require('./lib/util');

const job = JSON.parse(process.env.JOB || '{}');
const ID = process.env.JOB_ID || job.id || 'manual';
const P = job.params || job;
const req = {
  sports: Array.isArray(P.sports) && P.sports.length ? P.sports : ['football'],
  scope: P.scope || 'today',
  target: Number(P.target) || 0,
  count: Number(P.count) || 0,
  minutes: Number(P.minutes) || 85,
  noBook: !!P.noBook,
  text: job.text || '',
};
const started = Date.now();
const deadline = started + req.minutes * 60000;
const log = (...a) => console.log('[run]', ...a);

const state = { id: ID, status: 'running', stage: 'Understanding request', stages: [], request: req, started, updated: started,
  counts: {}, ticket: null, booking: null, error: '', notes: [] };
let lastSave = 0;
async function save(force) {
  state.updated = Date.now();
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

function window_() {
  const now = Date.now();
  const d = new Date(now);
  const day = (n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
  switch (req.scope) {
    case 'next3hours': return [now, now + 3 * 60 * 60 * 1000];
    case 'next6hours': return [now, now + 6 * 60 * 60 * 1000];
    case 'today': return [now, day(1)];
    case 'tomorrow': return [day(1), day(2)];
    case 'next3days': return [now, now + 3 * 24 * 60 * 60 * 1000];
    case 'next7days':
    case 'week': return [now, now + 7 * 24 * 60 * 60 * 1000];
    case 'weekend': {
      const toSat = (6 - d.getDay() + 7) % 7;
      const start = Math.max(now, day(toSat));
      return [start, day(toSat + 2)];
    }
    case 'all': return [now, now + 30 * 24 * 60 * 60 * 1000];
    default: return [now, day(1)];
  }
}

const TOP = /(premier|champions|europa|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira|championship|nba|euroleague|atp|wta|nhl|mlb)/i;
const prio = (e) => (TOP.test(`${e.country} ${e.league}`) ? 0 : 1);

async function notify(title, body) {
  const f = path.join(__dirname, '..', 'notify', 'out.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([{ title, body }]));
}

(async () => {
  const site = new Site();
  try {
    await save(true);
    await stage('Understanding request');
    log('request:', JSON.stringify(req));
    await site.start();

    await stage('Discovering available matches');
    let events = await site.discover(req, deadline);
    state.counts.displayed = events.length;
    events = events.map((e, i) => ({ ...e, key: `${e.sport}:${norm(e.home)}:${norm(e.away)}:${i}` }));
    if (!events.length) throw new Error('BangBet displayed no fixtures for the selected Time period. ' + site.notes.join(' | '));
    await save(true);

    await stage(`Inspecting matches one by one (0/${events.length})`);
    const page = await site.newPage();
    const cands = [];
    let done = 0;
    try {
      for (const ev of events) {
        if (Date.now() > deadline) break;
        try {
          if (!(await site.openEvent(page, ev, req.scope))) {
            ev.rejected = 'could not open or verify the match page';
          } else {
            ev.url = ev.url || page.url();
            ev.stats = await ex.stats(page, ev).catch((e) => ({ available: false, err: e.message }));
            if (!ev.stats || !ev.stats.available) {
              ev.rejected = 'BangBet Stats tab did not provide readable statistics';
            } else {
              ev.markets = await ex.markets(page, ev).catch(() => []);
              cands.push(...an.candidates(ev));
            }
            page.net.splice(0);
          }
        } catch (e) {
          ev.rejected = 'error: ' + e.message;
        }
        done++;
        state.counts.opened = done;
        state.counts.withStats = events.filter((x) => x.stats && x.stats.available).length;
        state.counts.withMarkets = events.filter((x) => x.markets && x.markets.length).length;
        const progressTicket = tk.build(cands, req);
        state.counts.selections = progressTicket.legs.length;
        state.counts.combinedOdds = Math.round(progressTicket.total * 100) / 100;
        if (done % 1 === 0 || done === events.length) {
          state.stage = `Inspecting displayed fixtures (${done}/${events.length}); ${progressTicket.legs.length} selections, combined odds ${state.counts.combinedOdds}`;
          await save(false);
        }
        if (req.target > 0 && progressTicket.targetReached) {
          state.counts.targetReachedAfter = done;
          break;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }

    await stage('Evaluating candidate selections');
    state.counts.withStats = events.filter((e) => e.stats && e.stats.available).length;
    state.counts.withMarkets = events.filter((e) => e.markets && e.markets.length).length;
    state.counts.candidates = cands.length;
    state.counts.remainingAfterStop = Math.max(0, events.length - done);

    await stage('Constructing ticket');
    const t = tk.build(cands, req);
    if (!t.legs.length) {
      const why = {};
      for (const e of events) if (e.rejected) why[e.rejected] = (why[e.rejected] || 0) + 1;
      throw new Error('No selection had enough evidence. Reasons: ' + (Object.entries(why).map(([k, v]) => `${v}x ${k}`).join('; ') || 'none recorded'));
    }
    state.ticket = {
      status: t.status, note: t.note, total: Math.round(t.total * 100) / 100,
      legs: t.legs.map((c) => ({ sport: c.sport, league: c.league, country: c.country, home: c.home, away: c.away, ts: c.ts,
        market: c.market, outcome: c.outcome, odds: c.odds, p: Math.round(c.p * 100), reason: c.reason, facts: c.facts, url: c.url })),
    };
    await save(true);

    if (!req.noBook) {
      await stage('Preparing BangBet betslip');
      state.booking = await bk.book(site, t.legs.map((c) => ({ ...state.ticket.legs[t.legs.indexOf(c)], })), deadline);
      log('booking:', JSON.stringify(state.booking));
    } else {
      state.booking = { ok: false, why: 'betslip preparation was switched off for this job' };
    }

    state.status = 'done';
    await stage('Ready');
    state.stages[state.stages.length - 1].ok = true;
    const names = req.sports.map((s) => s[0].toUpperCase() + s.slice(1)).join(' + ');
    await notify('BETBRAIN — YOUR TICKET IS READY',
      `${names} research completed.\nSelections: ${state.ticket.legs.length}\nTarget odds: ${req.target || 'not set'}\nTotal odds: ${state.ticket.total}\nStatus: ${t.status === 'ready' ? 'Ready' : 'Ready (partial: ' + t.note + ')'}` +
      (state.booking.ok ? `\nBangBet: ${state.booking.link || ''} ${state.booking.code ? '(code ' + state.booking.code + ')' : ''}` : '\nBangBet link: not prepared, open BetBrain to see the selections.'));
  } catch (e) {
    state.status = 'failed';
    state.error = e.message;
    log('FAILED', e.message);
    await notify('BETBRAIN — RESEARCH NOT COMPLETED', String(e.message).slice(0, 220));
  } finally {
    state.notes = site.notes;
    // a short summary of what the bot saw: this is what is read to improve the bot after a first run
    const recon = {
      counts: state.counts, notes: site.notes, apis: [...site.apis].slice(0, 40),
    };
    fs.writeFileSync(path.join(OUT, 'recon.json'), JSON.stringify(recon, null, 1));
    log('SUMMARY', JSON.stringify(recon).slice(0, 2500));
    await save(true);
    await gist.prune(20).catch(() => {});
    await site.close();
  }
})();
