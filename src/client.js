// Unofficial client for ACOS Innsyn+ portals (innsynpluss.onacos.no).
// Zero dependencies. Playwright is loaded lazily, only to pass the Azure WAF
// JavaScript challenge that guards file downloads.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

export const BASE = 'https://innsynpluss.onacos.no';
const API = `${BASE}/api/presentation/v2/nye-innsyn`;
const DEFAULT_UA = 'unofficial-acos-innsyn (+https://github.com/fipp/unofficial-acos-innsyn-plugin)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class InnsynError extends Error {}

class CookieJar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  set(name, value) { this.map.set(name, value); }
  has(name) { return this.map.has(name); }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

function cacheDir() {
  const d = process.env.ACOS_INNSYN_CACHE || path.join(os.homedir(), '.cache', 'unofficial-acos-innsyn');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Load a module that the user installed somewhere (cwd, env path, or next to us). */
async function loadPlaywright() {
  const tries = [];
  if (process.env.ACOS_PLAYWRIGHT_MODULE) tries.push(process.env.ACOS_PLAYWRIGHT_MODULE);
  tries.push('playwright');
  let globalRoot = null;
  try { globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* npm missing */ }
  for (const base of [process.cwd(), path.dirname(new URL(import.meta.url).pathname), globalRoot].filter(Boolean)) {
    try { tries.push(createRequire(path.join(base, 'noop.js')).resolve('playwright')); } catch { /* not there */ }
  }
  for (const t of tries) {
    try {
      const m = await import(t.startsWith('/') ? pathToFileURL(t).href : t);
      return m.chromium ? m : m.default;
    } catch { /* try next */ }
  }
  throw new InnsynError(
    'File downloads need Playwright to pass the portal\'s Azure WAF JavaScript challenge. ' +
    'Install it globally (npm i -g playwright && npx playwright install chromium), or set ACOS_PLAYWRIGHT_MODULE ' +
    'to the path of an installed playwright module, then restart the MCP server. Search and metadata work without it.');
}

/** Flatten the portal's nested {b:[...]} block tree. */
function* walk(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  if (Array.isArray(node.b)) for (const c of node.b) yield* walk(c);
}

function props(node) {
  const out = {};
  for (const n of walk(node)) if (n.type === 'Property' && n.title) out[n.title] = n.text;
  return out;
}

function meta(node) {
  const out = {};
  for (const n of walk(node)) if (n.type === 'Metadata' && n.key) out[n.key] = n.title;
  return out;
}

export class Portal {
  /**
   * @param {object} cfg  { slug, searchPath, portalId, menypunktId, datasources? }
   * @param {object} [opt] { delayMs, userAgent }
   */
  constructor(cfg, opt = {}) {
    this.cfg = { ...cfg };
    this.delayMs = opt.delayMs ?? Number(process.env.ACOS_INNSYN_DELAY_MS ?? 600);
    this.fileDelayMs = opt.fileDelayMs ?? Number(process.env.ACOS_INNSYN_FILE_DELAY_MS ?? 2000);
    this.ua = opt.userAgent ?? DEFAULT_UA;
    this.jar = new CookieJar();
    this.last = 0;
    this.sessionReady = false;
    this.clearanceUa = null;
  }

  async _throttle() {
    const wait = this.last + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }

  async _fetch(url, init = {}, { useClearanceUa = false } = {}) {
    await this._throttle();
    const headers = {
      'user-agent': useClearanceUa && this.clearanceUa ? this.clearanceUa : this.ua,
      ...(init.headers || {}),
    };
    const ck = this.jar.header();
    if (ck) headers.cookie = ck;
    const res = await fetch(url, { redirect: 'manual', ...init, headers });
    this.jar.absorb(res);
    return res;
  }

  _apiHeaders() {
    return {
      'content-type': 'application/json',
      'x-anti-csrf': '1',
      portalid: String(this.cfg.portalId),
      menypunktid: String(this.cfg.menypunktId),
      sprakid: '1',
      devicetype: 'desktop',
    };
  }

  async _session() {
    if (this.sessionReady) return;
    const res = await this._fetch(`${BASE}/${this.cfg.slug}/${this.cfg.searchPath}/`);
    if (res.status !== 200) throw new InnsynError(`Could not open ${this.cfg.slug}/${this.cfg.searchPath} (HTTP ${res.status})`);
    await res.arrayBuffer();
    this.sessionReady = true;
  }

  async _api(method, p, body) {
    await this._session();
    const res = await this._fetch(`${API}/${p}`, {
      method,
      headers: this._apiHeaders(),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await res.text();
    if (res.status !== 200) throw new InnsynError(`API ${method} ${p} returned HTTP ${res.status}`);
    try { return JSON.parse(text).content; } catch { throw new InnsynError(`API ${p} did not return JSON`); }
  }

  /** List the portal's data sources (Postliste, Plan- og byggesaker, ...). */
  async _init(datasource) {
    const kv = datasource ? [{ key: 'Datasource', value: datasource }] : [];
    const c = await this._api('POST', 'overviewInit', { keyValues: kv, type: 0 });
    const filters = c.filter?.searchOptions?.searchFilters || c.searchOptions?.searchFilters || [];
    const caseTypes = (filters.find((x) => x.identifier === 'Sakstype')?.fields || []).map((x) => x.name);
    return { filters, caseTypes, total: c.searchItems?.totalItemCount };
  }

  /**
   * Data sources with their case types. Portals with one journal and no
   * "Velg datakilde" menu get a single source with id null.
   * @param {{withCaseTypes?: boolean}} [opt]
   */
  async datasources({ withCaseTypes = false } = {}) {
    const init = await this._init();
    const f = init.filters.find((x) => x.identifier === 'Datasource');
    if (!f?.fields?.length) {
      if (!init.filters.length && !init.total) return [];
      return [{ id: null, name: 'Journal', note: 'Single journal; this portal has no data-source menu, so searches need no source.', ...(withCaseTypes ? { caseTypes: init.caseTypes } : {}) }];
    }
    const out = [];
    for (const x of f.fields) {
      const d = { id: x.identifier, name: x.name };
      if (withCaseTypes) d.caseTypes = (await this._init(x.identifier)).caseTypes;
      out.push(d);
    }
    return out;
  }

  /**
   * Search. Any of: text, title, caseOrDocId, gnrBnr, senderRecipient.
   * @returns {{total:number, page:number, pageCount:number, items:object[]}}
   */
  async search({ datasource, text, title, caseOrDocId, gnrBnr, senderRecipient, onlyCases, page = 1, pageSize = 50 } = {}) {
    if (![text, title, caseOrDocId, gnrBnr, senderRecipient].some((x) => x && String(x).trim())) {
      throw new InnsynError('Give at least one filter: text, title, case/document id, gnr/bnr or sender/recipient. Unfiltered searches would page through the whole journal.');
    }
    const kv = datasource ? [{ key: 'Datasource', value: datasource }] : [];
    if (text) kv.push({ key: 'searchTerm', value: text });
    if (title) kv.push({ key: 'titleSearch', value: title });
    if (caseOrDocId) kv.push({ key: 'caseDocIDSearch', value: caseOrDocId });
    if (gnrBnr) kv.push({ key: 'farmPropertyNumberSearch', value: gnrBnr });
    if (senderRecipient) kv.push({ key: 'senderRecipientSearch', value: senderRecipient });
    if (onlyCases) kv.push({ key: 'FilterContent', value: 'CaseOnly' });
    kv.push({ key: 'page', value: String(page) }, { key: 'pageSize', value: String(pageSize) });
    const c = await this._api('POST', 'overview', { type: 0, keyValues: kv });
    const s = c.searchItems;
    return {
      total: s.totalItemCount,
      page: s.pageNumber,
      pageCount: s.pageCount,
      items: s.items.map((it) => ({
        id: it.identifier,
        kind: it.identifier.startsWith('a-') ? 'case' : 'document',
        title: it.title?.trim(),
        type: it.type,
        caseNumber: it.properties?.saksnummer || undefined,
        date: it.properties?.dato,
        parentId: it.parentIdentifier || undefined,
      })),
    };
  }

  /** Search and follow pages up to maxItems. */
  async searchAll(q, maxItems = 500) {
    const out = [];
    let page = 1;
    for (;;) {
      const r = await this.search({ ...q, page, pageSize: 100 });
      out.push(...r.items);
      if (out.length >= maxItems || page >= r.pageCount || r.items.length === 0) return { total: r.total, items: out.slice(0, maxItems) };
      page += 1;
    }
  }

  /** Case (arkivsak) with its published documents. */
  async getCase(caseId) {
    const c = await this._api('GET', `sak/${caseId}`);
    const body = c.body;
    const docs = [];
    for (const n of walk(body)) {
      if (n.type === 'AsyncDocument' || (n.identifier?.startsWith('d-') && n !== body)) {
        const p = props(n);
        docs.push({ id: n.identifier, title: n.title?.trim(), documentId: p.DokumentID, date: p.Dato, type: p.Dokumenttype, recipient: p.Mottaker, sender: p.Avsender });
      }
    }
    const m = meta(body);
    const pr = body.props || {};
    return {
      id: body.identifier,
      title: body.title?.trim(),
      caseNumber: m.FRIENDLY_ID,
      date: pr.dato,
      caseType: pr.sakstype,
      handler: pr.saksbehandler,
      status: pr.status,
      documents: docs,
    };
  }

  /** Document (journalpost) with its files. Files are empty when the document must be ordered. */
  async getDocument(docId) {
    const c = await this._api('POST', `dokument/${docId}`, {});
    const files = [];
    for (const n of walk(c)) {
      if (n.type === 'FileList') {
        for (const f of n.b || []) if (f.url) files.push({ id: f.identifier, title: f.title?.trim(), role: n.key === 'DOCUMENT_FILES' ? 'main' : 'attachment', url: f.url });
      }
    }
    const m = meta(c);
    const texts = {};
    for (const n of walk(c)) if (n.type === 'Text' && n.title && n.text) texts[n.title] = n.text;
    return {
      id: c.identifier,
      title: c.title?.trim(),
      documentId: m.FRIENDLY_ID,
      caseDocumentId: m.CASE_DOCUMENT_FRIENDLY_ID,
      date: m.DATE,
      department: m.DEPARTMENT,
      journalDate: texts.Journaldato,
      letterDate: texts.Brevdato,
      files,
      orderOnly: files.length === 0,
    };
  }

  _loadCachedClearance() {
    const cache = path.join(cacheDir(), 'clearance.json');
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (c.expires > Date.now()) { this.jar.set('afd_azwaf_jsclearance', c.value); this.clearanceUa = c.ua; return true; }
    } catch { /* none */ }
    return false;
  }

  /**
   * Open the file URL in a real (headless) Chromium so the portal's own Azure WAF
   * JavaScript challenge runs. Either the browser receives the file directly
   * (saved to destPath) or it earns the clearance cookie, which we keep and reuse
   * for plain HTTP requests with the same browser user agent.
   * @returns {Promise<null|{path,bytes,contentType}>} the file if the browser got it
   */
  async _browserFetch(fileUrl, destPath) {
    const pw = await loadPlaywright();
    let browser;
    try {
      browser = await pw.chromium.launch();
    } catch (e) {
      const first = String(e.message).split('\n')[0];
      const missing = /Executable doesn't exist|install/i.test(e.message);
      const bp = process.env.PLAYWRIGHT_BROWSERS_PATH;
      throw new InnsynError(missing
        ? 'Playwright was found, but the Chromium build it expects is not installed. Each Playwright version needs one specific Chromium revision. ' +
          'Run `npx playwright install chromium` with the same Playwright version' +
          (bp ? ` (PLAYWRIGHT_BROWSERS_PATH=${bp} must be writable), or install the Playwright version that matches the browsers already in ${bp}` : '') +
          `, then restart the MCP server. Playwright said: ${first}`
        : `Could not start Chromium for the download check: ${first}`);
    }
    try {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await ctx.newPage();
      let saved = null;
      page.on('download', async (d) => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        await d.saveAs(destPath);
        saved = { path: destPath, bytes: fs.statSync(destPath).size, contentType: 'application/octet-stream (browser download)' };
      });
      if (process.env.ACOS_INNSYN_DEBUG) { page.on('response', (r) => process.stderr.write(`[browser] ${r.status()} ${r.url().slice(0, 90)}\n`)); }
      await page.goto(fileUrl).catch(() => { /* navigation turns into a download */ });
      let cookie;
      for (let i = 0; i < 20 && !saved; i++) {
        cookie = (await ctx.cookies()).find((c) => c.name === 'afd_azwaf_jsclearance');
        if (cookie && i > 2) break;
        await sleep(1000);
      }
      if (cookie) {
        this.clearanceUa = await page.evaluate(() => navigator.userAgent).catch(() => null);
        this.jar.set('afd_azwaf_jsclearance', cookie.value);
        const expires = cookie.expires > 0 ? cookie.expires * 1000 : Date.now() + 30 * 60 * 1000;
        fs.writeFileSync(path.join(cacheDir(), 'clearance.json'), JSON.stringify({ value: cookie.value, ua: this.clearanceUa, expires }));
      }
      if (!saved && !cookie) throw new InnsynError("The portal's firewall (Azure WAF) is refusing file downloads from this network right now, probably because of recent request volume. Wait 10-30 minutes and try again; already downloaded files are skipped. Search and metadata still work.");
      return saved;
    } finally {
      await browser.close();
    }
  }

  async _plainFetch(full, destPath) {
    await sleep(Math.max(0, this.fileDelayMs - this.delayMs));
    const res = await this._fetch(full, {}, { useClearanceUa: true });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    if (res.status === 200 && !ct.includes('text/html')) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      return { path: destPath, bytes: buf.length, contentType: ct };
    }
    if (res.status !== 403) throw new InnsynError(`File download returned HTTP ${res.status}`);
    return null;
  }

  /** Download a file (url from getDocument) to destPath. Returns {path, bytes, contentType}. */
  async downloadFile(url, destPath) {
    const full = url.startsWith('http') ? url : `${BASE}${url}`;
    await this._session();
    if (!this.jar.has('afd_azwaf_jsclearance')) this._loadCachedClearance();
    let r = await this._plainFetch(full, destPath);
    if (r) return r;
    try { fs.rmSync(path.join(cacheDir(), 'clearance.json')); } catch { /* none */ }
    r = await this._browserFetch(full, destPath);
    if (r) return r;
    r = await this._plainFetch(full, destPath);
    if (r) return r;
    throw new InnsynError("The portal's firewall (Azure WAF) is refusing file downloads from this network right now, probably because of recent request volume. Wait 10-30 minutes and try again; already downloaded files are skipped. Search and metadata still work.");
  }
}

/** Safe file name: "YYYY-MM-DD_<title> (<documentId>).<ext>". */
export function fileName(doc, file) {
  const iso = (doc.date || '').split('.').reverse().join('-');
  const ext = (/\((\w+), [\d,.]+\s*[KMG]?B\)$/i.exec(file.title)?.[1] || 'pdf').toLowerCase();
  const t = file.title.replace(/\s*\(\w+, [\d,.]+\s*[KMG]?B\)$/i, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  const id = (doc.documentId || '').replace(/\//g, '-');
  return `${iso ? iso + '_' : ''}${t}${id ? ` (${id})` : ''}.${ext}`;
}
