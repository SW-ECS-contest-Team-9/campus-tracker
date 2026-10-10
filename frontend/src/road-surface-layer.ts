// Draws the carriageway surfaces of road-surface.ts on the Cesium preview map (see that file for what and why).
import { api, type CarriagewayRoad } from './api';
import { ROAD_SURFACE, buildRoadSurfaces } from './road-surface';
import { tmInverse } from './tm';
import type { Viewer } from './vworld';

export type RoadSurfacePart = 'ground' | 'underground';

export class RoadSurfaceLayer {
  private prims: Record<RoadSurfacePart, any> = { ground: null, underground: null };
  private visible: Record<RoadSurfacePart, boolean> = { ground: true, underground: false };
  roads: CarriagewayRoad[] = [];

  constructor(private readonly viewer: Viewer) {}

  async reload() {
    this.roads = (await api.roads()).roads;
    this.draw();
    return this.roads;
  }

  setVisible(visible: boolean, part: RoadSurfacePart = 'ground') {
    this.visible[part] = visible;
    if (this.prims[part]) this.prims[part].show = visible;
  }

  private draw() {
    const C = (window as any).Cesium;
    const { ground, underground } = buildRoadSurfaces(this.roads);
    const color = C.Color.fromCssColorString(ROAD_SURFACE.color);
    const position = (x: number, y: number, z = 0) => {
      const { latitude, longitude } = tmInverse(x, y);
      return C.Cartesian3.fromDegrees(longitude, latitude, z);
    };
    for (const part of ['ground', 'underground'] as const) {
      if (this.prims[part]) this.viewer.scene.primitives.remove(this.prims[part]);
      this.prims[part] = null;
    }
    if (ground.length) {
      // laid on the rendered terrain (like the mobility corridors without a height): no flicker, never buried
      this.prims.ground = this.viewer.scene.primitives.add(new C.GroundPrimitive({
        geometryInstances: ground.map((ring) => new C.GeometryInstance({
          geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(ring.map(([x, y]) => position(x, y))) }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) },
        })),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false }),
        classificationType: C.ClassificationType.TERRAIN,
        show: this.visible.ground,
      }));
    }
    if (underground.indices.length) {
      const values = new Float64Array(underground.positions.length);
      for (let i = 0; i < values.length; i += 3) {
        const c = position(underground.positions[i], underground.positions[i + 1], underground.positions[i + 2]);
        values.set([c.x, c.y, c.z], i);
      }
      // at the stored height; where the ground or a building is in front, it shows through faintly
      this.prims.underground = this.viewer.scene.primitives.add(new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.Geometry({
            attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }) } as any,
            indices: new Uint32Array(underground.indices),
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
        show: this.visible.underground,
      }));
    }
  }
}
