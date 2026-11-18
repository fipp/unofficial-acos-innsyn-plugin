#!/usr/bin/env node
// acos-innsyn CLI. Prints JSON to stdout.

import { parseArgs } from 'node:util';
import * as ops from './ops.js';
import { discover } from './discover.js';

const HELP = `acos-innsyn - unofficial client for ACOS Innsyn+ (innsynpluss.onacos.no)

Usage:
  acos-innsyn portals [--with-source TEXT]          known kommuner (optionally only those with a matching data source)
  acos-innsyn sources KOMMUNE                        data sources of a kommune's portal
  acos-innsyn search KOMMUNE [filters]               search; filters:
        --gnr 12/345  --title TEXT  --text TEXT  --id 2024/12345  --party NAME
        --source NAME (repeatable, name fragment or id; default: all)
        --cases (cases only)  --max N (per source, default 50)
  acos-innsyn case KOMMUNE CASE_ID [--files]         case with its document list (--files: add file count / orderOnly per document)
  acos-innsyn doc KOMMUNE DOC_ID                     document with its files
  acos-innsyn download KOMMUNE ID --out DIR          download files of a document (d-...) or a whole case (a-...)
  acos-innsyn discover SLUG                          probe a portal slug

KOMMUNE is a slug (baerum), name (Bærum) or kommunenummer (3201).
Environment: ACOS_INNSYN_DELAY_MS (default 600), ACOS_INNSYN_CACHE, ACOS_PLAYWRIGHT_MODULE.
`;

async function main() {
  const { values: v, positionals: pos } = parseArgs({
    allowPositionals: true,
    options: {
      gnr: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, id: { type: 'string' },
      party: { type: 'string' }, source: { type: 'string', multiple: true }, cases: { type: 'boolean' },
      max: { type: 'string' }, out: { type: 'string' }, files: { type: 'boolean' }, 'with-source': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, a, b] = pos;
  const print = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  switch (cmd) {
    case 'portals': return print(ops.listPortals({ withSource: v['with-source'] }));
    case 'sources': return print(await ops.datasources(a));
    case 'search':
      return print(await ops.search(a, {
        gnrBnr: v.gnr, title: v.title, text: v.text, caseOrDocId: v.id, senderRecipient: v.party,
        source: v.source, onlyCases: v.cases, max: v.max ? Number(v.max) : undefined,
      }));
    case 'case': return print(await ops.getCase(a, b, { withFiles: v.files }));
    case 'doc': return print(await ops.getDocument(a, b));
    case 'download':
      if (!v.out) throw new Error('--out DIR is required');
      return print(await ops.download(a, b, v.out));
    case 'discover': return print(await discover(a));
    default: process.stdout.write(HELP); if (cmd && !v.help) process.exitCode = 2;
  }
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 1; });
