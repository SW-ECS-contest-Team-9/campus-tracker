// E07: 운동장 높이 확정 뒤 (A) 길·노드 높이의 출처 분류, (B) 구역 후보별로 옛 규칙(T03)과 새 규칙(운동장 기준값 복사 포함)의 전후 수치,
// (C) G1 길 14개 판정용 표. 오프라인. DB·서버 접근 없음. 수치 기준은 docs/audit/t03/evaluate.ts·followup.ts와 같다.
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/e07/evaluate.ts <3d-map-audit-20261009 폴더> backend/data/terrain/samples/smap_samples_5186.json docs/audit/e07/results.json
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { applyLocalSamples, changeStats, parseLocalSamples } from '../../../backend/src/geo/terrain-local-samples.ts';
import { planRelevel, RELEVEL_DEFAULTS, RELEVEL_FIELD, type RelevelRoad, type RelevelNode, type RelevelOptions, type RelevelPlan } from '../../../backend/src/geo/terrain-relevel.ts';

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
const REF = RELEVEL_FIELD.references[0], refOld = at(oldH, REF);
const isRef = (z: number) => Math.abs(z - refOld) <= RELEVEL_FIELD.referenceMatchM;
const usersOf = (id: string) => roads.filter((r) => r.fromNodeId === id || r.toNodeId === id);
const results: any = { created: '2026-10-10', snapshot: { roads: roads.length, nodes: nodes.length },
  reference: { xy: REF, oldDemM: refOld, t01M: at(t01, REF), shiftT01M: at(t01, REF) - refOld } };

// ---------- A. 높이의 출처 ----------
const verts = roads.flatMap((r) => r.coordinates.map((p, i) => ({ r, i, p, end: i === 0 || i === r.coordinates.length - 1, aboveOld: p[2] - at(oldH, p), d: at(t01, p) - at(oldH, p) })));
const drapedZ = [...new Set(verts.filter((v) => outdoor(v.r) && !v.end && Math.abs(v.aboveOld) <= 0.02).map((v) => v.p[2]))];
const klass = (v: typeof verts[number]) => !outdoor(v.r) ? 'indoor' : Math.abs(v.aboveOld) <= 0.02 ? 'draped' : isRef(v.p[2]) ? 'reference-copy' : 'own';
const tally = (list: typeof verts) => Object.fromEntries(['draped', 'reference-copy', 'own', 'indoor'].map((k) => [k, list.filter((v) => klass(v) === k).length]));
const onChanged = verts.filter((v) => Math.abs(v.d) >= MIN);
results.provenance = {
  note: 'draped = 실외 길 꼭짓점이 자기 자리 옛 지형 ±0.02 m. reference-copy = 얹히지 않았는데 높이가 기준 표본(옛 지형 141.7326 m)과 0.006 m 안. own = 그 밖의 실외. 길 끝은 길마다 따로 센다.',
  allVertices: tally(verts), onChangedTerrain: tally(onChanged),
  drapedOnChangedByRoad: Object.entries(Object.groupBy(onChanged.filter((v) => klass(v) === 'draped'), (v) => v.r.id)).map(([id, v]) => ({ id: short(id), name: v![0].r.name, vertices: v!.length, ends: v!.filter((x) => x.end).length })),
  indoorVerticesWithReferenceValue: verts.filter((v) => !outdoor(v.r) && isRef(v.p[2])).length,
  referenceCopies: verts.filter((v) => klass(v) === 'reference-copy').map((v) => ({ road: short(v.r.id), name: v.r.name, structure: v.r.structure, index: v.i, end: v.end,
    node: v.end ? short(v.i === 0 ? v.r.fromNodeId : v.r.toNodeId) : null, xy: [v.p[0], v.p[1]], z: v.p[2], oldDemHereM: r2(at(oldH, v.p)), t01HereM: r2(at(t01, v.p)),
    needToGroundM: r2(at(t01, v.p) - v.p[2]), afterRigidShiftAboveGroundM: r2(v.p[2] + results.reference.shiftT01M - at(t01, v.p)) })),
  referenceNodes: nodes.filter((n) => isRef(n.coordinate[2])).map((n) => ({ node: short(n.id), xy: [n.coordinate[0], n.coordinate[1]], z: n.coordinate[2], aboveOldM: r2(n.coordinate[2] - at(oldH, n.coordinate)),
    needToGroundM: r2(at(t01, n.coordinate) - n.coordinate[2]), afterRigidShiftAboveGroundM: r2(n.coordinate[2] + results.reference.shiftT01M - at(t01, n.coordinate)),
    roads: usersOf(n.id).map((r) => `${short(r.id)} ${r.structure}${outdoor(r) ? '' : ' (실내)'}`) })),
  // 자체 높이 수준: 기준값과의 차, 얹힌 꼭짓점 값 중 같은 것이 있는가(다른 자리의 옛 지형값을 베꼈는가)
  ownLevelsOnChanged: [...new Set(onChanged.filter((v) => klass(v) === 'own').map((v) => v.p[2]))].sort((a, b) => a - b).map((z) => ({ z, minusReferenceM: r2(z - refOld),
    equalsADrapedVertexValue: drapedZ.some((d) => Math.abs(d - z) <= 0.006), vertices: onChanged.filter((v) => klass(v) === 'own' && v.p[2] === z).length,
    roads: [...new Set(onChanged.filter((v) => klass(v) === 'own' && v.p[2] === z).map((v) => short(v.r.id)))] })),
  // "운동장 어딘가의 옛 지형값과 같다"는 증거가 못 된다: 운동장 보정 칸(지형 차 2 m 이상) 가운데 그 값 ±0.006 m인 칸 수
  chanceMatchCells: (() => { const cells: number[] = []; for (let i = 0; i < oldH.length; i++) if (t01[i] - oldH[i] >= 2) cells.push(oldH[i]);
    return { cellsRaised2mOrMore: cells.length, ...Object.fromEntries([141.73, 142.44, 143.8, 144.8, 145.8, 150.8].map((z) => [z, cells.filter((c) => Math.abs(c - z) <= 0.006).length])) }; })(),
};

