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
  acos-innsyn download KOMMUNE ID --out DIR [--max-files N]   files of a document (d-...) or a whole case (a-...); default max 60 files per run.
        Exit code 3 when the run stopped early (max-files, firewall); run it again to continue.
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
      max: { type: 'string' }, out: { type: 'string' }, files: { type: 'boolean' }, 'max-files': { type: 'string' }, 'with-source': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, a, b] = pos;
  const int = (flag, x) => {
    if (x === undefined) return undefined;
    if (!/^-?\d+$/.test(x.trim())) throw new Error(`--${flag} must be a whole number (got "${x}")`);
    return Number(x);
  };
  const print = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  switch (cmd) {
    case 'portals': return print(ops.listPortals({ withSource: v['with-source'] }));
    case 'sources': return print(await ops.datasources(a));
    case 'search':
      return print(await ops.search(a, {
        gnrBnr: v.gnr, title: v.title, text: v.text, caseOrDocId: v.id, senderRecipient: v.party,
        source: v.source, onlyCases: v.cases, max: int('max', v.max),
      }));
    case 'case': return print(await ops.getCase(a, b, { withFiles: v.files }));
    case 'doc': return print(await ops.getDocument(a, b));
    case 'download':
      if (!v.out) throw new Error('--out DIR is required');
    {
      const m = await ops.download(a, b, v.out, { maxFiles: int('max-files', v['max-files']) });
      print(m);
      if (!m.summary.complete) process.exitCode = 3; // stopped early (max-files, firewall, error); run again to continue
      return undefined;
    }
    case 'discover': return print(await discover(a));
    default:
      if (cmd && cmd !== 'help' && !v.help) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 2; } else process.stdout.write(HELP);
  }
}

// Messages from the shared code name MCP parameters; translate them to CLI flags.
const CLI_NAMES = [[/\bgnr_bnr\b/g, '--gnr'], [/\bmax_files\b/g, '--max-files'], [/\bout_dir\b/g, '--out'], [/\bcase_or_doc_id\b/g, '--id'],
  [/\blist_portals\b/g, '`acos-innsyn portals`'], [/(?<!-)\bmax must\b/g, '--max must']];
main().catch((e) => {
  const msg = CLI_NAMES.reduce((m, [re, to]) => m.replace(re, to), e.message);
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 1;
});
