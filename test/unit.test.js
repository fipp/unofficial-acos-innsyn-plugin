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
