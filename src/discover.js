// Find a kommune's ACOS Innsyn+ search page, its portal/menu IDs and data sources.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, Portal, InnsynError } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY = path.join(here, '..', 'data', 'portals.json');

export function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return { portals: [] }; }
}

export function slugify(name) {
  return name.split(' - ')[0].trim().toLowerCase().replace(/\s+/g, '-')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a');
}

/** Look up a portal by slug, kommune name or kommunenummer. */
export function findPortal(q) {
  const reg = loadRegistry();
  const s = String(q).trim().toLowerCase().replace(/\s+kommune$/, '').replace(/^kommune\s+/, '');
  return reg.portals.find((p) => p.slug === s || p.kommunenummer === s || p.name?.toLowerCase() === s || slugify(p.name || '') === slugify(s));
}

async function get(url, ua) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { status: res.status, text: res.status === 200 ? await res.text() : '' };
}

/**
 * Discover a portal from its slug. Returns null when the slug has no portal.
 * Search pages tried: links on the front page under /<slug>/ that look like search pages,
 * then common paths.
 */
export async function discover(slug, { ua = 'unofficial-acos-innsyn (portal discovery)', delayMs = 500 } = {}) {
  const front = await get(`${BASE}/${slug}/`, ua);
  if (front.status !== 200) return null;
  const links = new Set();
  const re = new RegExp(`(?:https://innsynpluss\\.onacos\\.no(?::443)?)?/${slug}/([a-z0-9-]+)/`, 'gi');
  for (const m of front.text.matchAll(re)) links.add(m[1].toLowerCase());
  const skip = new Set(['moteoversikt', 'partier', 'utvalg', 'login']);
  const candidates = [...new Set([...['postliste', 'sok', 'innsyn'].filter((x) => links.has(x)), ...[...links].filter((x) => !skip.has(x)), 'postliste', 'sok'])];
  for (const sp of candidates) {
    await new Promise((r) => setTimeout(r, delayMs));
    const page = await get(`${BASE}/${slug}/${sp}/`, ua);
    if (page.status !== 200) continue;
    const pid = /portalID\s*=\s*(\d+)/.exec(page.text)?.[1];
    const mid = /menypunktID\s*=\s*(\d+)/.exec(page.text)?.[1];
    if (!pid || !mid) continue;
    const portal = new Portal({ slug, searchPath: sp, portalId: Number(pid), menypunktId: Number(mid) }, { userAgent: ua, delayMs });
    try {
      const ds = await portal.datasources({ withCaseTypes: true });
      if (ds.length) return { slug, searchPath: sp, portalId: Number(pid), menypunktId: Number(mid), datasources: ds };
    } catch (e) {
      if (!(e instanceof InnsynError)) throw e;
    }
  }
  return { slug, searchPath: null, portalId: null, menypunktId: null, datasources: [], note: 'Portal exists but no searchable postliste/sok page was found' };
}
