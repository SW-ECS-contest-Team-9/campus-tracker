// Draws the ground surfaces of paved-surface.ts (merged, smooth-edged roads, paved areas and the sports field) and the
// underground roads of road-surface.ts on a Cesium map: the preview and the editor both mount it through scene-layers.ts
// (see those files for what and why).
import type { CarriagewayRoad, SceneBuilding } from './api';
import { AREA_FILLS, type MobilityPick } from './mobility-map';
import { pavingAppearance, pavingAttribute } from './paving-pattern';
import { PAVED, buildPavedSurfaces, type Material, type PavedSurfaces, type SurfaceArea } from './paved-surface';
import { ROAD_SURFACE, buildRoadSurfaces, isUnderground } from './road-surface';
import type { LayerArea } from './scene-layer-data';
import { clipMesh, type Mesh, type SectionPlane } from './section';
import { setTerrainClip } from './terrain-clip';
import { tmForward, tmInverse } from './tm';
import type { Viewer } from './vworld';

/**
 * ground: the wide paved surfaces: the asphalt of the vehicle roads and vehicle areas, and the block paving of the
 * pedestrian-priority ways and plazas; pedestrian: the other pedestrian ways, sidewalks, stairs and crossings;
 * area: the sports field; underground: every underground way.
 */
export type RoadSurfacePart = 'ground' | 'pedestrian' | 'area' | 'underground';
const PART: Record<Material, RoadSurfacePart> = { carriageway: 'ground', block: 'ground', crossing: 'pedestrian', stairs: 'pedestrian', sidewalk: 'pedestrian', pedestrian: 'pedestrian', field: 'area' };

export type RoadSurfaceSources = {
  /** Ground height at an EPSG:5186 point (the terrain grid the map is drawn from). */
  ground: (x: number, y: number) => number;
  buildings: () => SceneBuilding[];
  /** Which parts show at first (default: all but the underground ways). */
  visible?: Partial<Record<RoadSurfacePart, boolean>>;
  /** false: a click goes through the surfaces (the editor picks its lines and the ground, never a surface). */
  pickable?: boolean;
};

/**
 * The outdoor open areas that are drawn here as filled surfaces, merged with the roads. Z08: what an area is paved
 * with follows who uses it, from the stored attributes: `asphalt` when vehicles drive on it (kind parking, or a
 * vehicle / shared road above ground ends inside it: a turnaround), `block` for the other plazas (pedestrian),
 * `field` for the sports field (AREA_FILLS).
 */
export function surfaceAreas(areas: LayerArea[], roads: Pick<CarriagewayRoad, 'roadClass' | 'levelId' | 'name' | 'buildingId' | 'geometry'>[] = []): SurfaceArea[] {
  const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
  const inside = (p: number[], ring: number[][]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (ring[i][1] > p[1] !== ring[j][1] > p[1] && p[0] < ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) hit = !hit;
    return hit;
  };
  const ends = roads.filter((r) => r.roadClass !== 'pedestrian' && !isUnderground(r)).flatMap((r) => [r.geometry.coordinates[0], r.geometry.coordinates[r.geometry.coordinates.length - 1]]);
  return areas.flatMap((a) => {
    if (areaSurfacePart(a) === null) return [];
    const rings = a.geometry.coordinates.map(metres);
    const fill = AREA_FILLS.find((f) => f.match(a))?.id === 'field' ? 'field' as const : a.kind === 'parking' || ends.some((p) => inside(p, rings[0])) ? 'asphalt' as const : 'block' as const;
    return [{ id: a.id, fill, elevationM: a.elevationM, rings }];
  });
}

/** The part an open area is drawn in as a filled surface, or null (an indoor area, or a kind that is not filled: only plazas, parking areas and the field are). */
export function areaSurfacePart(area: { kind: string; name: string | null; elevationM: number | null; buildingId: string | null; floor: string | null }): RoadSurfacePart | null {
  if (area.elevationM != null && (area.buildingId || area.floor)) return null;
  if (AREA_FILLS.find((f) => f.match(area))?.id === 'field') return 'area';
  return area.kind === 'parking' || area.kind === 'plaza' ? 'ground' : null;
}

/** What the structures layer tells the surfaces (scene-layers.ts passes it on): `key` changes when anything in it does. */
export type SurfaceContext = {
  key: string;
  /** The structures the surfaces give way to (structures.ts PRECEDENCE). */
  exclude?: { platforms: { polygon: number[][][]; top: (x: number, y: number) => number }[]; treads: number[][][][]; stairRibbonReachM: number; platformTints: string[] };
  /** Where the ground beside a surface is drawn flush with it (the neutral campus ground). */
  flush?: (x: number, y: number) => boolean;
};

