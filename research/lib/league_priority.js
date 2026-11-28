'use strict';
// Transparent, auditable competition / league-priority ordering used ONLY to determine
// the order in which eligible fixtures enter the research pool.
// NEVER discards fixtures without ranking data, and NEVER overrides statistical
// probability or evidence quality during candidate ranking / ticket selection.
const { norm } = require('./util');

// Documented established-competition tiers per sport (lower tier number = researched earlier).
// Tier 1: Global / flagship premier competitions
// Tier 2: Established major top-flight national / continental competitions
// Tier 3: Strong secondary / professional leagues & major qualifiers
// Tier 50: Documented fallback for competitions without explicit ranking metadata (always preserved)
const ESTABLISHED_TIERS = {
  football: [
    { tier: 1, re: /\b(uefa champions league|champions league|fifa world cup|uefa euro|copa america|premier league|laliga|la liga|bundesliga|serie a|ligue 1)\b/i, excludeRe: /\b(women|u19|u20|u21|u23|youth|reserve|2\.|serie b|ligue 2|segunda|amateur|regional|ghana|kenya|uganda|bangladesh|ethiopia|tanzania|nigeria|egypt|cambodia|vietnam|india|zambia|zimbabwe|malawi|botswana|namibia|bahrain|kuwait|oman|lebanon|syria|jordan|iraq|yemen|myanmar|laos|singapore|malaysia|indonesia|thailand|hong kong|macau|taiwan|mongolia|nepal|bhutan|maldives|sri lanka|pakistan|afghanistan|belarus|armenia|azerbaijan|kazakhstan|uzbekistan|kyrgyzstan|tajikistan|turkmenistan|faroe|gibraltar|andorra|san marino|malta|luxembourg|liechtenstein|estonia|latvia|lithuania|moldova|montenegro|north macedonia|kosovo|albania|bosnia|iceland|wales|northern ireland|ireland|jamaica|trinidad|barbados|bermuda|belize|nicaragua|el salvador|honduras|guatemala|panama|costa rica|bolivia|venezuela|ecuador|paraguay|peru|uruguay|chile)\b/i, label: 'tier1_flagship_football' },
    { tier: 2, re: /\b(uefa europa league|europa conference|conference league|eredivisie|primeira liga|liga portugal|championship|super lig|scottish premiership|pro league|jupiler|super league|brasileiro|serie a betano|liga profesional|liga mx|mls|major league soccer|copa libertadores|copa sudamericana|africa cup|afcon|caf champions|asian cup|afc champions|nations league|fa cup|copa del rey|dfb pokal|coppa italia|coupe de france)\b/i, excludeRe: /\b(u19|u20|u21|u23|youth|reserve|amateur)\b/i, label: 'tier2_major_football' },
    { tier: 3, re: /\b(2\. bundesliga|laliga 2|segunda division|serie b|ligue 2|league one|league two|ekstraklasa|superliga|allsvenskan|eliteserien|superettan|bundesliga|hnl|first division|j1 league|k league 1|a-league|saudi pro|pro league|division 1|primera division)\b/i, excludeRe: /\b(u19|u20|u21|u23|youth|reserve|amateur|regional)\b/i, label: 'tier3_established_football' },
  ],
  basketball: [
    { tier: 1, re: /\b(nba|euroleague|fiba world cup|olympic)\b/i, excludeRe: /\b(g league|summer|u18|u19|u20|youth)\b/i, label: 'tier1_flagship_basketball' },
    { tier: 2, re: /\b(eurocup|champions league|acb|liga endesa|bbl|easycredit|lega basket|serie a|lnb|pro a|bsl|super lig|vtb|nbl|ncaa|wnba|aba league|greek basket)\b/i, excludeRe: /\b(u18|u19|u20|youth|regional)\b/i, label: 'tier2_major_basketball' },
    { tier: 3, re: /\b(cba|kbl|b\.league|g league|pro b|leb oro|serie a2|plk|lnb)\b/i, excludeRe: /\b(youth|u18)\b/i, label: 'tier3_established_basketball' },
  ],
  tennis: [
    { tier: 1, re: /\b(australian open|roland garros|french open|wimbledon|us open|atp finals|wta finals|davis cup|billie jean|united cup)\b/i, excludeRe: /\b(junior|boys|girls|wheelchair)\b/i, label: 'tier1_grand_slam_finals' },
    { tier: 2, re: /\b(atp|wta)\b/i, excludeRe: /\b(challenger|itf|utr|junior|doubles)\b/i, label: 'tier2_atp_wta_tour' },
    { tier: 3, re: /\b(challenger|wta 125|atp.*doubles|wta.*doubles)\b/i, excludeRe: /\b(junior)\b/i, label: 'tier3_challenger_doubles' },
    { tier: 4, re: /\b(itf)\b/i, excludeRe: /\b(junior)\b/i, label: 'tier4_itf' },
  ],
  baseball: [
    { tier: 1, re: /\b(mlb|major league baseball|world baseball classic)\b/i, excludeRe: /\b(spring|minor)\b/i, label: 'tier1_mlb' },
    { tier: 2, re: /\b(npb|kbo|lmb|cpbl|ncaa|triple-a|milb|lidom|lvbp|lmp|abl)\b/i, excludeRe: null, label: 'tier2_pro_baseball' },
  ],
  hockey: [
    { tier: 1, re: /\b(nhl|iihf world championship|olympic)\b/i, excludeRe: /\b(u18|u20|junior)\b/i, label: 'tier1_nhl' },
    { tier: 2, re: /\b(khl|shl|liiga|del|national league|nla|extraliga|champions hockey league|ahl|ice hockey league)\b/i, excludeRe: /\b(u18|u20|junior)\b/i, label: 'tier2_major_hockey' },
    { tier: 3, re: /\b(allsvenskan|mestis|del2|swiss league|whl|ohl|qmjhl|echl|vhl|ncaa|ligue magnus|elite league)\b/i, excludeRe: null, label: 'tier3_established_hockey' },
  ],
};

