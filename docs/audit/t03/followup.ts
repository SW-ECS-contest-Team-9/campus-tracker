// T03 후속: (A) 구역별·조합별 지형 후보마다 길·건물이 어떻게 달라지는가, (B) 자체 높이 길 묶음을 통째로 옮기면 맞는가. 오프라인. DB·서버 접근 없음.
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/t03/followup.ts <3d-map-audit-20261009 폴더> <backend/data/terrain/samples/smap_samples_5186.json> <followup.json>
import fs from 'node:fs';
import path from 'node:path';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { applyLocalSamples, parseLocalSamples } from '../../../backend/src/geo/terrain-local-samples.ts';
import { planRelevel, RELEVEL_DEFAULTS, type RelevelRoad, type RelevelNode } from '../../../backend/src/geo/terrain-relevel.ts';

const [audit, samplesFile, outFile] = process.argv.slice(2);
type XYZ = [number, number, number];
type Road = RelevelRoad & { name: string | null };
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = json(path.join(audit, 'terrain-grid-meta.json'));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const oldH = f32(path.join(audit, 'terrain-grid.f32')), t01 = f32(path.join(audit, 't01/dem-T01.f32'));
const roads: Road[] = json(path.join(audit, 'claude-live/roads-live-2.json')).items.filter((r: Road) => !/^(6f2a4bcd|7408c108)/.test(r.id));
const nodes: RelevelNode[] = json(path.join(audit, 'claude-live/nodes-live-2.json')).items;
const input = json(samplesFile);
const r2 = (v: number) => Math.round(v * 100) / 100;
const short = (id: string) => id.slice(0, 8);
const outdoor = (r: Road) => r.levelId === null && r.buildingId === null && r.structure !== 'indoor_corridor' && r.structure !== 'elevator';
const at = (h: Float32Array, p: number[]) => bilinear(g, h, p[0], p[1])!;
const MIN = RELEVEL_DEFAULTS.minDeltaM;
const results: any = { created: '2026-10-10', truthProxy: 'dem-T01.f32 (세 구역 모두 보정한 격자, S-MAP 표본 기반. 독립 측량 아님)' };

// ---------- A. 구역별·조합별 후보 ----------
const AREAS = ['field', 'corridor', 's06'];
const combos = [1, 2, 4, 3, 5, 6, 7].map((m) => AREAS.filter((_, i) => m & (1 << i)));
const allSamples = parseLocalSamples(input).samples;
const nearestSample = (p: number[]) => Math.min(...allSamples.map((s) => Math.hypot(s.x - p[0], s.y - p[1])));
const scene = new Map<string, any>(json(path.join(audit, 'claude-live/scene-live.json')).buildings.map((b: any) => [b.name, b]));
const inner = new Map<string, any>(json(path.join(audit, 'claude-live/buildings.json')).buildings.map((b: any) => [b.buildingId, b]));
const outlines: { name: string; pts: number[][]; heightM: number }[] = json(path.join(audit, 'building-outlines-5186.json')).flatMap((o: any) => {
  const sc = scene.get(o.name); if (!sc) return [];
  const pts: number[][] = [];
  for (const poly of o.coordinates) { const ring = poly[0]; for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
    for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  } }
  const p = inner.get(sc.buildingId); pts.push([p.x, p.y]);
  return [{ name: o.name, pts, heightM: sc.heightM }];
});
// scene-heights.ts 규칙(T01 impact.py와 같음): 바닥 = 최저 - 1, 지붕 = max(중앙 + 높이, 최고 + 3)
const block = (h: Float32Array, b: { pts: number[][]; heightM: number }) => {
  const s = b.pts.map((p) => at(h, p)).sort((x, y) => x - y), n = s.length, med = n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return [s[0] - 1, Math.max(med + b.heightM, s[n - 1] + 3)];
};
const count = (v: number[]) => ({ below05: v.filter((a) => a < -0.5).length, below2: v.filter((a) => a < -2).length, above05: v.filter((a) => a > 0.5).length, above2: v.filter((a) => a > 2).length,
  lowestM: v.length ? r2(Math.min(...v)) : null, highestM: v.length ? r2(Math.max(...v)) : null });

