// Draws the road surfaces of road-surface.ts on the Cesium preview map (see that file for what and why).
import { api, type CarriagewayRoad } from './api';
import { ROAD_SURFACE, buildRoadSurfaces } from './road-surface';
import { clipMesh, type SectionPlane } from './section';
import { tmInverse } from './tm';
import type { Viewer } from './vworld';

/** ground: carriageways on the ground; pedestrian: pedestrian ways, stairs and crossings on the ground; underground: every underground way. */
export type RoadSurfacePart = 'ground' | 'pedestrian' | 'underground';

export class RoadSurfaceLayer {
  private readonly prims: any;
  private parts: { part: RoadSurfacePart; prim: any }[] = [];
  private visible: Record<RoadSurfacePart, boolean> = { ground: true, pedestrian: true, underground: false };
  private section: SectionPlane | null = null;
  roads: CarriagewayRoad[] = [];

  constructor(private readonly viewer: Viewer) {
    this.prims = viewer.scene.primitives.add(new (window as any).Cesium.PrimitiveCollection());
  }

  async reload() {
    this.roads = (await api.roads()).roads;
    this.draw();
    return this.roads;
  }

  setVisible(visible: boolean, part: RoadSurfacePart = 'ground') {
    this.visible[part] = visible;
    for (const p of this.parts) if (p.part === part) p.prim.show = visible;
  }

  /**
   * Cross-section (section-layer.ts): underground ways are cut at the plane here. The surfaces laid on the ground need
   * nothing: they are only drawn where the ground is, and the ground itself is cut.
   */
  setSection(plane: SectionPlane | null) {
    this.section = plane;
    this.draw();
  }

  private draw() {
    const C = (window as any).Cesium;
    const { ground, underground } = buildRoadSurfaces(this.roads);
    const position = (x: number, y: number, z = 0) => {
      const { latitude, longitude } = tmInverse(x, y);
      return C.Cartesian3.fromDegrees(longitude, latitude, z);
    };
    this.prims.removeAll();
    this.parts = [];
    const add = (part: RoadSurfacePart, prim: any) => {
      prim.show = this.visible[part];
      this.parts.push({ part, prim: this.prims.add(prim) });
    };
    // laid on the rendered terrain (like the mobility corridors without a height): no flicker, never buried.
    // One primitive per kind, in draw order: where two kinds overlap the later one shows.
    for (const { kind, rings } of ground) {
      const color = C.Color.fromCssColorString(ROAD_SURFACE.colors[kind]);
      add(kind === 'carriageway' ? 'ground' : 'pedestrian', new C.GroundPrimitive({
        geometryInstances: rings.map((ring) => new C.GeometryInstance({
          geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(ring.map(([x, y]) => position(x, y))) }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) },
        })),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false }),
        classificationType: C.ClassificationType.TERRAIN,
      }));
    }
    for (const group of underground) {
      const mesh = this.section ? clipMesh(this.section, group.mesh) : group.mesh;
      if (!mesh.indices.length) continue;
      const color = C.Color.fromCssColorString(ROAD_SURFACE.colors[group.kind]);
      const values = new Float64Array(mesh.positions.length);
      for (let i = 0; i < values.length; i += 3) {
        const c = position(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
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
  }
}
