// T03: 지형을 바꿀 때 길 높이를 같이 옮기는 규칙(planRelevel)을 운영 스냅숏에서 평가한다. 오프라인. DB·서버 접근 없음.
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/t03/evaluate.ts <terrain-grid.f32> <terrain-grid-meta.json> <새 격자.f32> <roads-live-2.json> <nodes-live-2.json> <results.json>
import fs from 'node:fs';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { planRelevel, RELEVEL_DEFAULTS, type RelevelRoad, type RelevelNode, type RelevelPlan } from '../../../backend/src/geo/terrain-relevel.ts';

const [oldFile, metaFile, newFile, roadsFile, nodesFile, outFile] = process.argv.slice(2);
type XYZ = [number, number, number];
type Road = RelevelRoad & { name: string | null };
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = json(metaFile);
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const oldH = f32(oldFile), newH = f32(newFile);
const roads: Road[] = json(roadsFile).items, nodes: RelevelNode[] = json(nodesFile).items;
const r2 = (v: number) => Math.round(v * 100) / 100;
const short = (id: string) => id.slice(0, 8);
const byId = (list: Road[], id: string) => list.find((r) => r.id === id)!;
const outdoor = (r: Road) => r.levelId === null && r.buildingId === null && r.structure !== 'indoor_corridor' && r.structure !== 'elevator';
const delta = (p: XYZ) => bilinear(g, newH, p[0], p[1])! - bilinear(g, oldH, p[0], p[1])!;
const above = (h: Float32Array, p: XYZ) => p[2] - bilinear(g, h, p[0], p[1])!;
const maxGrade = (c: XYZ[]) => Math.max(...c.slice(1).map((p, i) => Math.abs(p[2] - c[i][2]) / Math.max(Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 1e-9)));
const results: any = { created: '2026-10-10', options: RELEVEL_DEFAULTS, roads: roads.length, nodes: nodes.length };

// ---- 0. 입력 확인 ----
results.input = {
  deletedRoadsPresent: roads.filter((r) => /^(6f2a4bcd|7408c108)/.test(r.id)).map((r) => r.id),
  maxDecimalsZ: Math.max(...roads.flatMap((r) => r.coordinates.map((p) => (String(p[2]).split('.')[1] ?? '').length))),
  endVertexMinusNodeMaxM: Math.max(...roads.flatMap((r) => [[r.fromNodeId, r.coordinates[0]], [r.toNodeId, r.coordinates.at(-1)!]] as [string, XYZ][])
    .map(([id, p]) => Math.max(...nodes.find((n) => n.id === id)!.coordinate.map((v, i) => Math.abs(v - p[i]))))),
};

// ---- 1. 바뀐 지형 위 실외 꼭짓점이 옛 지형에 얹혀 있었는가 (길 z - 옛 지형) ----
const touched = roads.filter(outdoor).flatMap((r) => r.coordinates.map((p, i) => ({ r, i, d: delta(p), a: above(oldH, p), end: i === 0 || i === r.coordinates.length - 1 })))
  .filter((v) => Math.abs(v.d) >= RELEVEL_DEFAULTS.minDeltaM);
const bins = [0.02, 0.05, 0.5, 1, 2, Infinity];
const hist = (v: typeof touched) => Object.fromEntries(bins.map((b, k) => [`${k ? `>${bins[k - 1]} ` : ''}<=${b}`, v.filter((x) => Math.abs(x.a) <= b && (k === 0 || Math.abs(x.a) > bins[k - 1])).length]));
const touchedIds = [...new Set(touched.map((v) => v.r.id))];
results.onOldTerrain = { outdoorVerticesOnChangedTerrain: touched.length, outdoorRoadsTouched: touchedIds.length,
  absRoadMinusOldTerrainM: { all: hist(touched), interior: hist(touched.filter((v) => !v.end)), ends: hist(touched.filter((v) => v.end)) } };