// ---------- B. 구역 후보 × 규칙 ----------
const T03: RelevelOptions = { ...RELEVEL_DEFAULTS, references: [] };
const apply = (list: Road[], p: RelevelPlan): Road[] => list.map((r) => ({ ...r, coordinates: p.roads.find((x) => x.id === r.id)?.coordinates ?? r.coordinates }));
const applyNodes = (p: RelevelPlan): RelevelNode[] => nodes.map((n) => p.nodes.find((x) => x.id === n.id) ?? n);
const maxGrade = (c: XYZ[]) => Math.max(...c.slice(1).map((p, i) => Math.abs(p[2] - c[i][2]) / Math.max(Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 1e-9)));
const byId = (list: Road[], id: string) => list.find((r) => r.id === id)!;
const candidate = (areas: string[]) => {
  const cand = applyLocalSamples(g, oldH, parseLocalSamples(input, areas).samples).heights;
  const touched = roads.filter(outdoor).flatMap((r) => r.coordinates.map((p, i) => ({ r, i, p }))).filter((v) => Math.abs(at(cand, v.p) - at(oldH, v.p)) >= MIN);
  const ids = [...new Set(touched.map((v) => v.r.id))];
  const base = ids.map((id) => maxGrade(byId(roads, id).coordinates));
  const row = (list: Road[], h: Float32Array, ns: RelevelNode[]) => {
    const shown = touched.map((t) => byId(list, t.r.id).coordinates[t.i][2] - at(h, t.p)), truth = touched.map((t) => byId(list, t.r.id).coordinates[t.i][2] - at(t01, t.p));
    const grades = ids.map((id) => maxGrade(byId(list, id).coordinates));
    return { within05: shown.filter((a) => Math.abs(a) <= 0.5).length, below05: shown.filter((a) => a < -0.5).length, below2: shown.filter((a) => a < -2).length, above05: shown.filter((a) => a > 0.5).length, above2: shown.filter((a) => a > 2).length,
      lowestM: r2(Math.min(...shown)), highestM: r2(Math.max(...shown)),
      truthWithin05: truth.filter((a) => Math.abs(a) <= 0.5).length, truthBelow2: truth.filter((a) => a < -2).length,
      worstGrade: r2(Math.max(...grades)), roadsSteeper: grades.filter((v, i) => v > base[i] + 0.01).length, roadsOver30pct: grades.filter((v) => v > 0.3).length,
      // 길 끝과 노드 높이의 차(틈). 0이어야 한다.
      maxEndNodeGapM: Math.max(...list.flatMap((r) => [[r.fromNodeId, r.coordinates[0]], [r.toNodeId, r.coordinates.at(-1)!]] as [string, XYZ][]).map(([id, p]) => Math.abs(ns.find((n) => n.id === id)!.coordinate[2] - p[2]))) };
  };
  const rule = (opts: RelevelOptions) => {
    const plan = planRelevel(g, oldH, cand, roads, nodes, opts), after = apply(roads, plan), nodesAfter = applyNodes(plan);
    const back = planRelevel(g, cand, oldH, after, nodesAfter, opts), restored = apply(after, back), nodesBack = nodes.map((n) => back.nodes.find((x) => x.id === n.id) ?? nodesAfter.find((x) => x.id === n.id)!);
    const truthGrew = touched.filter((t) => Math.abs(byId(after, t.r.id).coordinates[t.i][2] - at(t01, t.p)) > Math.abs(t.p[2] - at(t01, t.p)) + 0.05).length;
    const segs = plan.roads.flatMap((pr) => { const b = byId(roads, pr.id); return b.coordinates.slice(1).flatMap((p, k) => {
      const run = Math.hypot(p[0] - b.coordinates[k][0], p[1] - b.coordinates[k][1]), dz0 = p[2] - b.coordinates[k][2], dz1 = pr.coordinates[k + 1][2] - pr.coordinates[k][2];
      return Math.abs(dz1 - dz0) > 0.5 ? [{ road: short(b.id), name: b.name, structure: b.structure, segment: k, runM: r2(run), riseBeforeM: r2(dz0), riseAfterM: r2(dz1), gradeAfter: r2(Math.abs(dz1) / Math.max(run, 1e-9)) }] : []; }); });
    return { ...row(after, cand, nodesAfter), truthErrorGrew: truthGrew,
      moved: { roads: plan.roads.length, vertices: plan.roads.reduce((s, r) => s + r.vertices.length, 0), nodes: plan.nodes.map((n) => ({ node: short(n.id), rule: n.rule, fromZ: n.fromZ, toZ: n.coordinate[2], aboveCandidateM: r2(n.coordinate[2] - at(cand, n.coordinate)), aboveT01M: r2(n.coordinate[2] - at(t01, n.coordinate)), roads: n.roadIds.map(short) })),
        list: plan.roads.map((r) => ({ road: short(r.id), name: byId(roads, r.id).name, vertices: r.vertices.length, shiftM: [r2(Math.min(...r.vertices.map((v) => v.toZ - v.fromZ))), r2(Math.max(...r.vertices.map((v) => v.toZ - v.fromZ)))] })) },
      keptNodes: plan.refusedNodes.map((n) => ({ node: short(n.id), reason: n.reason, terrainShiftM: r2(n.deltaM), aboveAfterM: r2(n.aboveAfterM) })),
      notMovedOwnHeights: plan.refusedRoads.filter((r) => r.reason === 'own-heights').map((r) => ({ road: short(r.id), name: byId(roads, r.id).name, vertices: r.vertices, copiedReferenceKept: r.referenceCopies, aboveAfterM: [r2(r.aboveAfterM[0]), r2(r.aboveAfterM[1])] })),
      notMovedIndoorRoads: plan.refusedRoads.filter((r) => r.reason === 'indoor').length,
      segmentsChangedOver05: segs,
      stairs: roads.filter((r) => r.structure === 'stairs' && plan.roads.some((p) => p.id === r.id)).map((r) => ({ road: short(r.id), name: r.name, riseBeforeM: r2(r.coordinates.at(-1)![2] - r.coordinates[0][2]), riseAfterM: r2(byId(after, r.id).coordinates.at(-1)![2] - byId(after, r.id).coordinates[0][2]) })),
      reverse: { verticesNotRestored: roads.flatMap((r, k) => r.coordinates.map((p, i) => p[2] !== restored[k].coordinates[i][2])).filter(Boolean).length, nodesNotRestored: nodes.filter((n, k) => n.coordinate[2] !== nodesBack[k].coordinate[2]).length } };
  };
  let changedCells = 0; for (let i = 0; i < cand.length; i++) if (cand[i] !== oldH[i]) changedCells++;
  // terrain:local-samples 미리보기가 출력할 값(서버의 기준 격자가 이 스냅숏과 같을 때). id 계산은 scripts/terrain-local-samples.ts와 같다.
  const inputSha = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const preview = { id: `local-samples-${createHash('sha256').update(meta.versionId).update(inputSha).update(Buffer.from(cand.buffer)).digest('hex').slice(0, 16)}`, samples: parseLocalSamples(input, areas).samples.length, ...changeStats(g, oldH, cand) };
  return { areas: areas.join('+'), changedCells, preview, outdoorVertices: touched.length, outdoorRoads: ids.length, referenceShiftM: at(cand, REF) - refOld,
    before: row(roads, oldH, nodes), terrainOnly: row(roads, cand, nodes), t03Rule: rule(T03), e07Rule: rule(RELEVEL_FIELD) };
};
results.candidates = [['field'], ['field', 's06'], ['field', 'corridor', 's06'], ['corridor'], ['s06']].map(candidate);

