#!/usr/bin/env node
// Rebuild data/portals.json: probe every Norwegian kommune (SSB classification 131)
// for an ACOS Innsyn+ portal and record its search page and data sources.
// Polite: one request at a time with a pause. Takes a few minutes.

import fs from 'node:fs';
import { discover, REGISTRY } from '../src/discover.js';

const UA = 'unofficial-acos-innsyn registry builder (+https://github.com/fipp/unofficial-acos-innsyn-plugin)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const date = new Date().toISOString().slice(0, 10);

function variants(name) {
  const base = name.split(' - ')[0].trim().toLowerCase().replace(/\s+/g, '-');
  return [...new Set([
    base.replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a'),
    base.replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa'),
    base.replace(/æ/g, 'a').replace(/ø/g, 'o').replace(/å/g, 'a'),
  ])].filter((s) => /^[a-z0-9-]+$/.test(s));
}

const res = await fetch(`https://data.ssb.no/api/klass/v1/classifications/131/codesAt?date=${date}`, { headers: { accept: 'application/json', 'user-agent': UA } });
const { codes } = await res.json();
const portals = [];
for (const k of codes) {
  for (const slug of variants(k.name)) {
    const r = await fetch(`https://innsynpluss.onacos.no/${slug}/`, { redirect: 'manual', headers: { 'user-agent': UA } });
    await sleep(300);
    if (r.status !== 200) continue;
    const d = await discover(slug, { ua: UA, delayMs: 400 });
    const entry = { kommunenummer: k.code, name: k.name.split(' - ')[0], ...d };
    portals.push(entry);
    process.stderr.write(`${k.code} ${entry.name} -> ${slug} [${(d?.datasources || []).map((x) => x.name).join(' | ')}]\n`);
    break;
  }
}
fs.writeFileSync(REGISTRY, JSON.stringify({ generated: date, source: 'SSB klass 131 + probe of innsynpluss.onacos.no/<slug>/', portals }, null, 1) + '\n');
process.stderr.write(`${portals.length} portals written to ${REGISTRY}\n`);
