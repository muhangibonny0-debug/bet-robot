'use strict';
// Backend Groq AI Analyst + Strict Schema Validation + 3-Ranked Market Recommendations & Fallback.
// Uses the existing zero-cost Groq API integration (primary: openai/gpt-oss-20b, fallback: openai/gpt-oss-120b).
// Never fabricates statistics, never invents bookmaker markets/odds, supports NO SELECTION,
// and validates every recommendation against the live bookmaker market catalogue.

const { getKnowledgeGuideForSport } = require('./ai_knowledge');
const { buildStructuredStatsPacket } = require('./stats_packet');
const approvedMarkets = require('./approved_markets');
const sportMarkets = require('./sport_markets');
const { norm } = require('./util');

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = process.env.GROQ_PRIMARY_MODEL || 'openai/gpt-oss-20b';
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b';

function getGroqKey() {
  return String(process.env.GROQ_API_KEY || '').trim();
}

// Build a compact, truthful list of available approved bookmaker markets for a fixture.
function summarizeAvailableMarkets(ev) {
  const sp = String((ev && ev.sport) || 'football').toLowerCase();
  const raw = Array.isArray(ev && ev.markets) ? ev.markets : [];
  const out = [];
  const seen = new Set();
  for (let idx = 0; idx < raw.length; idx++) {
    const m = raw[idx];
    if (!m || !Number.isFinite(m.odds) || m.odds <= 1 || m.odds >= 1000) continue;
    const ap = sp === 'football'
      ? approvedMarkets.matchApprovedMarket(m.title, m.label, ev)
      : sportMarkets.matchSportMarket(sp, m.title, m.label, ev);
    if (!ap || !ap.approved) continue;
    const key = `${ap.approvedMarketId}::${ap.canonicalOutcome}::${m.odds.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      liveMarketIndex: idx,
      approvedMarketId: ap.approvedMarketId,
      marketName: ap.marketName || m.title,
      title: m.title,
      outcome: m.label,
      canonicalOutcome: ap.canonicalOutcome || '',
      line: ap.line != null ? ap.line : (m.line != null ? m.line : null),
      side: ap.side || '',
      teamSide: ap.teamSide || '',
      dir: ap.dir || '',
      odds: Number(m.odds),
    });
  }
  return out;
}

function buildAnalystPrompt(ev, statsPacket, availableMarkets) {
  const sport = String((ev && ev.sport) || 'football').toLowerCase();
  const guide = getKnowledgeGuideForSport(sport);
  const catalogueSummary = sport === 'football'
    ? approvedMarkets.listApprovedMarkets().map((m) => ({
        id: m.id,
        name: m.name,
        family: m.marketFamily || 'general',
        outcomes: m.outcomes,
        settlement: m.settlementRules,
      }))
    : (sportMarkets.SPORT_APPROVED_MARKETS[sport] || []);

  const payload = {
    fixture: statsPacket.matchIdentity,
    statistics: {
      headToHeadAverages: statsPacket.headToHeadAverages,
      winProbability: statsPacket.winProbability,
      previousMeetings: statsPacket.previousMeetings,
      leagueStandings: statsPacket.leagueStandings,
      lastMatchesForm: statsPacket.lastMatchesForm,
      teamStatsComparison: statsPacket.teamStatsComparison,
      halfScoringSplits: statsPacket.halfScoringSplits,
      completeness: statsPacket.completeness,
    },
    availableBookmakerMarkets: availableMarkets.slice(0, 80),
  };

  const system = [
    'You are the BetRobot Statistical Analyst AI.',
    'Analyze the provided fixture using ONLY the supplied statistics and available bookmaker markets.',
    'NEVER invent statistics, NEVER convert missing values to 0, NEVER fabricate market IDs or odds.',
    'You MUST return strictly valid JSON matching the required schema and nothing else (no markdown fences).',
    guide,
    'APPROVED MARKET CATALOGUE FOR THIS SPORT:',
    JSON.stringify(catalogueSummary),
  ].join('\n\n');

  const user = [
    'Analyze this fixture and return strictly valid JSON with the exact keys:',
    '{',
    '  "matchId": number|string|null,',
    '  "homeTeam": string,',
    '  "awayTeam": string,',
    '  "competition": string,',
    '  "kickoff": string|null,',
    '  "statisticalEvidenceSummary": string,',
    '  "supportingStatistics": string[],',
    '  "contradictoryStatistics": string[],',
    '  "missingInformation": string[],',
    '  "dataCompletenessAssessment": "complete"|"partial"|"insufficient",',
    '  "noSelection": boolean,',
    '  "noSelectionReason": string,',
    '  "recommendations": [',
    '    {',
    '      "rank": 1|2|3,',
    '      "approvedMarketId": string,',
    '      "marketName": string,',
    '      "outcome": string,',
    '      "canonicalOutcome": string,',
    '      "line": number|null,',
    '      "odds": number,',
    '      "explanation": string,',
    '      "confidenceAssessment": "high"|"medium"|"low",',
    '      "evidenceStrength": number',
    '    }',
    '  ],',
    '  "rejectedAlternatives": [{ "market": string, "reason": string }],',
    '  "requestedMissingFields": string[]',
    '}',
    '',
    'RULES:',
    '- Return up to 3 ranked recommendations (rank 1 = strongest, rank 2 = second-best alternative, rank 3 = third-best alternative).',
    '- Every recommendation MUST match an entry in availableBookmakerMarkets (exact approvedMarketId, outcome, line, odds).',
    '- Avoid ranking highly correlated markets as if they were independent.',
    '- If evidence is insufficient, contradictory, or no available market is genuinely supported, set "noSelection": true and "recommendations": [].',
    '',
    'FIXTURE DATA:',
    JSON.stringify(payload),
  ].join('\n');

  return { system, user };
}

function extractJsonObject(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {}
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function matchRecommendationToLiveMarket(rec, availableMarkets, ev) {
  if (!rec || typeof rec !== 'object' || !Array.isArray(availableMarkets)) return null;
  const targetId = String(rec.approvedMarketId || '').trim();
  if (!targetId) return null;
  const targetCanon = norm(rec.canonicalOutcome || '');
  const targetOutcome = norm(rec.outcome || '');
  const targetLine = rec.line != null && rec.line !== '' && Number.isFinite(Number(rec.line)) ? Number(rec.line) : null;

  // 1) Exact approvedMarketId + canonicalOutcome (+ line if present)
  if (targetCanon) {
    const hit = availableMarkets.find((m) =>
      m.approvedMarketId === targetId &&
      norm(m.canonicalOutcome) === targetCanon &&
      (targetLine == null || m.line == null || Math.abs(Number(m.line) - targetLine) < 0.01)
    );
    if (hit) return hit;
  }

  // 2) Exact approvedMarketId + outcome text (+ line if present)
  if (targetOutcome) {
    const hit = availableMarkets.find((m) =>
      m.approvedMarketId === targetId &&
      norm(m.outcome) === targetOutcome &&
      (targetLine == null || m.line == null || Math.abs(Number(m.line) - targetLine) < 0.01)
    );
    if (hit) return hit;
  }

  // 3) Re-parse rec.marketName + rec.outcome through approved dictionary to resolve canonicalOutcome
  const sp = String((ev && ev.sport) || 'football').toLowerCase();
  const parsed = sp === 'football'
    ? approvedMarkets.matchApprovedMarket(rec.marketName || targetId, rec.outcome || '', ev || {})
    : sportMarkets.matchSportMarket(sp, rec.marketName || targetId, rec.outcome || '', ev || {});
  if (parsed && parsed.approved && parsed.approvedMarketId === targetId) {
    const hit = availableMarkets.find((m) =>
      m.approvedMarketId === targetId &&
      norm(m.canonicalOutcome) === norm(parsed.canonicalOutcome)
    );
    if (hit) return hit;
  }

  return null;
}

// Strict schema & catalogue validation of an AI analyst JSON response.
function validateAiAnalysisResponse(parsed, ev, availableMarkets) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['Response is not a JSON object.'], cleaned: null };
  }
  const sp = String((ev && ev.sport) || 'football').toLowerCase();
  const isApprovedId = (id) => (sp === 'football'
    ? approvedMarkets.isApprovedMarketId(id)
    : sportMarkets.isApprovedSportMarketId(sp, id));

  if (typeof parsed.statisticalEvidenceSummary !== 'string' || !parsed.statisticalEvidenceSummary.trim()) {
    errors.push('Missing statisticalEvidenceSummary.');
  }
  const completeness = ['complete', 'partial', 'insufficient'].includes(parsed.dataCompletenessAssessment)
    ? parsed.dataCompletenessAssessment
    : 'partial';

  const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  if (rawRecs.length > 3) {
    errors.push('More than 3 recommendations returned.');
  }

  const validatedRecs = [];
  const rejectedFabricated = [];
  const seenKeys = new Set();

  for (const r of rawRecs.slice(0, 3)) {
    if (!r || typeof r !== 'object') continue;
    const mid = String(r.approvedMarketId || '').trim();
    if (!isApprovedId(mid)) {
      rejectedFabricated.push({ market: `${r.marketName || mid}: ${r.outcome || ''}`, reason: `unapproved_or_fabricated_market_id (${mid})` });
      continue;
    }
    const liveMatch = matchRecommendationToLiveMarket(r, availableMarkets, ev);
    if (!liveMatch) {
      rejectedFabricated.push({ market: `${r.marketName || mid}: ${r.outcome || ''}`, reason: 'not_available_in_live_bookmaker_catalogue' });
      continue;
    }
    const dedupeKey = `${liveMatch.approvedMarketId}::${liveMatch.canonicalOutcome}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const strength = Number(r.evidenceStrength);
    const boundedStrength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength > 1 ? strength / 100 : strength)) : 0.6;

    validatedRecs.push({
      rank: validatedRecs.length + 1,
      approvedMarketId: liveMatch.approvedMarketId,
      marketName: liveMatch.marketName,
      market: liveMatch.title,
      outcome: liveMatch.outcome,
      canonicalOutcome: liveMatch.canonicalOutcome,
      line: liveMatch.line,
      side: liveMatch.side,
      teamSide: liveMatch.teamSide,
      dir: liveMatch.dir,
      odds: liveMatch.odds, // Authoritative live bookmaker odds, never AI-invented
      liveMarketIndex: liveMatch.liveMarketIndex,
      explanation: String(r.explanation || '').trim() || 'Supported by collected fixture statistics.',
      confidenceAssessment: ['high', 'medium', 'low'].includes(r.confidenceAssessment) ? r.confidenceAssessment : 'medium',
      evidenceStrength: Math.round(boundedStrength * 1000) / 1000,
    });
  }

  const noSelection = parsed.noSelection === true || validatedRecs.length === 0;
  const noSelectionReason = noSelection
    ? (String(parsed.noSelectionReason || '').trim() || (rejectedFabricated.length ? 'All AI recommendations were unavailable or invalid in live bookmaker catalogue.' : 'Insufficient or contradictory statistical evidence.'))
    : '';

  if (errors.length) {
    return { valid: false, errors, cleaned: null };
  }

  return {
    valid: true,
    errors: [],
    rejectedFabricated,
    cleaned: {
      matchId: parsed.matchId ?? (ev && (ev.matchId || (ev.stats && ev.stats.fixtureId))) ?? null,
      homeTeam: String(parsed.homeTeam || (ev && ev.home) || ''),
      awayTeam: String(parsed.awayTeam || (ev && ev.away) || ''),
      competition: String(parsed.competition || (ev && ev.league) || ''),
      kickoff: parsed.kickoff || ((ev && ev.ts) ? new Date(ev.ts).toISOString() : null),
      statisticalEvidenceSummary: parsed.statisticalEvidenceSummary.trim(),
      supportingStatistics: Array.isArray(parsed.supportingStatistics) ? parsed.supportingStatistics.map(String).slice(0, 12) : [],
      contradictoryStatistics: Array.isArray(parsed.contradictoryStatistics) ? parsed.contradictoryStatistics.map(String).slice(0, 10) : [],
      missingInformation: Array.isArray(parsed.missingInformation) ? parsed.missingInformation.map(String).slice(0, 15) : [],
      dataCompletenessAssessment: completeness,
      noSelection,
      noSelectionReason,
      recommendations: noSelection ? [] : validatedRecs,
      rejectedAlternatives: [
        ...(Array.isArray(parsed.rejectedAlternatives) ? parsed.rejectedAlternatives.slice(0, 8) : []),
        ...rejectedFabricated,
      ],
      requestedMissingFields: Array.isArray(parsed.requestedMissingFields) ? parsed.requestedMissingFields.map(String).slice(0, 8) : [],
    },
  };
}

