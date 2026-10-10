// E10 — 운동장을 면(공간 영역)으로: 운동장 다각형·접근점 제안과 길찾기 전후 모의. 읽기 전용(DB·MCP 호출 없음).
//   npx tsx docs/audit/e10/build.ts <3d-map-audit-20261009> docs/audit/e10 <plan.png>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { areaLinks, Polygon, type WalkArea } from '../../../backend/src/modules/editor-mcp/area-links.ts';
import { checkReachability, type ReachRoad } from '../../../backend/src/modules/editor-mcp/reachability.ts';

type XY = [number, number];
const [audit, outDir, png] = process.argv.slice(2);
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const r2 = (v: number) => Math.round(v * 100) / 100, r1 = (v: number) => Math.round(v * 10) / 10;
const s8 = (id: string) => id.slice(0, 8);
const FLOOR = 148.9; // E06 측정
const DELETED = ['6f2a4bcd', '7408c108'];

// ---- 입력
const surfaces = json('frontend/public/corrections/field-surfaces-v3.geojson');
const cells: XY[] = surfaces.features.find((f: any) => f.properties.id === 'SF-FIELD').geometry.coordinates[0].slice(0, -1).map((p: number[]) => [p[0], p[1]]);
const photo: XY[] = json('frontend/public/corrections/field-boundary-v4.geojson').features.find((f: any) => f.properties.id === 'REF-PHOTO15-V4-EDGE').geometry.coordinates.map((p: number[]) => [p[0], p[1]]);
const roads: any[] = json(`${audit}/claude-live/roads-live-2.json`).items;
const nodes: any[] = json(`${audit}/claude-live/nodes-live-2.json`).items;
const buildings: { name: string; coordinates: number[][][][] }[] = json(`${audit}/building-outlines-5186.json`);
const openAreasToday = json(`${audit}/claude-live/mobility-live.json`).openAreas.length;
if (roads.some((r) => DELETED.some((d) => r.id.startsWith(d)))) throw new Error('삭제된 길이 스냅숏에 있음');
const meta = json(`${audit}/terrain-grid-meta.json`);
const grid: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const f32 = (p: string) => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const oldH = f32(`${audit}/terrain-grid.f32`), newH = f32(`${audit}/t01/dem-T01.f32`);

// ---- 다각형: S-MAP 평지 칸 윤곽(2 m 칸 계단 모양)을 2 m(한 칸) 허용으로 단순화
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segDist = (p: XY, a: XY, b: XY) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
function simplify(line: XY[], tol: number): XY[] {
  let worst = 0, at = 0;
  for (let i = 1; i < line.length - 1; i++) { const d = segDist(line[i], line[0], line.at(-1)!); if (d > worst) { worst = d; at = i; } }
  return worst <= tol ? [line[0], line.at(-1)!] : [...simplify(line.slice(0, at + 1), tol).slice(0, -1), ...simplify(line.slice(at), tol)];
}
const far = cells.reduce((b, p, i) => (dist(p, cells[0]) > dist(cells[b], cells[0]) ? i : b), 0);
const TOL = 2;
const ring: XY[] = [...simplify(cells.slice(0, far + 1), TOL).slice(0, -1), ...simplify([...cells.slice(far), cells[0]], TOL).slice(0, -1)].map((p) => [r2(p[0]), r2(p[1])]);
const ringArea = (r: XY[]) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0)) / 2;
const poly = new Polygon([ring]), cellPoly = new Polygon([cells]), photoPoly = new Polygon([photo]);
const centroid: XY = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const side = (p: XY) => { const dx = p[0] - centroid[0], dy = p[1] - centroid[1]; return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? '동' : '서') : (dy > 0 ? '북' : '남'); };
const quant = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
const along = (r: XY[], step: number) => r.flatMap((a, i) => { const b = r[(i + 1) % r.length], n = Math.max(1, Math.round(dist(a, b) / step)); return Array.from({ length: n }, (_, k) => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n] as XY); });
const bySide: Record<string, { toPhoto: number[]; toCells: number[] }> = {};
for (const p of along(ring, 1)) { const s = (bySide[side(p)] ??= { toPhoto: [], toCells: [] }); s.toPhoto.push(photoPoly.nearestOnBoundary(p).d); s.toCells.push(cellPoly.nearestOnBoundary(p).d); }
const sides = Object.fromEntries(Object.entries(bySide).map(([k, v]) => [k, { boundaryM: v.toPhoto.length, vsPhoto15_medianM: r1(quant(v.toPhoto, 0.5)), vsPhoto15_p90M: r1(quant(v.toPhoto, 0.9)), vsPhoto15_maxM: r1(Math.max(...v.toPhoto)), vsCells_maxM: r1(Math.max(...v.toCells)) }]));