export class RoadSurfaceLayer {
  private readonly prims: any;
  private parts: { part: RoadSurfacePart; prim: any }[] = [];
  private visible: Record<RoadSurfacePart, boolean> = { ground: true, pedestrian: true, area: true, underground: false };
  private section: SectionPlane | null = null;
  private areas: LayerArea[] = [];
  /** The data changed since the surfaces were built (they are built only while a part is shown). */
  private stale = false;
  /** Built once per data change, not per frame and not per toggle. */
  private paved: PavedSurfaces = { surfaces: [], joinedRoadIds: [], heightSource: {}, covered: [], rawOutline: [], outline: [] };
  private underground: ReturnType<typeof buildRoadSurfaces>['underground'] = [];
  roads: CarriagewayRoad[] = [];
  /** How long the last build of the merged surfaces took. */
  buildMs = 0;
  private context: SurfaceContext = { key: '' };

  constructor(private readonly viewer: Viewer, private readonly src: RoadSurfaceSources) {
    this.prims = viewer.scene.primitives.add(new (window as any).Cesium.PrimitiveCollection());
    Object.assign(this.visible, src.visible);
  }

  /** New roads and areas. The surfaces are built now if any part is shown, otherwise when one is turned on. */
  setData(roads: CarriagewayRoad[], areas: LayerArea[]) {
    this.roads = roads;
    this.areas = areas;
    this.stale = true;
    this.build();
  }

  private build() {
    if (!this.stale) return;
    if (!Object.values(this.visible).some(Boolean)) {
      // nothing shown: drop what was drawn from the old data, build when a part is turned on
      this.paved = { surfaces: [], joinedRoadIds: [], heightSource: {}, covered: [], rawOutline: [], outline: [] };
      this.underground = [];
      this.draw();
      return;
    }
    this.stale = false;
    const started = performance.now();
    const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
    this.paved = buildPavedSurfaces({
      roads: this.roads, areas: surfaceAreas(this.areas, this.roads), ground: this.src.ground,
      buildings: this.src.buildings().flatMap((b) => b.geometry.coordinates.map((poly) => poly.map(metres))),
      exclude: this.context.exclude, flush: this.context.flush,
    });
    this.underground = buildRoadSurfaces(this.roads).underground;
    this.buildMs = performance.now() - started;
    this.draw();
  }

  isVisible(part: RoadSurfacePart) { return this.visible[part]; }

  /** The structures changed (or were turned on or off): the surfaces are built again around them. */
  setContext(context: SurfaceContext) {
    if (context.key === this.context.key) return;
    this.context = context;
    this.stale = true;
    this.build();
  }

  /**
   * The visible ground surfaces as drawn, for the structures layer: plan shape and triangles (x, y, height, edge per
   * vertex) of what lies outside the platforms, and per material the polygons that lie on a platform (they colour its top).
   */
  drawn() {
    const shown = (m: Material) => this.visible[PART[m]];
    return {
      surfaces: this.paved.surfaces.filter((s) => shown(s.material)).map((s) => ({ polygons: s.drawn, mesh: s.mesh, stride: 4 })),
      covered: this.paved.covered.filter((c) => shown(c.material)).map((c) => ({ color: this.color(c.material), pattern: this.pattern(c.material), polygons: c.polygons })),
    };
  }

  setVisible(visible: boolean, part: RoadSurfacePart = 'ground') {
    this.visible[part] = visible;
    this.build();
    for (const p of this.parts) if (p.part === part) p.prim.show = visible;
    this.clipGround();
  }

  /** Cross-section (section-layer.ts): every surface is cut at the plane; null restores them. */
  setSection(plane: SectionPlane | null) {
    this.section = plane;
    this.draw();
  }

  /** The surfaces as drawn (x, y, height, edge per vertex) with their colour: the cross-section marks where they meet its plane. */
  surfaces(): { color: string; mesh: Mesh }[] {
    return this.paved.surfaces.filter((s) => this.visible[PART[s.material]]).map((s) => ({ color: this.color(s.material), mesh: s.mesh }));
  }

  private color(material: Material) {
    return material === 'field' ? AREA_FILLS.find((f) => f.id === 'field')!.color : ROAD_SURFACE.colors[material];
  }