// ---- 2. 규칙 비교: 그대로 / 채택(얹힌 길의 안쪽 꼭짓점만 +Δ) / 전부 +Δ ----
const plan = planRelevel(g, oldH, newH, roads, nodes);
const apply = (list: Road[], p: RelevelPlan): Road[] => list.map((r) => ({ ...r, coordinates: p.roads.find((x) => x.id === r.id)?.coordinates ?? r.coordinates }));
const proposed = apply(roads, plan);
const naive = roads.map((r) => (outdoor(r) ? { ...r, coordinates: r.coordinates.map((p): XYZ => [p[0], p[1], p[2] + delta(p)]) } : r));
const fit = (list: Road[], h: Float32Array) => {
  const v = touched.map((t) => above(h, byId(list, t.r.id).coordinates[t.i]));
  return { within05: v.filter((a) => Math.abs(a) <= 0.5).length, below2: v.filter((a) => a < -2).length, lowestM: r2(Math.min(...v)), highestM: r2(Math.max(...v)) };
};
const grades = (list: Road[]) => touchedIds.map((id) => maxGrade(byId(list, id).coordinates));
const base = grades(roads);
const gradeRow = (list: Road[]) => ({ worstGrade: r2(Math.max(...grades(list))), roadsSteeper: grades(list).filter((v, i) => v > base[i] + 0.01).length,
  roadsOver30pct: grades(list).filter((v) => v > 0.3).length });
results.rules = {
  beforeOnOldTerrain: { ...fit(roads, oldH), ...gradeRow(roads) },
  terrainOnly: { ...fit(roads, newH), ...gradeRow(roads) },
  proposed: { ...fit(proposed, newH), ...gradeRow(proposed), roadsChanged: plan.roads.length, verticesChanged: plan.roads.reduce((s, r) => s + r.vertices.length, 0), nodesMoved: plan.nodes.length },
  allOutdoorPlusDelta: { ...fit(naive, newH), ...gradeRow(naive) },
};
// 전부 +Δ가 망가뜨리는 것: 계단 높이차, 평탄하게 그린 길, 실내 길과 같이 쓰는 노드의 틈
const rise = (c: XYZ[]) => c.at(-1)![2] - c[0][2];
const span = (c: XYZ[]) => Math.max(...c.map((p) => p[2])) - Math.min(...c.map((p) => p[2]));
results.allOutdoorPlusDeltaDamage = {
  stairs: roads.filter((r) => outdoor(r) && r.structure === 'stairs' && touchedIds.includes(r.id)).map((r) => ({ id: short(r.id), name: r.name, riseBeforeM: r2(rise(r.coordinates)), riseAfterM: r2(rise(byId(naive, r.id).coordinates)) })),
  flatRoads: roads.filter((r) => touchedIds.includes(r.id) && r.structure !== 'stairs' && span(r.coordinates) < 0.005)
    .map((r) => ({ id: short(r.id), name: r.name, zBefore: r.coordinates[0][2], zSpanAfterM: r2(span(byId(naive, r.id).coordinates)) })),
  nodesSharedWithIndoor: nodes.map((n) => ({ n, users: roads.filter((r) => r.fromNodeId === n.id || r.toNodeId === n.id) }))
    .filter(({ n, users }) => Math.abs(delta(n.coordinate)) >= RELEVEL_DEFAULTS.minDeltaM && users.some(outdoor) && users.some((r) => !outdoor(r)))
    .map(({ n, users }) => ({ node: short(n.id), z: n.coordinate[2], gapIfOnlyOutdoorEndMovesM: r2(delta(n.coordinate)), outdoor: users.filter(outdoor).map((r) => short(r.id)), indoor: users.filter((r) => !outdoor(r)).map((r) => `${short(r.id)} ${r.structure}`) })),
};

