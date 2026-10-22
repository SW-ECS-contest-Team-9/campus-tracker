import { pool } from '../config/database.js';
import type { FusionConfigV4 } from '../modules/fusion/fusion.config.js';
import { terrain } from './terrain.js';
import { circularFootprintAxis, type CircularAxis } from '../modules/fusion/fusion-circular-corridor.js';

export interface StartHeightRoad {
  id: string; buildingId: string | null; levelId: string | null; status: string; revision: number;
  coordinates: [number, number, number][];
}
export interface StartHeightFloor {
  id: string; buildingId: string; levelId: string;
  source?: 'CALIBRATED' | 'SCENE' | 'AREA';
  /** Calibrated phone height, already includes the phone-to-floor offset. */
  phoneHeightM: number; polygons: [number, number][][][];
}
export interface StartHeightMap { mapVersionId: string | null; sceneVersionId?: string | null; roads: StartHeightRoad[]; floors: StartHeightFloor[]; circularAxis?: CircularAxis | null }
export interface StartHeightCandidate { id: string; kind: 'ROAD' | 'FLOOR'; buildingId: string | null; levelId: string | null; phoneHeightM: number }
export interface StartHeightSelection {
  reason: 'SELECTED' | 'NO_CANDIDATE' | 'AMBIGUOUS' | 'POSITION_UNCERTAIN';
  candidates: StartHeightCandidate[]; selected: StartHeightCandidate | null;
}

/** Snapshot mutable map materials once per run/session. The exact snapshot is saved in run config. */
export async function loadStartHeightMap(config: object, mapVersionId: string | null): Promise<StartHeightMap | null> {
  const c = config as FusionConfigV4;
  if (!c.startHeightRoadsEnabled && !c.startHeightFloorsEnabled && !c.roadHeightAnchorsEnabled && !c.circularCorridorEnabled) return null;
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const roads: StartHeightRoad[] = [];
    const floors: StartHeightFloor[] = [];
    let sceneVersionId: string | null = null;
    let circularAxis: CircularAxis | null = null;
    if (c.startHeightRoadsEnabled || c.roadHeightAnchorsEnabled) {
      const { rows } = await db.query<StartHeightRoad & { geometry: { coordinates: [number, number, number][] } }>(
        `SELECT id, building_id "buildingId", level_id "levelId", status, revision, ST_AsGeoJSON(geom, 8)::json geometry
         FROM mobility.road_segments WHERE (status='APPROVED' OR ($1 AND status='DRAFT'))
         AND pedestrian_access <> 'prohibited' AND structure <> 'elevator' ORDER BY id`, [c.startHeightIncludeDrafts || c.roadHeightAnchorIncludeDrafts]);
      for (const { geometry, ...r } of rows) roads.push({ ...r, coordinates: geometry.coordinates });
    }
    if (c.startHeightFloorsEnabled && mapVersionId) {
      const { rows } = await db.query<{ buildingId: string; geometry: { coordinates: [number, number][][][] }; calibration: { entrancePhoneOrthometricM?: number; levels?: { orthometricM: number; relativeFloor: number }[] } | null }>(
        `SELECT b.building_id "buildingId", ST_AsGeoJSON(b.geom, 8)::json geometry, m.metadata->'calibration' calibration
         FROM campus_buildings b JOIN building_metadata m ON m.map_version_id=b.map_version_id AND m.building_id=b.building_id
         WHERE b.map_version_id=$1 ORDER BY b.building_id`, [mapVersionId]);
      for (const r of rows) {
        const levels = [...(r.calibration?.levels ?? [])];
        const entrance = r.calibration?.entrancePhoneOrthometricM;
        if (typeof entrance === 'number' && Number.isFinite(entrance) && !levels.some((l) => l.relativeFloor === 0)) {
          levels.push({ orthometricM: entrance, relativeFloor: 0 });
        }
        for (const l of levels) if (Number.isFinite(l.orthometricM) && Number.isFinite(l.relativeFloor)) {
          floors.push({ id: `${r.buildingId}:${l.relativeFloor}`, source: 'CALIBRATED', buildingId: r.buildingId, levelId: String(l.relativeFloor), phoneHeightM: l.orthometricM, polygons: r.geometry.coordinates });
        }
      }
      // These explicit floor tables also drive the preview's building floor view. They are map
      // estimates, not calibration measurements, so the resulting datum remains provisional.
      const { rows: scenes } = await db.query<{ id: string; appearance: { id: string; windows?: { floorsM?: number[]; floorNames?: string[] } }[] | null }>(
        `SELECT id, metadata->'appearance' appearance FROM scene_versions WHERE active AND map_version_id=$1 ORDER BY id LIMIT 1`, [mapVersionId]);
      const scene = scenes[0];
      if (scene) {
        sceneVersionId = scene.id;
        const { rows: buildings } = await db.query<{ buildingId: string; geometry: { coordinates: [number, number][][][] } }>(
          `SELECT building_id "buildingId", ST_AsGeoJSON(geom, 8)::json geometry FROM scene_buildings WHERE scene_version_id=$1 ORDER BY building_id`, [scene.id]);
        const polygons = new Map(buildings.map((b) => [b.buildingId, b.geometry.coordinates]));
        for (const a of scene.appearance ?? []) {
          const shape = polygons.get(a.id);
          if (!shape) continue;
          for (const [i, h] of (a.windows?.floorsM ?? []).entries()) if (Number.isFinite(h)) {
            floors.push({ id: `scene:${a.id}:${i}`, source: 'SCENE', buildingId: a.id,
              levelId: a.windows?.floorNames?.[i] || `height:${h}`, phoneHeightM: h + c.phoneHeightM, polygons: shape });
          }
        }
      }
      const { rows: areas } = await db.query<{ id: number; buildingId: string; floor: string; elevationM: number; geometry: { coordinates: [number, number][][] } }>(
        `SELECT id, building_id "buildingId", floor, elevation_m "elevationM", ST_AsGeoJSON(geom, 8)::json geometry
         FROM mobility.open_areas WHERE building_id IS NOT NULL AND floor IS NOT NULL AND elevation_m IS NOT NULL ORDER BY id`);
      for (const a of areas) if (Number.isFinite(a.elevationM)) floors.push({ id: `area:${a.id}`, source: 'AREA',
        buildingId: a.buildingId, levelId: a.floor, phoneHeightM: a.elevationM + c.phoneHeightM, polygons: [a.geometry.coordinates] });
    }
    if (c.circularCorridorEnabled && c.circularCorridorBuildingId && mapVersionId) {
      const { rows } = await db.query<{ sceneId: string; geometry: { coordinates: [number, number][][][] } }>(
        `SELECT v.id "sceneId", ST_AsGeoJSON(b.geom, 8)::json geometry FROM scene_buildings b
         JOIN scene_versions v ON v.id=b.scene_version_id WHERE v.active AND v.map_version_id=$1 AND b.building_id=$2`,
        [mapVersionId, c.circularCorridorBuildingId]);
      if (rows[0]) {
        sceneVersionId = rows[0].sceneId;
        circularAxis = circularFootprintAxis(c.circularCorridorBuildingId, rows[0].geometry.coordinates[0]?.[0] ?? []);
      }
    }
    await db.query('COMMIT');
    return { mapVersionId, sceneVersionId, roads, floors, circularAxis };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { db.release(); }
}

