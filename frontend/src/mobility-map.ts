// Hand-drawn mobility spaces (QGIS edits PostGIS schema "mobility", migration 019) on the preview map.
// Corridors are drawn with their real width, open areas as filled polygons, portals as labelled points.
// Features without elevation_m lie on the terrain; with it, at that absolute (MSL) height (indoor / elevated).
import { api, type MobilityCorridor, type MobilityOpenArea, type MobilityPortal, type MobilitySpaces } from './api';
import { ROAD_SURFACE } from './road-surface';
import { clipLonLatPolygons, type SectionPlane } from './section';
import type { Viewer } from './vworld';

export type MobilityPick = { kind: 'mobility'; table: 'corridors' | 'openAreas' | 'portals'; id: number };

const CORRIDOR_COLORS: Record<string, string> = {
  walkway: '#0ea5e9', sidewalk: '#38bdf8', indoor_corridor: '#8b5cf6', stairs: '#f97316', ramp: '#eab308',
  crosswalk: '#f8fafc', road_shoulder: '#94a3b8', other: '#64748b',
};
const AREA_COLORS: Record<string, string> = { plaza: '#22c55e', courtyard: '#84cc16', lobby: '#a855f7', parking: '#94a3b8', other: '#64748b' };
/**
 * Open areas drawn as a filled surface (first match wins); every other area keeps the translucent look.
 * asphalt: paved road surface in the colour of the carriageways (road-surface.ts), so a road running into it reads as
 *   one surface. There is no paved-road kind: kind `parking` stands in, and so does any area with "포장면" in its name.
 * field: the sports field, a muted tan. Kind `other`, told by its name: there is no field kind.
 * Outdoors the fill is laid on the map's ground (never buried, no flicker). `flat` adds a level surface at the area's
 * floor height in the same unlit colour: it covers the ground where that is lower, and where the ground is higher the
 * ground shows instead, in the same colour. Inside a building (building or floor written) only the level surface is drawn.
 */
export const AREA_FILLS: { id: string; match: (a: { kind: string; name: string | null }) => boolean; color: string; flat: boolean }[] = [
  { id: 'asphalt', match: (a) => a.kind === 'parking' || /포장면/.test(a.name ?? ''), color: ROAD_SURFACE.colors.carriageway, flat: false },
  { id: 'field', match: (a) => a.kind === 'other' && /운동장/.test(a.name ?? ''), color: '#c9956b', flat: true },
];
const PORTAL_COLORS: Record<string, string> = {
  building_entrance: '#ef4444', plaza_entrance: '#22c55e', stair_start: '#f97316', stair_end: '#fb923c', elevator: '#a855f7', junction: '#0ea5e9', other: '#64748b',
};

export class MobilityLayer {
  private entities: any[] = [];
  private readonly fills: any;
  private visible = true;
  private section: SectionPlane | null = null;
  /**
   * True when road-surface-layer.ts draws the outdoor filled areas (merged with the roads, smooth-edged, at their own
   * height): they are then left out here. False (the VWorld map): drawn here as before.
   */
  surfacesElsewhere = false;
  data: MobilitySpaces = { corridors: [], openAreas: [], portals: [] };

  constructor(private readonly viewer: Viewer) {
    // filled areas lie under the road surfaces (road-surface-layer.ts): lowest in the draw order
    this.fills = viewer.scene.primitives.add(new (window as any).Cesium.PrimitiveCollection());
    viewer.scene.primitives.lowerToBottom(this.fills);
  }

  async reload() {
    this.data = await api.mobility();
    this.draw();
    return this.data;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    for (const e of this.entities) e.show = visible;
    this.fills.show = visible;
  }

  /** Cross-section (section-layer.ts): the level surfaces of filled areas are cut at the plane; null restores them. */
  setSection(plane: SectionPlane | null) {
    this.section = plane;
    this.draw();
  }

  feature(pick: MobilityPick): MobilityCorridor | MobilityOpenArea | MobilityPortal | undefined {
    return (this.data[pick.table] as { id: number }[]).find((f) => f.id === pick.id) as MobilityCorridor | MobilityOpenArea | MobilityPortal | undefined;
  }

  private add(entity: object, pick: MobilityPick) {
    const e = this.viewer.entities.add(entity);
    e.mobilityPick = pick;
    e.show = this.visible;
    this.entities.push(e);
  }

