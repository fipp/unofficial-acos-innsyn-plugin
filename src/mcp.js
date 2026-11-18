#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.

import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import * as ops from './ops.js';

const VERSION = '0.2.1';
const PROTOCOL = '2025-06-18';

const kommune = { type: 'string', description: 'Kommune: portal slug (baerum), name (Bærum) or kommunenummer (3201).' };

const TOOLS = [
  {
    name: 'list_portals',
    description: 'List Norwegian kommuner known to publish their journal (postliste, byggesaker, politiske saker) on ACOS Innsyn+ (innsynpluss.onacos.no), with each portal\'s data sources and a hasByggesak flag. Use with_source to filter, e.g. "bygg" for kommuner with byggesaker. Portals with no sources carry a note.',
    inputSchema: { type: 'object', properties: { with_source: { type: 'string', description: 'Regex/fragment matched against data source names AND the case types (sakstyper) inside them. Many portals have one source called "Journal" whose case types include Byggesak, so "bygg" matches those too.' } } },
    run: (a) => ops.listPortals({ withSource: a.with_source }),
  },
  {
    name: 'list_sources',
    description: 'List the data sources (e.g. Postliste, Plan- og byggesaker fra 2015, Plan- og byggesaker 2003-2015) of one kommune\'s portal.',
    inputSchema: { type: 'object', properties: { kommune }, required: ['kommune'] },
    run: (a) => ops.datasources(a.kommune),
  },
  {
    name: 'search',
    description: 'Search a kommune\'s public journal. At least one of gnr_bnr, title, text, case_or_doc_id, party is required (unfiltered searches are rejected). Searches every data source unless source is given. Returns cases (id a-...) and documents (id d-...). Tip: for a property, search gnr_bnr first, then the street address in title, then owner names in party; check both old and new byggesak sources.',
    inputSchema: {
      type: 'object',
      properties: {
        kommune,
        gnr_bnr: { type: 'string', description: 'Gårds- og bruksnummer, e.g. "12/345".' },
        title: { type: 'string', description: 'Words in the case or document title, e.g. a street address.' },
        text: { type: 'string', description: 'Free-text search.' },
        case_or_doc_id: { type: 'string', description: 'Saks- eller dokumentID, e.g. "2024/12345".' },
        party: { type: 'string', description: 'Sender or recipient name.' },
        source: { type: 'array', items: { type: 'string' }, description: 'Data source name fragments or ids, e.g. ["bygg"].' },
        cases_only: { type: 'boolean' },
        max: { type: 'integer', description: 'Max results per data source (default 50).' },
      },
      required: ['kommune'],
    },
    run: (a) => ops.search(a.kommune, {
      gnrBnr: a.gnr_bnr, title: a.title, text: a.text, caseOrDocId: a.case_or_doc_id, senderRecipient: a.party,
      source: a.source, onlyCases: a.cases_only, max: a.max,
    }),
  },
  {
    name: 'get_case',
    description: 'Get a case (arkivsak, id starting "a-") with date, caseType, handler, status and its list of published documents. The list does not say whether a document has files; set with_files to add fileCount and orderOnly per document (one extra request per document, max 30).',
    inputSchema: { type: 'object', properties: { kommune, case_id: { type: 'string' }, with_files: { type: 'boolean' } }, required: ['kommune', 'case_id'] },
    run: (a) => ops.getCase(a.kommune, a.case_id, { withFiles: a.with_files }),
  },
  {
    name: 'get_document',
    description: 'Get a document (journalpost, id starting "d-") with dates and its files (main document and attachments). orderOnly=true means no file is published; it can only be requested by innsynskrav.',
    inputSchema: { type: 'object', properties: { kommune, doc_id: { type: 'string' } }, required: ['kommune', 'doc_id'] },
    run: (a) => ops.getDocument(a.kommune, a.doc_id),
  },
  {
    name: 'download',
    description: 'Download all files of a document (d-...) or of every document in a case (a-...) into a folder, named "YYYY-MM-DD_<title> (<DokumentID>).pdf". Already downloaded files are skipped. Needs Playwright installed for the portal\'s browser check. Returns a manifest including order-only documents.',
    inputSchema: {
      type: 'object',
      properties: { kommune, id: { type: 'string' }, out_dir: { type: 'string', description: 'Target folder (absolute, or relative to the server\'s working directory).' } },
      required: ['kommune', 'id', 'out_dir'],
    },
    run: (a) => ops.download(a.kommune, a.id, path.resolve(a.out_dir.replace(/^~(?=$|\/)/, os.homedir()))),
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'unofficial-acos-innsyn', version: VERSION },
        instructions: 'Unofficial tools for Norwegian kommuner\'s public journals on ACOS Innsyn+. Requests are rate limited; be economical. Only public material is accessible; order-only documents need an innsynskrav to the kommune.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
      try {
        const out = await tool.run(params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/')) return undefined;
      return fail(-32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg).catch((e) => send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
});
