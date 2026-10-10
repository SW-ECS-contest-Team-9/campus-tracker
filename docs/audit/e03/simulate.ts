// E03 — 길 사슬 10개를 운영 스냅숏 길망에 대조하고, 근거 A(자료만으로 성립) 편집을 복사본에 모의 적용한다.
// 읽기 전용: DB·MCP 호출 없음. 검증은 편집기의 validateNetwork 를 그대로 불러 쓴다(지형 없이 호출 → OFF_TERRAIN 은 실행되지 않음).
//   npx tsx docs/audit/e03/simulate.ts <audit-dir> <out-dir>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateNetwork, type Finding } from '../../../backend/src/modules/editor-mcp/network-validate.js';
// editor.service.ts 는 불러오면 서버 설정(JWT_SECRET 등)을 요구하므로 상수 네 개만 옮겨 적었다(editor.service.ts 11·12·22·23행).
const LEVEL_TOLERANCE_M = 1.25, JUNCTION_ENDPOINT_M = 0.15, CONNECTOR_Z_M = 0.3;
const isConnector = (structure: string) => ['stairs', 'elevator'].includes(structure);

const [audit, outDir] = process.argv.slice(2);
const live = `${audit}/claude-live`;
const raw = (p: string) => readFileSync(p);
const sha = (p: string) => createHash('sha256').update(raw(p)).digest('hex');
const json = (p: string) => JSON.parse(raw(p).toString('utf8'));
type Road = { id: string; name: string | null; structure: string; levelId: string | null; status: string; revision: number; fromNodeId: string; toNodeId: string; coordinates: [number, number, number][]; [k: string]: any };
type Node = { id: string; levelId: string | null; coordinate: [number, number, number]; [k: string]: any };
const roads: Road[] = json(`${live}/roads-live-2.json`).items;
const nodes: Node[] = json(`${live}/nodes-live-2.json`).items;
const cand = json(`${audit}/claude-user-20261010/길사슬/path-graph-candidate-v3.json`);
const g1 = new Set<string>(json('docs/audit/t03/followup.json').ownHeightGroups.find((g: any) => g.group === 'G1').roads.map((r: any) => r.id));
const DELETED = ['6f2a4bcd', '7408c108'];
if (roads.some((r) => DELETED.some((d) => r.id.startsWith(d)))) throw new Error('삭제된 길이 스냅숏에 있음');
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const s8 = (id: string) => id.slice(0, 8);
const QA = { levelToleranceM: LEVEL_TOLERANCE_M, duplicateNodeM: JUNCTION_ENDPOINT_M };
const count = (f: Finding[]) => f.reduce((m, x) => ({ ...m, [`${x.code}/${x.severity}`]: (m[`${x.code}/${x.severity}`] ?? 0) + 1 }), {} as Record<string, number>);
const on = (n: string, rs: Road[]) => rs.filter((r) => r.fromNodeId === n || r.toNodeId === n);

// ---- 길망 요약 (전후 비교용)
function summary(rs: Road[], ns: Node[]) {
  const ids = new Set(ns.map((n) => n.id)), parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const r of rs) for (const n of [r.fromNodeId, r.toNodeId]) if (!parent.has(n)) parent.set(n, n);
  for (const r of rs) parent.set(find(r.fromNodeId), find(r.toNodeId));
  const comp = new Map<string, number>();
  for (const r of rs) comp.set(find(r.fromNodeId), (comp.get(find(r.fromNodeId)) ?? 0) + 1);
  const pairs = new Map<string, string[]>();
  for (const r of rs) { const k = [r.fromNodeId, r.toNodeId].sort().join('|'); pairs.set(k, [...(pairs.get(k) ?? []), s8(r.id)]); }
  const endOff = rs.flatMap((r) => ([[r.fromNodeId, r.coordinates[0]], [r.toNodeId, r.coordinates.at(-1)!]] as const).map(([n, c]) => {
    const nc = ns.find((x) => x.id === n)?.coordinate; return nc ? Math.max(Math.hypot(nc[0] - c[0], nc[1] - c[1]), Math.abs(nc[2] - c[2])) : 0; }));
  return { roads: rs.length, nodeRows: ns.length, nodesUsed: parent.size, nodesUnused: ns.filter((n) => !parent.has(n.id)).map((n) => s8(n.id)),
    componentsByRoadCount: [...comp.values()].sort((a, b) => b - a), selfLoops: rs.filter((r) => r.fromNodeId === r.toNodeId).map((r) => s8(r.id)),
    duplicateEdges: [...pairs.values()].filter((v) => v.length > 1), danglingRefs: rs.filter((r) => !ids.has(r.fromNodeId) || !ids.has(r.toNodeId)).map((r) => s8(r.id)),
    degree1Nodes: [...parent.keys()].filter((n) => on(n, rs).length === 1).length,
    maxRoadEndOffNodeM: r3(Math.max(...endOff)), validator: count(validateNetwork(rs as any, ns as any, undefined, QA)) };
}

