// T04: 차도 구역 표본(E09 차도가 지나는 곳)의 기준 잔차, 10 m 구획 검증, 구역 조합별 미리보기 수치·후보 id, 길 재조정(E07 규칙) 모의 실행.
// 설정은 T01 그대로(LOCAL_SAMPLE_DEFAULTS). 오프라인. DB·서버 접근 없음.
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/t04/evaluate.ts <3d-map-audit-20261009 폴더> <기존 표본 파일> <새 구역 표본 파일> <results.json> <격자 출력 폴더>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { applyLocalSamples, changeStats, mergeLocalSampleInputs, parseLocalSamples } from '../../../backend/src/geo/terrain-local-samples.ts';
import { planRelevel, RELEVEL_FIELD, type RelevelNode, type RelevelRoad } from '../../../backend/src/geo/terrain-relevel.ts';

const [audit, oldFile, newFile, outFile, gridOut] = process.argv.slice(2);
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = json(path.join(audit, 'terrain-grid-meta.json'));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const live = f32(path.join(audit, 'terrain-grid.f32'));
const oldInput = json(oldFile), newInput = json(newFile), both = mergeLocalSampleInputs([oldInput, newInput]);
const NEW: string[] = [...new Set<string>(newInput.groups.map((x: any) => x.area))];
type S = { x: number; y: number; z: number; area: string };
const samplesOf = (input: any, areas: string[]): S[] => input.groups.filter((x: any) => areas.includes(x.area)).flatMap((x: any) => x.points.map((p: number[]) => ({ x: p[0], y: p[1], z: p[2], area: x.area })));
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const stat = (r: number[]) => r.length ? { n: r.length, median: r2(pct(r, 0.5)), p90Abs: r2(pct(r.map(Math.abs), 0.9)), maxAbs: r2(Math.max(...r.map(Math.abs))) } : { n: 0 };
const at = (h: Float32Array, p: number[]) => bilinear(g, h, p[0], p[1])!;
const fold = (s: S) => (((Math.floor(s.x / 10) * 7 + Math.floor(s.y / 10) * 13) % 5) + 5) % 5; // E01·T01 과 같은 10 m 구획 5등분
const results: any = { created: '2026-10-10', newAreas: NEW };

// ---- 1. 구역별: 기준 잔차, 전부 넣고 표본 자리, 10 m 구획 검증 ----
// 검증은 (a) 그 구역 표본만 넣을 때, (b) 기존 세 구역 + 새 구역 전부를 넣을 때 두 가지.
const all = samplesOf(both, ['field', 'corridor', 's06', ...NEW]);
const holdout = (set: S[]) => {
  const res: Record<string, number[]> = {}, worst: Record<string, number[][]> = {}; let skipped = 0;
  for (let k = 0; k < 5; k++) {
    const r = applyLocalSamples(g, live, set.filter((s) => fold(s) !== k)); skipped += r.skipped.length;
    for (const s of set) if (fold(s) === k) { const d = s.z - at(r.heights, [s.x, s.y]); (res[s.area] ??= []).push(d); (worst[s.area] ??= []).push([s.x, s.y, s.z, r2(d), r2(s.z - at(live, [s.x, s.y]))]); }
  }
  for (const a of Object.keys(worst)) worst[a] = worst[a].sort((p, q) => Math.abs(q[3]) - Math.abs(p[3])).slice(0, 8); // [x, y, 표본 z, 검증 잔차, 기준 잔차]
  return { res, skipped, worst };
};
const hoAll = holdout(all), fitAll = applyLocalSamples(g, live, all);
results.areas = Object.fromEntries(NEW.map((a) => {
  const mine = all.filter((s) => s.area === a), alone = holdout(mine);
  return [a, { samples: mine.length, baseline: stat(mine.map((s) => s.z - at(live, [s.x, s.y]))),
    fitAllIn: stat(mine.map((s) => s.z - at(fitAll.heights, [s.x, s.y]))),
    holdoutBlock10mAlone: { ...stat(alone.res[a]), guardSkippedInFolds: alone.skipped }, holdoutBlock10mWithAll: stat(hoAll.res[a]),
    holdoutOver2m: hoAll.res[a].filter((d) => Math.abs(d) > 2).length, holdoutWorst: hoAll.worst[a] }];
}));
results.existingAreasWithAll = Object.fromEntries(['field', 'corridor', 's06'].map((a) => [a, stat(hoAll.res[a])]));
results.guardSkippedAllIn = fitAll.skipped.length;
console.log(JSON.stringify(results.areas, null, 1), JSON.stringify(results.existingAreasWithAll));