async function callGroqChat(system, user, opts = {}) {
  const apiKey = opts.apiKey || getGroqKey();
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured');
  const fetchFn = opts.fetch || fetch;
  const model = opts.useFallback ? FALLBACK_MODEL : (opts.model || PRIMARY_MODEL);
  const timeoutMs = Number(opts.timeoutMs) || 35000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchFn(GROQ_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 1400,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (!opts.useFallback && (res.status === 404 || res.status === 429 || res.status === 503)) {
        return callGroqChat(system, user, { ...opts, useFallback: true });
      }
      const txt = (await res.text().catch(() => '')).slice(0, 200).replace(apiKey, '[REDACTED]');
      throw new Error(`Groq HTTP ${res.status} (${model}): ${txt}`);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error(`Groq returned empty content (${model})`);
    const usage = data.usage || {};
    return {
      content: String(content),
      model,
      durationMs: Date.now() - t0,
      tokens: {
        prompt: Number(usage.prompt_tokens) || 0,
        completion: Number(usage.completion_tokens) || 0,
        total: Number(usage.total_tokens) || 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// Offline deterministic fallback that constructs up to 3 non-correlated ranked recommendations
// strictly from deterministic statistical candidates when GROQ_API_KEY is unavailable.
function analyzeFixtureOfflineFallback(ev, deterministicCandidates = [], statsPacket = null) {
  const pkt = statsPacket || buildStructuredStatsPacket(ev);
  const avail = summarizeAvailableMarkets(ev);
  const valid = (Array.isArray(deterministicCandidates) ? deterministicCandidates : [])
    .filter((c) => c && Number.isFinite(c.p) && Number.isFinite(c.odds) && c.p >= 0.5 && c.approvedMarketId)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const recs = [];
  const usedGroups = new Set();
  const groupOf = (id) => {
    if (['match_result_1x2', 'double_chance', 'match_result_1x2_1up', 'match_result_1x2_2up', 'draw_no_bet', 'any_team_to_win', 'asian_handicap_plus_0_5', 'asian_handicap_plus_1'].includes(id)) return 'result_ft';
    if (['total_goals', 'total_over_0_5', 'total_over_1_5'].includes(id)) return 'total_ft';
    if (['team_total', 'team_total_over_0_5'].includes(id)) return 'team_total';
    if (['first_half_total_over_0_5', 'first_half_double_chance'].includes(id)) return 'first_half';
    if (['second_half_total_over_0_5', 'highest_scoring_half_second'].includes(id)) return 'second_half';
    return id;
  };

  for (const c of valid) {
    if (recs.length >= 3) break;
    const g = groupOf(c.approvedMarketId);
    if (usedGroups.has(g) && valid.some((o) => !usedGroups.has(groupOf(o.approvedMarketId)))) continue;
    const liveMatch = matchRecommendationToLiveMarket(c, avail, ev);
    if (!liveMatch) continue;
    usedGroups.add(g);
    recs.push({
      rank: recs.length + 1,
      approvedMarketId: liveMatch.approvedMarketId,
      marketName: liveMatch.marketName,
      market: liveMatch.title,
      outcome: liveMatch.outcome,
      canonicalOutcome: liveMatch.canonicalOutcome,
      line: liveMatch.line,
      side: liveMatch.side,
      teamSide: liveMatch.teamSide,
      dir: liveMatch.dir,
      odds: liveMatch.odds,
      liveMarketIndex: liveMatch.liveMarketIndex,
      explanation: c.reason || 'Supported by collected fixture statistics.',
      confidenceAssessment: c.p >= 0.72 ? 'high' : (c.p >= 0.58 ? 'medium' : 'low'),
      evidenceStrength: Math.round(c.p * 1000) / 1000,
    });
  }

  return {
    ok: true,
    aiSource: 'deterministic_fallback',
    modelUsed: 'none',
    tokens: { prompt: 0, completion: 0, total: 0 },
    durationMs: 0,
    analysis: {
      matchId: pkt.matchIdentity.matchId,
      homeTeam: pkt.matchIdentity.homeTeam,
      awayTeam: pkt.matchIdentity.awayTeam,
      competition: pkt.matchIdentity.competition,
      kickoff: pkt.matchIdentity.kickoffIso,
      statisticalEvidenceSummary: recs.length
        ? `Deterministic statistical evaluation found ${recs.length} ranked market(s) from ${pkt.completeness.retrievedCount}/${pkt.completeness.totalChecked} stat fields.`
        : 'No approved market met statistical evidence thresholds.',
      supportingStatistics: pkt.completeness.retrievedFields,
      contradictoryStatistics: [],
      missingInformation: pkt.completeness.missingFields,
      dataCompletenessAssessment: pkt.completeness.complete ? 'complete' : (pkt.completeness.usable ? 'partial' : 'insufficient'),
      noSelection: recs.length === 0,
      noSelectionReason: recs.length === 0 ? 'No approved market met evidence thresholds.' : '',
      recommendations: recs,
      rejectedAlternatives: [],
      requestedMissingFields: [],
    },
  };
}

// Full Groq AI analysis of one fixture with schema validation and safe retry.
async function analyzeFixtureWithAi(ev, opts = {}) {
  const statsPacket = opts.statsPacket || buildStructuredStatsPacket(ev);
  const availableMarkets = summarizeAvailableMarkets(ev);

  if (!availableMarkets.length) {
    return {
      ok: true,
      aiSource: 'skipped_no_markets',
      modelUsed: 'none',
      tokens: { prompt: 0, completion: 0, total: 0 },
      durationMs: 0,
      analysis: {
        matchId: statsPacket.matchIdentity.matchId,
        homeTeam: statsPacket.matchIdentity.homeTeam,
        awayTeam: statsPacket.matchIdentity.awayTeam,
        competition: statsPacket.matchIdentity.competition,
        kickoff: statsPacket.matchIdentity.kickoffIso,
        statisticalEvidenceSummary: 'No approved bookmaker markets were available for this fixture.',
        supportingStatistics: [],
        contradictoryStatistics: [],
        missingInformation: statsPacket.completeness.missingFields,
        dataCompletenessAssessment: statsPacket.completeness.complete ? 'complete' : (statsPacket.completeness.usable ? 'partial' : 'insufficient'),
        noSelection: true,
        noSelectionReason: 'No approved bookmaker markets available.',
        recommendations: [],
        rejectedAlternatives: [],
        requestedMissingFields: [],
      },
    };
  }

  const apiKey = opts.apiKey || getGroqKey();
  if (!apiKey && !opts.requireGroq) {
    return analyzeFixtureOfflineFallback(ev, opts.deterministicCandidates || [], statsPacket);
  }

  const { system, user } = buildAnalystPrompt(ev, statsPacket, availableMarkets);
  let lastErr = '';
  let totalTokens = { prompt: 0, completion: 0, total: 0 };
  let totalMs = 0;
  let modelUsed = PRIMARY_MODEL;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const retryNote = attempt > 1
        ? `\n\nPREVIOUS OUTPUT WAS INVALID (${lastErr}). Return strictly valid JSON matching the exact schema.`
        : '';
      const resp = await callGroqChat(system, user + retryNote, opts);
      modelUsed = resp.model;
      totalMs += resp.durationMs;
      totalTokens.prompt += resp.tokens.prompt;
      totalTokens.completion += resp.tokens.completion;
      totalTokens.total += resp.tokens.total;

      const parsed = extractJsonObject(resp.content);
      const val = validateAiAnalysisResponse(parsed, ev, availableMarkets);
      if (val.valid) {
        return {
          ok: true,
          aiSource: 'groq',
          modelUsed,
          attempts: attempt,
          tokens: totalTokens,
          durationMs: totalMs,
          rejectedFabricated: val.rejectedFabricated,
          analysis: val.cleaned,
        };
      }
      lastErr = val.errors.join('; ');
    } catch (e) {
      lastErr = e.message;
    }
  }

  // If Groq failed after safe retries, fall back cleanly if allowed, otherwise report failure
  if (opts.fallbackOnError !== false && Array.isArray(opts.deterministicCandidates)) {
    const fb = analyzeFixtureOfflineFallback(ev, opts.deterministicCandidates, statsPacket);
    fb.groqError = lastErr;
    fb.tokens = totalTokens;
    fb.durationMs = totalMs;
    return fb;
  }

  return {
    ok: false,
    aiSource: 'groq_failed',
    modelUsed,
    error: lastErr,
    tokens: totalTokens,
    durationMs: totalMs,
    analysis: null,
  };
}

// Phase 7 — Strict Rank 1 -> Rank 2 -> Rank 3 Fallback against live bookmaker markets.
// Never substitutes an unanalyzed outcome or line. Skips the fixture if all 3 are unavailable.
function resolveRankedSelectionWithFallback(analysis, liveMarkets, ev = {}) {
  const trace = {
    rank1Attempted: false,
    rank2Fallback: false,
    rank3Fallback: false,
    selectedRank: 0,
    skipped: false,
    reason: '',
    attempts: [],
  };

  if (!analysis || analysis.noSelection === true || !Array.isArray(analysis.recommendations) || !analysis.recommendations.length) {
    trace.skipped = true;
    trace.reason = (analysis && analysis.noSelectionReason) || 'no_selection';
    return { selected: null, liveMarket: null, trace };
  }

  const sp = String((ev && ev.sport) || 'football').toLowerCase();
  const avail = summarizeAvailableMarkets({ ...ev, markets: liveMarkets });

  const sorted = [...analysis.recommendations].sort((a, b) => (a.rank || 99) - (b.rank || 99)).slice(0, 3);
  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    const rankNum = i + 1;
    if (rankNum === 1) trace.rank1Attempted = true;
    if (rankNum === 2) trace.rank2Fallback = true;
    if (rankNum === 3) trace.rank3Fallback = true;

    // Validate exact match against live bookmaker catalogue
    const liveMatch = matchRecommendationToLiveMarket(rec, avail, ev);
    if (!liveMatch) {
      trace.attempts.push({ rank: rankNum, approvedMarketId: rec.approvedMarketId, outcome: rec.outcome, ok: false, reason: 'unavailable_in_live_catalogue' });
      continue;
    }

    // Confirm raw live market object is still active & valid
    const rawMarket = liveMarkets[liveMatch.liveMarketIndex];
    if (!rawMarket || !Number.isFinite(rawMarket.odds) || rawMarket.odds <= 1) {
      trace.attempts.push({ rank: rankNum, approvedMarketId: rec.approvedMarketId, outcome: rec.outcome, ok: false, reason: 'invalid_live_odds' });
      continue;
    }

    // Double-check exact approved ID match
    const recheck = sp === 'football'
      ? approvedMarkets.matchApprovedMarket(rawMarket.title, rawMarket.label, ev)
      : sportMarkets.matchSportMarket(sp, rawMarket.title, rawMarket.label, ev);
    if (!recheck || !recheck.approved || recheck.approvedMarketId !== rec.approvedMarketId) {
      trace.attempts.push({ rank: rankNum, approvedMarketId: rec.approvedMarketId, outcome: rec.outcome, ok: false, reason: 'market_identity_mismatch' });
      continue;
    }

    trace.selectedRank = rankNum;
    trace.attempts.push({ rank: rankNum, approvedMarketId: rec.approvedMarketId, outcome: liveMatch.outcome, odds: rawMarket.odds, ok: true });
    return {
      selected: {
        ...rec,
        rank: rankNum,
        market: rawMarket.title,
        outcome: rawMarket.label,
        odds: rawMarket.odds,
        canonicalOutcome: liveMatch.canonicalOutcome,
        line: liveMatch.line,
        side: liveMatch.side,
        teamSide: liveMatch.teamSide,
        dir: liveMatch.dir,
      },
      liveMarket: rawMarket,
      trace,
    };
  }

  trace.skipped = true;
  trace.reason = 'all_ranked_recommendations_unavailable';
  return { selected: null, liveMarket: null, trace };
}

module.exports = {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  getGroqKey,
  summarizeAvailableMarkets,
  buildAnalystPrompt,
  extractJsonObject,
  validateAiAnalysisResponse,
  analyzeFixtureWithAi,
  analyzeFixtureOfflineFallback,
  resolveRankedSelectionWithFallback,
};
