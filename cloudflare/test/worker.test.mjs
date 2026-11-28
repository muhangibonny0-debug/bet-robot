import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, validateResearchParams, verifyRunnerCompletion } from '../src/worker.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    _raw: store,
  };
}

function makeEnv(kv) {
  return {
    BETBRAIN_JOBS: kv,
    CLIENT_AUTH_TOKEN: 'test-client-secret-123',
    RUNNER_CALLBACK_TOKEN: 'test-runner-secret-456',
    GITHUB_DISPATCH_TOKEN: 'ghp_mock_dispatch_token',
    GITHUB_OWNER: 'muhangibonny0-debug',
    GITHUB_REPO: 'bet-robot',
    GITHUB_WORKFLOW_FILE: 'research.yml',
    GITHUB_REF: 'main',
    MAX_CONCURRENT_JOBS: '1',
    JOB_STALE_MINUTES: '20',
    JOB_MAX_MINUTES: '115',
  };
}

test('Cloudflare Worker: rejects unauthenticated requests with 401', async () => {
  const kv = createMemoryKv();
  const env = makeEnv(kv);
  const req = new Request('https://worker.test/health');
  const res = await handleRequest(req, env, {});
  assert.equal(res.status, 401);
});

test('Cloudflare Worker: health endpoint reports ready when configured', async () => {
  const kv = createMemoryKv();
  const env = makeEnv(kv);
  const req = new Request('https://worker.test/health', {
    headers: { Authorization: 'Bearer test-client-secret-123' },
  });
  const res = await handleRequest(req, env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, 'betbrain-cloudflare-coordinator');
  assert.equal(body.acceptingJobs, true);
});

test('Cloudflare Worker: validates research params strictly', () => {
  assert.equal(validateResearchParams({ sports: ['football'], scope: 'today', target: 3.5 }).ok, true);
  assert.equal(validateResearchParams({ sports: [], scope: 'today', target: 3.5 }).ok, false);
  assert.equal(validateResearchParams({ sports: ['cricket'], scope: 'today', target: 3.5 }).ok, false);
  assert.equal(validateResearchParams({ sports: ['football'], scope: 'range', dateFrom: '2026-11-01', dateTo: '2027-02-01' }).ok, false);
  assert.equal(validateResearchParams({ sports: ['football'], scope: 'today', target: 1.0 }).ok, false);
});

