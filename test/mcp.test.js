import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('MCP server starts, initializes and lists six tools', async () => {
  const server = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(err, '', `server wrote to stderr: ${err}`);
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(msgs[0].result.serverInfo.name, 'unofficial-acos-innsyn');
  assert.deepEqual(msgs[1].result.tools.map((t) => t.name).sort(), ['download', 'get_case', 'get_document', 'list_portals', 'list_sources', 'search']);
});
