// The rendered ground can be hidden inside polygons (Cesium globe.clippingPolygons; the terrain data is untouched).
// The globe has one such collection, and two layers use it: the review layer of scene-local-corrections.ts and the
// merged ground surfaces of road-surface-layer.ts. Each sets its polygons here under its own name; the collection is
// rebuilt from all of them, so they do not undo each other.
const owners = new WeakMap<object, Map<string, unknown[][]>>();

/** Hide the ground inside these polygons (each a list of Cesium.Cartesian3, not closed); [] gives this owner's ground back. */
export function setTerrainClip(viewer: any, owner: string, polygons: unknown[][]) {
  const C = (window as any).Cesium;
  const sets = owners.get(viewer) ?? new Map<string, unknown[][]>();
  owners.set(viewer, sets);
  sets.set(owner, polygons);
  const all = [...sets.values()].flat();
  viewer.scene.globe.clippingPolygons = all.length
    ? new C.ClippingPolygonCollection({ polygons: all.map((positions) => new C.ClippingPolygon({ positions })) })
    : undefined;
}