// ---- 면 안 표본(1 m): 건물 외곽과 겹침, 지형과의 차
const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
const inside: XY[] = [];
for (let x = Math.floor(Math.min(...xs)) + 0.5; x < Math.max(...xs); x++) for (let y = Math.floor(Math.min(...ys)) + 0.5; y < Math.max(...ys); y++) if (poly.covers([x, y])) inside.push([x, y]);
const overlap = buildings.map((b) => ({ name: b.name, m2: inside.filter((p) => b.coordinates.some((pg) => new Polygon(pg).covers(p))).length })).filter((b) => b.m2 > 0);
const terrainStats = (h: Float32Array) => {
  const d = inside.map((p) => bilinear(grid, h, p[0], p[1])).filter((v): v is number => v != null).map((v) => v - FLOOR);
  return { minM: r2(Math.min(...d)), p05M: r2(quant(d, 0.05)), medianM: r2(quant(d, 0.5)), p95M: r2(quant(d, 0.95)), maxM: r2(Math.max(...d)),
    areaAboveFloorBy5cm_pct: r1(100 * d.filter((v) => v > 0.05).length / d.length), areaAboveFloorBy15cm_pct: r1(100 * d.filter((v) => v > 0.15).length / d.length), areaBelowFloorBy50cm_pct: r1(100 * d.filter((v) => v < -0.5).length / d.length) };
};