// ---- 근거 A 편집: 검증기가 merge_nodes 를 권하는 쌍 중 mergeNodes(editor.ops.ts)의 사전조건을 모두 통과하는 것만
const findingsBefore = validateNetwork(roads as any, nodes as any, undefined, QA);
const merges = findingsBefore.filter((f) => f.code === 'LEVEL_NODES_NOT_JOINED' || f.code === 'DUPLICATE_NODES').map((f, i) => {
  const [a, b] = f.nodeIds!.map((id) => nodes.find((n) => n.id === id)!);
  const [keep, remove] = on(a.id, roads).length >= on(b.id, roads).length ? [a, b] : [b, a]; // 길이 더 많이 붙은 쪽을 남긴다
  const dxy = Math.hypot(keep.coordinate[0] - remove.coordinate[0], keep.coordinate[1] - remove.coordinate[1]), dz = Math.abs(keep.coordinate[2] - remove.coordinate[2]);
  const touching = [...on(keep.id, roads), ...on(remove.id, roads)], moving = on(remove.id, roads);
  const pre = { withinTolerance: dxy <= 0.15 && dz <= CONNECTOR_Z_M, levelRule: keep.levelId === remove.levelId || touching.some((r) => isConnector(r.structure)),
    noCollapse: !moving.some((r) => r.fromNodeId === keep.id || r.toNodeId === keep.id), allDraft: moving.every((r) => r.status === 'DRAFT') };
  return { id: `E03-A${i + 1}`, op: 'merge_nodes', args: { keepNodeId: keep.id, removeNodeId: remove.id }, validatorCode: f.code, validatorSuggestion: f.suggestion,
    dxyM: r3(dxy), dzM: r3(dz), editorPreconditions: pre, gradeA: Object.values(pre).every(Boolean),
    expect: { keepNode: { id: keep.id, levelId: keep.levelId, coordinate: keep.coordinate, roads: on(keep.id, roads).map((r) => r.id).sort() },
      removeNode: { id: remove.id, levelId: remove.levelId, coordinate: remove.coordinate, roads: on(remove.id, roads).map((r) => ({ id: r.id, name: r.name, structure: r.structure, levelId: r.levelId, status: r.status, end: r.fromNodeId === remove.id ? 'start' : 'end' })) } } };
});
const gradeA = merges.filter((m) => m.gradeA);

function applyMerges(rs: Road[]) { // mergeNodes 와 같은 동작: 노드 id 교체 + 그 끝 좌표를 남는 노드 좌표로, 개정 +1
  const out: Road[] = structuredClone(rs);
  for (const m of gradeA) {
    const keep = nodes.find((n) => n.id === m.args.keepNodeId)!;
    for (const r of out) {
      if (r.fromNodeId !== m.args.removeNodeId && r.toNodeId !== m.args.removeNodeId) continue;
      if (r.fromNodeId === m.args.removeNodeId) { r.fromNodeId = keep.id; r.coordinates[0] = [...keep.coordinate]; }
      if (r.toNodeId === m.args.removeNodeId) { r.toNodeId = keep.id; r.coordinates[r.coordinates.length - 1] = [...keep.coordinate]; }
      r.revision++;
    }
  }
  return out;
}
const after = applyMerges(roads);
let maxMove = 0; const revised: Record<string, number[]> = {};
roads.forEach((r, i) => { r.coordinates.forEach((c, k) => { maxMove = Math.max(maxMove, Math.hypot(c[0] - after[i].coordinates[k][0], c[1] - after[i].coordinates[k][1]), Math.abs(c[2] - after[i].coordinates[k][2])); });
  if (after[i].revision !== r.revision) revised[r.id] = [r.revision, after[i].revision]; });