test('Cloudflare Worker: dispatches GitHub workflow, blocks duplicates, accepts runner progress, and verifies completion', async () => {
  const kv = createMemoryKv();
  const env = makeEnv(kv);
  let dispatched = 0;
  let now = 1700000000000;

  const mockFetch = async (url, init = {}) => {
    if (String(url).includes('/dispatches')) {
      dispatched++;
      return new Response(null, { status: 204 });
    }
    if (String(url).includes('/runs?event=workflow_dispatch')) {
      return new Response(JSON.stringify({
        workflow_runs: [{
          id: 987654,
          run_number: 42,
          html_url: 'https://github.com/muhangibonny0-debug/bet-robot/actions/runs/987654',
          status: 'queued',
          conclusion: null,
          created_at: new Date(now).toISOString(),
        }],
      }), { status: 200 });
    }
    if (String(url).includes('/actions/runs/987654') && init.method !== 'POST') {
      return new Response(JSON.stringify({
        id: 987654,
        status: 'in_progress',
        conclusion: null,
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  // 1) Create job
  const createRes = await handleRequest(new Request('https://worker.test/jobs', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-client-secret-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'job_abc', text: 'football today 3.0', params: { sports: ['football'], scope: 'today', target: 3.0 } }),
  }), env, {}, { fetch: mockFetch, now: () => now });
  assert.equal(createRes.status, 202);
  const created = await createRes.json();
  assert.equal(created.id, 'job_abc');
  assert.equal(created.githubRun.runId, 987654);
  assert.equal(dispatched, 1);

  // 2) Duplicate request blocked with 409
  const dupRes = await handleRequest(new Request('https://worker.test/jobs', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-client-secret-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: { sports: ['football'], scope: 'today', target: 3.0 } }),
  }), env, {}, { fetch: mockFetch, now: () => now });
  assert.equal(dupRes.status, 409);

  // 3) Live target update before selection starts
  const tgtRes = await handleRequest(new Request('https://worker.test/jobs/job_abc/target', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-client-secret-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 4.5 }),
  }), env, {}, { fetch: mockFetch, now: () => now });
  assert.equal(tgtRes.status, 200);

  // 4) Runner polls control and sees pendingTarget
  const ctrlRes = await handleRequest(new Request('https://worker.test/jobs/job_abc/control', {
    headers: { 'X-Runner-Token': 'test-runner-secret-456' },
  }), env, {}, { fetch: mockFetch, now: () => now });
  const ctrl = await ctrlRes.json();
  assert.equal(ctrl.pendingTarget, 4.5);
  assert.equal(ctrl.cancelRequested, false);

  // 5) Runner attempts to report `done` WITHOUT a verified booking code -> rejected to booking_failed
  const fakeDoneRes = await handleRequest(new Request('https://worker.test/jobs/job_abc/progress', {
    method: 'POST',
    headers: { 'X-Runner-Token': 'test-runner-secret-456', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', ticket: { legs: [{ home: 'A', away: 'B' }] }, booking: { ok: false, code: '' } }),
  }), env, {}, { fetch: mockFetch, now: () => now });
  const fakeDone = await fakeDoneRes.json();
  assert.equal(fakeDone.status, 'booking_failed');

  // 6) Verify completion helper directly accepts genuine verified booking code
  const okVer = verifyRunnerCompletion('done', {
    ticket: { legs: [{ home: 'A', away: 'B', odds: 1.8 }] },
    booking: { ok: true, code: 'M5j8eu', codeVerifiedIndependently: true },
  });
  assert.equal(okVer.status, 'done');
  assert.equal(okVer.verified, true);
});

test('Cloudflare Worker: detects crashed GitHub runner and marks job failed', async () => {
  const kv = createMemoryKv();
  const env = makeEnv(kv);
  let now = 1700000000000;
  let runStatus = 'in_progress';
  let runConclusion = null;

  const mockFetch = async (url) => {
    if (String(url).includes('/dispatches')) return new Response(null, { status: 204 });
    if (String(url).includes('/runs?event=workflow_dispatch')) {
      return new Response(JSON.stringify({
        workflow_runs: [{ id: 555, status: 'queued', conclusion: null, created_at: new Date(now).toISOString() }],
      }), { status: 200 });
    }
    if (String(url).includes('/actions/runs/555')) {
      return new Response(JSON.stringify({ id: 555, status: runStatus, conclusion: runConclusion }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  await handleRequest(new Request('https://worker.test/jobs', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-client-secret-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'job_crash', params: { sports: ['football'], scope: 'today', target: 2.5 } }),
  }), env, {}, { fetch: mockFetch, now: () => now });

  // Runner crashes on GitHub Actions
  runStatus = 'completed';
  runConclusion = 'failure';
  const getRes = await handleRequest(new Request('https://worker.test/jobs/job_crash', {
    headers: { Authorization: 'Bearer test-client-secret-123' },
  }), env, {}, { fetch: mockFetch, now: () => now + 60000 });
  const job = await getRes.json();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /without reporting verified completion/i);
});

test('Cloudflare Worker: shares confirmed-used tickets across phones', async () => {
  const kv = createMemoryKv();
  const env = makeEnv(kv);
  const res1 = await handleRequest(new Request('https://worker.test/tickets/t1/confirm-used', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-client-secret-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookingCode: 'ABC123',
      selections: [{ fixtureId: 101, home: 'Arsenal', away: 'Chelsea', approvedMarketId: 'match_result_1x2', canonicalOutcome: 'H' }],
    }),
  }), env, {});
  assert.equal(res1.status, 200);

  const res2 = await handleRequest(new Request('https://worker.test/tickets/confirmed-used', {
    headers: { Authorization: 'Bearer test-client-secret-123' },
  }), env, {});
  const data = await res2.json();
  assert.equal(data.count, 1);
  assert.equal(data.tickets[0].bookingCode, 'ABC123');
});