// ---- 접근점. 좌표는 건물 노트(학교 캠퍼스맵 표지, EPSG:5186 변환값)·운영 스냅숏·2차 주석에서 그대로 옮긴 값이다.
// B09(2026-10-10): 계단 제안(stair)을 더했다. 좌표·높이는 docs/audit/b09/results.json 에서 옮긴 값이다(상승관 두 계단 = 사용자 그림, 한림관 6층·대일관 현관 = S-MAP 1 m 격자).
type Stair = { lowerXY: XY; lowerM: number; upperXY: XY; upperM: number | [number, number]; risers: string; grade: string };
const ACCESS: { id: string; name: string; xy: XY | null; node?: string; leadsTo: string; grade: string; note: string; stair?: Stair }[] = [
  { id: 'AP-DAEIL-FRONT', name: '대일관 현관 앞 계단 아래 (= 사잇길 쪽 길 45682ee7이 닿는 곳)', xy: [201157.33, 557301.3], node: '561a12b4', leadsTo: '계단 13단쯤 → 대일관 1층 로비(151.0 m 추정). 서쪽 길 45682ee7 → 사잇길',
    grade: '위치 추정(운영 노드 자리, 길 이름에 "추정") / 높이 측정(E06, E07의 이동값 148.958)', note: '운영 노드 재사용. 저장 높이 141.73 m라 D04(지형+도로 이동) 뒤에만 접근점이 된다. 학교 표지 대일관 입구(1) (201155.2, 557310.0)에서 8.9 m 남쪽. S-MAP 1 m 격자에서 땅이 오르기 시작하는 곳은 노드에서 4.9 m 북쪽(면 경계 201157.4, 557306.2)',
    stair: { lowerXY: [201157.4, 557306.2], lowerM: FLOOR, upperXY: [201155.2, 557310.0], upperM: 151.0, risers: '13단(건물 노트: 사진에서 센 값 ±1)', grade: '아래 끝 = S-MAP 지면이 148.9에서 오르기 시작하는 면 경계(추정 ±2 m) / 위 끝 = 학교 표지 대일관 입구(1)(원천) / 1층 151.0 m = 148.9 + 13단 약 2.1 m(추정 ±0.3)' } },
  { id: 'AP-SANGSEUNG-STAIR-L', name: '상승관으로 올라가는 왼쪽 계단 아래 (사용자 그림. 2차 주석 A2 = 대일관 화단 벽 동쪽 끝 계단과 같은 곳으로 봄)', xy: [201205.4, 557289.5], leadsTo: '화단 사이 단 → 상승관 입구(학교 표지 150.9 m, S-MAP), 대일관 입구(2) 1층 복도 151.7 m, 안쪽 마당 153.1 m',
    grade: '확정(사용자: 운동장에서 좌우 두 계단 중 하나로 올라간다) / 위치 추정 ±3 m(사용자 그림을 카카오 항공사진에 맞춤, 맞춤 오차 0.07 m, 항공사진 자체의 어긋남은 확인 못 함)', note: '운영 노드 없음. 옛 제안 A2 (201207.5, 557288.4)에서 2.4 m',
    stair: { lowerXY: [201205.01, 557287.4], lowerM: FLOOR, upperXY: [201205.4, 557294.5], upperM: 150.9, risers: '모름', grade: '아래·위 끝 = 사용자 그림의 계단 뭉치 양 끝(추정 ±3 m) / 위 높이 150.9 m = 4.9 m 서쪽 학교 입구 표지 자리의 S-MAP 값(추정. 위 끝 옆 지면은 151.0~151.2 m)' } },
  { id: 'AP-SANGSEUNG-STAIR-R', name: '상승관으로 올라가는 오른쪽 계단 아래 (사용자 그림, 청운관 서쪽 벽 쪽)', xy: [201214.0, 557283.0], leadsTo: '화단 사이 단 → 안쪽 마당 153.1 m(S-MAP) → 상승관',
    grade: '확정(사용자: 좌우 두 계단) / 위치 추정 ±4 m: 그림의 뭉치(201210.7~201213.9, 557290.2~557294.2)는 계단 위쪽에 그려져 있어, 운동장에 닿는 끝은 S-MAP에서 청운관 서쪽 벽을 따라 153.0 → 149.0 m로 내려오는 비탈(S-MAP x 201211~201213, 항공사진의 포장 띠 x 201215.5~201217)의 아래 끝으로 잡았다', note: '운영 노드 없음. 청운관 1층 입구 표지에서 4 m 안팎이라 같은 문 앞일 수 있다(추정)',
    stair: { lowerXY: [201214.0, 557283.0], lowerM: FLOOR, upperXY: [201210.8, 557294.2], upperM: [152.0, 153.1], risers: '모름', grade: '아래 끝 = S-MAP 비탈의 아래 끝(추정 ±4 m) / 위 끝 = 사용자 그림의 뭉치 위 끝(추정 ±3 m) / 위 높이 = 그 자리 S-MAP 지면 152.0 m ~ 안쪽 마당 153.1 m(S-MAP 면이 뭉개져 단 높이는 추정)' } },
  { id: 'AP-CHEONGUN-1F', name: '청운관 1층 입구', xy: [201216.5, 557279.8], leadsTo: '청운관 1층(148.9 m)', grade: '원천(학교 표지: 위치·층) / 측정(높이). 문의 정확한 자리는 모름(현장 요청 F5 ①)', note: '운영 노드 없음. 가까운 62a3ac5d(150.8 m)는 높이가 달라 같은 점으로 보지 않는다' },
  { id: 'AP-CHEONGUN-A5', name: '청운관에서 내려오는 계단 아래 (2차 주석 A5)', xy: null, leadsTo: '청운관 쪽 위', grade: '모름: 후보 (201231.4, 557271.4)~(201234, 557264) ±8 m, 어느 끝이 운동장 바닥인지 모름(F5 ②)', note: '좌표를 정하지 않았다' },
  { id: 'AP-HYEIN-B1', name: '혜인관 입구(1): 운동장 높이 문 = B1, 오른쪽 계단 위가 1층 로비', xy: [201218.7, 557213.7], leadsTo: '혜인관 B1(149.3 m, S-MAP) → 계단 → 1층 로비(153.4 m 추정)', grade: '원천(학교 표지: 위치) / 확정(사용자: 운동장 높이 문 = B1) / S-MAP(높이)',
    note: '운영 길 3910b4a5가 5.0 m 서쪽 (201213.72, 557213.9)을 지나 B1 노드 435187c0(150.26 m)로 간다. 그 꼭짓점에서 길을 자르면 생기는 노드를 접근점으로 쓴다(제안)' },
  { id: 'AP-HYEIN-B1-2', name: '혜인관 입구(2) B1층', xy: [201247.7, 557255.8], leadsTo: '혜인관 B1(149.6 m, S-MAP)', grade: '원천(학교 표지: 위치·층) / S-MAP(높이)', note: '운영 노드 없음' },
  { id: 'AP-EUNJU1-5F', name: '은주1관 입구(2) 5층', xy: [201135.8, 557250.2], leadsTo: '은주1관 5층(148.9 m)', grade: '원천(학교 표지: 위치·층) / 확정(사용자: 운동장에서 바로 들어가는 문 = 5층) / 측정(높이)', note: '운영 노드 없음. 은주관 실내 길 0개' },
  { id: 'AP-EUNJU2-5F', name: '은주2관 입구(2) 5층', xy: [201201.8, 557168.3], leadsTo: '은주2관 5층(148.9 m)', grade: '원천(학교 표지: 위치·층) / 확정(사용자) / 측정(높이)', note: '운영 노드 없음' },
  { id: 'AP-HANLIM-6F', name: '한림관 6층에서 올라오는 계단 6칸쯤의 위 끝 (한림관·은주1관 모퉁이, 운동장 쪽)', xy: [201148.0, 557304.0], leadsTo: '계단 6칸쯤 아래 → 한림관 6층(147.9 m)·은주1관 5층 연결통로',
    grade: '확정(사용자: 6층에서 계단 6칸쯤을 올라와 운동장 높이 길, 위 끝은 운동장 쪽) / 위치 추정 ±3 m(S-MAP 1 m 격자: 은주1관 북쪽 끝 바로 북쪽에 147.0~148.0 m 자리, x 201150부터 148.9 m)', note: '운영 노드 없음. S-MAP 면에는 한림관으로 건너가는 통로가 없다(x 201128~201136에서 땅이 132~146 m로 꺼짐). 학교 표지 한림관–은주관 연결통로 (201131.7, 557297.5)에서 17.5 m',
    stair: { lowerXY: [201140.0, 557304.0], lowerM: 147.9, upperXY: [201149.0, 557304.0], upperM: FLOOR, risers: '6칸쯤(사용자)', grade: '높이차 약 1 m 확정(사용자) / 아래 끝 = S-MAP 147.6~148.1 m 칸의 가운데(추정 ±3 m). S-MAP은 1 m 계단을 9 m 비탈로 뭉갠다' } },
];
const access = ACCESS.map((a) => {
  if (!a.xy) return { ...a, placed: false as const };
  const edge = poly.nearestOnBoundary(a.xy), isIn = poly.covers(a.xy);
  const at: XY = isIn ? a.xy : [r2(edge.point[0]), r2(edge.point[1])];
  return { ...a, placed: true as const, insideArea: isIn, distanceToBoundaryM: r1(edge.d), side: side(at), accessXY: at, ...(a.stair ? { stair: ((s: Stair) => ({ ...s, lengthM: r1(dist(s.lowerXY, s.upperXY)) }))({ ...a.stair, ...(isIn ? {} : a.stair.lowerM === FLOOR ? { lowerXY: at } : { upperXY: at }) }) } : {}), // 운동장 쪽 끝 = 면 경계의 접근점
    terrainOldM: r2(bilinear(grid, oldH, at[0], at[1])!), terrainFieldCandidateM: r2(bilinear(grid, newH, at[0], at[1])!) };
});