// ---- 사슬
const real = (p: string) => nodes.find((n) => n.id.startsWith(p))?.id ?? null;
const realRoad = (p: string, rs: Road[]) => rs.find((r) => r.id.startsWith(p)) ?? null;
function route(rs: Road[], from: string, to: string): Road[] | null { // 길 수가 가장 적은 경로
  const prev = new Map<string, Road | null>([[from, null]]); const q = [from];
  while (q.length) { const n = q.shift()!; if (n === to) break;
    for (const r of on(n, rs)) { const m = r.fromNodeId === n ? r.toNodeId : r.fromNodeId; if (!prev.has(m)) { prev.set(m, r); q.push(m); } } }
  if (!prev.has(to)) return null;
  const path: Road[] = []; for (let n = to; prev.get(n); ) { const r = prev.get(n)!; path.unshift(r); n = r.fromNodeId === n ? r.toNodeId : r.fromNodeId; }
  return path;
}
function joints(path: Road[], start: string, rs: Road[]) { // 편집기 규칙으로 본 이음매: 끝이 노드 위에 있는가, 높이 단, 층 규칙
  const issues: any[] = []; let n = start;
  for (let i = 0; i < path.length; i++) {
    const r = path[i], next = r.fromNodeId === n ? r.toNodeId : r.fromNodeId, b = path[i + 1];
    if (b) {
      const nc = nodes.find((x) => x.id === next)!.coordinate;
      const endOf = (x: Road) => (x.fromNodeId === next ? x.coordinates[0] : x.coordinates.at(-1)!);
      const off = Math.max(...[r, b].map((x) => Math.max(Math.hypot(endOf(x)[0] - nc[0], endOf(x)[1] - nc[1]), Math.abs(endOf(x)[2] - nc[2]))));
      const step = Math.abs(endOf(r)[2] - endOf(b)[2]);
      if (off > 0.02) issues.push({ kind: '끝이 노드 위에 없음', node: s8(next), offM: r3(off) });
      if (step > CONNECTOR_Z_M) issues.push({ kind: '높이 단', node: s8(next), stepM: r3(step) });
      if (r.levelId !== b.levelId && !isConnector(r.structure) && !isConnector(b.structure) && !on(next, rs).some((x) => isConnector(x.structure)))
        issues.push({ kind: '층 표기가 다른 길이 계단·승강기 없이 한 노드', node: s8(next), levels: [r.levelId, b.levelId] });
    }
    n = next;
  }
  return issues;
}
function chainReport(rs: Road[], findings: Finding[]) {
  return cand.chains.map((ch: any) => {
    const legs = ch.legs.map((leg: any) => {
      const a = real(leg.from), b = real(leg.to);
      // 양 끝이 운영 노드인 구간만 운영 길망에서 다시 찾는다(후보 그래프의 경로는 쓰지 않는다). 후보 노드가 낀 구간은 운영에 없다
      const operational = !!a && !!b;
      const path = operational ? route(rs, a!, b!) : null;
      return { from: leg.from, to: leg.to, operational, joined: !!path,
        roads: (path ?? []).map((r) => ({ id: r.id, name: r.name, structure: r.structure, levelId: r.levelId, status: r.status, revision: r.revision, z: [r.coordinates[0][2], r.coordinates.at(-1)![2]], g1: g1.has(s8(r.id)) })),
        nodes: path ? [...new Set(path.flatMap((r) => [r.fromNodeId, r.toNodeId]))] : [a, b].filter(Boolean),
        jointIssues: path ? joints(path, a!, rs) : [],
        candidateOnly: operational ? [] : [...new Set((leg.roads as string[]).filter((id) => !realRoad(id, rs)))],
        realRoadsInCandidateLeg: operational ? [] : [...new Set((leg.roads as string[]).filter((id) => realRoad(id, rs)).map((id) => realRoad(id, rs)!.id))] };
    });
    const used = new Set<string>(legs.flatMap((l: any) => [...l.roads.map((r: any) => r.id), ...l.realRoadsInCandidateLeg]));
    const hit = findings.filter((f) => f.code !== 'ISOLATED_COMPONENT' && f.roadIds.some((id) => used.has(id)));
    const ends = [real(ch.waypoints[0]), real(ch.waypoints.at(-1))];
    return { chain: ch.chain, candidateGraphFound: ch.found, joinedInOperationalGraph: legs.every((l: any) => l.operational && l.joined),
      endpointsOperationallyReachable: ends[0] && ends[1] ? !!route(rs, ends[0], ends[1]) : null, legs,
      g1Roads: [...used].filter((id) => g1.has(s8(id))).map(s8), validatorOnChainRoads: count(hit),
      validatorWarningsOrErrors: hit.filter((f) => f.severity !== 'info').map((f) => ({ code: f.code, nodeIds: f.nodeIds, location: f.location, suggestion: f.suggestion })) };
  });
}
const chainsBefore = chainReport(roads, findingsBefore), findingsAfter = validateNetwork(after as any, nodes as any, undefined, QA), chainsAfter = chainReport(after, findingsAfter);
const mergeRoads = new Set(gradeA.flatMap((m) => [...m.expect.keepNode.roads, ...m.expect.removeNode.roads.map((r) => r.id)]));
const strip = (r: Road) => JSON.stringify({ ...r, fromNodeId: 0, toNodeId: 0, coordinates: 0, revision: 0 });