// ---------- C. G1 길 14개 (E04 묶음) ----------
const G1 = ['c52095ad', '8e71c240', '45682ee7', '88ba01e6', '19800cee', '8e03aa9e', 'b14ac1da', '00cd9c0f', '2f206e6c', '618385b9', 'a7a51d3c', 'fdb059c4', '9112314a', '3ab80c19'];
const fieldOnly = applyLocalSamples(g, oldH, parseLocalSamples(input, ['field']).samples).heights;
const planAll = planRelevel(g, oldH, t01, roads, nodes, RELEVEL_FIELD);
results.g1 = G1.map((pre) => { const r = roads.find((x) => x.id.startsWith(pre))!, after = planAll.roads.find((p) => p.id === r.id)?.coordinates ?? r.coordinates;
  return { road: pre, name: r.name, structure: r.structure, vertices: r.coordinates.map((p, i) => ({ xy: [r2(p[0]), r2(p[1])], z: p[2], minusReferenceM: r2(p[2] - refOld), aboveOldM: r2(p[2] - at(oldH, p)),
    needToT01GroundM: r2(at(t01, p) - p[2]), terrainShiftAllM: r2(at(t01, p) - at(oldH, p)), terrainShiftFieldOnlyM: r2(at(fieldOnly, p) - at(oldH, p)), zAfterE07: after[i][2], aboveT01AfterM: r2(after[i][2] - at(t01, p)) })) }; });

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
const brief = (x: any) => ({ within05: x.within05, below2: x.below2, lowest: x.lowestM, highest: x.highestM, truthWithin05: x.truthWithin05, truthBelow2: x.truthBelow2, worstGrade: x.worstGrade, steeper: x.roadsSteeper, over30: x.roadsOver30pct, gap: x.maxEndNodeGapM });
console.log(JSON.stringify(results.reference), JSON.stringify(results.provenance, null, 1));
for (const c of results.candidates) { console.log(`\n== ${c.areas}: preview ${JSON.stringify(c.preview)} cells ${c.changedCells}, outdoor vertices ${c.outdoorVertices} (roads ${c.outdoorRoads}), reference shift ${r2(c.referenceShiftM)}`);
  for (const k of ['before', 'terrainOnly', 't03Rule', 'e07Rule']) console.log(k.padEnd(12), JSON.stringify(brief(c[k])));
  for (const k of ['t03Rule', 'e07Rule']) console.log(k, JSON.stringify({ moved: c[k].moved, kept: c[k].keptNodes, own: c[k].notMovedOwnHeights.length, refKept: c[k].notMovedOwnHeights.filter((r: any) => r.copiedReferenceKept), segs: c[k].segmentsChangedOver05, stairs: c[k].stairs, grew: c[k].truthErrorGrew, reverse: c[k].reverse })); }
