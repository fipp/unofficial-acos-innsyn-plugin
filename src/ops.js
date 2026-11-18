// High-level operations shared by the CLI and the MCP server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Portal, InnsynError, fileName, declaresFormat } from './client.js';
import { discover, findPortal, loadRegistry, slugify } from './discover.js';

const portals = new Map();

function localCache() {
  const f = path.join(process.env.ACOS_INNSYN_CACHE || path.join(os.homedir(), '.cache', 'unofficial-acos-innsyn'), 'portals.json');
  try { return { f, data: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return { f, data: {} }; }
}

/** Resolve a kommune (slug, name or number) to a ready Portal. Discovers and caches unknown slugs. */
export async function portal(kommune, { fresh = false } = {}) {
  const key = String(kommune).trim().toLowerCase();
  if (!fresh && portals.has(key)) return portals.get(key);
  let cfg = fresh ? null : findPortal(key);
  if (fresh) {
    const slug = findPortal(key)?.slug || slugify(key);
    cfg = await discover(slug);
    if (!cfg?.searchPath) throw new InnsynError(`${kommune}: the portal no longer answers as recorded, and rediscovery found no searchable journal.`);
    const cache = localCache();
    cache.data[slug] = cfg;
    fs.mkdirSync(path.dirname(cache.f), { recursive: true });
    fs.writeFileSync(cache.f, JSON.stringify(cache.data, null, 1));
  } else if (!cfg || !cfg.searchPath) {
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

/**
 * Run fn(portal). If the portal answers as if its recorded IDs are stale (it moved, like Bærum
 * did in 2026), rediscover it once and retry.
 */
async function withPortal(kommune, fn) {
  const p = await portal(kommune);
  try {
    return await fn(p);
  } catch (e) {
    const status = e?.cause?.status;
    const stale = e instanceof InnsynError && (status >= 500 || status === 404 || /^Could not open /.test(e.message));
    if (!stale) throw e;
    return fn(await portal(kommune, { fresh: true }));
  }
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
      // true: byggesaker are labelled (source name or sakstype). null: not labelled; the journal may still hold them.
      hasByggesak: (p.datasources || []).some((d) => /bygg/i.test(d.name) || d.caseTypes?.some((t) => /bygg/i.test(t))) ? true : null,
      ...(p.datasources?.length ? {} : { note: 'Portal exists, but no searchable journal was found (meetings only, or an unknown page layout).' }),
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
  const list = await withPortal(kommune, (p) => sources(p));
  return list.map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.id === null && list.length === 1 ? { note: 'Single journal; this portal has no data-source menu, so searches need no source.' } : {}),
  }));
}

export async function search(kommune, q) {
  return withPortal(kommune, async (p) => {
    const out = [];
    for (const ds of await sources(p, q.source)) {
      const r = await p.searchAll({ ...q, datasource: ds.id }, q.max ?? 50);
      out.push({ source: ds.name, total: r.total, items: r.items });
    }
    return out;
  });
}

/**
 * Case with its document list. withFiles adds orderOnly and fileCount per document
 * (one extra request per document, at most maxDocs documents).
 */
export async function getCase(kommune, caseId, { withFiles = false, maxDocs = 30 } = {}) {
  const p = await portal(kommune);
  const c = await withPortal(kommune, (q) => q.getCase(caseId));
  if (withFiles) {
    for (const d of c.documents.slice(0, maxDocs)) {
      const doc = await p.getDocument(d.id);
      d.fileCount = doc.files.length;
      d.orderOnly = doc.orderOnly;
    }
    if (c.documents.length > maxDocs) c.note = `File info added for the first ${maxDocs} of ${c.documents.length} documents.`;
  }
  return c;
}

export async function getDocument(kommune, docId) {
  return withPortal(kommune, (p) => p.getDocument(docId));
}

/**
 * Download every file of a document, or of every document in a case.
 * Returns a manifest; order-only documents are listed but not fetched.
 */
export async function download(kommune, id, outDir, { skipExisting = true, maxFiles = 60 } = {}) {
  const p = await portal(kommune);
  let docIds;
  let caseInfo;
  if (id.startsWith('a-')) {
    caseInfo = await withPortal(kommune, (q) => q.getCase(id));
    docIds = caseInfo.documents.map((d) => d.id);
  } else {
    docIds = [id];
  }
  const manifest = { case: caseInfo ? { id: caseInfo.id, title: caseInfo.title, caseNumber: caseInfo.caseNumber } : undefined, outDir, files: [], orderOnly: [] };
  let fetched = 0;
  outer: for (const did of docIds) {
    let doc;
    try {
      doc = await p.getDocument(did);
    } catch (e) {
      if (!(e instanceof InnsynError)) throw e;
      manifest.stopped = { reason: e.message, atDocument: did };
      break;
    }
    if (doc.orderOnly) { manifest.orderOnly.push({ id: doc.id, title: doc.title, documentId: doc.documentId, date: doc.date }); continue; }
    const used = new Map();
    for (const f of doc.files) {
      // Same title twice in one document (e.g. two "Situasjonsplan") -> "<title> 2 (<id>).pdf", "<title> 3 (<id>).pdf".
      const plain = fileName(doc, f);
      const n = (used.get(plain) || 0) + 1;
      used.set(plain, n);
      const name = fileName(doc, f, n);
      const dest = path.join(outDir, name);
      const base = { document: doc.title, documentId: doc.documentId, role: f.role, file: f.title };
      if (skipExisting && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        manifest.files.push({ path: dest, skipped: true, bytes: fs.statSync(dest).size, ...base });
        continue;
      }
      if (fetched >= maxFiles) {
        manifest.stopped = { reason: `Reached max_files (${maxFiles}). Run again to continue; files on disk are skipped.`, atDocument: did };
        break outer;
      }
      try {
        const r = await p.downloadFile(f.url, dest, { declaredPdf: declaresFormat(f) });
        fetched += 1;
        manifest.files.push({ path: r.path, bytes: r.bytes, contentType: r.contentType, via: r.via, ...base });
      } catch (e) {
        if (!(e instanceof InnsynError)) throw e;
        manifest.stopped = { reason: e.message, atDocument: did, atFile: f.title };
        break outer;
      }
    }
  }
  manifest.summary = { fetched, skipped: manifest.files.filter((x) => x.skipped).length, orderOnly: manifest.orderOnly.length, complete: !manifest.stopped };
  return manifest;
}
