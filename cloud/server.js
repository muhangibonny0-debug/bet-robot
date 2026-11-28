'use strict';
// Optional Google Cloud Run API + worker adapter for BetRobot.
// Reuses the EXACT same research/run.js engine and HTTP contract as research/local_server.js:
//   GET  /health
//   POST /jobs
//   GET  /jobs/:id
//   POST /jobs/:id/cancel
//
// ZERO-SPEND / SAFE-RESOURCE SAFEGUARDS:
//   - Enforces configurable MAX_CONCURRENT_JOBS, MAX_JOBS_PER_DAY, MAX_JOBS_PER_MONTH,
//     MAX_JOB_MINUTES, and MAX_ACTIVE_MINUTES_PER_DAY.
//   - Refuses new jobs with HTTP 429 when any configured safe limit is reached.
//   - Prevents duplicate concurrent job IDs or identical active requests (HTTP 409).
//   - IMPORTANT: Application-level limits reduce usage but CANNOT guarantee $0 GCP billing
//     on their own. Google Cloud requires a billing account for Cloud Run; always configure
//     GCP Cloud Billing Budgets/Alerts and scale limits (minScale=0, maxScale=1) separately.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function createCloudServer(opts = {}) {
  const PORT = Number(opts.port ?? process.env.PORT ?? 8080);
  const HOST = opts.host || process.env.HOST || '0.0.0.0';
  const STATE_DIR = opts.stateDir || process.env.BETROBOT_STATE_DIR || path.join(__dirname, 'state');
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const TOKEN = String(opts.token ?? process.env.BETROBOT_CLOUD_TOKEN ?? '').trim();
  const LIMITS = {
    maxConcurrentJobs: Math.max(1, Number(opts.maxConcurrentJobs ?? process.env.MAX_CONCURRENT_JOBS ?? 1)),
    maxJobsPerDay: Math.max(1, Number(opts.maxJobsPerDay ?? process.env.MAX_JOBS_PER_DAY ?? 10)),
    maxJobsPerMonth: Math.max(1, Number(opts.maxJobsPerMonth ?? process.env.MAX_JOBS_PER_MONTH ?? 100)),
    maxJobMinutes: Math.max(2, Math.min(60, Number(opts.maxJobMinutes ?? process.env.MAX_JOB_MINUTES ?? 15))),
    maxActiveMinutesPerDay: Math.max(5, Number(opts.maxActiveMinutesPerDay ?? process.env.MAX_ACTIVE_MINUTES_PER_DAY ?? 90)),
    botConcurrency: Math.max(1, Math.min(3, Number(opts.botConcurrency ?? process.env.BOT_CONCURRENCY ?? 2))),
  };

  const USAGE_FILE = path.join(STATE_DIR, 'usage.json');
  const CONFIRMED_USED_FILE = path.join(STATE_DIR, 'confirmed_used_tickets.json');
  const activeProcs = new Map(); // jobId -> { child, startedAt, fingerprint }

  function loadConfirmedUsedStore() {
    try {
      if (fs.existsSync(CONFIRMED_USED_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONFIRMED_USED_FILE, 'utf8'));
        if (parsed && Array.isArray(parsed.tickets)) return parsed;
      }
    } catch (_) {}
    return { tickets: [] };
  }

  function saveConfirmedUsedStore(store) {
    const tmp = CONFIRMED_USED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, CONFIRMED_USED_FILE);
  }

  function upsertConfirmedUsedTicket(ticketId, payload = {}) {
    const cleanId = String(ticketId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) return null;
    const store = loadConfirmedUsedStore();
    const existingIdx = store.tickets.findIndex((t) => t && t.ticketId === cleanId);
    const existing = existingIdx >= 0 ? store.tickets[existingIdx] : null;
    let selections = Array.isArray(payload.selections) ? payload.selections : (Array.isArray(payload.legs) ? payload.legs : []);
    let bookingCode = String(payload.bookingCode || (existing && existing.bookingCode) || '').trim();
    if (!selections.length) {
      const jobFile = path.join(STATE_DIR, `job-${cleanId}.json`);
      if (fs.existsSync(jobFile)) {
        try {
          const jf = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
          const legs = jf && jf.ticket && Array.isArray(jf.ticket.legs) ? jf.ticket.legs : [];
          selections = legs.map((l) => ({
            fixtureId: l.fixtureId || 0,
            home: l.home || '',
            away: l.away || '',
            league: l.league || '',
            sport: l.sport || 'football',
            approvedMarketId: l.approvedMarketId || '',
            market: l.market || '',
            outcome: l.outcome || '',
            canonicalOutcome: l.canonicalOutcome || '',
            line: l.line != null ? l.line : null,
          }));
          if (!bookingCode && jf && jf.booking && jf.booking.code) bookingCode = String(jf.booking.code).trim();
        } catch (_) {}
      }
    }
    const entry = {
      ticketId: cleanId,
      bookingCode,
      confirmedUsed: true,
      confirmedAt: (existing && existing.confirmedAt) || Number(payload.confirmedAt) || Date.now(),
      selections: selections.length ? selections : ((existing && existing.selections) || []),
    };
    if (existingIdx >= 0) store.tickets[existingIdx] = entry;
    else store.tickets.push(entry);
    if (store.tickets.length > 50) store.tickets = store.tickets.slice(-50);
    saveConfirmedUsedStore(store);
    return { entry, alreadyConfirmed: !!existing };
  }

  function utcDayKey(ms = Date.now()) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  function utcMonthKey(ms = Date.now()) {
    return new Date(ms).toISOString().slice(0, 7);
  }

  function loadUsage() {
    try {
      if (fs.existsSync(USAGE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_) {}
    return { byDay: {}, byMonth: {} };
  }

  function saveUsage(u) {
    try {
      const tmp = USAGE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
      fs.renameSync(tmp, USAGE_FILE);
    } catch (_) {}
  }

  function checkSafeLimits(nowMs = Date.now()) {
    const usage = loadUsage();
    const day = utcDayKey(nowMs);
    const month = utcMonthKey(nowMs);
    const dayStats = usage.byDay[day] || { jobs: 0, activeMinutes: 0 };
    const monthStats = usage.byMonth[month] || { jobs: 0, activeMinutes: 0 };

    if (activeProcs.size >= LIMITS.maxConcurrentJobs) {
      return { ok: false, status: 409, reason: `Concurrency limit reached (${activeProcs.size}/${LIMITS.maxConcurrentJobs} active jobs).` };
    }
    if (dayStats.jobs >= LIMITS.maxJobsPerDay) {
      return { ok: false, status: 429, reason: `Daily safe job limit reached (${dayStats.jobs}/${LIMITS.maxJobsPerDay} jobs for ${day}).` };
    }
    if (monthStats.jobs >= LIMITS.maxJobsPerMonth) {
      return { ok: false, status: 429, reason: `Monthly safe job limit reached (${monthStats.jobs}/${LIMITS.maxJobsPerMonth} jobs for ${month}).` };
    }
    if (dayStats.activeMinutes >= LIMITS.maxActiveMinutesPerDay) {
      return { ok: false, status: 429, reason: `Daily active compute limit reached (${dayStats.activeMinutes.toFixed(1)}/${LIMITS.maxActiveMinutesPerDay} min for ${day}).` };
    }
    return { ok: true, usage: { day, dayStats, month, monthStats } };
  }

  function recordJobStart(nowMs = Date.now()) {
    const usage = loadUsage();
    const day = utcDayKey(nowMs);
    const month = utcMonthKey(nowMs);
    usage.byDay[day] = usage.byDay[day] || { jobs: 0, activeMinutes: 0 };
    usage.byMonth[month] = usage.byMonth[month] || { jobs: 0, activeMinutes: 0 };
    usage.byDay[day].jobs++;
    usage.byMonth[month].jobs++;
    saveUsage(usage);
  }

  function recordJobDuration(startedAt, endedAt = Date.now()) {
    const mins = Math.max(0.1, (endedAt - startedAt) / 60000);
    const usage = loadUsage();
    const day = utcDayKey(startedAt);
    const month = utcMonthKey(startedAt);
    usage.byDay[day] = usage.byDay[day] || { jobs: 0, activeMinutes: 0 };
    usage.byMonth[month] = usage.byMonth[month] || { jobs: 0, activeMinutes: 0 };
    usage.byDay[day].activeMinutes = Math.round((usage.byDay[day].activeMinutes + mins) * 100) / 100;
    usage.byMonth[month].activeMinutes = Math.round((usage.byMonth[month].activeMinutes + mins) * 100) / 100;
    saveUsage(usage);
  }

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function authorized(req) {
    if (!TOKEN) return false;
    const auth = String(req.headers.authorization || '').trim();
    if (!auth.startsWith('Bearer ')) return false;
    const given = auth.slice(7).trim();
    if (!given || given.length !== TOKEN.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
    } catch (_) {
      return false;
    }
  }

  function readBody(req, limit = 262144) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function requestFingerprint(params) {
    return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 16);
  }

  const spawnWorker = opts.spawnWorker || ((id, job, stateFile, logFile) => {
    const env = {
      ...process.env,
      JOB_ID: id,
      JOB: JSON.stringify(job),
      LOCAL_STATE_FILE: stateFile,
      CONFIRMED_USED_FILE,
      LOCAL_NO_GIST: '1',
      BOT_CONCURRENCY: String(LIMITS.botConcurrency),
    };
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'research', 'run.js')], {
      cwd: path.join(__dirname, '..', 'research'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    return { child, logStream };
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (!TOKEN) {
      return json(res, 503, { ok: false, error: 'Cloud backend misconfigured: BETROBOT_CLOUD_TOKEN is not set.' });
    }

    if (req.method === 'GET' && u.pathname === '/health') {
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized: invalid cloud backend token' });
      const lim = checkSafeLimits();
      return json(res, 200, {
        ok: true,
        engine: 'betrobot-cloud-run',
        activeJobs: activeProcs.size,
        concurrency: LIMITS.botConcurrency,
        limits: LIMITS,
        usage: lim.usage || null,
        acceptingJobs: lim.ok,
        refusalReason: lim.ok ? '' : lim.reason,
      });
    }

    if (!authorized(req)) {
      return json(res, 401, { ok: false, error: 'Unauthorized: provide Authorization: Bearer <cloud_token>' });
    }

    if (req.method === 'POST' && u.pathname === '/jobs') {
      const lim = checkSafeLimits();
      if (!lim.ok) {
        return json(res, lim.status, { ok: false, error: lim.reason, limits: LIMITS });
      }
      try {
        const raw = await readBody(req);
        const job = JSON.parse(raw || '{}');
        const id = String(job.id || `cr_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!id) return json(res, 400, { ok: false, error: 'Missing job id' });
        if (activeProcs.has(id)) {
          return json(res, 409, { ok: false, error: `Duplicate job id "${id}" is already running.` });
        }

        const params = { ...(job.params || {}) };
        params.usePhoneGateway = false;
        // Enforce cloud safe maximum job duration
        params.minutes = Math.min(LIMITS.maxJobMinutes, Math.max(2, Number(params.minutes) || LIMITS.maxJobMinutes));
        const fp = requestFingerprint(params);
        for (const [activeId, info] of activeProcs.entries()) {
          if (info.fingerprint === fp) {
            return json(res, 409, { ok: false, error: `An identical research job (${activeId}) is already running.` });
          }
        }

        job.params = params;
        const stateFile = path.join(STATE_DIR, `job-${id}.json`);
        const logFile = path.join(STATE_DIR, `job-${id}.log`);
        const startedAt = Date.now();
        const initState = {
          id,
          status: 'running',
          stage: 'Starting BetRobot Cloud Run worker...',
          started: startedAt,
          updated: startedAt,
          request: params,
          backendMode: 'google_cloud_run',
        };
        fs.writeFileSync(stateFile, JSON.stringify(initState, null, 2));
        recordJobStart(startedAt);

        const { child, logStream } = spawnWorker(id, job, stateFile, logFile);
        activeProcs.set(id, { child, startedAt, fingerprint: fp });

        child.on('exit', (code) => {
          activeProcs.delete(id);
          if (logStream) logStream.end();
          recordJobDuration(startedAt, Date.now());
          try {
            const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (cur.status === 'running' || cur.status === 'queued') {
              cur.status = 'failed';
              cur.error = `Cloud worker exited with code ${code}`;
              cur.updated = Date.now();
              fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
            }
          } catch (_) {}
        });

        return json(res, 202, { ok: true, id, backendMode: 'google_cloud_run', maxMinutes: params.minutes });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    const mGet = /^\/jobs\/([a-zA-Z0-9_-]+)$/.exec(u.pathname);
    if (req.method === 'GET' && mGet) {
      const stateFile = path.join(STATE_DIR, `job-${mGet[1]}.json`);
      if (!fs.existsSync(stateFile)) return json(res, 404, { ok: false, error: 'Job not found' });
      try {
        return json(res, 200, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    const mTarget = /^\/jobs\/([a-zA-Z0-9_-]+)\/target$/.exec(u.pathname);
    if ((req.method === 'POST' || req.method === 'PATCH') && mTarget) {
      const id = mTarget[1];
      const stateFile = path.join(STATE_DIR, `job-${id}.json`);
      if (!fs.existsSync(stateFile)) return json(res, 404, { ok: false, error: 'Job not found' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const target = Number(body.target);
        if (!Number.isFinite(target) || target <= 1.0 || target > 10000) {
          return json(res, 400, { ok: false, error: 'Invalid target odds (must be > 1.0 and <= 10000).' });
        }
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const locked = cur.targetLocked === true || (cur.progress && cur.progress.targetLocked === true) ||
          (cur.status && cur.status !== 'running' && cur.status !== 'queued');
        if (locked) {
          return json(res, 409, {
            ok: false,
            targetLocked: true,
            error: 'Selection has already started; target odds are locked for this research run.',
          });
        }
        fs.writeFileSync(stateFile + '.target.json', JSON.stringify({ target, updatedAt: Date.now() }));
        if (cur.request && typeof cur.request === 'object') cur.request.target = target;
        if (cur.counts && typeof cur.counts === 'object') cur.counts.targetOdds = target;
        if (cur.progress && typeof cur.progress === 'object') cur.progress.targetOdds = target;
        cur.updated = Date.now();
        fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
        return json(res, 200, { ok: true, id, target, targetLocked: false });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    const mCancel = /^\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/.exec(u.pathname);
    if (req.method === 'POST' && mCancel) {
      const id = mCancel[1];
      const info = activeProcs.get(id);
      if (info && info.child) {
        info.child.kill();
        activeProcs.delete(id);
        recordJobDuration(info.startedAt, Date.now());
      }
      const stateFile = path.join(STATE_DIR, `job-${id}.json`);
      if (fs.existsSync(stateFile)) {
        try {
          const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          cur.status = 'cancelled';
          cur.stage = 'Cancelled by user.';
          cur.updated = Date.now();
          fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
        } catch (_) {}
      }
      return json(res, 200, { ok: true, cancelled: true });
    }

    if (req.method === 'GET' && u.pathname === '/tickets/confirmed-used') {
      const store = loadConfirmedUsedStore();
      return json(res, 200, { ok: true, count: store.tickets.length, tickets: store.tickets });
    }

    const mConfirmUsed = /^\/tickets\/([a-zA-Z0-9_-]+)\/confirm-used$/.exec(u.pathname);
    if (req.method === 'POST' && mConfirmUsed) {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const resUpsert = upsertConfirmedUsedTicket(mConfirmUsed[1], body);
        if (!resUpsert) return json(res, 400, { ok: false, error: 'Invalid ticket id' });
        return json(res, 200, {
          ok: true,
          ticketId: resUpsert.entry.ticketId,
          confirmedUsed: true,
          alreadyConfirmed: resUpsert.alreadyConfirmed,
          selectionsCount: resUpsert.entry.selections.length,
        });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  });

  function shutdown() {
    for (const [, info] of activeProcs.entries()) {
      if (info.child) info.child.kill();
    }
    activeProcs.clear();
    server.close();
  }

  return { server, PORT, HOST, STATE_DIR, LIMITS, checkSafeLimits, shutdown };
}

if (require.main === module) {
  const app = createCloudServer();
  process.on('SIGTERM', () => app.shutdown());
  process.on('SIGINT', () => app.shutdown());
  app.server.listen(app.PORT, app.HOST, () => {
    console.log(`[BetRobot Cloud Run] Listening on ${app.HOST}:${app.PORT} (limits=${JSON.stringify(app.LIMITS)})`);
  });
}

module.exports = { createCloudServer };
