// BetBrain + BetRobot — Cloudflare Worker Coordinator (Free Plan + Workers KV)
// Lightweight, permanent, zero-spending coordinator:
//   BetBrain (Android) -> Cloudflare Worker -> GitHub Actions (ubuntu-latest)
//   -> BetRobot + Groq AI -> Cloudflare Worker -> BetBrain.
//
// Secrets (set via `wrangler secret put`, NEVER hardcoded):
//   CLIENT_AUTH_TOKEN      : Bearer token for BetBrain phones
//   RUNNER_CALLBACK_TOKEN  : Token for GitHub Actions runner callbacks
//   GITHUB_DISPATCH_TOKEN  : GitHub PAT with Actions (Read & write) on bet-robot

const VALID_SPORTS = ['football', 'basketball', 'tennis', 'baseball', 'hockey'];
const VALID_SCOPES = [
  'today', 'tomorrow', 'weekend', 'next3days', 'next7days', 'week',
  'next3hours', 'next6hours', 'all', 'date', 'range',
];
const TERMINAL_STATUSES = new Set([
  'done', 'partial', 'booking_failed', 'no_qualifying', 'failed', 'cancelled',
  'data_limit_reached', 'gateway_disconnected', 'timed_out',
]);

const JOB_TTL_SECONDS = 7 * 24 * 3600; // 7 days auto-cleanup on free KV
const ACTIVE_KEY = 'meta:active_job';
const CONFIRMED_USED_KEY = 'meta:confirmed_used_tickets';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function timingSafeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function isClientAuthorized(request, env) {
  const expected = String(env.CLIENT_AUTH_TOKEN || '').trim();
  if (!expected) return false;
  const auth = String(request.headers.get('Authorization') || '').trim();
  if (!auth.startsWith('Bearer ')) return false;
  return timingSafeEqual(auth.slice(7).trim(), expected);
}

function isRunnerAuthorized(request, env) {
  const expected = String(env.RUNNER_CALLBACK_TOKEN || '').trim();
  if (!expected) return false;
  const headerTok = String(request.headers.get('X-Runner-Token') || '').trim();
  if (headerTok && timingSafeEqual(headerTok, expected)) return true;
  const auth = String(request.headers.get('Authorization') || '').trim();
  if (auth.startsWith('Bearer ') && timingSafeEqual(auth.slice(7).trim(), expected)) return true;
  return false;
}

function sanitizeId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function generateJobId(nowMs = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `cf_${nowMs}_${rand}`;
}

function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function validateResearchParams(params) {
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'Missing research parameters.' };
  }
  const sports = Array.isArray(params.sports) ? params.sports.map((s) => String(s).toLowerCase().trim()) : [];
  if (!sports.length || sports.some((s) => !VALID_SPORTS.includes(s))) {
    return { ok: false, error: 'Request must specify one or more supported sports: football, basketball, tennis, baseball, hockey.' };
  }
  const scope = String(params.scope || 'today').trim();
  if (!VALID_SCOPES.includes(scope)) {
    return { ok: false, error: `Unsupported date scope "${scope}".` };
  }
  if (scope === 'date' && !parseYmd(params.date)) {
    return { ok: false, error: 'Invalid specific date. Expected YYYY-MM-DD.' };
  }
  if (scope === 'range') {
    const f = parseYmd(params.dateFrom);
    const t = parseYmd(params.dateTo);
    if (!f || !t || t.getTime() < f.getTime()) {
      return { ok: false, error: 'Invalid date range. Expected valid YYYY-MM-DD dateFrom and dateTo.' };
    }
    const spanDays = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
    if (spanDays > 70) {
      return { ok: false, error: 'Date range cannot exceed 70 days.' };
    }
  }
  if (params.target != null && Number(params.target) !== 0) {
    const tg = Number(params.target);
    if (!Number.isFinite(tg) || tg <= 1.0 || tg > 10000) {
      return { ok: false, error: 'Target odds must be greater than 1.0 and at most 10000.' };
    }
  }
  if (params.count != null && Number(params.count) !== 0) {
    const ct = Number(params.count);
    if (!Number.isInteger(ct) || ct < 1 || ct > 100) {
      return { ok: false, error: 'Selection count must be a whole number from 1 to 100.' };
    }
  }
  if (params.markets != null && (!Array.isArray(params.markets) || params.markets.some((m) => typeof m !== 'string'))) {
    return { ok: false, error: 'Markets filter must be an array of strings.' };
  }
  return { ok: true, sports, scope };
}

