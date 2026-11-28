'use strict';
// Read-only live diagnostic probe for GitHub Actions runner (NO Phone Gateway, NO paid proxy, NO bets).
// Tests:
//   1) Minimal live Groq API check (real model, latency, auth/quota error — never prints key).
//   2) Real BangBet weekend fixture discovery, Stats-tab activation, Gismo/Sportradar network trace,
//      full field extraction, missing-field audit, and timing.
//   3) Real Groq AI Analyst call using genuine collected stats + actual BangBet 21-market catalogue,
//      validating strict JSON, 3 ranked recommendations, live bookmaker match, and NO SELECTION behavior.

const fs = require('fs');
const path = require('path');
const { Site, createFixtureRegistry, OUT } = require('../lib/site');
const ex = require('../lib/extract');
const an = require('../lib/analyze');
const { buildStructuredStatsPacket } = require('../lib/stats_packet');
const aiAnalyst = require('../lib/ai_analyst');
const dates = require('../lib/dates');

async function testLiveGroqMinimal() {
  const key = aiAnalyst.getGroqKey();
  if (!key) {
    return { status: 'BLOCKED', realGroq: false, reason: 'GROQ_API_KEY is not set in environment.' };
  }
  const t0 = Date.now();
  const model = aiAnalyst.PRIMARY_MODEL;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with strictly valid JSON: {"ok":true,"note":"ready"}' }],
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });
    const latencyMs = Date.now() - t0;
    const rawText = await res.text();
    if (!res.ok) {
      const safeErr = rawText.replace(key, '[REDACTED]').slice(0, 240);
      return { status: 'FAIL', realGroq: true, httpStatus: res.status, model, latencyMs, error: safeErr };
    }
    const data = JSON.parse(rawText);
    const content = data?.choices?.[0]?.message?.content || '';
    return {
      status: 'PASS',
      realGroq: true,
      httpStatus: res.status,
      model: data.model || model,
      latencyMs,
      usage: data.usage || null,
      responseSample: String(content).slice(0, 120),
    };
  } catch (e) {
    return {
      status: 'FAIL',
      realGroq: true,
      model,
      latencyMs: Date.now() - t0,
      error: String(e.message || e).replace(key, '[REDACTED]'),
    };
  }
}

