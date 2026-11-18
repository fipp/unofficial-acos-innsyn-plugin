// High-level operations shared by the CLI and the MCP server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Portal, InnsynError, fileName, declaresFormat, checkId } from './client.js';
import { discover, findPortal, loadRegistry, slugify } from './discover.js';

const portals = new Map();

function localCache() {
  const f = path.join(process.env.ACOS_INNSYN_CACHE || path.join(os.homedir(), '.cache', 'unofficial-acos-innsyn'), 'portals.json');
  try { return { f, data: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return { f, data: {} }; }
}

/** Resolve a kommune (slug, name or number) to a ready Portal. Discovers and caches unknown slugs. */
export async function portal(kommune, { fresh = false } = {}) {
  if (typeof kommune !== 'string' && typeof kommune !== 'number') throw new InnsynError('kommune is required: a slug (baerum), name (Bærum) or kommunenummer (3201).');
  const key = String(kommune).trim().toLowerCase().replace(/\s+kommune$/, '').replace(/^kommune\s+/, '');
  if (!key || !/^[\p{L}\d .'-]+$/u.test(key) || /^[.-]|\.\./.test(key)) throw new InnsynError(`"${kommune}" is not a kommune name, slug or number. Use list_portals to see known kommuner.`);
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
 * did in 2026), rediscover it once and retry. A 5xx/404 alone is not proof: a bad search term
 * gives HTTP 500 too. So first reopen the search page and overviewInit (two requests); only if
 * that fails is the portal treated as moved.
 */
async function withPortal(kommune, fn) {
  const p = await portal(kommune);
  try {
    return await fn(p);
  } catch (e) {
    if (!(e instanceof InnsynError)) throw e;
    const status = e.cause?.status;
    let stale = /^Could not open /.test(e.message);
    if (!stale && (status >= 500 || status === 404)) {
      p.sessionReady = false;
      try { await p._init(); } catch (probe) { stale = probe instanceof InnsynError; }
    }
    if (!stale) throw e;
    return fn(await portal(kommune, { fresh: true }));
  }
}

/** Integer option within [min, max]; undefined gives def. */
function intOpt(name, v, def, min, max) {
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw new InnsynError(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)}).`);
  return v;
}

export function listPortals({ withSource } = {}) {
  const reg = loadRegistry();
  let list = reg.portals;
  if (withSource) {
    let re;
    try { re = new RegExp(withSource, 'i'); } catch { re = new RegExp(withSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
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
  const wanted = (Array.isArray(source) ? source : [source]).filter((w) => w !== undefined && w !== null && String(w).trim());
  if (!wanted.length) return all;
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

export const MAX_RESULTS = 500;

export async function search(kommune, q) {
  const max = intOpt('max', q.max, 50, 0, MAX_RESULTS);
  return withPortal(kommune, async (p) => {
    const out = [];
    for (const ds of await sources(p, q.source)) {
      const r = await p.searchAll({ ...q, datasource: ds.id }, max);
      out.push({ source: ds.name, total: r.total, items: r.items });
    }
    if (q.gnrBnr && out.every((x) => !x.total)) {
      const g = String(q.gnrBnr).replace(/\s+/g, '');
      out.push({ hint: `gnr_bnr ${g} found nothing in any source. Some portals do not index gnr/bnr; try title "Gbnr ${g}", title "${g}" and the street address before concluding there are no cases.` });
    }
    return out;
  });
}

/**
 * Case with its document list. withFiles adds orderOnly and fileCount per document
 * (one extra request per document, at most maxDocs documents).
 */
export async function getCase(kommune, caseId, { withFiles = false, maxDocs = 30 } = {}) {
  return withPortal(kommune, async (p) => {
    const c = await p.getCase(caseId);
    if (withFiles) {
      for (const d of c.documents.slice(0, maxDocs)) {
        try {
          const doc = await p.getDocument(d.id);
          d.fileCount = doc.files.length;
          d.orderOnly = doc.orderOnly;
        } catch (e) {
          if (!(e instanceof InnsynError)) throw e;
          d.fileError = e.message; // one failing document should not hide the rest
        }
      }
      if (c.documents.length > maxDocs) c.note = `File info added for the first ${maxDocs} of ${c.documents.length} documents.`;
    }
    return c;
  });
}

/**
 * The file already on disk for dest, or null. A file whose title does not declare its format is
 * named .pdf up front but saved under its real type (.jpg, .docx ...), so look for any
 * "<name>.<ext>" with the same stem.
 */
export function existingFile(dest, declared) {
  const size = (f) => { try { const st = fs.statSync(f); return st.isFile() ? st.size : 0; } catch { return 0; } };
  if (size(dest)) return { path: dest, bytes: size(dest) };
  if (declared) return null;
  const dir = path.dirname(dest);
  const stem = path.basename(dest).replace(/\.pdf$/i, '');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.startsWith(`${stem}.`) || !/^\.[a-z0-9]{2,5}$/i.test(n.slice(stem.length)) || /\.(part|browser)$/i.test(n)) continue;
    const f = path.join(dir, n);
    if (size(f)) return { path: f, bytes: size(f) };
  }
  return null;
}

export async function getDocument(kommune, docId) {
  return withPortal(kommune, (p) => p.getDocument(docId));
}

/**
 * Download every file of a document, or of every document in a case.
 * Returns a manifest; order-only documents are listed but not fetched.
 */
export async function download(kommune, id, outDir, { skipExisting = true, maxFiles = 60 } = {}) {
  id = checkId(id);
  maxFiles = intOpt('max_files', maxFiles, 60, 1, 500);
  if (typeof outDir !== 'string' || !outDir.trim()) throw new InnsynError('out_dir is required: the folder to save files in.');
  // Check the target folder before spending any requests on it.
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    throw new InnsynError(`Cannot use out_dir "${outDir}": ${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'a file (not a folder) is in the way' : e.message}.`);
  }
  if (!fs.statSync(outDir).isDirectory()) throw new InnsynError(`out_dir "${outDir}" is a file, not a folder.`);
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
  // Any error inside the loop (portal, disk, network) stops the run but keeps the manifest.
  const why = (e) => (e instanceof InnsynError ? e.message : `${e.code ? e.code + ': ' : ''}${e.cause?.message || e.message}`);
  outer: for (const [i, did] of docIds.entries()) {
    const left = docIds.length - i;
    let doc;
    try {
      doc = await p.getDocument(did);
    } catch (e) {
      manifest.stopped = { reason: why(e), atDocument: did, documentsLeft: left };
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
      const have = skipExisting && existingFile(dest, declaresFormat(f));
      if (have) {
        manifest.files.push({ path: have.path, skipped: true, bytes: have.bytes, ...base });
        continue;
      }
      if (fetched >= maxFiles) {
        manifest.stopped = { reason: `Reached max_files (${maxFiles}) with ${left} of ${docIds.length} document(s) still to check. Run again to continue; files on disk are skipped.`, atDocument: did, documentsLeft: left };
        break outer;
      }
      try {
        const r = await p.downloadFile(f.url, dest, { declaredPdf: declaresFormat(f) });
        fetched += 1;
        manifest.files.push({ path: r.path, bytes: r.bytes, contentType: r.contentType, via: r.via, ...base });
      } catch (e) {
        manifest.stopped = { reason: why(e), atDocument: did, atFile: f.title, documentsLeft: left };
        break outer;
      }
    }
  }
  manifest.summary = { fetched, skipped: manifest.files.filter((x) => x.skipped).length, orderOnly: manifest.orderOnly.length, complete: !manifest.stopped };
  return manifest;
}