  private pattern(material: Material) {
    return material === 'field' ? 0 : ROAD_SURFACE.patterns[material] ?? 0;
  }

  private position(x: number, y: number, z = 0) {
    const { latitude, longitude } = tmInverse(x, y);
    return (window as any).Cesium.Cartesian3.fromDegrees(longitude, latitude, z);
  }

  /** The ground is hidden inside the visible surfaces: they lie at their own height, and the ground would poke through. */
  private clipGround() {
    setTerrainClip(this.viewer, 'road-surfaces', this.paved.surfaces.filter((s) => this.visible[PART[s.material]])
      .flatMap((s) => s.outline.map((ring) => ring.map(([x, y]) => this.position(x, y)))));
  }

  /** Triangles (x, y, height first in each vertex) as one unlit primitive with a colour (r, g, b in 0..255) per vertex. */
  private primitive(mesh: Mesh, stride: number, rgb: (vertex: number) => number[], id?: object, pattern = 0) {
    const C = (window as any).Cesium;
    const n = mesh.positions.length / stride;
    const values = new Float64Array(n * 3);
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.position(mesh.positions[i * stride], mesh.positions[i * stride + 1], mesh.positions[i * stride + 2]);
      values.set([c.x, c.y, c.z], i * 3);
      colors.set([...rgb(i), 255], i * 4);
    }
    return new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.Geometry({
          attributes: {
            position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }),
            color: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: colors }),
            paving: pavingAttribute(C, mesh.positions, stride, pattern),
          } as any,
          indices: new Uint32Array(mesh.indices),
          primitiveType: C.PrimitiveType.TRIANGLES,
          boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
        }),
        id,
      }),
      appearance: pavingAppearance(C),
      asynchronous: false,
      allowPicking: this.src.pickable !== false,
    });
  }

  private draw() {
    const C = (window as any).Cesium;
    const bytes = (css: string) => { const c = C.Color.fromCssColorString(css); return [c.red * 255, c.green * 255, c.blue * 255]; };
    this.prims.removeAll();
    this.parts = [];
    const add = (part: RoadSurfacePart, prim: any) => {
      prim.show = this.visible[part];
      this.parts.push({ part, prim: this.prims.add(prim) });
    };
    const cut = (mesh: Mesh, stride: number) => (this.section ? clipMesh(this.section, mesh, stride) : mesh);
    const ground = bytes(PAVED.groundColor);
    const skirtColor = bytes(PAVED.skirtColor);
    const field = this.areas.find((a) => AREA_FILLS.find((f) => f.match(a))?.id === 'field');
    for (const s of this.paved.surfaces) {
      const body = bytes(this.color(s.material));
      const rim = body.map((v, k) => v + (ground[k] - v) * PAVED.rimFade);
      const mesh = cut(s.mesh, 4);
      // the area keeps its click (Detail panel) where the surface is one area
      const pick: MobilityPick | undefined = s.material === 'field' && field ? { kind: 'mobility', table: 'openAreas', id: field.id } : undefined;
      if (mesh.indices.length) add(PART[s.material], this.primitive(mesh, 4, (i) => { const t = mesh.positions[i * 4 + 3]; return body.map((v, k) => v + (rim[k] - v) * t); }, pick && { mobilityPick: pick }, this.pattern(s.material)));
      const skirt = cut(s.skirt, 3);
      if (skirt.indices.length) add(PART[s.material], this.primitive(skirt, 3, () => skirtColor));
    }
    for (const group of this.underground) {
      const mesh = cut(group.mesh, 3);
      if (!mesh.indices.length) continue;
      const color = C.Color.fromCssColorString(ROAD_SURFACE.colors[group.kind]);
      const values = new Float64Array(mesh.positions.length);
      for (let i = 0; i < values.length; i += 3) {
        const c = this.position(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
        values.set([c.x, c.y, c.z], i);
      }
      // at the stored height; where the ground or a building is in front, it shows through (a little lighter)
      add('underground', new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.Geometry({
            attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }) } as any,
            indices: new Uint32Array(mesh.indices),
            primitiveType: C.PrimitiveType.TRIANGLES,
            boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(color),
            depthFailColor: C.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(ROAD_SURFACE.undergroundHiddenAlpha)),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }),
        depthFailAppearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
        asynchronous: false,
        allowPicking: this.src.pickable !== false,
      }));
    }
    this.clipGround();
  }
}