  private draw() {
    const C = (window as any).Cesium;
    for (const e of this.entities) this.viewer.entities.remove(e);
    this.entities = [];
    const color = (css: string, a: number) => C.Color.fromCssColorString(css).withAlpha(a);
    this.fills.removeAll();
    this.fills.show = this.visible;
    const onGround: any[] = [];
    const level: any[] = [];
    const polygon = (rings: number[][][]) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(rings[0].flat()), rings.slice(1).map((h) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(h.flat()))));
    for (const a of this.data.openAreas) {
      const pick: MobilityPick = { kind: 'mobility', table: 'openAreas', id: a.id };
      const hierarchy = polygon(a.geometry.coordinates);
      const fill = AREA_FILLS.find((f) => f.match(a));
      if (fill) {
        const attributes = () => ({ color: C.ColorGeometryInstanceAttribute.fromColor(color(fill.color, 1)) });
        const indoor = a.elevationM != null && (a.buildingId || a.floor);
        if (this.surfacesElsewhere && !indoor) continue;
        if (!indoor) onGround.push(new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: hierarchy }), id: { mobilityPick: pick }, attributes: attributes() }));
        if (a.elevationM != null && (indoor || fill.flat)) {
          for (const rings of this.section ? clipLonLatPolygons(this.section, [a.geometry.coordinates]) : [a.geometry.coordinates]) {
            level.push(new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: polygon(rings), height: a.elevationM, vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }), id: { mobilityPick: pick }, attributes: attributes() }));
          }
        }
        continue;
      }
      this.add({
        polygon: {
          hierarchy,
          material: color(AREA_COLORS[a.kind] ?? AREA_COLORS.other, 0.3),
          ...(a.elevationM != null ? { height: a.elevationM, perPositionHeight: false } : { classificationType: C.ClassificationType.TERRAIN }),
        },
      }, pick);
      this.add({
        polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(a.geometry.coordinates[0].flatMap(([lon, lat]) => [lon, lat, a.elevationM ?? 0])),
          width: 2, clampToGround: a.elevationM == null, material: color(AREA_COLORS[a.kind] ?? AREA_COLORS.other, 0.9) },
      }, pick);
    }
    if (onGround.length) this.fills.add(new C.GroundPrimitive({ geometryInstances: onGround, appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false }), classificationType: C.ClassificationType.TERRAIN }));
    if (level.length) this.fills.add(new C.Primitive({ geometryInstances: level, appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }), asynchronous: false }));
    for (const c of this.data.corridors) {
      const css = CORRIDOR_COLORS[c.kind] ?? CORRIDOR_COLORS.other;
      const pick: MobilityPick = { kind: 'mobility', table: 'corridors', id: c.id };
      // the corridor band with its real width, plus the centerline (dashed when one-way)
      this.add({
        corridor: {
          positions: C.Cartesian3.fromDegreesArray(c.geometry.coordinates.flat()),
          width: c.widthM,
          material: color(css, 0.45),
          cornerType: C.CornerType.ROUNDED,
          ...(c.elevationM != null ? { height: c.elevationM } : { classificationType: C.ClassificationType.TERRAIN }),
        },
      }, pick);
      this.add({
        polyline: {
          positions: C.Cartesian3.fromDegreesArrayHeights(c.geometry.coordinates.flatMap(([lon, lat]) => [lon, lat, (c.elevationM ?? 0) + 0.05])),
          width: 2,
          clampToGround: c.elevationM == null,
          material: c.oneWay ? new C.PolylineArrowMaterialProperty(color(css, 1)) : color(css, 1),
        },
      }, pick);
      if (c.name) {
        const mid = c.geometry.coordinates[Math.floor(c.geometry.coordinates.length / 2)];
        this.add({
          position: C.Cartesian3.fromDegrees(mid[0], mid[1], c.elevationM ?? 0),
          label: { text: c.name, font: '12px system-ui, "Apple SD Gothic Neo", sans-serif', fillColor: color(css, 1), outlineColor: C.Color.BLACK, outlineWidth: 3,
            style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: c.elevationM == null ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE, scaleByDistance: new C.NearFarScalar(150, 1, 1500, 0.5) },
        }, pick);
      }
    }
    for (const p of this.data.portals) {
      const css = PORTAL_COLORS[p.kind] ?? PORTAL_COLORS.other;
      const [lon, lat] = p.geometry.coordinates;
      this.add({
        position: C.Cartesian3.fromDegrees(lon, lat, p.elevationM ?? 0),
        point: { pixelSize: 11, color: color(css, 1), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: p.elevationM == null ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE },
        label: p.name ? { text: p.name, font: '12px system-ui, "Apple SD Gothic Neo", sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: p.elevationM == null ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE, scaleByDistance: new C.NearFarScalar(150, 1, 1500, 0.5) } : undefined,
      }, { kind: 'mobility', table: 'portals', id: p.id });
    }
  }
}

export const MOBILITY_KIND_LABELS: Record<string, string> = {
  walkway: '보행로', sidewalk: '인도', indoor_corridor: '실내 복도', stairs: '계단', ramp: '경사로', crosswalk: '횡단보도', road_shoulder: '도로 갓길',
  plaza: '광장', courtyard: '중정', lobby: '로비', parking: '주차장',
  building_entrance: '건물 출입구', plaza_entrance: '광장 출입구', stair_start: '계단 시작', stair_end: '계단 끝', elevator: '엘리베이터', junction: '교차점', other: '기타',
};