// ---- 3. 채택 규칙의 결과 목록 ----
const pair = (v: [number, number]) => v.map(r2);
results.plan = {
  roads: plan.roads.map((r) => { const b = byId(roads, r.id); const shift = r.vertices.map((v) => v.toZ - v.fromZ); return { id: short(r.id), name: b.name, vertices: b.coordinates.length, changed: r.vertices.length,
    shiftM: pair([Math.min(...shift), Math.max(...shift)]), maxGradeBefore: r2(maxGrade(b.coordinates)), maxGradeAfter: r2(maxGrade(r.coordinates)) }; }),
  nodes: plan.nodes.map((n) => ({ id: short(n.id), fromZ: n.fromZ, toZ: n.coordinate[2] })),
  // 노드는 그대로 두므로 틈은 없다. 얹힌 길의 끝 구간 경사만 달라진다.
  refusedNodes: plan.refusedNodes.map((n) => ({ node: short(n.id), reason: n.reason, deltaM: r2(n.deltaM), aboveTerrainBeforeM: r2(n.aboveBeforeM), aboveTerrainAfterM: r2(n.aboveAfterM), gapM: 0,
    ends: n.drapedRoadIds.map((id) => { const b = byId(roads, id), a = byId(proposed, id);
      const seg = (c: XYZ[]) => (b.fromNodeId === n.id ? [c[0], c[1]] : [c.at(-1)!, c.at(-2)!]);
      const run = Math.hypot(seg(b.coordinates)[1][0] - seg(b.coordinates)[0][0], seg(b.coordinates)[1][1] - seg(b.coordinates)[0][1]);
      return { road: short(id), endSegmentM: r2(run), stepBeforeM: r2(seg(b.coordinates)[1][2] - seg(b.coordinates)[0][2]), stepAfterM: r2(seg(a.coordinates)[1][2] - seg(a.coordinates)[0][2]) }; }),
    otherRoads: n.otherRoadIds.map((id) => `${short(id)} ${byId(roads, id).structure}${outdoor(byId(roads, id)) ? '' : ' (실내)'}`) })),
  refusedOutdoorRoads: plan.refusedRoads.filter((r) => r.reason === 'own-heights').map((r) => ({ id: short(r.id), name: byId(roads, r.id).name, structure: byId(roads, r.id).structure,
    vertices: r.vertices, deltaM: pair(r.deltaM), aboveOldTerrainM: pair(r.aboveBeforeM), aboveNewTerrainM: pair(r.aboveAfterM) })),
  refusedOutdoorVertices: plan.refusedRoads.filter((r) => r.reason === 'own-heights').reduce((s, r) => s + r.vertices, 0),
  refusedIndoorRoads: plan.refusedRoads.filter((r) => r.reason === 'indoor').length,
};

// ---- 4. 되돌리기: 격자를 바꿔 다시 돌리면 원래 값이 그대로 나오는가 ----
const nodesAfter = nodes.map((n) => plan.nodes.find((x) => x.id === n.id) ?? n);
const back = planRelevel(g, newH, oldH, proposed, nodesAfter);
const restored = apply(proposed, back);
const diffs = roads.flatMap((r, k) => r.coordinates.map((p, i) => Math.abs(p[2] - restored[k].coordinates[i][2])));
// 저장 자릿수가 다를 때: 옮겨지는 꼭짓점의 z를 소수 n자리 임의 값으로 바꿔 왕복
const roundTrip = (decimals: number) => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worst = 0, n = 0;
  for (let rep = 0; rep < 200; rep++) for (const r of plan.roads) for (const v of r.vertices) {
    const d = delta(byId(roads, r.id).coordinates[v.index]);
    const z = Number((v.fromZ + (rnd() - 0.5) * 0.08).toFixed(decimals));
    const there = Math.round((z + d) * 1e6) / 1e6, home = Math.round((there - d) * 1e6) / 1e6;
    worst = Math.max(worst, Math.abs(home - z)); n++;
  }
  return { decimals, cases: n, worstM: worst };
};
results.reverse = { roadsRestored: back.roads.length, verticesRestored: back.roads.reduce((s, r) => s + r.vertices.length, 0), nodesRestored: back.nodes.length,
  maxAbsDifferenceM: Math.max(...diffs), verticesNotRestoredExactly: diffs.filter((d) => d !== 0).length, storedDecimals: [2, 3, 6, 9].map(roundTrip) };

fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