// ---- 2. 조합별 미리보기 수치(terrain:local-samples 가 출력할 값)와 길 재조정 모의 실행 ----
type Road = RelevelRoad & { name: string | null };
const roads: Road[] = json(path.join(audit, 'claude-live/roads-live-2.json')).items.filter((r: Road) => !/^(6f2a4bcd|7408c108)/.test(r.id));
const nodes: RelevelNode[] = json(path.join(audit, 'claude-live/nodes-live-2.json')).items;
const outdoor = (r: Road) => r.levelId === null && r.buildingId === null && r.structure !== 'indoor_corridor' && r.structure !== 'elevator';
const id = (input: any, h: Float32Array) => `local-samples-${createHash('sha256').update(meta.versionId).update(createHash('sha256').update(JSON.stringify(input)).digest('hex')).update(Buffer.from(h.buffer, h.byteOffset, h.byteLength)).digest('hex').slice(0, 16)}`;
const combo = (name: string, input: any, areas: string[], base?: Float32Array) => {
  const parsed = parseLocalSamples(input, areas), r = applyLocalSamples(g, live, parsed.samples), h = r.heights;
  fs.writeFileSync(path.join(gridOut, `dem-${name}.f32`), Buffer.from(h.buffer, h.byteOffset, h.byteLength));
  const plan = planRelevel(g, live, h, roads, nodes, RELEVEL_FIELD);
  const after = roads.map((x) => ({ ...x, coordinates: plan.roads.find((p) => p.id === x.id)?.coordinates ?? x.coordinates }));
  const back = planRelevel(g, h, live, after, nodes.map((n) => plan.nodes.find((x) => x.id === n.id) ?? n), RELEVEL_FIELD);
  const restored = after.map((x) => back.roads.find((p) => p.id === x.id)?.coordinates ?? x.coordinates);
  // 바뀐 지형 위 실외 꼭짓점: 길 높이 - 지형, 전(옛 지형) / 후(후보 지형, 길 재조정 뒤). base 가 있으면 base 대비 새로 바뀐 칸 위의 것만.
  const ref = base ?? live;
  const touched = roads.flatMap((x, k) => outdoor(x) ? x.coordinates.map((p, i) => ({ road: x, p, i, k })) : []).filter((v) => Math.abs(at(h, v.p) - at(ref, v.p)) >= 0.005);
  const before = touched.map((v) => v.p[2] - at(live, v.p)), aft = touched.map((v) => after[v.k].coordinates[v.i][2] - at(h, v.p));
  const tally = (d: number[]) => ({ within05: d.filter((a) => Math.abs(a) <= 0.5).length, below05: d.filter((a) => a < -0.5).length, below2: d.filter((a) => a < -2).length, above05: d.filter((a) => a > 0.5).length, above2: d.filter((a) => a > 2).length,
    lowestM: d.length ? r2(Math.min(...d)) : null, highestM: d.length ? r2(Math.max(...d)) : null });
  const indoorTouched = roads.flatMap((x) => outdoor(x) ? [] : x.coordinates).filter((p) => Math.abs(at(h, p) - at(ref, p)) >= 0.005).length;
  return { name, areas, files: input === oldInput ? 'first file only' : 'both files', id: id(input, h), samples: parsed.samples.length, skippedSamples: r.skipped.length, ...changeStats(g, live, h),
    relevel: { roads: plan.roads.map((x) => ({ road: x.id.slice(0, 8), name: roads.find((q) => q.id === x.id)!.name, vertices: x.vertices.length, shiftM: [r2(Math.min(...x.vertices.map((v) => v.toZ - v.fromZ))), r2(Math.max(...x.vertices.map((v) => v.toZ - v.fromZ)))] })),
      vertices: plan.roads.reduce((t, x) => t + x.vertices.length, 0), nodes: plan.nodes.map((n) => ({ node: n.id.slice(0, 8), rule: n.rule, fromZ: n.fromZ, toZ: n.coordinate[2] })),
      keptNodes: plan.refusedNodes.map((n) => ({ node: n.id.slice(0, 8), reason: n.reason, aboveAfterM: r2(n.aboveAfterM) })),
      notMovedOwnHeights: plan.refusedRoads.filter((x) => x.reason === 'own-heights').map((x) => ({ road: x.id.slice(0, 8), name: roads.find((q) => q.id === x.id)!.name, vertices: x.vertices, aboveBeforeM: x.aboveBeforeM.map(r2), aboveAfterM: x.aboveAfterM.map(r2) })),
      notMovedIndoorRoads: plan.refusedRoads.filter((x) => x.reason === 'indoor').length,
      reverseNotRestored: roads.flatMap((x, k) => x.coordinates.map((p, i) => p[2] !== restored[k][i][2])).filter(Boolean).length },
    outdoorVerticesOnChangedCells: { scope: base ? '기존 조합 대비 새로 바뀐 칸 위' : '바뀐 칸 위 전부', n: touched.length, roads: [...new Set(touched.map((v) => v.road.id.slice(0, 8)))], before: tally(before), after: tally(aft),
      list: base ? touched.map((v, k) => ({ road: v.road.id.slice(0, 8), name: v.road.name, structure: v.road.structure, index: v.i, xy: [r2(v.p[0]), r2(v.p[1])], z: v.p[2], aboveOldM: r2(before[k]), aboveNewM: r2(aft[k]) })) : undefined },
    indoorVerticesOnChangedCells: indoorTouched, heights: h };
};
const strip = (c: any) => { const { heights, ...rest } = c; return rest; };
// 이미 알린 id 가 그대로인지: 첫 파일만으로 만든 조합
const fieldOnly = combo('check-field', oldInput, ['field']), fieldS06old = combo('check-field-s06', oldInput, ['field', 's06']);
results.announcedIds = { field: { id: fieldOnly.id, expected: 'local-samples-7e415b29668b2f62', same: fieldOnly.id === 'local-samples-7e415b29668b2f62', changedCells: fieldOnly.changedCells },
  fieldS06: { id: fieldS06old.id, expected: 'local-samples-09eca6c203f338b0', same: fieldS06old.id === 'local-samples-09eca6c203f338b0', changedCells: fieldS06old.changedCells } };
