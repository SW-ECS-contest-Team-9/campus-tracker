// 국소 표면 보정(1차, 추정) — 기존 Cesium scene 위에 덧그리는 검토용 레이어. 원본 건물·지형·실내 경로·운영 DB는 바꾸지 않는다.
// 자료: frontend/public/corrections/*.geojson (EPSG:5186, 각 파일 provenance에 원천 경로·SHA256). 좌표 변환은 tm.ts(백엔드 geo/tm.ts와 같은 식).
// 피처 종류: kind=extrude (평면 폴리곤, fromM→toM 압출) / kind=surface (3D 폴리곤 z 원값, 면 그대로) / kind=line (3D 선)
//   / kind=clip (이 평면 안 렌더 지형을 잘라냄, globe clippingPolygons) / kind=skirt (3D 선 z ↔ otherZ 세로 면)
//   / kind=override (원본 건물 하나의 평면을 표시용으로 대체, 끄면 원본). 모든 피처는 properties.source 필수.
// 그룹: corrected(원천 표면) / estimated(추정 구조 — 모든 피처에 estimated=true·assumption 필수, 별도 토글).
import { tmInverse } from './tm';

type CesiumNS = typeof import('cesium');

export type CorrectionGroup = 'corrected' | 'estimated' | 'stairCandidate' | 'stairV6' | 'pathGraph';
export const CORRECTION_FILES: { file: string; group: CorrectionGroup }[] = [
  { file: 'munye-highrise-v2.geojson', group: 'corrected' }, // v1(셀 윤곽)은 비교용으로 파일만 보존
  { file: 'field-surfaces-v3.geojson', group: 'corrected' },
  { file: 's06-centre-surface-v2.geojson', group: 'corrected' }, // R1~R5 및 하단 내부 24표본 사이 추정 면·동일 범위 지형 절단(실제 폭·접속 미검증, v1은 비교용 보존)
  { file: 'corridor-surface-v5.1.geojson', group: 'corrected' }, // 사잇길 = 내부 S-MAP 표본 TIN v5.1(경계에서 실제로 잘린 조각, v3 SF-CORRIDOR 대체), 빈칸은 선만. v4 파일은 비교용 보존
  { file: 'terrain-clip-v1.geojson', group: 'corrected' }, // 표면 구역 안 지형 잘라냄 + 경계 렌더 연결면
  { file: 'field-structures-est-v1.geojson', group: 'estimated' },
  { file: 'field-boundary-v4.geojson', group: 'estimated' }, // 사진15 재대응 경계(참고선)
  { file: 'cheongun-split-v1.geojson', group: 'estimated' }, // 청운관 본체/돌출부 분리(원본 건물 평면 대체), 지붕 슬래브가 원 지붕 셀 면 대체
  { file: 'stair-endpoints-v6.geojson', group: 'estimated' }, // 계단 끝점 상태 v6 + 제안 계단 선(v4·v5는 파일만 보존)
  // 비교 'DRAFT 계단 노출 비교': 기존 DRAFT 기반 추정 계단 자리만 사잇길 면 절단(Corrected 위에서만)
  { file: 'corridor-stair-cut-v1.geojson', group: 'stairCandidate' },
  // 경쟁 후보 'v6 계단 후보': v6 끝점에 맞춘 새 추정 계단 + 그 자리 사잇길 대체(Corrected 위에서만, 켜면 DRAFT 비교보다 우선, 기존 DRAFT 계단 숨김)
  { file: 'stairs-v6-est.geojson', group: 'stairV6' },
  // '길 사슬 후보': path-graph-candidate-v2.json을 integrate_path_graph.py로 변환. 그래프 상태(+0.3 m)와 표면 접속 상태(+1.0 m)를 따로 표시
  { file: 'path-graph-candidate.geojson', group: 'pathGraph' },
  { file: 'access-comparison-v1.geojson', group: 'pathGraph' }, // S06 차도·S07 문턱과 기존 DEM/DRAFT 길 비교(접속 미검증)
];

