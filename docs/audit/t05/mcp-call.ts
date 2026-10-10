/** T05: calls one editor MCP tool on the local test backend and prints the JSON result.
 * Usage (from backend/, backend dev server running on PORT from the test .env):
 *   npx tsx ../docs/audit/t05/mcp-call.ts TOOL_NAME [JSON_ARGS | @args.json] [--write] [--as=C02]
 * Makes a 10-minute agent token in-process for agent "t05-check" (never printed). Refuses any database but the T05 test container.
 */
import fs from 'node:fs';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { signAgentToken } from '../../../backend/src/common/auth/jwt.js';
import { collectorRepository } from '../../../backend/src/modules/collectors/collector.repository.js';
import { SCOPE_READ, SCOPE_WRITE } from '../../../backend/src/modules/editor-mcp/mcp.context.js';

async function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const [tool, raw] = argv.filter((a) => !a.startsWith('--'));
  if (!tool) throw new Error('Usage: mcp-call.ts TOOL_NAME [JSON_ARGS | @args.json] [--write] [--as=C02]');
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5544') throw new Error('Refused: not the T05 test database (127.0.0.1:5544)');
  const input = raw ? JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw) : {};
  const code = flags.find((f) => f.startsWith('--as='))?.slice(5) ?? 'C02';
  const collector = await collectorRepository.findByCode(code);
  if (!collector) throw new Error(`Collector ${code} is not registered`);
  const clientDeviceId = 'mcp:t05-check';
  const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, clientDeviceId, { platform: 'mcp', deviceModel: 't05-check' });
  const token = signAgentToken({ collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId },
    { agent: 't05-check', scopes: flags.includes('--write') ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ] }, '10m');
  const res = await fetch(`http://127.0.0.1:${env.PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } }),
  });
  const text = await res.text();
  const json = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : text;
  const body = json ? JSON.parse(json) : null;
  const content = body?.result?.content?.find((c: { type: string }) => c.type === 'text')?.text;
  let data: unknown = body;
  try { if (content) data = JSON.parse(content); } catch { data = { text: content }; }
  console.log(JSON.stringify({ httpStatus: res.status, isError: !!body?.result?.isError, data }, null, 2));
  if (res.status !== 200 || body?.result?.isError) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