const result = {
  created: '2026-10-10', applied: false, note: '모의 실행만. 운영 DB·MCP 쓰기 없음',
  snapshot: { time: raw(`${live}/snapshot2-time.txt`).toString().trim(), roadsSha256: sha(`${live}/roads-live-2.json`), nodesSha256: sha(`${live}/nodes-live-2.json`),
    latestChangeId: json(`${live}/changes-2.json`).latestId, deletedAbsent: DELETED, coordinatePrecisionM: 0.01 },
  rules: { source: 'backend/src/modules/editor-mcp/network-validate.ts (그대로 import), editor.ops.ts mergeNodes 사전조건(이 스크립트에 복제)', LEVEL_TOLERANCE_M, JUNCTION_ENDPOINT_M, CONNECTOR_Z_M, offTerrainCheck: '미실행(지형 격자 없이 호출)' },
  mergeCandidates: merges,
  simulation: { before: summary(roads, nodes), after: summary(after, nodes), maxVertexMoveM: maxMove, roadRevisions: revised,
    attributesChanged: roads.filter((r, i) => strip(r) !== strip(after[i])).length },
  chains: chainsBefore.map((c: any, i: number) => ({ ...c, joinedAfterGradeA: chainsAfter[i].joinedInOperationalGraph, endpointsReachableAfterGradeA: chainsAfter[i].endpointsOperationallyReachable,
    usesMergedRoads: c.legs.some((l: any) => [...l.roads.map((r: any) => r.id), ...l.realRoadsInCandidateLeg].some((id: string) => mergeRoads.has(id))) })),
};
writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 1));

