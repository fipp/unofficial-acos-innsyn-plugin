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
