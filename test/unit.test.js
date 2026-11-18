import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName } from '../src/client.js';
import { slugify, findPortal } from '../src/discover.js';

test('fileName builds dated, safe names', () => {
  const doc = { date: '05.12.2025', documentId: '2025/123456' };
  assert.equal(fileName(doc, { title: 'Uttalelse v/Kulturvern (pdf, 105KB)' }), '2025-12-05_Uttalelse v-Kulturvern (2025-123456).pdf');
  assert.equal(fileName(doc, { title: 'Situasjonsplan  (pdf, 1,3MB)' }), '2025-12-05_Situasjonsplan (2025-123456).pdf');
  assert.equal(fileName({}, { title: 'Kart (docx, 12KB)' }), 'Kart.docx');
});

test('slugify handles Norwegian letters and Sami names', () => {
  assert.equal(slugify('Bærum'), 'baerum');
  assert.equal(slugify('Søndre Land'), 'sondre-land');
  assert.equal(slugify('Røros - Rosse'), 'roros');
});

test('findPortal resolves slug, name and kommunenummer', () => {
  for (const q of ['baerum', 'Bærum', '3201']) assert.equal(findPortal(q)?.slug, 'baerum');
  assert.equal(findPortal('finnes-ikke'), undefined);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Portal, InnsynError } from '../src/client.js';

test('search without any filter is rejected before any request', async () => {
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
  await assert.rejects(() => p.search({ datasource: 'abc' }), (e) => e instanceof InnsynError && /at least one filter/.test(e.message));
});

test('browser launch failure gives a plugin-specific explanation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-fake-pw-'));
  const fake = path.join(dir, 'fake-playwright.mjs');
  fs.writeFileSync(fake, "export const chromium = { launch: async () => { throw new Error(\"browserType.launch: Executable doesn't exist at /x/chromium-9999\\nPlease run npx playwright install\"); } };\n");
  const prev = process.env.ACOS_PLAYWRIGHT_MODULE;
  process.env.ACOS_PLAYWRIGHT_MODULE = fake;
  try {
    const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
    await assert.rejects(() => p._browserFetch('https://example.invalid/f', path.join(dir, 'out.pdf')),
      (e) => e instanceof InnsynError && /Chromium build it expects is not installed/.test(e.message) && /restart the MCP server/.test(e.message));
  } finally {
    if (prev === undefined) delete process.env.ACOS_PLAYWRIGHT_MODULE; else process.env.ACOS_PLAYWRIGHT_MODULE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { isoDate } from '../src/client.js';

test('isoDate converts portal dates and leaves others alone', () => {
  assert.equal(isoDate('05.12.2025'), '2025-12-05');
  assert.equal(isoDate('5.1.2025'), '2025-01-05');
  assert.equal(isoDate('2025-12-05'), '2025-12-05');
  assert.equal(isoDate(undefined), undefined);
  assert.equal(fileName({ date: '2025-12-05', documentId: '2025/1' }, { title: 'A (pdf, 1KB)' }), '2025-12-05_A (2025-1).pdf');
});

test('downloads are validated and written atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-store-'));
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
  try {
    assert.throws(() => p._store(Buffer.alloc(0), path.join(dir, 'a.pdf'), 'application/pdf', 'http'), /Empty file/);
    assert.throws(() => p._store(Buffer.from('<!DOCTYPE html><html>'), path.join(dir, 'b.pdf'), 'text/plain', 'http'), /Got a web page/);
    assert.throws(() => p._store(Buffer.from('GIF89a...'), path.join(dir, 'b.pdf'), 'image/gif', 'http'), /Expected a PDF/);
    const r = p._store(Buffer.from('%PDF-1.7 x'), path.join(dir, 'c.pdf'), null, 'browser');
    assert.equal(r.contentType, 'application/pdf');
    assert.equal(r.via, 'browser');
    assert.deepEqual(fs.readdirSync(dir), ['c.pdf']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate suffix goes before the id; squashed titles fall back to the document title', () => {
  const doc = { date: '2026-01-02', documentId: '2026/7', title: 'Storgata 1 - Bruksendring - Søknad' };
  assert.equal(fileName(doc, { title: 'Situasjonsplan (pdf, 1KB)' }, 2), '2026-01-02_Situasjonsplan 2 (2026-7).pdf');
  assert.equal(fileName(doc, { title: 'Storgata 1BruksendringSøknad (pdf, 5MB)' }), '2026-01-02_Storgata 1 - Bruksendring - Søknad (2026-7).pdf');
});