async function main() {
  const startedAt = Date.now();
  const maxFixtures = Math.max(1, Math.min(5, Number(process.env.PROBE_MAX_FIXTURES) || 2));
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      isGitHubActions: process.env.GITHUB_ACTIONS === 'true',
      runnerOs: process.env.RUNNER_OS || process.platform,
      phoneGatewayEnabled: false,
      proxyConfigured: Boolean(process.env.BOT_PROXY),
    },
    groqMinimalTest: null,
    discovery: null,
    fixtures: [],
    totalDurationMs: 0,
  };

  // Priority 2 — Minimal real Groq check
  report.groqMinimalTest = await testLiveGroqMinimal();

  // Priority 1 & 3 — Live BangBet discovery, Stats/Gismo trace, and real Groq AI analysis
  const site = new Site();
  const tBrowser0 = Date.now();
  await site.start({ optimizeData: true });
  const browserStartMs = Date.now() - tBrowser0;

  try {
    const tDisc0 = Date.now();
    const reg = createFixtureRegistry();
    const ds = dates.resolveDateScope({ scope: 'weekend' }, Date.now());
    const listing = await site.openListing('football', { scope: 'weekend' }, { tabScope: 'all', registry: reg });
    await site.collectNextBatch(listing, Date.now() + 35000, 15, {
      fromMs: ds.fromMs,
      toMs: ds.toMs,
      desiredEligibleCap: 20,
    });
    if (listing && listing.page) await listing.page.close().catch(() => {});
    const discoveryMs = Date.now() - tDisc0;

    const weekendMatches = reg.list.filter((e) => e.url && e.ts >= ds.fromMs && e.ts < ds.toMs);
    const chosen = (weekendMatches.length ? weekendMatches : reg.list.filter((e) => e.url)).slice(0, maxFixtures);

    report.discovery = {
      status: reg.list.length > 0 ? 'PASS' : 'FAIL',
      browserStartMs,
      discoveryMs,
      weekendWindow: { startDate: ds.startDate, endDate: ds.endDate },
      totalDiscovered: reg.list.length,
      inWeekendWindow: weekendMatches.length,
      sampledCount: chosen.length,
    };

    const page = await site.newPage();
    for (const ev of chosen) {
      const fT0 = Date.now();
      const networkTrace = [];
      const onResp = (r) => {
        const u = r.url();
        if (/gismo|sportradar|akamaized|widgets\.sir|\/api\/bet\/match\/odds/i.test(u)) {
          networkTrace.push({ status: r.status(), url: u.split('?')[0].slice(0, 160) });
        }
      };
      const onFail = (req) => {
        const u = req.url();
        if (/gismo|sportradar|akamaized|widgets\.sir/i.test(u)) {
          networkTrace.push({ failed: req.failure()?.errorText || 'failed', url: u.split('?')[0].slice(0, 160) });
        }
      };
      page.on('response', onResp);
      page.on('requestfailed', onFail);

      const opened = await site.openEvent(page, ev, 'weekend', { scope: 'weekend' });
      let markets = [];
      let stats = null;
      let statsPacket = null;
      let aiResult = null;
      let fallbackResult = null;
      let detCands = [];

      if (opened) {
        markets = await ex.markets(page, ev);
        ev.markets = markets;
        stats = await ex.stats(page, ev, { viaPhoneGateway: false });
        ev.stats = stats;
        statsPacket = buildStructuredStatsPacket(ev);
        detCands = an.candidates(ev, { sports: ['football'] });

        // Strictly require REAL Groq when key is present (never disguise offline fallback as Groq!)
        if (aiAnalyst.getGroqKey()) {
          aiResult = await aiAnalyst.analyzeFixtureWithAi(ev, {
            statsPacket,
            deterministicCandidates: detCands,
            requireGroq: true,
            fallbackOnError: false,
          });
        } else {
          aiResult = { ok: false, aiSource: 'blocked_no_groq_key', error: 'GROQ_API_KEY not configured' };
        }

        if (aiResult && aiResult.ok && aiResult.analysis) {
          fallbackResult = aiAnalyst.resolveRankedSelectionWithFallback(aiResult.analysis, markets, ev);
        }
      }

      page.off('response', onResp);
      page.off('requestfailed', onFail);

      report.fixtures.push({
        fixture: { home: ev.home, away: ev.away, league: ev.league, matchId: ev.matchId, url: ev.url },
        opened,
        durationMs: Date.now() - fT0,
        marketsRead: markets.length,
        approvedMarketsOffered: ev.marketDiscoveryReport ? ev.marketDiscoveryReport.approvedMarketsOffered : [],
        stats: stats ? {
          available: stats.available,
          status: stats.status,
          source: stats.source,
          tabClicked: stats.tab,
          gismoResponses: stats.responseCount || 0,
          endpointsCaptured: stats.endpointsCaptured || [],
          categories: stats.categories || {},
          licensingStatus: stats.diagnostics ? stats.diagnostics.licensingStatus : 'unknown',
          httpErrors: stats.diagnostics ? stats.diagnostics.httpErrors : [],
          failedRequests: stats.diagnostics ? stats.diagnostics.failedRequests : [],
        } : null,
        completeness: statsPacket ? statsPacket.completeness : null,
        networkTraceCount: networkTrace.length,
        networkTraceSample: networkTrace.slice(0, 35),
        aiAnalysis: aiResult ? {
          ok: aiResult.ok,
          aiSource: aiResult.aiSource,
          modelUsed: aiResult.modelUsed || null,
          tokens: aiResult.tokens || null,
          durationMs: aiResult.durationMs || 0,
          error: aiResult.error || null,
          noSelection: aiResult.analysis ? aiResult.analysis.noSelection : null,
          noSelectionReason: aiResult.analysis ? aiResult.analysis.noSelectionReason : null,
          recommendations: aiResult.analysis ? aiResult.analysis.recommendations : [],
          rejectedFabricated: aiResult.rejectedFabricated || [],
        } : null,
        fallbackTrace: fallbackResult ? fallbackResult.trace : null,
      });
    }
    await page.close().catch(() => {});
  } finally {
    await site.close();
  }

  report.totalDurationMs = Date.now() - startedAt;
  const outPath = path.join(OUT, 'live_probe_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[live-probe] FATAL:', e);
  process.exit(1);
});