export type CorrectionFeature = {
  id: string;
  file: string;
  kind: 'extrude' | 'surface' | 'line' | 'clip' | 'skirt' | 'override';
  type?: string;
  replaces?: string;
  buildingId?: string;
  otherZ?: number[];
  /** EPSG:5186 원 좌표(override용, campus-map 평면 대체는 WGS84 polygons 사용) */
  source: string;
  fromM?: number;
  toM?: number;
  /** WGS84 rings: [lon, lat, z?][] per ring, first ring outer. One entry per polygon. */
  polygons: number[][][][];
};

/** EPSG:5186 GeoJSON → 표시용 피처. source 없는 피처, 알 수 없는 kind는 거부(오류 목록에 기록). */
export function parseCorrections(file: string, fc: any, group: CorrectionGroup = 'corrected'): { features: CorrectionFeature[]; errors: string[] } {
  const features: CorrectionFeature[] = [];
  const errors: string[] = [];
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {};
    const id = String(p.id ?? '?');
    const kind = ['extrude', 'surface', 'line', 'clip', 'skirt', 'override'].includes(p.kind) ? p.kind as CorrectionFeature['kind'] : null;
    if (!p.source) { errors.push(`${file}:${id} source 없음`); continue; }
    if (group !== 'corrected' && !(p.estimated === true && p.assumption)) { errors.push(`${file}:${id} estimated/assumption 없음`); continue; }
    if (!kind) { errors.push(`${file}:${id} kind 알 수 없음`); continue; }
    if (kind === 'extrude' && !(Number.isFinite(p.fromM) && Number.isFinite(p.toM) && p.toM > p.fromM)) { errors.push(`${file}:${id} fromM/toM 잘못됨`); continue; }
    const g = f.geometry;
    if (kind === 'skirt' && !(Array.isArray(p.otherZ) && p.otherZ.length === g?.coordinates?.length)) { errors.push(`${file}:${id} skirt otherZ 길이 불일치`); continue; }
    if (kind === 'override' && !p.buildingId) { errors.push(`${file}:${id} override buildingId 없음`); continue; }
    const polys: number[][][][] = kind === 'line' || kind === 'skirt' ? (g?.type === 'LineString' ? [[g.coordinates]] : []) : g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) { errors.push(`${file}:${id} 도형 종류 불일치`); continue; }
    if ((kind === 'surface' || kind === 'line' || kind === 'skirt') && polys.some((poly) => poly.some((ring) => ring.some((c) => !Number.isFinite(c[2]))))) { errors.push(`${file}:${id} surface에 z 없음`); continue; }
    const polygons = polys.map((poly) => poly.map((ring) => ring.map(([x, y, z]) => {
      const { latitude, longitude } = tmInverse(x, y);
      return z === undefined ? [longitude, latitude] : [longitude, latitude, z];
    })));
    features.push({ replaces: p.replaces, id, file, kind, type: p.type, buildingId: p.buildingId, otherZ: p.otherZ, source: String(p.source), fromM: p.fromM, toM: p.toM, polygons });
  }
  return { features, errors };
}

