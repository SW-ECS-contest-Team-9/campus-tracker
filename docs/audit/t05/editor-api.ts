/** T05: one authenticated request to the editor REST API of the local test backend (the path the browser editor uses).
 * Usage (from backend/, backend running on PORT from the test .env):
 *   npx tsx ../docs/audit/t05/editor-api.ts GET changes?limit=5
 *   npx tsx ../docs/audit/t05/editor-api.ts POST changesets/<id>/revert            (sessionId and mutationId are generated)
 *   npx tsx ../docs/audit/t05/editor-api.ts POST areas @body.json [--as=T05]
 * Makes a collector access token in-process (never printed). Refuses any database but the T05 test container.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { signAccessToken } from '../../../backend/src/common/auth/jwt.js';
import { collectorRepository } from '../../../backend/src/modules/collectors/collector.repository.js';

async function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const [method, route, raw] = argv.filter((a) => !a.startsWith('--'));
  if (!method || !route) throw new Error('Usage: editor-api.ts METHOD PATH [JSON | @body.json] [--as=T05]');
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5544') throw new Error('Refused: not the T05 test database (127.0.0.1:5544)');
  const code = flags.find((f) => f.startsWith('--as='))?.slice(5) ?? 'T05';
  const collector = await collectorRepository.findByCode(code);
  if (!collector) throw new Error(`Collector ${code} is not registered`);
  const clientDeviceId = 't05-editor';
  const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, clientDeviceId, { platform: 'web', deviceModel: 't05-editor' });
  const token = signAccessToken({ collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId });
  let body: unknown = raw ? JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw) : undefined;
  if (/^changesets\/[^/]+\/revert$/.test(route) && body === undefined) body = { sessionId: randomUUID(), mutationId: randomUUID() };
  const res = await fetch(`http://127.0.0.1:${env.PORT}/api/v1/editor/${route}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  console.log(JSON.stringify({ httpStatus: res.status, data }, null, 2));
  if (!res.ok) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