test('malformed ids are rejected before any request', async () => {
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
  await assert.rejects(() => p.getDocument('a-123'), /not a document id/);
  await assert.rejects(() => p.getCase('d-123'), /not a case id/);
});

test('a file whose title does not declare a format is saved under its real type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-ext-'));
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
  try {
    const r = p._store(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), path.join(dir, 'foto.pdf'), 'image/jpeg', 'http', { declaredPdf: false });
    assert.equal(path.basename(r.path), 'foto.jpg');
    assert.deepEqual(fs.readdirSync(dir), ['foto.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fileName({ date: '2026-01-02' }, {}), '2026-01-02_dokument.pdf');
});

test('the throttle is shared across portals and serialises parallel calls', async () => {
  const a = new Portal({ slug: 'a', searchPath: 'sok', portalId: 1, menypunktId: 1 }, { delayMs: 120 });
  const b = new Portal({ slug: 'b', searchPath: 'sok', portalId: 2, menypunktId: 2 }, { delayMs: 120 });
  await a._throttle();
  const t0 = Date.now();
  await Promise.all([a._throttle(), b._throttle(), a._throttle()]);
  assert.ok(Date.now() - t0 >= 330, `three queued calls took only ${Date.now() - t0} ms`);
});

import { checkId } from '../src/client.js';
import * as ops from '../src/ops.js';

test('ids are trimmed, checked and cannot smuggle path segments', () => {
  assert.equal(checkId('  d-abc__12-2024  ', 'd'), 'd-abc__12-2024');
  assert.throws(() => checkId('abc'), /not a case or document id/);
  assert.throws(() => checkId('d-x/../../sak/a-1', 'd'), /not a valid document id/);
  assert.throws(() => checkId('d-a..b', 'd'), /not a valid document id/);
  assert.throws(() => checkId('a-1?x=1', 'a'), /not a valid case id/);
  // Real ids, as the portals return them (round 5 found 0.2.6 rejected all of these).
  for (const real of ['a-9e65a46b__696a__4a08__b3fe__6ae7cf63f461-1100043902!PaFAgq', 'a-8de09341__cd12__4975__9460__e28961550ab5-2015007742!PaFAgq']) {
    assert.equal(checkId(` ${real} `, 'a'), real);
    assert.equal(checkId(real.replace(/^a-/, 'd-'), 'd'), real.replace(/^a-/, 'd-'));
  }
  assert.throws(() => checkId(42, 'a'), /not a case id/);
});