const placed = access.filter((a) => a.placed) as any[];

// ---- 운동장 위에 저장된 길과 노드(스냅숏)
const onField = roads.map((r) => ({ r, inside: r.coordinates.filter((c: number[]) => poly.covers([c[0], c[1]])).length })).filter((x) => x.inside > 0)
  .map(({ r, inside: n }) => ({ id: s8(r.id), name: r.name, structure: r.structure, buildingId: r.buildingId, updatedBy: r.updatedBy, vertices: r.coordinates.length, verticesInside: n, lengthM: r1(r.lengthM),
    zMinM: Math.min(...r.coordinates.map((c: number[]) => c[2])), zMaxM: Math.max(...r.coordinates.map((c: number[]) => c[2])), pedestrianAccess: r.pedestrianAccess, revision: r.revision }));
const nodesOnField = nodes.filter((n) => poly.covers([n.coordinate[0], n.coordinate[1]]) || poly.nearestOnBoundary([n.coordinate[0], n.coordinate[1]]).d <= 0.5)
  .map((n) => ({ id: s8(n.id), z: n.coordinate[2], offFloorM: r2(n.coordinate[2] - FLOOR), accessToday: Math.abs(n.coordinate[2] - FLOOR) <= 0.5, roads: roads.filter((r) => r.fromNodeId === n.id || r.toNodeId === n.id).map((r) => s8(r.id)) }));