async function computeFingerprint(params) {
  const canonical = JSON.stringify({
    sports: [...(params.sports || [])].sort(),
    scope: params.scope || 'today',
    date: params.date || '',
    dateFrom: params.dateFrom || '',
    dateTo: params.dateTo || '',
    target: Number(params.target) || 0,
    count: Number(params.count) || 0,
    markets: Array.isArray(params.markets) ? [...params.markets].sort() : [],
  });
  const buf = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${String(env.GITHUB_DISPATCH_TOKEN || '').trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'betbrain-cloudflare-coordinator',
    'Content-Type': 'application/json',
  };
}

function ghRepoBase(env) {
  const owner = String(env.GITHUB_OWNER || 'muhangibonny0-debug').trim();
  const repo = String(env.GITHUB_REPO || 'bet-robot').trim();
  return `https://api.github.com/repos/${owner}/${repo}`;
}

async function dispatchGitHubWorkflow(env, jobId, jobPayload, fetchFn = fetch) {
  const wf = String(env.GITHUB_WORKFLOW_FILE || 'research.yml').trim();
  const ref = String(env.GITHUB_REF || 'main').trim();
  const url = `${ghRepoBase(env)}/actions/workflows/${wf}/dispatches`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({
      ref,
      inputs: {
        job_id: jobId,
        job: JSON.stringify(jobPayload),
      },
    }),
  });
  if (res.status !== 204 && res.status !== 200) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, status: res.status, error: `GitHub dispatch failed (HTTP ${res.status}): ${txt}` };
  }
  return { ok: true, status: res.status };
}

async function lookupLatestWorkflowRun(env, dispatchedAfterMs, fetchFn = fetch) {
  const wf = String(env.GITHUB_WORKFLOW_FILE || 'research.yml').trim();
  const url = `${ghRepoBase(env)}/actions/workflows/${wf}/runs?event=workflow_dispatch&per_page=5`;
  try {
    const res = await fetchFn(url, { headers: ghHeaders(env) });
    if (!res.ok) return null;
    const data = await res.json();
    const runs = Array.isArray(data && data.workflow_runs) ? data.workflow_runs : [];
    for (const run of runs) {
      const createdMs = Date.parse(run.created_at || '');
      if (Number.isFinite(createdMs) && createdMs >= dispatchedAfterMs - 15000) {
        return {
          runId: run.id,
          runNumber: run.run_number || null,
          htmlUrl: run.html_url || '',
          status: run.status || '',
          conclusion: run.conclusion || null,
        };
      }
    }
  } catch (_) {}
  return null;
}

async function fetchWorkflowRunStatus(env, runId, fetchFn = fetch) {
  if (!runId) return null;
  try {
    const res = await fetchFn(`${ghRepoBase(env)}/actions/runs/${runId}`, { headers: ghHeaders(env) });
    if (!res.ok) return null;
    const run = await res.json();
    return {
      runId: run.id,
      status: run.status || '',
      conclusion: run.conclusion || null,
      htmlUrl: run.html_url || '',
    };
  } catch (_) {
    return null;
  }
}

