'use strict';
// Lightweight zero-dependency HTTP client for reporting BetRobot progress, partial results,
// and verified completion to the Cloudflare Worker coordinator, and polling control signals
// (live target-odds updates before selection lock & user cancellation).

function getConfig() {
  const url = String(process.env.CLOUDFLARE_WORKER_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.CLOUDFLARE_RUNNER_TOKEN || '').trim();
  return { enabled: Boolean(url && token), url, token };
}

async function reportProgress(jobId, state, opts = {}) {
  const cfg = getConfig();
  if (!cfg.enabled || !jobId) return { ok: false, skipped: true };
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const payload = {
      ...state,
      githubRun: process.env.GITHUB_RUN_ID ? {
        runId: Number(process.env.GITHUB_RUN_ID) || process.env.GITHUB_RUN_ID,
        runNumber: Number(process.env.GITHUB_RUN_NUMBER) || null,
        htmlUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : '',
      } : state.githubRun || null,
    };
    const res = await fetch(`${cfg.url}/jobs/${encodeURIComponent(jobId)}/progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Runner-Token': cfg.token,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      cancelRequested: body.cancelRequested === true,
      pendingTarget: body.pendingTarget || null,
      status: body.status || state.status,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function pollControl(jobId, opts = {}) {
  const cfg = getConfig();
  if (!cfg.enabled || !jobId) return { ok: false, skipped: true };
  const timeoutMs = Number(opts.timeoutMs) || 6000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/jobs/${encodeURIComponent(jobId)}/control`, {
      headers: { 'X-Runner-Token': cfg.token },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      cancelRequested: body.cancelRequested === true,
      pendingTarget: body.pendingTarget || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getConfig, reportProgress, pollControl };