results.candidates = combos.map((areas) => {
  const cand = applyLocalSamples(g, oldH, parseLocalSamples(input, areas).samples).heights;
  let changedCells = 0, maxDiffT01 = 0;
  for (let i = 0; i < cand.length; i++) { if (cand[i] !== oldH[i]) changedCells++; maxDiffT01 = Math.max(maxDiffT01, Math.abs(cand[i] - t01[i])); }
  const plan = planRelevel(g, oldH, cand, roads, nodes);
  const after = new Map(roads.map((r) => [r.id, plan.roads.find((p) => p.id === r.id)?.coordinates ?? r.coordinates]));
  const rows = roads.filter(outdoor).flatMap((r) => r.coordinates.map((p, i) => ({ r, i, p, q: after.get(r.id)![i] })))
    .filter((v) => Math.abs(at(cand, v.p) - at(oldH, v.p)) >= MIN)
    .map((v) => ({ ...v, shownBefore: v.p[2] - at(oldH, v.p), shownAfter: v.q[2] - at(cand, v.q), trueBefore: v.p[2] - at(t01, v.p), trueAfter: v.q[2] - at(t01, v.q), sampleM: nearestSample(v.p) }));
  // 판정: (1) 참값 대비 오차가 커진 꼭짓점(실제로 나빠짐), (2) 지금은 지형 ±0.5 m 안으로 보이는데 전환 뒤 벗어나 보이는 꼭짓점(있던 오차가 드러남),
  // (3) 그중 후보 지형이 참값 격자와 0.5 m 넘게 다른 자리(지형 후보 탓), (4) 표본에서 6 m 넘게 떨어진 줄임 구간에 있는 것(지형 자체가 미검증)
  const exposed = rows.filter((v) => Math.abs(v.shownBefore) <= 0.5 && Math.abs(v.shownAfter) > 0.5);
  const perRoad = [...new Set(rows.map((v) => v.r.id))].map((id) => { const v = rows.filter((x) => x.r.id === id), r = v[0].r; return {
    id: short(id), name: r.name, structure: r.structure, moved: plan.roads.some((p) => p.id === id), vertices: v.length,
    shownBeforeM: [r2(Math.min(...v.map((x) => x.shownBefore))), r2(Math.max(...v.map((x) => x.shownBefore)))],
    shownAfterM: [r2(Math.min(...v.map((x) => x.shownAfter))), r2(Math.max(...v.map((x) => x.shownAfter)))],
    trueErrorBeforeM: [r2(Math.min(...v.map((x) => x.trueBefore))), r2(Math.max(...v.map((x) => x.trueBefore)))],
    trueErrorAfterM: [r2(Math.min(...v.map((x) => x.trueAfter))), r2(Math.max(...v.map((x) => x.trueAfter)))],
    newlyOff05: v.filter((x) => exposed.includes(x)).length, maxSampleDistanceM: r2(Math.max(...v.map((x) => x.sampleM))) }; });
  const buildings = outlines.map((b) => { const [b0, t0] = block(oldH, b), [b1, t1] = block(cand, b); return { building: b.name, baseShiftM: r2(b1 - b0), roofShiftM: r2(t1 - t0) }; })
    .filter((b) => Math.abs(b.baseShiftM) > 0.3 || Math.abs(b.roofShiftM) > 0.3);
  const indoorVertices = roads.filter((r) => !outdoor(r)).flatMap((r) => r.coordinates).filter((p) => Math.abs(at(cand, p) - at(oldH, p)) >= MIN).length;
  return { areas: areas.join('+'), changedCells, maxDiffFromT01M: r2(maxDiffT01), outdoorVertices: rows.length, outdoorRoads: perRoad.length, indoorVertices,
    relevel: { roads: plan.roads.length, vertices: plan.roads.reduce((s, r) => s + r.vertices.length, 0), keptNodes: plan.refusedNodes.length },
    shownBefore: count(rows.map((v) => v.shownBefore)), shownAfter: count(rows.map((v) => v.shownAfter)),
    trueErrorBefore: count(rows.map((v) => v.trueBefore)), trueErrorAfter: count(rows.map((v) => v.trueAfter)),
    trueErrorGrew: rows.filter((v) => Math.abs(v.trueAfter) > Math.abs(v.trueBefore) + 0.05).length,
    newlyOff05: exposed.length, newlyOff05WhereCandidateDiffersFromT01: exposed.filter((v) => Math.abs(at(cand, v.p) - at(t01, v.p)) > 0.5).length,
    newlyOff05InFadeZone: exposed.filter((v) => v.sampleM > 6).length,
    roads: perRoad, buildingsOver03: buildings };
});