function parseCompetitionIdentity(ev) {
  const rawLeague = String((ev && ev.league) || '').trim();
  const rawCountry = String((ev && ev.country) || '').trim();
  let country = rawCountry;
  let league = rawLeague;
  if (!country && rawLeague.includes(' - ')) {
    const idx = rawLeague.indexOf(' - ');
    country = rawLeague.slice(0, idx).trim();
    league = rawLeague.slice(idx + 3).trim();
  }
  const fullName = country && league && !league.toLowerCase().startsWith(country.toLowerCase())
    ? `${country} - ${league}`
    : (rawLeague || rawCountry || '');
  const identified = !!(league || country);
  return { identified, country, league, fullName };
}

// Compute a transparent, auditable league-priority record for a fixture.
// Combines real BangBet competition metadata (tournamentWeight, countryWeight, highLight, popular, marketNumber)
// with the documented established-competition hierarchy and a documented preservation fallback.
function computeLeaguePriority(ev) {
  const sport = String((ev && ev.sport) || 'football').toLowerCase();
  const comp = parseCompetitionIdentity(ev);
  const text = `${comp.country} ${comp.league}`.trim();
  const tw = Number.isFinite(Number(ev && ev.tournamentWeight)) && Number(ev.tournamentWeight) > 0
    ? Number(ev.tournamentWeight)
    : null;
  const cw = Number.isFinite(Number(ev && ev.countryWeight)) && Number(ev.countryWeight) > 0
    ? Number(ev.countryWeight)
    : null;
  const highLight = !!(ev && ev.highLight);
  const popular = !!(ev && ev.popular);
  const marketNumber = Number.isFinite(Number(ev && ev.marketNumber)) ? Number(ev.marketNumber) : 0;

  let establishedTier = null;
  let establishedLabel = '';
  const rules = ESTABLISHED_TIERS[sport] || ESTABLISHED_TIERS.football;
  if (text) {
    for (const r of rules) {
      if (r.re.test(text) && !(r.excludeRe && r.excludeRe.test(text))) {
        establishedTier = r.tier;
        establishedLabel = r.label;
        break;
      }
    }
  }

  // Primary composite rank (lower = researched first):
  // 1) Established major competitions with BangBet weight/highlight support -> 10..39
  // 2) BangBet-weighted / highlighted competitions (using real tournamentWeight + countryWeight) -> 40..79
  // 3) Identified competitions without explicit weight -> 80..89 (ordered by marketNumber desc if present)
  // 4) Documented fallback (unidentified / unranked competition) -> 100 (ALWAYS preserved, never discarded)
  let tier = 50;
  let rankScore = 1000;
  let source = 'fallback_preserved';

  if (establishedTier != null) {
    tier = establishedTier;
    const wPart = tw != null ? Math.min(20, tw) : 10;
    const cPart = cw != null ? Math.min(20, cw) * 0.25 : 2.5;
    const hlBonus = highLight ? -3 : 0;
    const popBonus = popular ? -1.5 : 0;
    rankScore = establishedTier * 100 + wPart + cPart + hlBonus + popBonus;
    source = tw != null || cw != null ? `established_and_bangbet_weight:${establishedLabel}` : `established_hierarchy:${establishedLabel}`;
  } else if (tw != null || cw != null || highLight || popular) {
    tier = highLight || popular ? 10 : 20;
    const wPart = tw != null ? Math.min(100, tw) * 3 : 60;
    const cPart = cw != null ? Math.min(100, cw) : 40;
    const hlBonus = highLight ? -40 : 0;
    const popBonus = popular ? -20 : 0;
    const mktBonus = marketNumber > 0 ? -Math.min(15, marketNumber / 15) : 0;
    rankScore = 400 + wPart + cPart + hlBonus + popBonus + mktBonus;
    source = 'bangbet_competition_weight';
  } else if (comp.identified) {
    tier = 30;
    const mktBonus = marketNumber > 0 ? -Math.min(25, marketNumber / 10) : 0;
    rankScore = 800 + mktBonus;
    source = 'identified_competition_fallback';
  } else {
    tier = 50;
    rankScore = 1000;
    source = 'unidentified_competition_fallback_preserved';
  }

  return {
    identified: comp.identified,
    country: comp.country,
    league: comp.league,
    competitionName: comp.fullName,
    tier,
    rankScore: Math.round(rankScore * 100) / 100,
    source,
    bangbetWeights: {
      tournamentWeight: tw,
      countryWeight: cw,
      highLight,
      popular,
      marketNumber,
    },
  };
}