async function loadFile(base: string, file: string): Promise<any | null> {
  try {
    const res = await fetch(`${base}${file}`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null; // 없는 파일(dev 서버는 index.html을 돌려줌)
    return await res.json();
  } catch {
    return null;
  }
}

/** 보정 레이어 생성(그룹별, 기본 숨김). 없는 파일은 pending으로 보고. */
export type FootprintOverride = { setFootprintOverride(buildingId: string, coordinates: number[][][][] | null): void };
export function readPathConstraints(fc: any): { id: string; note: string }[] {
  const notes = [fc?.provenance?.constraint_notes, fc?.provenance?.omitted_path_notes].flatMap((n) => Array.isArray(n) ? n : []);
  return notes.filter((n) => typeof n?.id === 'string' && typeof n?.note === 'string').map(({ id, note }) => ({ id, note }));
}
export async function addLocalCorrections(C: CesiumNS, viewer: any, sceneLayer: FootprintOverride | null = null, base = '/corrections/') {
  const loaded: string[] = [];
  const pending: string[] = [];
  const errors: string[] = [];
  const pathConstraints: { id: string; note: string }[] = [];
  const byGroup: Record<CorrectionGroup, CorrectionFeature[]> = { corrected: [], estimated: [], stairCandidate: [], stairV6: [], pathGraph: [] };
  const hidesByGroup: Record<CorrectionGroup, string[]> = { corrected: [], estimated: [], stairCandidate: [], stairV6: [], pathGraph: [] };
  for (const { file, group } of CORRECTION_FILES) {
    const fc = await loadFile(base, file);
    if (!fc) { pending.push(file); continue; }
    const r = parseCorrections(file, fc, group);
    loaded.push(file);
    if (group === 'pathGraph') pathConstraints.push(...readPathConstraints(fc));
    byGroup[group].push(...r.features);
    hidesByGroup[group].push(...(fc.provenance?.hides ?? [])); // 이 그룹이 켜지면 숨길 기존 객체 id 접두어
    errors.push(...r.errors);
  }
  const prims = {
    corrected: draw(C, viewer, byGroup.corrected, false), estimated: draw(C, viewer, byGroup.estimated, true),
    stairCandidate: draw(C, viewer, byGroup.stairCandidate, false), stairV6: draw(C, viewer, byGroup.stairV6, true), pathGraph: draw(C, viewer, byGroup.pathGraph, true),
  };
  // 지형 잘라냄: 보정 면 구역 안 렌더 지형만 숨김(DEM 자료 불변). 끄면 clippingPolygons를 비활성화해 원본 그대로.
  const clips = byGroup.corrected.filter((f) => f.kind === 'clip');
  const clipping = clips.length ? new C.ClippingPolygonCollection({
    enabled: false,
    polygons: clips.map((f) => new C.ClippingPolygon({ positions: C.Cartesian3.fromDegreesArray(f.polygons[0][0].slice(0, -1).flatMap(([lon, lat]) => [lon, lat])) })),
  }) : null;
  if (clipping) viewer.scene.globe.clippingPolygons = clipping;
  const replacedBy = (g: CorrectionGroup) => byGroup[g].map((f) => f.replaces).filter(Boolean) as string[];
  const state: Record<CorrectionGroup, boolean> = { corrected: false, estimated: false, stairCandidate: false, stairV6: false, pathGraph: false };
  const apply = () => {
    const v6 = state.corrected && state.stairV6; // 계단 후보들은 Corrected 위에서만 의미
    const draft = state.corrected && state.stairCandidate && !v6;
    const vis: Record<CorrectionGroup, boolean> = { corrected: state.corrected, estimated: state.estimated, stairCandidate: draft, stairV6: v6, pathGraph: state.pathGraph };
    for (const g of Object.keys(prims) as CorrectionGroup[]) for (const p of prims[g]) p.show = vis[g];
    const hidden = new Set<string>([...(state.corrected ? replacedBy('corrected') : []), ...(draft ? replacedBy('stairCandidate') : []), ...(v6 ? replacedBy('stairV6') : []), ...(state.estimated ? replacedBy('estimated') : [])]);
    const prefixes = v6 ? hidesByGroup.stairV6 : [];
    for (const [id, pids] of INSTANCE_IDS) {
      const hide = hidden.has(id) || prefixes.some((x) => id.startsWith(x));
      for (const l of OUTLINES.get(id) ?? []) l.show = !hide;
      for (const pid of pids) for (const p of [...prims.corrected, ...prims.estimated]) {
        const a = p.getGeometryInstanceAttributes ? p.getGeometryInstanceAttributes(pid) : undefined;
        if (a?.show) a.show = C.ShowGeometryInstanceAttribute.toValue(!hide, a.show);
      }
    }
    if (clipping) clipping.enabled = state.corrected;
  };
  if (errors.length) console.warn('local corrections rejected', errors);
  return {
    loaded, pending, errors, pathConstraints, ids: Object.values(byGroup).flat().map((f) => f.id),
    setVisible(show: boolean, group: CorrectionGroup = 'corrected') {
      state[group] = show;
      apply();
      if (group === 'estimated') for (const f of byGroup.estimated) if (f.kind === 'override') sceneLayer?.setFootprintOverride(f.buildingId!, show ? f.polygons : null);
      viewer.scene.requestRender?.();
    },
  };
}

// 면마다 다른 색(띠/평지/지붕 구분) + 테두리선. surface는 지형과 같은 높이에서 깜박이지 않게 polygon offset으로 앞쪽에 그림.
// MY-T(압출)는 반투명: 원본 건물의 불명확 가장자리(MY-R)와 아래 저층이 덩어리 안에 묻히지 않고 보이게.
// 추정 구조는 종류별 색(옹벽·화단·계단·참·외곽선).
const INSTANCE_IDS = new Map<string, { kind: string; id: string; source: string }[]>(); // 피처 id → 인스턴스별 pick id(다각형마다 하나)
const OUTLINES = new Map<string, any[]>(); // 면 테두리선(대체 시 함께 숨김)
const PALETTE = ['#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#f97316'];
const EST_COLORS: Record<string, string> = { retaining_wall: '#78716c', planter: '#4d7c0f', stair_step: '#fb923c', landing: '#fdba74', outline: '#ffffff', stair_outline: '#fb923c', open_slab: '#38bdf8', column: '#0369a1', endpoint_unverified: '#dc2626', endpoint_confirmed: '#16a34a', endpoint_surface_match: '#16a34a', stair_proposal: '#facc15', corridor_cut: '#a5b4fc', path_drawn_only: '#9ca3af', path_connected: '#22c55e', path_graph_connected: '#22c55e', path_unverified: '#f97316', path_candidate_node: '#a855f7', surface_unverified: '#facc15', surface_operational_only: '#3b82f6', gap_unverified: '#ef4444' };
const TYPE_COLORS: Record<string, string> = { high_rise: '#60a5fa', low_wing: '#a78bfa', corridor_cut: '#a5b4fc', corridor_tin: '#818cf8', gap_unverified: '#ef4444' }; // 계단 후보 사잇길 면은 원 면(남색)과 구분되는 연한 남색

function draw(C: CesiumNS, viewer: any, features: CorrectionFeature[], estimated: boolean): any[] {
  const extrudes: any[] = [];
  const surfaces: any[] = [];
  const walls: any[] = [];
  const comparisonLines: any[] = [];
  const outlines = new C.PolylineCollection({ show: false });
  features.forEach((f, i) => {
    const css = estimated ? EST_COLORS[f.type ?? ''] ?? '#fb923c' : f.kind === 'extrude' ? TYPE_COLORS[f.type ?? ''] ?? '#60a5fa' : TYPE_COLORS[f.type ?? ''] ?? PALETTE[i % PALETTE.length];
    const color = C.Color.fromCssColorString(css).withAlpha(estimated ? 1 : f.kind === 'extrude' ? 0.55 : 1);
    const edge = C.Material.fromType('Color', { color: C.Color.fromCssColorString(css).darken(0.35, new C.Color()) });
    if (f.kind === 'clip' || f.kind === 'override') return;
    if (f.kind === 'skirt') {
      const r = f.polygons[0][0];
      const zs = r.map((c) => c[2]);
      walls.push(new C.GeometryInstance({
        geometry: new C.WallGeometry({ positions: C.Cartesian3.fromDegreesArrayHeights(r.flatMap(([lon, lat, z]) => [lon, lat, z])), minimumHeights: zs.map((z, k) => Math.min(z, f.otherZ![k])), maximumHeights: zs.map((z, k) => Math.max(z, f.otherZ![k])), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
        id: { kind: 'correction', id: f.id, source: f.source }, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#a8a29e').withAlpha(0.45)) }, // 렌더 연결면(벽 아님): 중립색 반투명
      }));
      return;
    }
    for (const poly of f.polygons) {
      if (f.kind === 'line') {
        if (f.file === 'access-comparison-v1.geojson') {
          const color = C.Color.fromCssColorString(css);
          comparisonLines.push(viewer.entities.add({
            show: false,
            name: `${f.id} · 비교용·물리 접속 미검증`,
            polyline: {
              positions: C.Cartesian3.fromDegreesArrayHeights(poly[0].flat()),
              width: 3, arcType: C.ArcType.NONE,
              material: color,
              depthFailMaterial: new C.PolylineDashMaterialProperty({ color: color.withAlpha(0.65), dashLength: 16 }),
            },
          }));
          continue;
        }
        outlines.add({ positions: C.Cartesian3.fromDegreesArrayHeights(poly[0].flatMap(([lon, lat, z]) => [lon, lat, z + 0.1])), width: 3, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(css) }) });
        continue;
      }
      const outer = poly[0].map(([lon, lat, z]) => [lon, lat, f.kind === 'surface' ? z : f.toM!]);
      const ring = (r: number[][]) => f.kind === 'surface'
        ? C.Cartesian3.fromDegreesArrayHeights(r.slice(0, -1).flat())
        : C.Cartesian3.fromDegreesArray(r.slice(0, -1).flatMap(([lon, lat]) => [lon, lat]));
      const hierarchy = new C.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new C.PolygonHierarchy(ring(h))));
      const geometry = f.kind === 'extrude'
        ? new C.PolygonGeometry({ polygonHierarchy: hierarchy, height: f.fromM, extrudedHeight: f.toM, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT })
        : new C.PolygonGeometry({ polygonHierarchy: hierarchy, perPositionHeight: true, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT });
      const pickId = { kind: 'correction', id: f.id, source: f.source };
      INSTANCE_IDS.set(f.id, [...(INSTANCE_IDS.get(f.id) ?? []), pickId]); // 다각형마다 별도 객체(getGeometryInstanceAttributes는 참조 비교, 첫 인스턴스만 찾음)
      (f.kind === 'extrude' ? extrudes : surfaces).push(new C.GeometryInstance({ geometry, id: pickId, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color), show: new C.ShowGeometryInstanceAttribute(true) } }));
      if (f.type === 'corridor_tin' || f.type === 'corridor_cut') continue; // 삼각형 조각 테두리는 그리지 않음(면만)
      const line = outlines.add({ positions: C.Cartesian3.fromDegreesArrayHeights(outer.flatMap(([lon, lat, z]) => [lon, lat, z + 0.05])), width: estimated ? 1 : 2, material: edge });
      OUTLINES.set(f.id, [...(OUTLINES.get(f.id) ?? []), line]);
    }
  });
  const add = (instances: any[], translucent: boolean, offset: boolean) => instances.length
    ? viewer.scene.primitives.add(new C.Primitive({
      geometryInstances: instances,
      appearance: new C.PerInstanceColorAppearance({ translucent, closed: false, renderState: offset ? { polygonOffset: { enabled: true, factor: -1, units: -4 } } : undefined }),
      asynchronous: false, show: false,
    }))
    : null;
  // 보정 면은 불투명: 잘라낸 지형 자리를 면이 덮음(깊이 검사는 그대로)
  return [add(surfaces, estimated, true), add(extrudes, !estimated, false), add(walls, true, false), viewer.scene.primitives.add(outlines), ...comparisonLines].filter(Boolean);
}