// ---- 적용 계획 (실행하지 않음). merge_nodes 에는 expectedRevision 인자가 없으므로 사전 상태는 읽기 도구로 먼저 확인한다.
const plan = {
  title: 'E03 근거 A 편집 적용 계획', applied: false, requiresUserApproval: true,
  basedOn: result.snapshot,
  preconditions: [
    { tool: 'get_changes', args: { sinceId: result.snapshot.latestChangeId }, expect: 'changeSets 가 비어 있음. 비어 있지 않으면 중단하고 스냅숏부터 다시 뜬다' },
    { tool: 'validate_network', args: { checks: ['LEVEL_NODES_NOT_JOINED', 'DUPLICATE_NODES'], limit: 200 }, expect: `LEVEL_NODES_NOT_JOINED ${merges.length}건, DUPLICATE_NODES 0건, nodeIds 가 operations 의 쌍과 같음` },
    { tool: 'get_feature', args: { type: 'node', id: '<각 keepNodeId·removeNodeId>' }, expect: 'levelId·coordinate(0.01 m)·roads 가 operations[].expect 와 같음' },
    { tool: 'get_feature', args: { type: 'road', id: '<expectRoadRevisions 의 각 길>' }, expect: 'status DRAFT, revision 이 before 값, lockedBy null' },
  ],
  expectRoadRevisions: Object.fromEntries(Object.entries(revised).map(([id, [b, a]]) => [id, { before: b, afterAll: a }])),
  operations: gradeA.map(({ id, op, args, validatorCode, dxyM, dzM, expect }) => ({ id, op, args, validatorCode, dxyM, dzM, expect })),
  apply: { step1: { tool: 'apply_changes', args: { ops: gradeA.map((m) => ({ op: m.op, args: m.args })), dryRun: true }, expect: '오류 없음. 각 결과의 at 이 keepNode.coordinate 와 같음' },
    step2: '사용자 승인 뒤 같은 인자로 dryRun:false. 한 트랜잭션이고 연산마다 changeSet 이 하나씩 생긴다. 결과의 changeSetId 를 순서대로 기록한다',
    step3: { tool: 'validate_network', expect: 'LEVEL_NODES_NOT_JOINED 0건. 다른 코드 건수는 result.json simulation.after.validator 와 같음(OFF_TERRAIN 은 모의에서 미실행이라 제외)' } },
  rollback: { tool: 'revert_changeset', order: 'step2 에서 받은 changeSetId 를 역순으로 하나씩', note: '그 길이 뒤에 다시 바뀌었으면 거부된다. 병합으로 길이 떨어진 노드 행은 지워지지 않으므로 되돌리면 원래 노드에 다시 붙는다' },
  doNotTouch: DELETED.map((d) => `${d}… (사용자 삭제, 복원·사용 금지)`),
};
writeFileSync(`${outDir}/apply-plan.json`, JSON.stringify(plan, null, 1));

console.log('A 편집', gradeA.length, '/', merges.length, gradeA.map((m) => `${s8(m.args.removeNodeId)}→${s8(m.args.keepNodeId)} dxy ${m.dxyM} dz ${m.dzM}`));
console.log('전', JSON.stringify(result.simulation.before)); console.log('후', JSON.stringify(result.simulation.after));
console.log('꼭짓점 최대 이동', maxMove, '속성 변화', result.simulation.attributesChanged, '개정', JSON.stringify(revised));
for (const c of result.chains) console.log(c.chain.slice(0, 2), '운영 연결 전/후', c.joinedInOperationalGraph, c.joinedAfterGradeA, '| 양끝 도달 전/후', c.endpointsOperationallyReachable, c.endpointsReachableAfterGradeA, '| 병합 길 사용', c.usesMergedRoads, '| G1', c.g1Roads.join(','), '| 검증', JSON.stringify(c.validatorOnChainRoads),
  '\n   ', c.legs.map((l: any) => `${l.from.slice(0, 8)}→${l.to.slice(0, 8)} ${l.operational ? (l.joined ? `O(${l.roads.map((r: any) => `${s8(r.id)}:${r.structure}:${r.levelId ? 'L' : '-'}:${r.z.join('~')}`).join(' ')})` : 'X') : `후보(${l.candidateOnly.join(',')}; 실재 ${l.realRoadsInCandidateLeg.map(s8).join(',')})`} ${JSON.stringify(l.jointIssues)}`).join('\n    '));
