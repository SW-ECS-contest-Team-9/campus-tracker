// 국소 표면 보정(1차, 추정) — 기존 Cesium scene 위에 덧그리는 검토용 레이어. 원본 건물·지형·실내 경로·운영 DB는 바꾸지 않는다.
// 자료: frontend/public/corrections/*.geojson (EPSG:5186, 각 파일 provenance에 원천 경로·SHA256). 좌표 변환은 tm.ts(백엔드 geo/tm.ts와 같은 식).
// 피처 종류: kind=extrude (평면 폴리곤, fromM→toM 압출) / kind=surface (3D 폴리곤 z 원값, 면 그대로) / kind=line (3D 선). 모든 피처는 properties.source 필수.
// 그룹: corrected(원천 표면) / estimated(추정 구조 — 모든 피처에 estimated=true·assumption 필수, 별도 토글).
import { tmInverse } from './tm';

type CesiumNS = typeof import('cesium');

export type CorrectionGroup = 'corrected' | 'estimated';
export const CORRECTION_FILES: { file: string; group: CorrectionGroup }[] = [
  { file: 'munye-highrise-v2.geojson', group: 'corrected' }, // v1(셀 윤곽)은 비교용으로 파일만 보존
  { file: 'field-surfaces-v3.geojson', group: 'corrected' },
  { file: 'field-structures-est-v1.geojson', group: 'estimated' },
  // 다른 작업자 산출 예정(아직 없으면 pending): 평지 경계·계단 끝점 v4
  { file: 'field-boundary-v4.geojson', group: 'estimated' },
  { file: 'stair-endpoints-v4.geojson', group: 'estimated' },
];

export type CorrectionFeature = {
  id: string;
  file: string;
  kind: 'extrude' | 'surface' | 'line';
  type?: string;
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
    const kind = p.kind === 'extrude' || p.kind === 'surface' || p.kind === 'line' ? p.kind : null;
    if (!p.source) { errors.push(`${file}:${id} source 없음`); continue; }
    if (group === 'estimated' && !(p.estimated === true && p.assumption)) { errors.push(`${file}:${id} estimated/assumption 없음`); continue; }
    if (!kind) { errors.push(`${file}:${id} kind 알 수 없음`); continue; }
    if (kind === 'extrude' && !(Number.isFinite(p.fromM) && Number.isFinite(p.toM) && p.toM > p.fromM)) { errors.push(`${file}:${id} fromM/toM 잘못됨`); continue; }
    const g = f.geometry;
    const polys: number[][][][] = kind === 'line' ? (g?.type === 'LineString' ? [[g.coordinates]] : []) : g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) { errors.push(`${file}:${id} 도형 종류 불일치`); continue; }
    if ((kind === 'surface' || kind === 'line') && polys.some((poly) => poly.some((ring) => ring.some((c) => !Number.isFinite(c[2]))))) { errors.push(`${file}:${id} surface에 z 없음`); continue; }
    const polygons = polys.map((poly) => poly.map((ring) => ring.map(([x, y, z]) => {
      const { latitude, longitude } = tmInverse(x, y);
      return z === undefined ? [longitude, latitude] : [longitude, latitude, z];
    })));
    features.push({ id, file, kind, type: p.type, source: String(p.source), fromM: p.fromM, toM: p.toM, polygons });
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
export async function addLocalCorrections(C: CesiumNS, viewer: any, base = '/corrections/') {
  const loaded: string[] = [];
  const pending: string[] = [];
  const errors: string[] = [];
  const byGroup: Record<CorrectionGroup, CorrectionFeature[]> = { corrected: [], estimated: [] };
  for (const { file, group } of CORRECTION_FILES) {
    const fc = await loadFile(base, file);
    if (!fc) { pending.push(file); continue; }
    const r = parseCorrections(file, fc, group);
    loaded.push(file);
    byGroup[group].push(...r.features);
    errors.push(...r.errors);
  }
  const prims = { corrected: draw(C, viewer, byGroup.corrected, false), estimated: draw(C, viewer, byGroup.estimated, true) };
  if (errors.length) console.warn('local corrections rejected', errors);
  return {
    loaded, pending, errors, ids: [...byGroup.corrected, ...byGroup.estimated].map((f) => f.id),
    setVisible(show: boolean, group: CorrectionGroup = 'corrected') {
      for (const p of prims[group]) p.show = show;
      viewer.scene.requestRender?.();
    },
  };
}

// 면마다 다른 색(띠/평지/지붕 구분) + 테두리선. surface는 지형과 같은 높이에서 깜박이지 않게 polygon offset으로 앞쪽에 그림.
// MY-T(압출)는 반투명: 원본 건물의 불명확 가장자리(MY-R)와 아래 저층이 덩어리 안에 묻히지 않고 보이게.
// 추정 구조는 종류별 색(옹벽·화단·계단·참·외곽선).
const PALETTE = ['#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#f97316'];
const EST_COLORS: Record<string, string> = { retaining_wall: '#78716c', planter: '#4d7c0f', stair_step: '#fb923c', landing: '#fdba74', outline: '#ffffff', stair_outline: '#fb923c', open_slab: '#38bdf8', column: '#0369a1' };
const TYPE_COLORS: Record<string, string> = { high_rise: '#60a5fa', low_wing: '#a78bfa' };

function draw(C: CesiumNS, viewer: any, features: CorrectionFeature[], estimated: boolean): any[] {
  const extrudes: any[] = [];
  const surfaces: any[] = [];
  const outlines = new C.PolylineCollection({ show: false });
  features.forEach((f, i) => {
    const css = estimated ? EST_COLORS[f.type ?? ''] ?? '#fb923c' : f.kind === 'extrude' ? TYPE_COLORS[f.type ?? ''] ?? '#60a5fa' : PALETTE[i % PALETTE.length];
    const color = C.Color.fromCssColorString(css).withAlpha(estimated ? 1 : f.kind === 'extrude' ? 0.55 : 0.8);
    const edge = C.Material.fromType('Color', { color: C.Color.fromCssColorString(css).darken(0.35, new C.Color()) });
    for (const poly of f.polygons) {
      if (f.kind === 'line') {
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
      (f.kind === 'extrude' ? extrudes : surfaces).push(new C.GeometryInstance({ geometry, id: { kind: 'correction', id: f.id, source: f.source }, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) } }));
      outlines.add({ positions: C.Cartesian3.fromDegreesArrayHeights(outer.flatMap(([lon, lat, z]) => [lon, lat, z + 0.05])), width: estimated ? 1 : 2, material: edge });
    }
  });
  const add = (instances: any[], translucent: boolean, offset: boolean) => instances.length
    ? viewer.scene.primitives.add(new C.Primitive({
      geometryInstances: instances,
      appearance: new C.PerInstanceColorAppearance({ translucent, closed: false, renderState: offset ? { polygonOffset: { enabled: true, factor: -1, units: -4 } } : undefined }),
      asynchronous: false, show: false,
    }))
    : null;
  return [add(surfaces, true, true), add(extrudes, !estimated, false), viewer.scene.primitives.add(outlines)].filter(Boolean);
}
