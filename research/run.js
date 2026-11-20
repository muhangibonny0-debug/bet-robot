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
  maxEvents: Number(P.maxEvents) || Math.min(140, Math.max(60, (Number(P.count) || 10) * 5)),
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
  const now = new Date();
  const day = (d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d).getTime();
  if (req.scope === 'tomorrow') return [day(1), day(2)];
  if (req.scope === 'week') { const toMon = (8 - now.getDay()) % 7 || 7; return [Date.now(), day(toMon)]; }
  if (req.scope === 'weekend') { const toSat = (6 - now.getDay() + 7) % 7; return [Math.max(Date.now(), day(toSat)), day(toSat + 2)]; }
  return [Date.now(), day(1)];
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
    state.counts.discovered = events.length;
    const [from, to] = window_();
    events = events.filter((e) => !e.ts || (e.ts >= from && e.ts < to)).map((e, i) => ({ ...e, key: `${e.sport}:${norm(e.home)}:${norm(e.away)}:${i}` }));
    events.sort((a, b) => prio(a) - prio(b) || (a.ts || 9e15) - (b.ts || 9e15));
    state.counts.inWindow = events.length;
    if (!events.length) throw new Error('No matches could be discovered on BangBet for this request. ' + site.notes.join(' | '));
    events = events.slice(0, req.maxEvents);
    await save(true);

    await stage(`Collecting statistics and markets (${events.length} matches)`);
    const pages = [await site.newPage(), await site.newPage(), await site.newPage()];
    let done = 0;
    const free = [...pages];
    await pool(events, 3, async (ev) => {
      if (Date.now() > deadline) return;
      const page = free.pop();
      try {
        if (!(await site.openEvent(page, ev))) { ev.rejected = 'could not open the match page'; return; }
        const here = page.url();
        ev.url = ev.url || here;
        ev.stats = await ex.stats(page, ev).catch((e) => ({ available: false, err: e.message }));
        ev.markets = await ex.markets(page, ev).catch(() => []);
      } catch (e) {
        ev.rejected = 'error: ' + e.message;
      } finally {
        free.push(page);
        done++;
        state.counts.analysed = done;
        if (done % 4 === 0) { state.stage = `Collecting statistics and markets (${done} of ${events.length})`; await save(false); }
      }
    });
    for (const p of pages) await p.close().catch(() => {});

    await stage('Evaluating candidate selections');
    const cands = [];
    for (const ev of events) if (ev.markets) cands.push(...an.candidates(ev));
    state.counts.withStats = events.filter((e) => e.stats && e.stats.available).length;
    state.counts.withMarkets = events.filter((e) => e.markets && e.markets.length).length;
    state.counts.candidates = cands.length;

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
