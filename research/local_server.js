'use strict';
// Local authenticated HTTP test runner for BetBrain-Test.apk on private Wi-Fi / LAN.
// Runs the locally modified BetRobot research/run.js without pushing to GitHub,
// without exposing an unauthenticated public backend, and without requiring PhoneGateway.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.BETROBOT_LOCAL_PORT || 8787);
const HOST = process.env.BETROBOT_LOCAL_HOST || '0.0.0.0';
const STATE_DIR = path.join(__dirname, 'out', 'local_jobs');
fs.mkdirSync(STATE_DIR, { recursive: true });
const CONFIRMED_USED_FILE = path.join(STATE_DIR, 'confirmed_used_tickets.json');

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
  // If selections weren't provided by client, recover them from the saved job state file on disk
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

// Stable local token persisted on disk (or supplied via BETROBOT_LOCAL_TOKEN)
const TOKEN_FILE = path.join(STATE_DIR, '.local_token');
let TOKEN = (process.env.BETROBOT_LOCAL_TOKEN || '').trim();
if (!TOKEN) {
  if (fs.existsSync(TOKEN_FILE)) {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } else {
    TOKEN = 'bb_local_' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_FILE, TOKEN);
  }
}

const activeProcs = new Map(); // jobId -> ChildProcess

function getLanIps() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && u.pathname === '/health') {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized: invalid local backend token' });
    const conc = Math.max(1, Math.min(4, Number(process.env.BOT_CONCURRENCY) || 2));
    return json(res, 200, {
      ok: true,
      engine: 'betrobot-local-modified',
      branch: 'local/stats-investigation-repair',
      activeJobs: activeProcs.size,
      concurrency: conc,
    });
  }

  if (!authorized(req)) {
    return json(res, 401, { ok: false, error: 'Unauthorized: provide Authorization: Bearer <local_token>' });
  }

  if (req.method === 'POST' && u.pathname === '/jobs') {
    if (activeProcs.size > 0) {
      return json(res, 409, { ok: false, error: 'A local research job is already running.' });
    }
    try {
      const raw = await readBody(req);
      const job = JSON.parse(raw || '{}');
      const id = String(job.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return json(res, 400, { ok: false, error: 'Missing job id' });

      // In local laptop mode, PhoneGateway is NOT needed unless explicitly requested
      if (job.params && job.params.usePhoneGateway == null) job.params.usePhoneGateway = false;
      const stateFile = path.join(STATE_DIR, `job-${id}.json`);
      const initState = {
        id,
        status: 'running',
        stage: 'Starting local modified BetRobot engine...',
        started: Date.now(),
        updated: Date.now(),
        request: job.params || {},
        backendMode: 'local_modified_betrobot',
      };
      fs.writeFileSync(stateFile, JSON.stringify(initState, null, 2));

      const dTmp = 'D:\\.flutter-work\\tmp';
      const env = {
        ...process.env,
        ...(fs.existsSync(dTmp) ? { TEMP: dTmp, TMP: dTmp } : {}),
        JOB_ID: id,
        JOB: JSON.stringify(job),
        LOCAL_STATE_FILE: stateFile,
        CONFIRMED_USED_FILE,
        LOCAL_NO_GIST: '1',
        BOT_CONCURRENCY: String(Math.max(1, Math.min(4, Number(process.env.BOT_CONCURRENCY) || 2))),
        PLAYWRIGHT_CORE_PATH: process.env.PLAYWRIGHT_CORE_PATH || 'D:\\.flutter-work\\pw\\node_modules\\playwright-core',
        CHROME_PATH: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      };
      const child = spawn(process.execPath, [path.join(__dirname, 'run.js')], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeProcs.set(id, child);
      const logFile = path.join(STATE_DIR, `job-${id}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.on('exit', (code) => {
        activeProcs.delete(id);
        logStream.end();
        try {
          const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (cur.status === 'running' || cur.status === 'queued') {
            cur.status = 'failed';
            cur.error = `Local worker exited with code ${code}`;
            cur.updated = Date.now();
            fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
          }
        } catch (_) {}
      });

      return json(res, 202, { ok: true, id, backendMode: 'local_modified_betrobot' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  const mGet = /^\/jobs\/([a-zA-Z0-9_-]+)$/.exec(u.pathname);
  if (req.method === 'GET' && mGet) {
    const stateFile = path.join(STATE_DIR, `job-${mGet[1]}.json`);
    if (!fs.existsSync(stateFile)) return json(res, 404, { ok: false, error: 'Job not found' });
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return json(res, 200, data);
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
      const targetFile = stateFile + '.target.json';
      fs.writeFileSync(targetFile, JSON.stringify({ target, updatedAt: Date.now() }));
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
    const p = activeProcs.get(id);
    if (p) {
      p.kill();
      activeProcs.delete(id);
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

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const ips = getLanIps();
    console.log('[BetRobot Local Test Server] Listening on port', PORT);
    console.log('[BetRobot Local Test Server] Private LAN URLs:', ips.map((ip) => `http://${ip}:${PORT}`).join(', ') || `http://127.0.0.1:${PORT}`);
    console.log('[BetRobot Local Test Server] Auth token saved in:', TOKEN_FILE);
  });
}

module.exports = { server, TOKEN, TOKEN_FILE, PORT, getLanIps, CONFIRMED_USED_FILE, upsertConfirmedUsedTicket, loadConfirmedUsedStore };
