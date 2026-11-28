'use strict';
// Controlled read-only Sportradar/Gismo diagnostic comparison tool.
// Captures URL, method, HTTP status, response headers, response body preview, DNS, and public network org.
// Never prints cookies, tokens, or credentials.
const dns = require('dns').promises;

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/cookie|auth|token|secret|key/i.test(k)) out[k] = `[REDACTED len=${String(v).length}]`;
    else out[k] = String(v).slice(0, 220);
  }
  return out;
}

async function probeDirectHttp(label, url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        ...headers,
      },
    });
    const body = (await res.text().catch(() => '')).slice(0, 500);
    return {
      label,
      url,
      status: res.status,
      statusText: res.statusText,
      ms: Date.now() - t0,
      headers: redactHeaders(Object.fromEntries(res.headers.entries())),
      bodyPreview: body.replace(/\s+/g, ' ').slice(0, 400),
    };
  } catch (e) {
    return { label, url, error: String(e && e.message ? e.message : e), ms: Date.now() - t0 };
  }
}

(async () => {
  const report = {
    env: process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'local_laptop',
    os: process.platform,
    node: process.version,
    timestamp: new Date().toISOString(),
    networkInfo: null,
    dns: {},
    directProbes: [],
  };

  try {
    const ipRes = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(6000) });
    if (ipRes.ok) {
      const ipj = await ipRes.json();
      report.networkInfo = { country: ipj.country, region: ipj.region, org: ipj.org, city: ipj.city };
    }
  } catch (_) {}

  for (const host of ['sportcenter.sir.sportradar.com', 'ws-cdn001.akamaized.net', 'stats.fn.sportradar.com', 'lmt.fn.sportradar.com', 'bet-api.bangbet.com']) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      report.dns[host] = addrs.map((a) => `${a.address} (v${a.family})`);
    } catch (e) {
      report.dns[host] = `ERR: ${e.message}`;
    }
  }

  const gismoHeaders = {
    Referer: 'https://sportcenter.sir.sportradar.com/',
    Origin: 'https://sportcenter.sir.sportradar.com',
  };

  const targets = [
    ['sportcenter_no_ref', 'https://sportcenter.sir.sportradar.com/luckybus/eurocup/match/', {}],
    ['sportcenter_with_ref', 'https://sportcenter.sir.sportradar.com/luckybus/eurocup/match/', { Referer: 'https://www.bangbet.com/', Origin: 'https://www.bangbet.com' }],
    ['akamai_widgetloader', 'https://ws-cdn001.akamaized.net/8aafc5e55ab4c0823fffa663b1dd3d42/widgetloader', { Referer: 'https://www.bangbet.com/' }],
    ['gismo_match_info_no_ref', 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo/match_info/72478732', {}],
    ['gismo_match_info_with_ref', 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo/match_info/72478732', gismoHeaders],
    ['gismo_match_versusrecent', 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo/stats_match_versusrecent/72478732', gismoHeaders],
    ['gismo_season_tables', 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo/stats_season_tables/142176', gismoHeaders],
    ['gismo_season_overunder', 'https://stats.fn.sportradar.com/common/en/Etc:UTC/gismo/stats_season_overunder/142176', gismoHeaders],
    ['gismo_lmt_match_info', 'https://lmt.fn.sportradar.com/common/en/Etc:UTC/gismo/match_info/72478732', { Referer: 'https://www.bangbet.com/', Origin: 'https://www.bangbet.com' }],
  ];

  report.directProbes = await Promise.all(targets.map(([label, url, headers]) => probeDirectHttp(label, url, headers)));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
