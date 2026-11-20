'use strict';
// progress and results of a research job, kept in a private gist the app reads
const API = 'https://api.github.com';
const hdr = () => ({ Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bet-research', 'Content-Type': 'application/json' });

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: hdr(), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.status === 204 ? null : r.json();
}

let gid = '';
async function find() {
  for (let p = 1; p <= 3; p++) {
    const l = await call('GET', `/gists?per_page=100&page=${p}`);
    if (!Array.isArray(l) || !l.length) break;
    const g = l.find((x) => x.description === 'bet-research');
    if (g) return g.id;
  }
  return '';
}

async function save(id, obj) {
  const files = { [`job-${id}.json`]: { content: JSON.stringify(obj) } };
  if (!gid) gid = await find();
  if (!gid) {
    const g = await call('POST', '/gists', { description: 'bet-research', public: false, files });
    gid = g.id;
    return;
  }
  await call('PATCH', `/gists/${gid}`, { files });
}

// keeps the newest jobs only
async function prune(keep = 20) {
  if (!gid) gid = await find();
  if (!gid) return;
  const g = await call('GET', `/gists/${gid}`);
  const names = Object.keys(g.files || {}).filter((n) => n.startsWith('job-')).sort();
  const drop = names.slice(0, Math.max(0, names.length - keep));
  if (!drop.length) return;
  const files = {};
  for (const n of drop) files[n] = null;
  await call('PATCH', `/gists/${gid}`, { files });
}

module.exports = { save, prune };
