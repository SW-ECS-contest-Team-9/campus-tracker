/**
 * Calibrates building levels from a field session recorded with markers (fusion-v4 with a TERRAIN datum required):
 *  - "entrance" markers: the phone height at the building's entrance floor (orthometric, Incheon MSL)
 *  - barometric plateaus inside the building: its floor levels, each with its measured height (storeys are uneven here)
 * Stored in building_metadata.metadata.calibration; the preview shows "entrance floor +N" from it.
 *
 *   npm run buildings:calibrate -- --session=<uuid> [--session=<uuid> ...]
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { calibrateLevels, heightPlateaus } from '../src/modules/trajectory/height-difference.js';

const { values: args } = parseArgs({ options: { session: { type: 'string', multiple: true } } });
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const PHONE_HEIGHT_M = 1;
const DEFAULT_FLOOR_HEIGHT_M = 3.5;

async function main() {
  const sessions = args.session ?? [];
  if (!sessions.length) throw new Error('--session is required');
  const ctx = await terrain.context(await terrain.activeVersion());
  if (!ctx) throw new Error('No active terrain version');
  const N = ctx.geoidSeparation;

  // entrance markers -> fused v4 height at the marker time, only with a terrain datum
  const { rows: entrances } = await pool.query<{ session: string; building: string | null; ortho: number | null; source: string | null; sigma: number | null }>(
    `SELECT m.session_id::text session, f.building_name building, f.ellipsoidal_altitude - $2 ortho, f.z_datum_source source, f.z_datum_sigma sigma
       FROM event_markers m
       JOIN LATERAL (SELECT * FROM fused_positions f WHERE f.session_id = m.session_id AND f.algorithm_version = 'fusion-v4'
                       AND f."timestamp" BETWEEN m."timestamp" - interval '3 seconds' AND m."timestamp" + interval '3 seconds'
                     ORDER BY abs(extract(epoch FROM f."timestamp" - m."timestamp")) LIMIT 1) f ON true
      WHERE m.session_id = ANY($1::uuid[]) AND m.type = 'entrance'`,
    [sessions, N],
  );
  const usable = entrances.filter((e) => e.building && e.source === 'TERRAIN' && e.ortho !== null && (e.sigma ?? 9) <= 1.5);
  console.log(`entrance markers: ${entrances.length}, usable (inside a building, terrain datum): ${usable.length}`);

  for (const name of [...new Set(usable.map((e) => e.building!))]) {
    const entrance = median(usable.filter((e) => e.building === name).map((e) => e.ortho!))!;
    // floor levels: clusters of the fused height inside the building (plateaus of the barometer)
    const { rows: pts } = await pool.query<{ ortho: number }>(
      `SELECT ellipsoidal_altitude - $3 ortho FROM fused_positions
        WHERE session_id = ANY($1::uuid[]) AND algorithm_version = 'fusion-v4' AND building_name = $2 AND z_datum_source = 'TERRAIN'
        ORDER BY 1`,
      [sessions, name, N],
    );
    // plateaus = peaks of the height histogram (stairs only pass through; levels are where time is spent).
    // Clearly separate plateaus stay separate levels, however close or far apart (trajectory/height-difference.ts).
    const plateaus = heightPlateaus(pts.map((p) => p.ortho));
    const { rows: meta } = await pool.query<{ buildingId: string; mapVersionId: string; heightM: number | null; floors: number | null; metadata: Record<string, unknown> }>(
      `SELECT m.building_id "buildingId", m.map_version_id "mapVersionId", m.register_height_m "heightM", m.register_ground_floors floors, m.metadata
         FROM building_metadata m JOIN spatial_map_versions v ON v.id = m.map_version_id AND v.active WHERE m.display_name = $1`,
      [name],
    );
    if (!meta.length) {
      console.log(`  ${name}: no building metadata row, skipped`);
      continue;
    }
    const registerFloorHeight = meta[0].heightM && meta[0].floors ? meta[0].heightM / meta[0].floors : null;
    const measured = calibrateLevels(plateaus, entrance, registerFloorHeight, DEFAULT_FLOOR_HEIGHT_M);
    const calibration = {
      entrancePhoneOrthometricM: r2(entrance),
      entranceFloorOrthometricM: r2(entrance - PHONE_HEIGHT_M),
      // one number for the "entrance floor +N" label of the preview only; the measured levels below are what counts
      floorHeightM: r2(measured.floorHeightM),
      floorHeightSource: measured.floorHeightSource,
      levelGapsM: measured.levelGapsM.map(r2),
      // relativeFloor = order of the measured plateaus from the entrance level (a floor nobody walked is not counted)
      levels: measured.levels.map((l) => ({ orthometricM: r2(l.orthometricM), aboveEntranceM: r2(l.aboveEntranceM), relativeFloor: l.relativeFloor, samples: l.samples })),
      entranceMarkers: usable.filter((e) => e.building === name).map((e) => r2(e.ortho!)),
      sessions,
      calibratedAt: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE building_metadata SET metadata = metadata || jsonb_build_object('calibration', $3::jsonb) WHERE map_version_id = $1 AND building_id = $2`,
      [meta[0].mapVersionId, meta[0].buildingId, JSON.stringify(calibration)],
    );
    console.log(`  ${name}: entrance floor ${calibration.entranceFloorOrthometricM} m (phone ${calibration.entrancePhoneOrthometricM} m, markers ${calibration.entranceMarkers.join(', ')}), floor height ${calibration.floorHeightM} m (${calibration.floorHeightSource})`);
    for (const l of calibration.levels) console.log(`     level ${l.orthometricM} m (${l.aboveEntranceM >= 0 ? '+' : ''}${l.aboveEntranceM} m) -> measured level ${l.relativeFloor >= 0 ? '+' : ''}${l.relativeFloor} from the entrance (${l.samples} samples)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