console.log(JSON.stringify(results.announcedIds));
const fieldS06 = combo('field-s06', oldInput, ['field', 's06']); // 첫 파일만: 이미 알린 id 그대로
results.combos = [strip(fieldS06)];
for (const a of NEW) results.combos.push(strip(combo(`only-${a}`, both, [a])));
results.combos.push(strip(combo('new-areas', both, NEW)));
results.combos.push(strip(combo('s06-new', both, ['s06', ...NEW])));
results.combos.push(strip(combo('field-s06-new', both, ['field', 's06', ...NEW], fieldS06.heights)));
results.combos.push(strip(combo('all', both, ['field', 'corridor', 's06', ...NEW])));
for (const c of results.combos) console.log(c.name, c.id, 'samples', c.samples, 'skipped', c.skippedSamples, 'cells', c.changedCells, 'delta', r2(c.minDelta), r2(c.maxDelta), 'steep', c.steepCellsBefore, c.steepCellsAfter,
  'relevel roads', c.relevel.roads.length, 'verts', c.relevel.vertices, 'nodes', c.relevel.nodes.length, 'kept', c.relevel.keptNodes.length, 'own', c.relevel.notMovedOwnHeights.length, 'indoor', c.relevel.notMovedIndoorRoads,
  'outdoor verts', c.outdoorVerticesOnChangedCells.n, JSON.stringify(c.outdoorVerticesOnChangedCells.before), JSON.stringify(c.outdoorVerticesOnChangedCells.after));
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
