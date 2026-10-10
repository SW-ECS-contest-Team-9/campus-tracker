/** N02: lays proposed roads into the LOCAL TEST DB through the editor MCP write tools (never the operational server).
 * Run from C:\campus-tracker-testdb\backend (test .env, backend running on its PORT):
 *   npx tsx ../docs/audit/n02/n02.ts state OUT.json [PAIRS.json]     roads/nodes/places/areas, validator, components, reachability
 *   npx tsx ../docs/audit/n02/n02.ts apply GROUP.json OUT.json [--commit]   apply_changes (dry run unless --commit)
 *   npx tsx ../docs/audit/n02/n02.ts call TOOL JSON
 *   npx tsx ../docs/audit/n02/n02.ts rest METHOD PATH [JSON|@file]      editor REST (areas, changeset revert)
 * GROUP.json: { id, comment, ops: [{ ref, op, args }] }. Refuses any database but the T05 test container (127.0.0.1:5544).
 */
import fs from 'node:fs';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { signAgentToken, signAccessToken } from '../../../backend/src/common/auth/jwt.js';
import { collectorRepository } from '../../../backend/src/modules/collectors/collector.repository.js';
import { SCOPE_READ, SCOPE_WRITE } from '../../../backend/src/modules/editor-mcp/mcp.context.js';

type Any = any;
let token = '';
async function login() {
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5544') throw new Error('Refused: not the T05 test database (127.0.0.1:5544)');
  const collector = await collectorRepository.findByCode('T05');
  if (!collector) throw new Error('Collector T05 is not registered');
  const clientDeviceId = 'mcp:n02-plaza';
  const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, clientDeviceId, { platform: 'mcp', deviceModel: 'n02-plaza' });
  token = signAgentToken({ collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId },
    { agent: 'n02-plaza', scopes: [SCOPE_READ, SCOPE_WRITE] }, '30m');
  restToken = signAccessToken({ collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId });
}
let restToken = '';
async function rest(method: string, route: string, body?: Any): Promise<Any> {
  const res = await fetch(`http://127.0.0.1:${env.PORT}/api/v1/editor/${route}`, { method,
    headers: { authorization: `Bearer ${restToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: Any = text; try { data = JSON.parse(text); } catch { /* text */ }
  if (!res.ok) throw new Error(`${method} ${route} ${res.status}: ${text.slice(0, 800)}`);
  return data;
}
async function mcp(tool: string, args: Any = {}): Promise<Any> {
  const res = await fetch(`http://127.0.0.1:${env.PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const json = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : text;
  const body = json ? JSON.parse(json) : null;
  const content = body?.result?.content?.find((c: Any) => c.type === 'text')?.text;
  let data: Any = body;
  try { if (content) data = JSON.parse(content); } catch { data = { text: content }; }
  if (res.status !== 200 || body?.result?.isError || body?.error) throw Object.assign(new Error(`${tool} failed: ${JSON.stringify(data).slice(0, 1500)}`), { data });
  return data;
}
async function listAll(type: 'road' | 'node' | 'place', extra: Any = {}) {
  const items: Any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await mcp('list_features', { type, limit: 200, offset, ...extra });
    items.push(...page.items);
    if (offset + 200 >= page.total) return items;
  }
}
const len = (c: number[][]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0);

function components(roads: Any[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const r of roads) for (const n of [r.fromNodeId, r.toNodeId]) if (!parent.has(n)) parent.set(n, n);
  for (const r of roads) parent.set(find(r.fromNodeId), find(r.toNodeId));
  const groups = new Map<string, Any[]>();
  for (const r of roads) { const k = find(r.fromNodeId); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.values()].map((g) => ({ roads: g.length, lengthM: Math.round(g.reduce((s, r) => s + r.lengthM, 0) * 10) / 10, sample: g.slice(0, 3).map((r) => `${r.id.slice(0, 8)} ${r.name ?? ''}`.trim()) }))
    .sort((a, b) => b.lengthM - a.lengthM);
}

async function state(out: string, pairsFile?: string) {
  const roads = (await listAll('road', { geometry: 'full' })).map((r) => ({ ...r, lengthM: Math.round(len(r.coordinates ?? r.vertices ?? []) * 100) / 100 }));
  const nodes = await listAll('node');
  const places = await listAll('place');
  const validation = await mcp('validate_network', { limit: 200 });
  const walkable = roads.filter((r) => r.pedestrianAccess === 'allowed');
  const result: Any = {
    at: new Date().toISOString(), counts: { roads: roads.length, nodes: nodes.length, places: places.length, totalLengthM: Math.round(roads.reduce((s, r) => s + r.lengthM, 0) * 10) / 10 },
    validation: { total: validation.total, byCode: validation.byCode, bySeverity: validation.findings.reduce((m: Any, f: Any) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {}) },
    components: { all: components(roads), walkableOnly: components(walkable) },
    reachability: [], findings: validation.findings, roads, nodes, places,
  };
  if (pairsFile) {
    const pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf8'));
    for (const p of pairs.pairs) {
      const row: Any = { id: p.id, label: p.label };
      for (const [key, mode, assume] of [['walk', 'pedestrian', false], ['walkAssumeUnknown', 'pedestrian', true], ['vehicle', 'vehicle', false]] as const) {
        if (key === 'vehicle' && !p.vehicle) continue;
        try {
          const r = await mcp('check_reachability', { from: p.from, to: p.to, mode, assumeUnknownAllowed: assume, snapRadiusM: p.snapRadiusM ?? 3 });
          row[key] = r.reachable ? { reachable: true, lengthM: r.lengthM, roads: r.roads.length, viaArea: r.roads.some((x: Any) => String(x.roadId).startsWith('area:')), snap: [r.from.snapDistanceM, r.to.snapDistanceM] }
            : { reachable: false, closestReachedM: r.closestReached?.distanceM ?? null, snap: [r.from.snapDistanceM, r.to.snapDistanceM] };
        } catch (e) { row[key] = { error: String((e as Any).data?.text ?? (e as Error).message).slice(0, 200) }; }
      }
      result.reachability.push(row);
    }
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ counts: result.counts, validation: result.validation, components: { all: result.components.all.map((c: Any) => [c.roads, c.lengthM]), walkableOnly: result.components.walkableOnly.map((c: Any) => [c.roads, c.lengthM]) } }));
  for (const r of result.reachability) console.log(r.id, JSON.stringify(r.walk), '| assume', JSON.stringify(r.walkAssumeUnknown), r.vehicle ? '| veh ' + JSON.stringify(r.vehicle) : '');
}