test('a resumed download finds a file that was saved under its real type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-resume-'));
  try {
    const dest = path.join(dir, '2026-01-02_Foto (2026-7).pdf');
    assert.equal(ops.existingFile(dest, false), null);
    fs.writeFileSync(path.join(dir, '2026-01-02_Foto (2026-7).jpg.part'), 'x');
    fs.writeFileSync(path.join(dir, '2026-01-02_Foto 2 (2026-7).jpg'), 'x');
    assert.equal(ops.existingFile(dest, false), null, 'must not match .part or a numbered sibling');
    fs.writeFileSync(path.join(dir, '2026-01-02_Foto (2026-7).jpg'), 'jpeg');
    assert.equal(path.basename(ops.existingFile(dest, false).path), '2026-01-02_Foto (2026-7).jpg');
    assert.equal(ops.existingFile(dest, true), null, 'a declared PDF only counts under its own name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad search and download options are rejected before any request', async () => {
  const fail = (re) => (e) => e instanceof InnsynError && re.test(e.message);
  await assert.rejects(() => ops.search('baerum', { title: 'x', max: -1 }), fail(/max must be a whole number from 0 to 500/));
  await assert.rejects(() => ops.search('baerum', { title: 'x', max: Number('abc') }), fail(/max must be/));
  await assert.rejects(() => ops.search('baerum', { title: 'x', max: 100000 }), fail(/max must be/));
  await assert.rejects(() => ops.search('baerum', { gnrBnr: 'abc', source: ['fra 2015'] }), fail(/not a gårds-\/bruksnummer/));
  await assert.rejects(() => ops.search('..', { title: 'x' }), fail(/not a kommune/));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-out-'));
  try {
    const file = path.join(dir, 'a.pdf');
    fs.writeFileSync(file, '%PDF-');
    await assert.rejects(() => ops.download('baerum', 'd-1', file), fail(/file .*in the way|is a file/));
    await assert.rejects(() => ops.download('baerum', 'abc', dir), fail(/not a case or document id/));
    await assert.rejects(() => ops.download('baerum', 'd-1', dir, { maxFiles: -1 }), fail(/max_files must be/));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"<name> kommune" resolves, and a broken with_source regex is matched literally', () => {
  assert.equal(findPortal('Bærum kommune')?.slug, 'baerum');
  assert.doesNotThrow(() => ops.listPortals({ withSource: '(' }));
});

test('a portal 500 on search is reported as a rejected search, and quotes are stripped', async () => {
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 });
  let sent;
  p._api = async (m, route, body) => { sent = body; throw new InnsynError('API POST overview returned HTTP 500', { cause: { status: 500 } }); };
  await assert.rejects(() => p.search({ title: '"Storgata 1"' }), /rejected the search \(HTTP 500\)/);
  assert.equal(sent.keyValues.find((k) => k.key === 'titleSearch').value, 'Storgata 1');
});

test('out_dir is checked without creating anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-od-'));
  try {
    assert.doesNotThrow(() => ops.checkOutDir(path.join(dir, 'new', 'deeper')));
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be created before the first file is saved');
    fs.writeFileSync(path.join(dir, 'f.pdf'), 'x');
    assert.throws(() => ops.checkOutDir(path.join(dir, 'f.pdf')), /is a file, not a folder/);
    assert.throws(() => ops.checkOutDir(path.join(dir, 'f.pdf', 'sub')), /file, not a folder|in the way/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download stops count files, and a missing single document is an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acos-dl-'));
  const p = await ops.portal('baerum');
  const orig = { getDocument: p.getDocument, downloadFile: p.downloadFile };
  try {
    p.getDocument = async (id) => ({ id, title: 'T', documentId: '2026/1', date: '2026-01-02', orderOnly: false,
      files: [1, 2, 3].map((n) => ({ title: `F${n} (pdf, 1KB)`, url: `/f${n}`, role: 'main' })) });
    p.downloadFile = async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, '%PDF-'); return { path: dest, bytes: 5 }; };
    const out = path.join(dir, 'out');
    const m = await ops.download('baerum', 'd-1!x', out, { maxFiles: 1 });
    assert.equal(m.summary.fetched, 1);
    assert.equal(m.stopped.filesLeft, 2);
    assert.match(m.stopped.reason, /2 file\(s\) left in this document\. Run again/);
    p.getDocument = async (id) => { throw new InnsynError(`No document "${id}" found`, { cause: { notFound: true } }); };
    await assert.rejects(() => ops.download('baerum', 'd-2!x', path.join(dir, 'none')), /No document/);
    assert.equal(fs.existsSync(path.join(dir, 'none')), false);
  } finally {
    Object.assign(p, orig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file requests keep the file delay after any other request', async () => {
  const p = new Portal({ slug: 'x', searchPath: 'sok', portalId: 1, menypunktId: 1 }, { delayMs: 20, fileDelayMs: 200 });
  await p._throttle();
  const t0 = Date.now();
  await p._throttle(p.fileDelayMs);
  assert.ok(Date.now() - t0 >= 190, `file throttle waited only ${Date.now() - t0} ms`);
});
