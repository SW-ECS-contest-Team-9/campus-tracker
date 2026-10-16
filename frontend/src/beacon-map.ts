// Placing beacons on the editor's 3D map (docs/BEACON_POSITIONING.md §5.5): pure helpers, no Cesium.
// Coordinates: EPSG:5186 metres, z = orthometric height above MSL (the editor cursor's frame and the registry's).
import { type BeaconForm } from './beacon-scan';
import { floorFromLevelId, floorLabel } from './floor-colors';
import { polygonContains, type Polygon } from './polygon-ops';

type XYZ = [number, number, number];

/** A building of the 3D map in the cursor's frame: footprint in EPSG:5186, floor table (MSL) from the building note. */
export interface MapBuilding {
  buildingId: string;
  name: string | null;
  polygons: Polygon[];
  /** floor surfaces above MSL, lowest first (appearance.windows.floorsM) */
  floorsM?: number[];
  /** the note's floor names in the order of floorsM ("B1", "1F", "2층" …) */
  floorNames?: string[];
}

export interface Placement {
  /** the building under the point, or "outdoor" */
  buildingId: string;
  buildingName: string | null;
  /** registry floor name (1F…99F, B1…B9) from the floor table, or null when unknown */
  floor: string | null;
  /** surface of that floor above MSL */
  floorHeightM: number | null;
}

/** A beacon on a ceiling still belongs to the floor below: a point counts from the floor surface up, with this slack below it. */
const FLOOR_SLACK_M = 0.3;

/** Which building and floor a point of the map is in. */
export function placementAt([x, y, z]: XYZ, buildings: MapBuilding[]): Placement {
  const b = buildings.find((it) => it.polygons.some((p) => polygonContains(x, y, p)));
  if (!b) return { buildingId: 'outdoor', buildingName: null, floor: null, floorHeightM: null };
  const floors = b.floorsM ?? [];
  let index = -1;
  for (let i = 0; i < floors.length; i++) if (floors[i] - FLOOR_SLACK_M <= z) index = i;
  if (index < 0) return { buildingId: b.buildingId, buildingName: b.name, floor: null, floorHeightM: null };
  const n = floorFromLevelId(b.floorNames?.[index]);
  return { buildingId: b.buildingId, buildingName: b.name, floor: n === null ? null : floorLabel(n), floorHeightM: floors[index] };
}

const round3 = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * The form with the beacon put at the cursor: grid position, z = cursor Z + [aboveCursorM] (the cursor on the floor,
 * the beacon on the wall), and the building / floor / floor height the map knows there (kept as typed when it knows none).
 */
export function formAtCursor(form: BeaconForm, cursor: XYZ, aboveCursorM: number, place: Placement): BeaconForm {
  const known = place.buildingId !== 'outdoor';
  return {
    ...form, positionMode: 'grid', x: round3(cursor[0]), y: round3(cursor[1]), z: round3(cursor[2] + aboveCursorM),
    latitude: '', longitude: '', mountAboveFloorM: '',
    buildingId: known || !form.buildingId.trim() ? place.buildingId : form.buildingId,
    floor: place.floor ?? (known ? '' : form.floor),
    floorHeightM: place.floorHeightM !== null ? round3(place.floorHeightM) : known ? '' : form.floorHeightM,
  };
}

/** The point a form puts the beacon at (grid mode only), or null. */
export function formPoint(f: BeaconForm): XYZ | null {
  if (f.positionMode !== 'grid') return null;
  const [x, y, z] = [f.x, f.y, f.z].map((v) => (v.trim() === '' ? NaN : Number(v)));
  return [x, y, z].every(Number.isFinite) ? [x, y, z] : null;
}
