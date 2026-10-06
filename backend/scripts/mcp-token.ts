/**
 * Agent tokens for the editor MCP endpoint (docs/EDITOR_MCP_PLAN.md 4). A token acts as an existing collector
 * account; the AI client is recorded as its own device row (platform "mcp"), and deleting that row revokes it.
 *
 *   npm run mcp:token -- --collector C01 --agent claude-code                 # read-only, 30 days; prints only the token
 *   npm run mcp:token -- --collector C01 --agent claude-code --scope write
 *   npm run mcp:token -- --list
 *   npm run mcp:token -- --revoke --collector C01 --agent claude-code
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { signAgentToken } from '../src/common/auth/jwt.js';
import { collectorRepository } from '../src/modules/collectors/collector.repository.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/modules/editor-mcp/mcp.context.js';

const { values: args } = parseArgs({
  options: {
    collector: { type: 'string' },
    agent: { type: 'string' },
    scope: { type: 'string', default: 'read' },
    days: { type: 'string', default: '30' },
    list: { type: 'boolean', default: false },
    revoke: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (args.list) {
    const { rows } = await pool.query(
      `SELECT c.collector_code "collector", d.device_model "agent", d.created_at "createdAt", d.last_seen_at "lastSeenAt"
         FROM devices d JOIN collectors c ON c.id = d.collector_id WHERE d.platform = 'mcp' ORDER BY 1, 2`);
    console.table(rows);
    return;
  }
  if (!args.collector || !args.agent) fail('Usage: npm run mcp:token -- --collector C01 --agent claude-code [--scope read|write] [--days 30]');
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(args.agent)) fail('--agent: lowercase letters, digits, ".", "_" or "-" (max 40)');
  const collector = await collectorRepository.findByCode(args.collector.trim().toUpperCase());
  if (!collector) fail(`Collector ${args.collector} is not registered`);
  const clientDeviceId = `mcp:${args.agent}`;

  if (args.revoke) {
    const { rowCount } = await pool.query(`DELETE FROM devices WHERE collector_id = $1 AND client_device_id = $2 AND platform = 'mcp'`, [collector.id, clientDeviceId]);
    console.error(rowCount ? `Revoked every ${args.agent} token of ${collector.collector_code}` : 'No such agent device');
    return;
  }
  if (args.scope !== 'read' && args.scope !== 'write') fail('--scope must be read or write');
  const days = Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail('--days must be 1–365');

  const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, clientDeviceId, { platform: 'mcp', deviceModel: args.agent });
  const scopes = args.scope === 'write' ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
  const token = signAgentToken(
    { collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId },
    { agent: args.agent, scopes }, `${days}d`);
  console.error(`# ${collector.collector_code} / ${args.agent} / ${scopes.join(' ')} / ${days} days — export CAMPUS_EDITOR_MCP_TOKEN=<token below>`);
  console.log(token); // stdout carries only the token so it can be captured: export CAMPUS_EDITOR_MCP_TOKEN=$(npm run mcp:token -- ...)
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }).finally(() => pool.end());