async function cancelGitHubRun(env, runId, fetchFn = fetch) {
  if (!runId) return false;
  try {
    const res = await fetchFn(`${ghRepoBase(env)}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      headers: ghHeaders(env),
    });
    return res.status === 202 || res.status === 200;
  } catch (_) {
    return false;
  }
}

// Independently verify completion claims from a runner before storing `status: 'done'`.
// A GitHub workflow finishing successfully does NOT mean research succeeded.
export function verifyRunnerCompletion(incomingStatus, payload) {
  if (incomingStatus !== 'done') {
    return { status: incomingStatus, verified: true, note: '' };
  }
  const booking = payload && payload.booking && typeof payload.booking === 'object' ? payload.booking : null;
  const ticket = payload && payload.ticket && typeof payload.ticket === 'object' ? payload.ticket : null;
  const code = booking && typeof booking.code === 'string' ? booking.code.trim() : '';
  const legs = ticket && Array.isArray(ticket.legs) ? ticket.legs : [];

  if (!booking || booking.ok !== true || !code) {
    return {
      status: 'booking_failed',
      verified: false,
      note: 'Coordinator rejected unverified completion: missing confirmed booking code.',
    };
  }
  if (!legs.length) {
    return {
      status: 'booking_failed',
      verified: false,
      note: 'Coordinator rejected unverified completion: ticket has zero legs.',
    };
  }
  if (booking.codeVerifiedIndependently === false) {
    return {
      status: 'booking_failed',
      verified: false,
      note: 'Coordinator rejected unverified completion: booking code failed independent verification.',
    };
  }
  return { status: 'done', verified: true, note: '' };
}

async function readJsonKv(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function writeJsonKv(kv, key, value, ttlSeconds = JOB_TTL_SECONDS) {
  if (!kv) return;
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await kv.put(key, JSON.stringify(value), opts);
}

async function reconcileActiveJob(env, fetchFn, nowMs = Date.now()) {
  const kv = env.BETBRAIN_JOBS;
  const activeMeta = await readJsonKv(kv, ACTIVE_KEY);
  if (!activeMeta || !activeMeta.id) return null;
  const job = await readJsonKv(kv, `job:${activeMeta.id}`);
  if (!job || TERMINAL_STATUSES.has(job.status)) {
    await kv.delete(ACTIVE_KEY);
    return null;
  }
  const staleMins = Math.max(5, Number(env.JOB_STALE_MINUTES || 20));
  const maxMins = Math.max(15, Number(env.JOB_MAX_MINUTES || 115));
  const lastUpd = Number(job.updated || job.started || nowMs);
  const started = Number(job.started || nowMs);

  // Check if GitHub Actions run already terminated abnormally
  if (job.githubRun && job.githubRun.runId && env.GITHUB_DISPATCH_TOKEN) {
    const ghRun = await fetchWorkflowRunStatus(env, job.githubRun.runId, fetchFn);
    if (ghRun && ghRun.status === 'completed' && !TERMINAL_STATUSES.has(job.status)) {
      job.githubRun = { ...job.githubRun, ...ghRun };
      job.status = ghRun.conclusion === 'cancelled' ? 'cancelled' : 'failed';
      job.error = `GitHub Actions runner ended (${ghRun.conclusion || 'unknown'}) without reporting verified completion.`;
      job.stage = 'Runner stopped before verified completion';
      job.updated = nowMs;
      await writeJsonKv(kv, `job:${job.id}`, job);
      await kv.delete(ACTIVE_KEY);
      return null;
    }
  }

  if (nowMs - lastUpd > staleMins * 60000 || nowMs - started > maxMins * 60000) {
    job.status = 'timed_out';
    job.error = nowMs - started > maxMins * 60000
      ? `Research job exceeded maximum runtime (${maxMins} min).`
      : `Runner stopped sending progress updates for over ${staleMins} min.`;
    job.stage = 'Timed out — no runner heartbeat';
    job.updated = nowMs;
    await writeJsonKv(kv, `job:${job.id}`, job);
    await kv.delete(ACTIVE_KEY);
    return null;
  }

  return job;
}

export async function handleRequest(request, env, ctx, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const nowMs = deps.now ? deps.now() : Date.now();
  const kv = env.BETBRAIN_JOBS;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Runner-Token',
      },
    });
  }

  if (!kv) {
    return json({ ok: false, error: 'Coordinator misconfigured: BETBRAIN_JOBS KV namespace is not bound.' }, 503);
  }
  if (!String(env.CLIENT_AUTH_TOKEN || '').trim()) {
    return json({ ok: false, error: 'Coordinator misconfigured: CLIENT_AUTH_TOKEN secret is not set.' }, 503);
  }

  // -------------------------------------------------------------------------
  // RUNNER CALLBACK ENDPOINTS (authenticated via RUNNER_CALLBACK_TOKEN)
  // -------------------------------------------------------------------------
  const mProgress = /^\/jobs\/([a-zA-Z0-9_-]+)\/progress$/.exec(pathname);
  if (request.method === 'POST' && mProgress) {
    if (!isRunnerAuthorized(request, env)) {
      return json({ ok: false, error: 'Unauthorized runner callback token.' }, 401);
    }
    const id = sanitizeId(mProgress[1]);
    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body.' }, 400);
    }
    const existing = (await readJsonKv(kv, `job:${id}`)) || {
      id,
      status: 'running',
      started: nowMs,
      backendMode: 'cloudflare_github_actions',
    };

    // Never overwrite a user-cancelled job with a running update
    if (existing.status === 'cancelled' && !TERMINAL_STATUSES.has(payload.status)) {
      return json({ ok: true, id, status: 'cancelled', cancelRequested: true });
    }

    const incomingStatus = String(payload.status || existing.status || 'running');
    const verified = verifyRunnerCompletion(incomingStatus, payload);
    const finalStatus = existing.status === 'cancelled' ? 'cancelled' : verified.status;

    const merged = {
      ...existing,
      ...payload,
      id,
      status: finalStatus,
      backendMode: 'cloudflare_github_actions',
      updated: nowMs,
      githubRun: payload.githubRun
        ? { ...(existing.githubRun || {}), ...payload.githubRun }
        : existing.githubRun || null,
      coordinatorVerifiedCompletion: verified.verified,
    };
    if (!verified.verified && verified.note) {
      merged.error = merged.error ? `${merged.error} | ${verified.note}` : verified.note;
    }
    // Preserve pending target update if selection is not yet locked
    if (existing.pendingTarget && !merged.targetLocked) {
      merged.pendingTarget = existing.pendingTarget;
    } else if (merged.targetLocked) {
      delete merged.pendingTarget;
    }

    await writeJsonKv(kv, `job:${id}`, merged);
    if (TERMINAL_STATUSES.has(finalStatus)) {
      const active = await readJsonKv(kv, ACTIVE_KEY);
      if (active && active.id === id) {
        await kv.delete(ACTIVE_KEY);
      }
    }

    return json({
      ok: true,
      id,
      status: finalStatus,
      cancelRequested: merged.status === 'cancelled',
      pendingTarget: merged.pendingTarget || null,
    });
  }

  const mControl = /^\/jobs\/([a-zA-Z0-9_-]+)\/control$/.exec(pathname);
  if (request.method === 'GET' && mControl) {
    if (!isRunnerAuthorized(request, env)) {
      return json({ ok: false, error: 'Unauthorized runner callback token.' }, 401);
    }
    const id = sanitizeId(mControl[1]);
    const job = await readJsonKv(kv, `job:${id}`);
    if (!job) return json({ ok: false, error: 'Job not found.' }, 404);
    return json({
      ok: true,
      id,
      status: job.status,
      cancelRequested: job.status === 'cancelled',
      pendingTarget: job.targetLocked ? null : (job.pendingTarget || null),
    });
  }

  // -------------------------------------------------------------------------
  // CLIENT ENDPOINTS (authenticated via CLIENT_AUTH_TOKEN)
  // -------------------------------------------------------------------------
  if (!isClientAuthorized(request, env)) {
    return json({ ok: false, error: 'Unauthorized: provide Authorization: Bearer <client_token>' }, 401);
  }

  // GET /health
  if (request.method === 'GET' && pathname === '/health') {
    const activeJob = await reconcileActiveJob(env, fetchFn, nowMs);
    const hasGhToken = Boolean(String(env.GITHUB_DISPATCH_TOKEN || '').trim());
    const hasRunnerTok = Boolean(String(env.RUNNER_CALLBACK_TOKEN || '').trim());
    return json({
      ok: true,
      engine: 'betbrain-cloudflare-coordinator',
      architecture: 'cloudflare_worker+github_actions',
      activeJobs: activeJob ? 1 : 0,
      activeJobId: activeJob ? activeJob.id : null,
      maxConcurrentJobs: Math.max(1, Number(env.MAX_CONCURRENT_JOBS || 1)),
      githubConfigured: hasGhToken,
      runnerCallbackConfigured: hasRunnerTok,
      acceptingJobs: hasGhToken && !activeJob,
      refusalReason: !hasGhToken
        ? 'GITHUB_DISPATCH_TOKEN secret not configured'
        : (activeJob ? `Active job ${activeJob.id} is already running` : ''),
      repo: `${env.GITHUB_OWNER || 'muhangibonny0-debug'}/${env.GITHUB_REPO || 'bet-robot'}`,
      workflow: env.GITHUB_WORKFLOW_FILE || 'research.yml',
    });
  }

  // POST /jobs — validate, enforce single active job & duplicate guard, trigger GitHub Actions
  if (request.method === 'POST' && pathname === '/jobs') {
    if (!String(env.GITHUB_DISPATCH_TOKEN || '').trim()) {
      return json({ ok: false, error: 'Coordinator missing GITHUB_DISPATCH_TOKEN secret.' }, 503);
    }
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON request body.' }, 400);
    }
    const params = body && typeof body.params === 'object' ? { ...body.params } : { ...(body || {}) };
    const val = validateResearchParams(params);
    if (!val.ok) {
      return json({ ok: false, error: val.error }, 400);
    }

    const activeJob = await reconcileActiveJob(env, fetchFn, nowMs);
    const fp = await computeFingerprint(params);
    if (activeJob) {
      if (activeJob.fingerprint === fp) {
        return json({
          ok: false,
          duplicate: true,
          activeJobId: activeJob.id,
          error: `An identical research job (${activeJob.id}) is already running.`,
        }, 409);
      }
      return json({
        ok: false,
        activeJobId: activeJob.id,
        error: `Another research job (${activeJob.id}) is already active. Cancel it or wait for completion.`,
      }, 409);
    }

    const id = sanitizeId(body && body.id) || generateJobId(nowMs);
    const existingById = await readJsonKv(kv, `job:${id}`);
    if (existingById && !TERMINAL_STATUSES.has(existingById.status)) {
      return json({ ok: false, error: `Duplicate job ID "${id}" is already active.` }, 409);
    }

    // Merge server-persisted confirmed-used selections so both phones share diversification history
    const usedStore = (await readJsonKv(kv, CONFIRMED_USED_KEY)) || { tickets: [] };
    const sharedUsed = [];
    for (const t of (usedStore.tickets || [])) {
      if (t && t.confirmedUsed === true && Array.isArray(t.selections)) {
        sharedUsed.push(...t.selections);
      }
    }
    if (sharedUsed.length) {
      const clientUsed = Array.isArray(params.usedSelections) ? params.usedSelections : [];
      params.usedSelections = [...clientUsed, ...sharedUsed].slice(0, 200);
    }

    // Ensure cloud runner does NOT require phone gateway unless explicitly requested
    if (params.usePhoneGateway == null) params.usePhoneGateway = false;

    const jobPayload = {
      id,
      text: String((body && body.text) || '').slice(0, 400),
      params,
    };

    const dispatchRes = await dispatchGitHubWorkflow(env, id, jobPayload, fetchFn);
    if (!dispatchRes.ok) {
      return json({ ok: false, error: dispatchRes.error }, 502);
    }

    // Best-effort lookup of the GitHub Actions run ID
    const ghRun = await lookupLatestWorkflowRun(env, nowMs, fetchFn);

    const jobRecord = {
      id,
      status: 'queued',
      stage: 'Queued: GitHub Actions runner starting...',
      started: nowMs,
      updated: nowMs,
      fingerprint: fp,
      backendMode: 'cloudflare_github_actions',
      request: params,
      githubRun: ghRun,
      progress: {
        stageKey: 'queued',
        stageLabel: 'Queued: GitHub Actions runner starting...',
        percent: null,
        elapsedSec: 0,
        estimatedRemainingSec: null,
        targetOdds: Number(params.target) || 0,
        targetLocked: false,
        targetEditable: true,
      },
      counts: {},
      ticket: null,
      booking: null,
      error: '',
    };

    await writeJsonKv(kv, `job:${id}`, jobRecord);
    await writeJsonKv(kv, ACTIVE_KEY, { id, started: nowMs, fingerprint: fp });

    return json({
      ok: true,
      id,
      status: 'queued',
      backendMode: 'cloudflare_github_actions',
      githubRun: ghRun,
    }, 202);
  }

  // GET /jobs/:id
  const mGet = /^\/jobs\/([a-zA-Z0-9_-]+)$/.exec(pathname);
  if (request.method === 'GET' && mGet) {
    const id = sanitizeId(mGet[1]);
    let job = await readJsonKv(kv, `job:${id}`);
    if (!job) return json({ ok: false, error: 'Job not found.' }, 404);

    // If still active, reconcile staleness and GitHub Actions run status
    if (!TERMINAL_STATUSES.has(job.status)) {
      if (!job.githubRun || !job.githubRun.runId) {
        const foundRun = await lookupLatestWorkflowRun(env, job.started || nowMs, fetchFn);
        if (foundRun) {
          job.githubRun = foundRun;
          await writeJsonKv(kv, `job:${id}`, job);
        }
      }
      await reconcileActiveJob(env, fetchFn, nowMs);
      job = (await readJsonKv(kv, `job:${id}`)) || job;
    }

    return json(job, 200);
  }

  // POST|PATCH /jobs/:id/target
  const mTarget = /^\/jobs\/([a-zA-Z0-9_-]+)\/target$/.exec(pathname);
  if ((request.method === 'POST' || request.method === 'PATCH') && mTarget) {
    const id = sanitizeId(mTarget[1]);
    const job = await readJsonKv(kv, `job:${id}`);
    if (!job) return json({ ok: false, error: 'Job not found.' }, 404);
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body.' }, 400);
    }
    const target = Number(body && body.target);
    if (!Number.isFinite(target) || target <= 1.0 || target > 10000) {
      return json({ ok: false, error: 'Invalid target odds (must be > 1.0 and <= 10000).' }, 400);
    }
    const locked = job.targetLocked === true ||
      (job.progress && job.progress.targetLocked === true) ||
      TERMINAL_STATUSES.has(job.status);
    if (locked) {
      return json({
        ok: false,
        targetLocked: true,
        error: 'Selection has already started; target odds are locked for this research run.',
      }, 409);
    }
    job.pendingTarget = target;
    if (job.request && typeof job.request === 'object') job.request.target = target;
    if (job.counts && typeof job.counts === 'object') job.counts.targetOdds = target;
    if (job.progress && typeof job.progress === 'object') job.progress.targetOdds = target;
    job.updated = nowMs;
    await writeJsonKv(kv, `job:${id}`, job);
    return json({ ok: true, id, target, targetLocked: false });
  }

  // POST /jobs/:id/cancel
  const mCancel = /^\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/.exec(pathname);
  if (request.method === 'POST' && mCancel) {
    const id = sanitizeId(mCancel[1]);
    const job = await readJsonKv(kv, `job:${id}`);
    if (!job) return json({ ok: false, error: 'Job not found.' }, 404);
    job.status = 'cancelled';
    job.stage = 'Cancelled by user.';
    job.updated = nowMs;
    await writeJsonKv(kv, `job:${id}`, job);
    const active = await readJsonKv(kv, ACTIVE_KEY);
    if (active && active.id === id) {
      await kv.delete(ACTIVE_KEY);
    }
    let ghCancelled = false;
    if (job.githubRun && job.githubRun.runId && env.GITHUB_DISPATCH_TOKEN) {
      ghCancelled = await cancelGitHubRun(env, job.githubRun.runId, fetchFn);
    }
    return json({ ok: true, id, cancelled: true, githubRunCancelled: ghCancelled });
  }

  // GET /tickets/confirmed-used
  if (request.method === 'GET' && pathname === '/tickets/confirmed-used') {
    const store = (await readJsonKv(kv, CONFIRMED_USED_KEY)) || { tickets: [] };
    return json({ ok: true, count: store.tickets.length, tickets: store.tickets });
  }

  // POST /tickets/:id/confirm-used
  const mConfirmUsed = /^\/tickets\/([a-zA-Z0-9_-]+)\/confirm-used$/.exec(pathname);
  if (request.method === 'POST' && mConfirmUsed) {
    const ticketId = sanitizeId(mConfirmUsed[1]);
    if (!ticketId) return json({ ok: false, error: 'Invalid ticket id.' }, 400);
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}
    const store = (await readJsonKv(kv, CONFIRMED_USED_KEY)) || { tickets: [] };
    const idx = store.tickets.findIndex((t) => t && t.ticketId === ticketId);
    const existing = idx >= 0 ? store.tickets[idx] : null;
    let selections = Array.isArray(body.selections) ? body.selections : (Array.isArray(body.legs) ? body.legs : []);
    let bookingCode = String(body.bookingCode || (existing && existing.bookingCode) || '').trim();
    if (!selections.length) {
      const jf = await readJsonKv(kv, `job:${ticketId}`);
      if (jf && jf.ticket && Array.isArray(jf.ticket.legs)) {
        selections = jf.ticket.legs.map((l) => ({
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
        if (!bookingCode && jf.booking && jf.booking.code) bookingCode = String(jf.booking.code).trim();
      }
    }
    const entry = {
      ticketId,
      bookingCode,
      confirmedUsed: true,
      confirmedAt: (existing && existing.confirmedAt) || Number(body.confirmedAt) || nowMs,
      selections: selections.length ? selections : ((existing && existing.selections) || []),
    };
    if (idx >= 0) store.tickets[idx] = entry;
    else store.tickets.push(entry);
    if (store.tickets.length > 50) store.tickets = store.tickets.slice(-50);
    await writeJsonKv(kv, CONFIRMED_USED_KEY, store, null);
    return json({
      ok: true,
      ticketId,
      confirmedUsed: true,
      alreadyConfirmed: !!existing,
      selectionsCount: entry.selections.length,
    });
  }

  return json({ ok: false, error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
