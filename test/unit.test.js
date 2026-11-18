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