async function apply(groupFile: string, out: string, commit: boolean) {
  const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  const ops = group.ops.map((o: Any) => ({ op: o.op, args: o.args }));
  const res = await mcp('apply_changes', { ops, dryRun: !commit });
  const results = res.results.map((r: Any, i: number) => ({ ref: group.ops[i].ref, ...r }));
  fs.writeFileSync(out, JSON.stringify({ group: group.id, comment: group.comment, committed: commit, at: new Date().toISOString(), batchId: res.batchId ?? null, results }, null, 1));
  for (const r of results) {
    console.log(r.ref, r.op, r.changeSetId ?? '', (r.roads ?? []).map((x: Any) => `${x.id.slice(0, 8)} ${x.lengthM}m s=${x.start.nodeId.slice(0, 8)}(${x.start.roadsAtNode}) e=${x.end.nodeId.slice(0, 8)}(${x.end.roadsAtNode})`).join(' ; '),
      r.crossings?.length ? `crossings=${JSON.stringify(r.crossings)}` : '', r.warnings?.length ? `WARN=${JSON.stringify(r.warnings)}` : '', r.nodeRefs?.length ? `nodeRefs=${JSON.stringify(r.nodeRefs.map((n: Any) => n.connected))}` : '', r.placeId ?? '', r.roadsConnected ?? '');
  }
  console.log(commit ? `COMMITTED batch ${res.batchId ?? '(single)'}` : 'DRY RUN, nothing saved');
}

async function main() {
  const argv = process.argv.slice(2), flags = argv.filter((a) => a.startsWith('--')), [cmd, a, b, c] = argv.filter((x) => !x.startsWith('--'));
  await login();
  if (cmd === 'state') await state(a, b);
  else if (cmd === 'apply') await apply(a, b, flags.includes('--commit'));
  else if (cmd === 'rest') console.log(JSON.stringify(await rest(a, b, c ? JSON.parse(c.startsWith('@') ? fs.readFileSync(c.slice(1), 'utf8') : c) : undefined), null, 1));
  else if (cmd === 'call') console.log(JSON.stringify(await mcp(a, b ? JSON.parse(b.startsWith('@') ? fs.readFileSync(b.slice(1), 'utf8') : b) : {}), null, 1));
  else throw new Error('Usage: n01.ts state|apply|call ...');
  void c;
}
main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; }).finally(() => pool.end());