// ---- 길찾기 모의 (보행, 접근 "unknown"을 통과로 볼 때와 아닐 때)
const area: WalkArea = { id: 'E10', name: '운동장', elevationM: FLOOR, floor: null, rings: [ring] };
const full = (short: string) => nodes.find((n) => n.id.startsWith(short))!.id;
const A = full('561a12b4'), H = full('435187c0');
const graph = (rs: any[]): ReachRoad[] => rs.map((r) => ({ ...r, lengthM: r.coordinates.slice(1).reduce((s: number, p: number[], i: number) => s + Math.hypot(p[0] - r.coordinates[i][0], p[1] - r.coordinates[i][1]), 0) }));
const reach = (rs: ReachRoad[], ns: any[], a: string, b: string) => Object.fromEntries(([['strict', false], ['unknownAllowed', true]] as const).map(([k, assume]) => {
  const x = checkReachability(rs, ns, a, b, 'pedestrian', assume);
  return [k, x.reachable ? { lengthM: r1(x.lengthM), via: x.roads.map((r) => (r.roadId.startsWith('area:') ? `면(${r1(r.lengthM)} m)` : s8(r.roadId))) } : { reachable: false }];
}));
const today = reach(graph(roads), nodes, A, H);
const linksToday = areaLinks([area], nodes).length;
// D04(E07 규칙) 뒤: 561a12b4 148.958 m (E07 결과). 길 3910b4a5의 얹힌 꼭짓점은 새 지형 높이가 된다.
const nodesD04 = nodes.map((n) => (n.id === A ? { ...n, coordinate: [n.coordinate[0], n.coordinate[1], 148.958] } : n));
const linksD04 = areaLinks([area], nodesD04).length;
// + 3910b4a5를 꼭짓점 10에서 자름 → 새 노드 X (혜인관 문 앞)
const c02 = roads.find((r) => r.id.startsWith('3910b4a5'))!;
const CUT = 10, cut = c02.coordinates[CUT] as number[];
const X = { id: 'E10-X-hyein-door', kind: 'junction', levelId: null, coordinate: [cut[0], cut[1], r2(bilinear(grid, newH, cut[0], cut[1])!)] };
const pieceA = { ...c02, id: '3910b4a5-A(운동장 구간)', toNodeId: X.id, coordinates: c02.coordinates.slice(0, CUT + 1) };
const pieceB = { ...c02, id: '3910b4a5-B(혜인관 문 앞)', fromNodeId: X.id, coordinates: c02.coordinates.slice(CUT) };
const nodesSplit = [...nodesD04, X], roadsSplit = [...roads.filter((r) => r !== c02), pieceA, pieceB];
const linksSplit = areaLinks([area], nodesSplit);
const lineOnly = reach(graph(roadsSplit), nodesSplit, A, H);
const withArea = reach([...graph(roadsSplit), ...linksSplit], nodesSplit, A, H);
const retired = reach([...graph(roadsSplit.filter((r) => r !== pieceA)), ...linksSplit], nodesSplit, A, H);
// 접근점 전부가 노드로 있다고 볼 때(가정): 면 안 최단 거리 표
const hypo = placed.map((a) => ({ id: a.id, levelId: null, coordinate: [a.accessXY[0], a.accessXY[1], FLOOR] as [number, number, number] }));
const hypoLinks = areaLinks([area], hypo);
const matrix = hypoLinks.map((l) => ({ from: l.fromNodeId, to: l.toNodeId, lengthM: r1(l.lengthM), straightM: r1(dist(l.coordinates[0], l.coordinates.at(-1)!)), bends: l.coordinates.length - 2 }));

