// High-level operations shared by the CLI and the MCP server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Portal, InnsynError, fileName } from './client.js';
import { discover, findPortal, loadRegistry, slugify } from './discover.js';

const portals = new Map();

function localCache() {
  const f = path.join(process.env.ACOS_INNSYN_CACHE || path.join(os.homedir(), '.cache', 'unofficial-acos-innsyn'), 'portals.json');
  try { return { f, data: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return { f, data: {} }; }
}

/** Resolve a kommune (slug, name or number) to a ready Portal. Discovers and caches unknown slugs. */
export async function portal(kommune) {
  const key = String(kommune).trim().toLowerCase();
  if (portals.has(key)) return portals.get(key);
  let cfg = findPortal(key);
  if (!cfg || !cfg.searchPath) {
    const cache = localCache();
    const slug = cfg?.slug || slugify(key);
    cfg = cache.data[slug];
    if (!cfg) {
      cfg = await discover(slug);
      if (!cfg) throw new InnsynError(`No ACOS Innsyn+ portal found for "${kommune}" (tried https://innsynpluss.onacos.no/${slug}/). Use list_portals to see known slugs.`);
      cache.data[slug] = cfg;
      fs.mkdirSync(path.dirname(cache.f), { recursive: true });
      fs.writeFileSync(cache.f, JSON.stringify(cache.data, null, 1));
    }
    if (!cfg.searchPath) throw new InnsynError(`${kommune}: the portal exists but has no searchable journal page.`);
  }
  const p = new Portal(cfg);
  portals.set(key, p);
  return p;
}

export function listPortals({ withSource } = {}) {
  const reg = loadRegistry();
  let list = reg.portals;
  if (withSource) {
    const re = new RegExp(withSource, 'i');
    list = list.filter((p) => p.datasources?.some((d) => re.test(d.name) || d.caseTypes?.some((t) => re.test(t))));
  }
  return {
    generated: reg.generated,
    count: list.length,
    portals: list.map((p) => ({
      slug: p.slug,
      name: p.name,
      kommunenummer: p.kommunenummer,
      datasources: (p.datasources || []).map((d) => d.name),
      hasByggesak: (p.datasources || []).some((d) => /bygg/i.test(d.name) || d.caseTypes?.some((t) => /bygg/i.test(t))),
    })),
  };
}

/** Pick data sources by id or case-insensitive name fragment; all if none given. */
async function sources(p, source) {
  const all = p.cfg.datasources?.length ? p.cfg.datasources : await p.datasources();
  if (!source) return all;
  const wanted = Array.isArray(source) ? source : [source];
  const hit = all.filter((d) => wanted.some((w) => d.id === w || d.name.toLowerCase().includes(String(w).toLowerCase())));
  if (!hit.length) throw new InnsynError(`No data source matches "${wanted.join(', ')}". Available: ${all.map((d) => d.name).join(' | ')}`);
  return hit;
}

export async function datasources(kommune) {
  const p = await portal(kommune);
  return (await sources(p)).map((d) => ({ id: d.id, name: d.name }));
}

export async function search(kommune, q) {
  const p = await portal(kommune);
  const out = [];
  for (const ds of await sources(p, q.source)) {
    const r = await p.searchAll({ ...q, datasource: ds.id }, q.max ?? 200);
    out.push({ source: ds.name, total: r.total, items: r.items });
  }
  return out;
}

export async function getCase(kommune, caseId) {
  return (await portal(kommune)).getCase(caseId);
}

export async function getDocument(kommune, docId) {
  return (await portal(kommune)).getDocument(docId);
}

/**
 * Download every file of a document, or of every document in a case.
 * Returns a manifest; order-only documents are listed but not fetched.
 */
export async function download(kommune, id, outDir, { skipExisting = true } = {}) {
  const p = await portal(kommune);
  let docIds;
  let caseInfo;
  if (id.startsWith('a-')) {
    caseInfo = await p.getCase(id);
    docIds = caseInfo.documents.map((d) => d.id);
  } else {
    docIds = [id];
  }
  const manifest = { case: caseInfo ? { id: caseInfo.id, title: caseInfo.title, caseNumber: caseInfo.caseNumber } : undefined, outDir, files: [], orderOnly: [] };
  for (const did of docIds) {
    const doc = await p.getDocument(did);
    if (doc.orderOnly) { manifest.orderOnly.push({ id: doc.id, title: doc.title, documentId: doc.documentId, date: doc.date }); continue; }
    for (const f of doc.files) {
      const dest = path.join(outDir, fileName(doc, f));
      if (skipExisting && fs.existsSync(dest)) { manifest.files.push({ path: dest, skipped: true, document: doc.title }); continue; }
      const r = await p.downloadFile(f.url, dest);
      manifest.files.push({ path: r.path, bytes: r.bytes, contentType: r.contentType, document: doc.title, documentId: doc.documentId, role: f.role });
    }
  }
  return manifest;
}