/** Local candidates only; multiple distinct heights require an explicit level or decisive GPS evidence. */
export function selectStartHeight(map: StartHeightMap, x: number, y: number, sigmaXY: number, c: FusionConfigV4,
  gps: { heightM: number; accuracy: number } | null): StartHeightSelection {
  const candidates: StartHeightCandidate[] = [];
  if (!Number.isFinite(sigmaXY) || sigmaXY > c.startHeightMaxPositionSigmaM) return { reason: 'POSITION_UNCERTAIN', candidates, selected: null };
  const eligible = (buildingId: string | null, levelId: string | null) =>
    (!c.startHeightBuildingId || c.startHeightBuildingId === buildingId) && (!c.startHeightLevelId || c.startHeightLevelId === levelId);
  if (c.startHeightRoadsEnabled) for (const road of map.roads) {
    if (road.status !== 'APPROVED' && !(c.startHeightIncludeDrafts && road.status === 'DRAFT')) continue;
    if (!eligible(road.buildingId, road.levelId)) continue;
    let best = { distance: Infinity, height: 0 };
    for (let i = 1; i < road.coordinates.length; i++) {
      const a = road.coordinates[i - 1], b = road.coordinates[i];
      if (![...a, ...b].every(Number.isFinite)) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      if (len2 < 1e-8) continue;
      const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
      const distance = Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy);
      if (distance < best.distance) best = { distance, height: a[2] + u * (b[2] - a[2]) };
    }
    if (best.distance <= c.startHeightRoadRadiusM) candidates.push({ id: road.id, kind: 'ROAD', buildingId: road.buildingId, levelId: road.levelId, phoneHeightM: best.height + c.phoneHeightM });
  }
  if (c.startHeightFloorsEnabled) for (const floor of map.floors) {
    if (!eligible(floor.buildingId, floor.levelId) || !Number.isFinite(floor.phoneHeightM)) continue;
    const inside = terrain.buildingAt({ buildings: [{ ...floor, name: null, groundFloors: null, undergroundFloors: null, heightM: null, floorLabels: [] }] }, x, y).building;
    if (inside) candidates.push({ id: floor.id, kind: 'FLOOR', buildingId: floor.buildingId, levelId: floor.levelId, phoneHeightM: floor.phoneHeightM });
  }
  if (!candidates.length) return { reason: 'NO_CANDIDATE', candidates, selected: null };
  const heights = candidates.map((p) => p.phoneHeightM);
  if (Math.max(...heights) - Math.min(...heights) <= c.startHeightAmbiguityM) return { reason: 'SELECTED', candidates, selected: candidates[0] };
  if (gps && gps.accuracy > 0 && gps.accuracy <= c.startHeightGpsMaxSigmaM) {
    const ranked = [...candidates].sort((a, b) => Math.abs(a.phoneHeightM - gps.heightM) - Math.abs(b.phoneHeightM - gps.heightM));
    const best = ranked[0];
    const others = ranked.filter((p) => Math.abs(p.phoneHeightM - best.phoneHeightM) > c.startHeightAmbiguityM);
    const error = Math.abs(best.phoneHeightM - gps.heightM);
    if (error <= gps.accuracy && others.every((p) => Math.abs(p.phoneHeightM - gps.heightM) - error > 2 * gps.accuracy)) {
      return { reason: 'SELECTED', candidates, selected: best };
    }
  }
  return { reason: 'AMBIGUOUS', candidates, selected: null };
}