// ---- 산출물
const areaBody = { name: '운동장', kind: 'other', elevationM: FLOOR, buildingId: null, floor: null,
  note: 'E10 제안. 경계 = S-MAP 평지 칸 윤곽(field-surfaces-v3 SF-FIELD)을 2 m(한 칸) 허용으로 단순화. 바닥 148.9 m = E06 측정.', coordinates: ring };
const results = {
  title: 'E10 운동장을 면으로', applied: false,
  inputs: { snapshot: 'claude-live/roads-live-2.json (128) / nodes-live-2.json (118) / mobility-live.json', openAreasToday, polygonSource: 'frontend/public/corrections/field-surfaces-v3.geojson SF-FIELD', floorM: FLOOR },
  polygon: { vertices: ring.length, areaM2: Math.round(ringArea(ring)), sourceCellVertices: cells.length, sourceCellAreaM2: Math.round(ringArea(cells)), simplifyToleranceM: TOL,
    photo15AreaM2: Math.round(ringArea(photo)), sides, overlapWithBuildingOutlinesM2: overlap,
    terrainMinusFloor: { old: terrainStats(oldH), fieldCandidateT01: terrainStats(newH) } },
  access, nodesOnField, roadsOnField: onField,
  routing: {
    pair: '561a12b4(대일관 현관 앞 계단 아래) → 435187c0(혜인관 B1 통로 노드)',
    today, areaLinksWithTodayHeights: linksToday, areaLinksAfterD04Only: linksD04,
    afterD04AndSplit: { newNode: X, lineOnly, withArea, withAreaAndFieldPieceRetired: retired,
      fieldPieceLengthM: r1(graph([pieceA])[0].lengthM), areaLinkLengthM: linksSplit[0] ? r1(linksSplit[0].lengthM) : null, areaLinkBends: linksSplit[0] ? linksSplit[0].coordinates.length - 2 : null },
    ifEveryAccessPointWereANode: matrix,
  },
};
const ops = {
  title: 'E10 운동장 면과 접근점 편집 제안', applied: false, requiresUserApproval: true,
  basedOn: { snapshot: 'claude-live/roads-live-2.json (128 roads) / nodes-live-2.json (118 nodes), 2026-10-09T11:05:34Z', coordinatePrecisionM: 0.01 },
  never: 'id가 6f2a4bcd, 7408c108로 시작하는 삭제된 길은 되살리지 않는다. revert_changeset로 그 삭제를 되돌리지 않는다.',
  operations: [
    { id: 'E10-0', what: '선행: D04(운동장 지형 후보 켜기 + terrain:relevel-roads)', expectedPreState: '노드 561a12b4 높이 141.73, 활성 지형의 운동장 안 141.7 안팎', expectedPostState: '노드 561a12b4 높이 148.958, 운동장 안 지형 148.9 ± 0.1', why: '면의 접근점은 면 바닥 ±0.5 m 높이의 노드뿐이다' },
    { id: 'E10-1', what: '공간 영역 만들기', how: 'POST /api/v1/editor/areas (편집기 로그인 토큰) 또는 편집기 "공간 영역 → 공간 그리기"', expectedPreState: `GET /api/v1/editor/areas 에 이름 "운동장" 없음(스냅숏 공간 ${openAreasToday}개)`, body: areaBody, expectedPostState: `areaM2 ≈ ${Math.round(ringArea(ring))}` },
    { id: 'E10-2', what: '운동장 가로지르는 수집 경로를 혜인관 문 앞에서 자르기', op: 'split_road', args: { roadId: c02.id, expectedRevision: c02.revision, nearest: [cut[0], cut[1]] },
      expectedPreState: `길 ${s8(c02.id)} "${c02.name}" revision ${c02.revision}, 꼭짓점 ${c02.coordinates.length}개, 길이 ${r1(c02.lengthM)} m, 양 끝 561a12b4·435187c0`, expectedPostState: `운동장 구간 약 ${r1(graph([pieceA])[0].lengthM)} m + 문 앞 구간 약 ${r1(graph([pieceB])[0].lengthM)} m, 새 노드 높이 ≈ ${X.coordinate[2]} (D04 뒤)` },
    { id: 'E10-3', what: '운동장 구간(561a12b4 쪽 조각)을 보관 처리', op: 'retire_feature', args: { type: 'road', id: '<E10-2가 돌려준 561a12b4 쪽 조각 id>', expectedRevision: '<그 조각의 revision>' }, decision: '사용자 결정 필요: C02 수집 경로다. 지우지 않고 RETIRED로만 둔다(되돌리기 가능).',
      expectedPreState: 'check_reachability 561a12b4 → 435187c0 이 "area:" 구간으로 이어짐을 먼저 확인' },
    { id: 'E10-5', what: '계단 제안(B09): 상승관 왼쪽·오른쪽 계단(운동장 → 화단 사이 단), 한림관 6층 계단(6칸쯤, 147.9 → 148.9 m), 대일관 현관 계단(13단, 148.9 → 151.0 m)', how: 'access-points.geojson 의 stair(lowerXY·upperXY·높이)를 계단 길로 그린다. 운동장 쪽 끝 노드를 면 경계의 접근점, 높이 148.9 m에 둔다', stairs: placed.filter((a) => a.stair).map((a) => ({ accessPoint: a.id, ...a.stair })),
      decision: '좌표가 추정(±3~4 m)이고 단 수·단 위 높이를 모르는 계단이 있다(상승관 둘). 사용자 확인 뒤에 그린다. 지금 만들지 않는다.' },
    { id: 'E10-4', what: '나머지 접근점(은주1관·은주2관 5층, 청운관 1층, 혜인관 입구(2))', how: '각 문의 실내 길·계단을 그릴 때 끝 노드를 access-points.geojson의 점, 높이 148.9 m에 둔다', decision: '문 좌표가 학교 표지(±수 m)뿐이라 지금 노드를 만들지 않는다. 길 없는 노드는 저장할 수 없다.' },
  ],
  notProposed: ['4ee99835(C02 수집 경로, 149.7~150.7 m)·02d30f2b(150.7~150.8 m): 면 안을 지나지만 높이가 바닥보다 0.8~1.9 m 높고 출처가 미해결(E07 G3). 손대지 않는다', 'a789c985 지하주차장 통로·혜인관 실내 길: 면 아래·건물 안이라 대상 아님', '면 경계를 건물 외곽으로 자르기'],
};
mkdirSync(outDir, { recursive: true });
const fc = (features: any[]) => ({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5186' } }, features });
writeFileSync(`${outDir}/field-area.geojson`, JSON.stringify(fc([{ type: 'Feature', properties: { ...areaBody, coordinates: undefined, areaM2: Math.round(ringArea(ring)), applied: false }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }]), null, 1));
writeFileSync(`${outDir}/access-points.geojson`, JSON.stringify(fc(placed.map((a) => ({ type: 'Feature', properties: { ...a, xy: undefined, accessXY: undefined, markerXY: a.xy, elevationM: FLOOR }, geometry: { type: 'Point', coordinates: a.accessXY } }))), null, 1));
writeFileSync(`${outDir}/editor-ops.json`, JSON.stringify(ops, null, 1));
writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 1));