// ---------- B. 자체 높이 길 묶음과 통째 이동 ----------
const full = planRelevel(g, oldH, t01, roads, nodes);
const drapedIds = new Set(roads.filter((r) => outdoor(r) && (r.coordinates.length > 2 ? r.coordinates.slice(1, -1) : r.coordinates).every((p) => Math.abs(p[2] - at(oldH, p)) <= RELEVEL_DEFAULTS.onTerrainM)).map((r) => r.id));
const delta = (p: number[]) => at(t01, p) - at(oldH, p);
const component = (list: Road[]) => { // 노드를 같이 쓰는 길끼리 묶음
  const parent = new Map<string, string>(); const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const r of list) for (const n of [r.fromNodeId, r.toNodeId]) if (!parent.has(n)) parent.set(n, n);
  for (const r of list) parent.set(find(r.fromNodeId), find(r.toNodeId));
  const groups = new Map<string, Road[]>(); for (const r of list) { const k = find(r.fromNodeId); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.values()];
};
const touches = (r: Road) => r.coordinates.some((p) => Math.abs(delta(p)) >= MIN);
results.network = { components: component(roads).map((c) => ({ roads: c.length, outdoor: c.filter(outdoor).length, touchesChangedTerrain: c.some(touches) })) };
const own = roads.filter((r) => outdoor(r) && !drapedIds.has(r.id));
const pct = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const usersOf = (id: string) => roads.filter((r) => r.fromNodeId === id || r.toNodeId === id);
results.ownHeightGroups = component(own).filter((c) => c.some(touches)).map((c, k) => {
  const verts = c.flatMap((r) => r.coordinates.map((p, i) => ({ r, i, p, d: delta(p), need: at(t01, p) - p[2] })));
  const uniq = [...new Map(verts.map((v) => [v.p.join(','), v])).values()];
  const changed = uniq.filter((v) => Math.abs(v.d) >= MIN), pinned = uniq.filter((v) => Math.abs(v.d) < MIN);
  const need = changed.map((v) => v.need), shift = pct(need, 0.5), res = need.map((n) => n - shift);
  const nodeIds = [...new Set(c.flatMap((r) => [r.fromNodeId, r.toNodeId]))];
  const joins = nodeIds.flatMap((id) => { const n = nodes.find((x) => x.id === id)!, others = usersOf(id).filter((r) => !c.includes(r));
    return others.length ? [{ node: short(id), z: n.coordinate[2], terrainDeltaM: r2(delta(n.coordinate)), aboveOldTerrainM: r2(n.coordinate[2] - at(oldH, n.coordinate)), needM: r2(at(t01, n.coordinate) - n.coordinate[2]),
      with: others.map((r) => `${short(r.id)} ${r.structure} ${r.buildingId ?? (drapedIds.has(r.id) ? '(지형에 얹힌 길)' : '')}`.trim()) }] : []; });
  const levels = [...new Set(c.filter((r) => Math.max(...r.coordinates.map((p) => p[2])) - Math.min(...r.coordinates.map((p) => p[2])) < 0.005).map((r) => r.coordinates[0][2]))].sort();
  return { group: `G${k + 1}`, roads: c.map((r) => ({ id: short(r.id), name: r.name, structure: r.structure, vertices: r.coordinates.length, z: [Math.min(...r.coordinates.map((p) => p[2])), Math.max(...r.coordinates.map((p) => p[2]))],
      onChanged: r.coordinates.filter((p) => Math.abs(delta(p)) >= MIN).length })),
    flatLevelsM: levels, vertices: uniq.length,
    onChangedTerrain: { n: changed.length, terrainDeltaM: [r2(Math.min(...changed.map((v) => v.d))), r2(Math.max(...changed.map((v) => v.d)))],
      needM: { min: r2(Math.min(...need)), p10: r2(pct(need, 0.1)), median: r2(shift), p90: r2(pct(need, 0.9)), max: r2(Math.max(...need)) },
      afterMedianShift: { within05: res.filter((x) => Math.abs(x) <= 0.5).length, worstM: r2(Math.max(...res.map(Math.abs))) } },
    // 고정점: 지형이 안 바뀐 자리의 꼭짓점. 통째로 옮기면 이 자리의 (길 - 지형)이 그만큼 달라진다.
    onUnchangedTerrain: { n: pinned.length, aboveTerrainM: pinned.length ? [r2(Math.min(...pinned.map((v) => -v.need))), r2(Math.max(...pinned.map((v) => -v.need)))] : null,
      within05Now: pinned.filter((v) => Math.abs(v.need) <= 0.5).length, within05AfterMedianShift: pinned.filter((v) => Math.abs(v.need - shift) <= 0.5).length },
    joins };
});

// 볼트의 다른 높이 자료와 대조 (S-MAP 고도 표기와 좌표 검증.md, 사용자-SMAP높이-20261010/근거.md). 모두 S-MAP 계열이라 독립 측량은 아니다.
const checks: [string, number, number, number, number][] = [
  ['141.73 m 연장 시작 (8e71c240 서쪽 끝)', 201106.22, 557324.73, 141.73, 140.9941], ['141.73 m 연장 끝 (8e71c240 동쪽 끝)', 201139.10, 557309.50, 141.73, 147.2491],
  ['대일 접근점 (건물 속성이 붙는 자리)', 201192.29, 557323.23, 145.80, 151.6358], ['문예 입구점 (건물 속성이 붙는 자리)', 201107.67, 557339.65, 142.44, 142.7753],
  ['C02-00 (561a12b4 노드)', 201157.33, 557301.30, 141.73, 148.8775],
];
results.vaultHeights = checks.map(([what, x, y, roadZ, smapZ]) => ({ what, roadZ, smapZ, smapMinusRoadM: r2(smapZ - roadZ), oldDemM: r2(at(oldH, [x, y])), t01M: r2(at(t01, [x, y])), terrainDeltaM: r2(delta([x, y])) }));
results.fullPlanKeptNodes = full.refusedNodes.length;

fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
for (const c of results.candidates) console.log(JSON.stringify({ areas: c.areas, cells: c.changedCells, verts: c.outdoorVertices, roads: c.outdoorRoads, relevel: c.relevel, shownBefore: c.shownBefore, shownAfter: c.shownAfter,
  trueBefore: c.trueErrorBefore, trueAfter: c.trueErrorAfter, grew: c.trueErrorGrew, newlyOff: c.newlyOff05, candDiff: c.newlyOff05WhereCandidateDiffersFromT01, fade: c.newlyOff05InFadeZone, buildings: c.buildingsOver03 }));
