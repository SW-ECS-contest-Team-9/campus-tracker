// Draws the ground surfaces of paved-surface.ts (merged, smooth-edged roads, paved areas and the sports field) and the
// underground roads of road-surface.ts on the Cesium preview map (see those files for what and why).
import { api, type CarriagewayRoad, type MobilityOpenArea, type SceneBuilding } from './api';
import { AREA_FILLS, type MobilityPick } from './mobility-map';
import { PAVED, buildPavedSurfaces, type Material, type PavedSurfaces, type SurfaceArea } from './paved-surface';
import { ROAD_SURFACE, buildRoadSurfaces } from './road-surface';
import { clipMesh, type Mesh, type SectionPlane } from './section';
import { setTerrainClip } from './terrain-clip';
import { tmForward, tmInverse } from './tm';
import type { Viewer } from './vworld';

/**
 * ground: the black paved surface (carriageways, paved areas and the pedestrian ways that belong to them);
 * pedestrian: the other pedestrian ways, stairs and crossings; area: the sports field; underground: every underground way.
 */
export type RoadSurfacePart = 'ground' | 'pedestrian' | 'area' | 'underground';
const PART: Record<Material, RoadSurfacePart> = { carriageway: 'ground', crossing: 'pedestrian', stairs: 'pedestrian', pedestrian: 'pedestrian', field: 'area' };

export type RoadSurfaceSources = {
  /** Ground height at an EPSG:5186 point (the terrain grid the map is drawn from). */
  ground: (x: number, y: number) => number;
  buildings: () => SceneBuilding[];
};

/** The filled open areas of mobility-map.ts (AREA_FILLS) that are outdoors: these are drawn here, merged with the roads. */
export function surfaceAreas(areas: MobilityOpenArea[]): SurfaceArea[] {
  const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
  return areas.flatMap((a) => {
    const fill = AREA_FILLS.find((f) => f.match(a));
    if (!fill || (a.elevationM != null && (a.buildingId || a.floor))) return [];
    return [{ id: a.id, fill: fill.id === 'field' ? 'field' as const : 'asphalt' as const, elevationM: a.elevationM, rings: a.geometry.coordinates.map(metres) }];
  });
}

export class RoadSurfaceLayer {
  private readonly prims: any;
  private parts: { part: RoadSurfacePart; prim: any }[] = [];
  private visible: Record<RoadSurfacePart, boolean> = { ground: true, pedestrian: true, area: true, underground: false };
  private section: SectionPlane | null = null;
  private areas: MobilityOpenArea[] = [];
  /** Built once per data load (reload), not per frame and not per toggle. */
  private paved: PavedSurfaces = { surfaces: [], joinedRoadIds: [], heightSource: {}, rawOutline: [], outline: [] };
  private underground: ReturnType<typeof buildRoadSurfaces>['underground'] = [];
  roads: CarriagewayRoad[] = [];
  /** How long the last build of the merged surfaces took. */
  buildMs = 0;

  constructor(private readonly viewer: Viewer, private readonly src: RoadSurfaceSources) {
    this.prims = viewer.scene.primitives.add(new (window as any).Cesium.PrimitiveCollection());
  }

  async reload() {
    const [roads, mobility] = await Promise.all([api.roads(), api.mobility()]);
    this.roads = roads.roads;
    this.areas = mobility.openAreas;
    const started = performance.now();
    const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
    this.paved = buildPavedSurfaces({
      roads: this.roads, areas: surfaceAreas(this.areas), ground: this.src.ground,
      buildings: this.src.buildings().flatMap((b) => b.geometry.coordinates.map((poly) => poly.map(metres))),
    });
    this.underground = buildRoadSurfaces(this.roads).underground;
    this.buildMs = performance.now() - started;
    this.draw();
    return this.roads;
  }

  setVisible(visible: boolean, part: RoadSurfacePart = 'ground') {
    this.visible[part] = visible;
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
  private primitive(mesh: Mesh, stride: number, rgb: (vertex: number) => number[], id?: object) {
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
          } as any,
          indices: new Uint32Array(mesh.indices),
          primitiveType: C.PrimitiveType.TRIANGLES,
          boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
        }),
        id,
      }),
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }),
      asynchronous: false,
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
      if (mesh.indices.length) add(PART[s.material], this.primitive(mesh, 4, (i) => { const t = mesh.positions[i * 4 + 3]; return body.map((v, k) => v + (rim[k] - v) * t); }, pick && { mobilityPick: pick }));
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
      }));
    }
    this.clipGround();
  }
}