// ---- 평면도
const pad = 22, x0 = Math.min(...xs) - pad, y1 = Math.max(...ys) + pad, W = Math.max(...xs) - Math.min(...xs) + 2 * pad, Hh = Math.max(...ys) - Math.min(...ys) + 2 * pad, k = 8;
const px = (p: number[]) => ((p[0] - x0) * k).toFixed(1), py = (p: number[]) => ((y1 - p[1]) * k).toFixed(1);
const path = (r: number[][], close = true) => `M${r.map((p) => `${px(p)},${py(p)}`).join('L')}${close ? 'Z' : ''}`;
const label = (p: number[], t: string, c = '#111', dy = -8) => `<text x="${px(p)}" y="${(Number(py(p)) + dy).toFixed(1)}" font-size="13" fill="${c}" text-anchor="middle" font-family="Malgun Gothic, sans-serif" stroke="#fff" stroke-width="3" paint-order="stroke">${t}</text>`;
const inView = (c: number[]) => c[0] > x0 && c[0] < x0 + W && c[1] < y1 && c[1] > y1 - Hh;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * k}" height="${Hh * k}"><rect width="100%" height="100%" fill="#fff"/>
${buildings.map((b) => b.coordinates.map((pg) => `<path d="${path(pg[0])}" fill="#e5e7eb" stroke="#9ca3af"/>`).join('')).join('')}
<path d="${path(cells)}" fill="none" stroke="#86efac" stroke-width="1"/>
<path d="${path(ring)}" fill="#22c55e" fill-opacity="0.25" stroke="#15803d" stroke-width="2.5"/>
<path d="${path(photo)}" fill="none" stroke="#a855f7" stroke-width="1.2" stroke-dasharray="6 4"/>
${roads.filter((r) => r.coordinates.some(inView)).map((r) => `<path d="${path(r.coordinates, false)}" fill="none" stroke="${r === c02 ? '#dc2626' : '#6b7280'}" stroke-width="${r === c02 ? 2.5 : 1.3}"/>`).join('')}
${hypoLinks.map((l) => `<path d="${path(l.coordinates, false)}" fill="none" stroke="#2563eb" stroke-width="0.8" stroke-opacity="0.55"/>`).join('')}
${linksSplit.map((l) => `<path d="${path(l.coordinates, false)}" fill="none" stroke="#1d4ed8" stroke-width="3"/>`).join('')}
${placed.map((a) => `<path d="${path([a.xy, a.accessXY], false)}" stroke="#f59e0b" stroke-width="1.5" fill="none"/><circle cx="${px(a.accessXY)}" cy="${py(a.accessXY)}" r="6" fill="${a.node ? '#1d4ed8' : '#f59e0b'}" stroke="#fff" stroke-width="2"/>${label(a.accessXY, a.id.replace('AP-', ''), '#92400e', 20)}`).join('')}
${placed.filter((a) => a.stair).map((a) => `<path d="${path([a.stair.lowerXY, a.stair.upperXY], false)}" stroke="#be123c" stroke-width="5" fill="none"/>`).join('')}
<circle cx="${px(X.coordinate)}" cy="${py(X.coordinate)}" r="5" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>
${buildings.map((b) => { const r = b.coordinates[0][0]; const c = [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; return inView(c) ? label(c, b.name, '#374151', 0) : ''; }).join('')}
<text x="12" y="22" font-size="14" font-family="Malgun Gothic, sans-serif">E10 운동장 면 제안 (EPSG:5186, 위가 북). 초록 = 면 ${Math.round(ringArea(ring))}㎡·148.9 m, 연초록 선 = S-MAP 평지 칸, 보라 점선 = 사진15 경계(참고)</text>
<text x="12" y="42" font-size="14" font-family="Malgun Gothic, sans-serif">빨강 = 운동장을 가로지르는 저장 길 3910b4a5, 굵은 파랑 = 같은 두 점을 면으로 이은 선, 가는 파랑 = 접근점이 모두 노드일 때(가정), 주황 = 학교 표지·사용자 그림에서 면 경계로 옮긴 접근점(추정), 굵은 자주 = 계단 제안(B09)</text>
</svg>`;
mkdirSync(dirname(png), { recursive: true });
writeFileSync(png, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
console.log(JSON.stringify({ polygon: results.polygon, nodesOnField, routing: results.routing, access: access.map((a: any) => [a.id, a.placed ? [a.insideArea, a.distanceToBoundaryM, a.side, a.accessXY, a.terrainOldM, a.terrainFieldCandidateM] : 'unplaced']), roadsOnField: onField.map((r) => [r.id, r.lengthM, r.verticesInside, r.zMinM, r.zMaxM]) }));