// Order fixtures transparently by league-priority ranking, preserving ALL fixtures
// (never discarding fixtures lacking ranking data). Ties break by BangBet's native
// leagueOrderIndex and then earliest kickoff timestamp.
function orderFixturesByLeaguePriority(events) {
  const list = Array.isArray(events) ? events : [];
  let identifiedCount = 0;
  let fallbackCount = 0;

  const annotated = list.map((ev, idx) => {
    const lp = computeLeaguePriority(ev);
    if (lp.identified) identifiedCount++;
    if (lp.source.includes('fallback')) fallbackCount++;
    ev.leaguePriority = lp;
    if (!ev.country && lp.country) ev.country = lp.country;
    if (!ev.league && lp.league) ev.league = lp.league;
    return { ev, lp, idx };
  });

  annotated.sort((a, b) => {
    if (a.lp.rankScore !== b.lp.rankScore) return a.lp.rankScore - b.lp.rankScore;
    const la = a.ev.leagueOrderIndex != null ? a.ev.leagueOrderIndex : 1e9;
    const lb = b.ev.leagueOrderIndex != null ? b.ev.leagueOrderIndex : 1e9;
    if (la !== lb) return la - lb;
    const ta = a.ev.ts || 9e15;
    const tb = b.ev.ts || 9e15;
    if (ta !== tb) return ta - tb;
    return a.idx - b.idx;
  });

  const ordered = annotated.map((x) => x.ev);
  return {
    ordered,
    total: ordered.length,
    identifiedCount,
    fallbackCount,
    topCompetitionsSample: [...new Set(ordered.slice(0, 30).map((e) => e.leaguePriority.competitionName).filter(Boolean))].slice(0, 10),
  };
}

module.exports = {
  parseCompetitionIdentity,
  computeLeaguePriority,
  orderFixturesByLeaguePriority,
  ESTABLISHED_TIERS,
};
