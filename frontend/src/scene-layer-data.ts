// What the shared map layers (scene-layers.ts) are built from, and how the editor's in-memory state becomes that.
// Pure functions (tested in test/scene-layer-data.test.ts); no Cesium here.
import type { CarriagewayRoad, MobilityOpenArea } from './api';
import { tmInverse } from './tm';

/** An open area as the layers need it: rings in longitude / latitude, closed (first point repeated). */
export type LayerArea = Pick<MobilityOpenArea, 'id' | 'name' | 'kind' | 'elevationM' | 'buildingId' | 'floor' | 'geometry'>;
export type LayerData = { roads: CarriagewayRoad[]; areas: LayerArea[] };

/** A road of the editor snapshot (only what the surfaces read). Coordinates: EPSG:5186 x, y, MSL height. */
export type EditorRoad = {
  id: string; name: string | null; roadClass: string; structure: string; widthM: number | null; levelId: string | null; buildingId: string | null;
  fromNodeId?: string; toNodeId?: string; geometry: { coordinates: number[][] };
};
/** The road being drawn or edited and not saved yet: its vertices so far and the attributes in the form. */
export type EditorDraft = { id: string; coordinates: number[][]; attrs: Record<string, unknown> };
/** An area of the editor (GET /api/v1/editor/areas): rings in EPSG:5186 metres, closed. */
export type EditorArea = { id: number; name: string; kind: string; elevationM: number | null; buildingId: string | null; floor: string | null; geometry: { coordinates: number[][][] } };

const ATTRS = ['name', 'roadClass', 'structure', 'widthM', 'levelId', 'buildingId'] as const;

/**
 * The editor's current state as layer data, so the surfaces show what the editor shows (saved or not):
 *  - every road of the snapshot except elevators (as GET /api/v1/mobility/roads gives them);
 *  - the draft replaces the road it edits (vertices and form attributes); a new draft with two or more vertices is
 *    added as a road of its own (its ends are not joined to a node yet);
 *  - the areas with their rings turned into longitude / latitude.
 */
export function editorLayerData(roads: EditorRoad[], draft: EditorDraft | null, areas: EditorArea[]): LayerData {
  const withDraft = (road: EditorRoad): EditorRoad => {
    if (!draft || draft.id !== road.id) return road;
    const attrs = Object.fromEntries(ATTRS.filter((k) => k in draft.attrs).map((k) => [k, draft.attrs[k]]));
    return { ...road, ...attrs, geometry: { coordinates: draft.coordinates } };
  };
  const all = roads.map(withDraft);
  if (draft && draft.coordinates.length >= 2 && !roads.some((r) => r.id === draft.id)) {
    all.push(withDraft({ id: draft.id, name: null, roadClass: 'pedestrian', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, geometry: { coordinates: [] } }));
  }
  return {
    roads: all.filter((r) => r.structure !== 'elevator' && r.geometry.coordinates.length >= 2).map((r) => ({
      id: r.id, name: r.name, roadClass: r.roadClass as CarriagewayRoad['roadClass'], structure: r.structure, widthM: r.widthM, levelId: r.levelId, buildingId: r.buildingId,
      fromNodeId: r.fromNodeId ?? `draft:${r.id}:from`, toNodeId: r.toNodeId ?? `draft:${r.id}:to`,
      geometry: { type: 'LineString', coordinates: r.geometry.coordinates },
    })),
    areas: areas.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, elevationM: a.elevationM, buildingId: a.buildingId, floor: a.floor,
      geometry: { type: 'Polygon', coordinates: a.geometry.coordinates.map((ring) => ring.map(([x, y]) => { const g = tmInverse(x, y); return [g.longitude, g.latitude]; })) },
    })),
  };
}

/** Two data sets with the same key draw the same surfaces (nothing needs to be built again). */
export const layerDataKey = (data: LayerData) => JSON.stringify(data);
