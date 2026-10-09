// 국소 표면 보정(1차, 추정) — 기존 Cesium scene 위에 덧그리는 검토용 레이어. 원본 건물·지형·실내 경로·운영 DB는 바꾸지 않는다.
// 자료: frontend/public/corrections/*.geojson (EPSG:5186, 각 파일 provenance에 원천 경로·SHA256). 좌표 변환은 tm.ts(백엔드 geo/tm.ts와 같은 식).
// 피처 종류: kind=extrude (평면 폴리곤, fromM→toM 압출) / kind=surface (3D 폴리곤 z 원값, 면 그대로). 모든 피처는 properties.source 필수.
import { tmInverse } from './tm';

type CesiumNS = typeof import('cesium');

export const CORRECTION_FILES = ['munye-highrise-v1.geojson', 'field-surfaces-v3.geojson'];

export type CorrectionFeature = {
  id: string;
  file: string;
  kind: 'extrude' | 'surface';
  source: string;
  fromM?: number;
  toM?: number;
  /** WGS84 rings: [lon, lat, z?][] per ring, first ring outer. One entry per polygon. */
  polygons: number[][][][];
};

/** EPSG:5186 GeoJSON → 표시용 피처. source 없는 피처, 알 수 없는 kind는 거부(오류 목록에 기록). */
export function parseCorrections(file: string, fc: any): { features: CorrectionFeature[]; errors: string[] } {
  const features: CorrectionFeature[] = [];
  const errors: string[] = [];
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {};
    const id = String(p.id ?? '?');
    const kind = p.kind === 'extrude' || p.kind === 'surface' ? p.kind : null;
    if (!p.source) { errors.push(`${file}:${id} source 없음`); continue; }
    if (!kind) { errors.push(`${file}:${id} kind 알 수 없음`); continue; }
    if (kind === 'extrude' && !(Number.isFinite(p.fromM) && Number.isFinite(p.toM) && p.toM > p.fromM)) { errors.push(`${file}:${id} fromM/toM 잘못됨`); continue; }
    const g = f.geometry;
    const polys: number[][][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) { errors.push(`${file}:${id} 폴리곤 아님`); continue; }
    if (kind === 'surface' && polys.some((poly) => poly.some((ring) => ring.some((c) => !Number.isFinite(c[2]))))) { errors.push(`${file}:${id} surface에 z 없음`); continue; }
    const polygons = polys.map((poly) => poly.map((ring) => ring.map(([x, y, z]) => {
      const { latitude, longitude } = tmInverse(x, y);
      return z === undefined ? [longitude, latitude] : [longitude, latitude, z];
    })));
    features.push({ id, file, kind, source: String(p.source), fromM: p.fromM, toM: p.toM, polygons });
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

/** 보정 레이어 생성(기본 숨김). 없는 파일은 pending으로 보고. */
export async function addLocalCorrections(C: CesiumNS, viewer: any, base = '/corrections/') {
  const loaded: string[] = [];
  const pending: string[] = [];
  const errors: string[] = [];
  const features: CorrectionFeature[] = [];
  for (const file of CORRECTION_FILES) {
    const fc = await loadFile(base, file);
    if (!fc) { pending.push(file); continue; }
    const r = parseCorrections(file, fc);
    loaded.push(file);
    features.push(...r.features);
    errors.push(...r.errors);
  }
  const instances: any[] = [];
  for (const f of features) {
    const color = C.Color.fromCssColorString(f.kind === 'extrude' ? '#60a5fa' : '#f59e0b').withAlpha(0.85);
    for (const poly of f.polygons) {
      const ring = (r: number[][]) => f.kind === 'surface'
        ? C.Cartesian3.fromDegreesArrayHeights(r.slice(0, -1).flat())
        : C.Cartesian3.fromDegreesArray(r.slice(0, -1).flatMap(([lon, lat]) => [lon, lat]));
      const hierarchy = new C.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new C.PolygonHierarchy(ring(h))));
      const geometry = f.kind === 'extrude'
        ? new C.PolygonGeometry({ polygonHierarchy: hierarchy, height: f.fromM, extrudedHeight: f.toM, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT })
        : new C.PolygonGeometry({ polygonHierarchy: hierarchy, perPositionHeight: true, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT });
      instances.push(new C.GeometryInstance({ geometry, id: { kind: 'correction', id: f.id, source: f.source }, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) } }));
    }
  }
  const primitive = instances.length
    ? viewer.scene.primitives.add(new C.Primitive({ geometryInstances: instances, appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: false }), asynchronous: false, show: false }))
    : null;
  if (errors.length) console.warn('local corrections rejected', errors);
  return {
    loaded, pending, errors, ids: features.map((f) => f.id),
    setVisible(show: boolean) {
      if (primitive) primitive.show = show;
      viewer.scene.requestRender?.();
    },
  };
}
