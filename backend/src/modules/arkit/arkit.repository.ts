import { pool, type DbClient } from '../../config/database.js';
import type { ArkitPose } from './arkit.dto.js';
import { ARKIT_ALGORITHM, lineGeometry, type PosePoint, type GpsPoint, type FusionPoint, type TrajectoryResult } from './arkit.engine.js';
import { REALTIME_FUSION_VERSION } from '../fusion/fusion.algorithms.js';

export const arkitRepository = {
  async insert(db: DbClient, p: ArkitPose, deviceId: string) {
    await db.query(`INSERT INTO arkit_sessions(session_id,ar_session_id,device_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [p.sessionId, p.arSessionId, deviceId]);
    const { rows } = await db.query<{ receivedAt: Date }>(`INSERT INTO arkit_pose_samples
      (session_id,ar_session_id,device_id,sequence,timestamp,frame_timestamp,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,tracking_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(session_id,ar_session_id,sequence) DO NOTHING RETURNING created_at AS "receivedAt"`,
      [p.sessionId,p.arSessionId,deviceId,p.sequence,new Date(p.timestamp),p.frameTimestamp,p.position.x,p.position.y,p.position.z,p.rotation.x,p.rotation.y,p.rotation.z,p.rotation.w,p.trackingState]);
    if (rows.length) return { duplicate: false, receivedAt: rows[0].receivedAt };
    const existing = await db.query<{ receivedAt: Date }>('SELECT created_at AS "receivedAt" FROM arkit_pose_samples WHERE session_id=$1 AND ar_session_id=$2 AND sequence=$3', [p.sessionId,p.arSessionId,p.sequence]);
    return { duplicate: true, receivedAt: existing.rows[0].receivedAt };
  },
  async poses(sessionId: string, arSessionId: string, db: DbClient = pool): Promise<PosePoint[]> {
    return (await db.query<PosePoint>(`SELECT sequence,extract(epoch FROM timestamp)*1000::float8 AS timestamp,frame_timestamp AS "frameTimestamp",
      position_x AS x,position_y AS y,position_z AS z,tracking_state AS "trackingState" FROM arkit_pose_samples
      WHERE session_id=$1 AND ar_session_id=$2 ORDER BY timestamp,sequence`, [sessionId,arSessionId])).rows;
  },
  async gps(sessionId: string, db: DbClient = pool): Promise<GpsPoint[]> {
    return (await db.query<GpsPoint>(`SELECT extract(epoch FROM timestamp)*1000::float8 AS timestamp,latitude,longitude,
      horizontal_accuracy AS "horizontalAccuracy",altitude,ellipsoidal_altitude AS "ellipsoidalAltitude",vertical_accuracy AS "verticalAccuracy"
      FROM location_samples WHERE session_id=$1 ORDER BY timestamp,sequence`, [sessionId])).rows;
  },
  async fusion(sessionId: string, db: DbClient = pool): Promise<FusionPoint[]> {
    return (await db.query<FusionPoint>(`SELECT extract(epoch FROM timestamp)*1000::float8 AS timestamp,latitude,longitude,
      ellipsoidal_altitude AS "ellipsoidalAltitude",COALESCE(spatial_segment_id,0) AS segment FROM fused_positions
      WHERE session_id=$1 AND algorithm_version=$2 ORDER BY timestamp,fusion_sequence`, [sessionId,REALTIME_FUSION_VERSION])).rows;
  },
  async sessions(sessionId: string, db: DbClient = pool) {
    return (await db.query<{ arSessionId: string; poseCount: number; lastPose: PosePoint; lastReceivedAt: Date; result: TrajectoryResult | null; generatedAt: Date | null }>(`SELECT a.ar_session_id AS "arSessionId",
      (SELECT count(*) FROM arkit_pose_samples p WHERE p.session_id=a.session_id AND p.ar_session_id=a.ar_session_id) AS "poseCount",
      (SELECT json_build_object('sequence',p.sequence,'timestamp',extract(epoch FROM p.timestamp)*1000,'frameTimestamp',p.frame_timestamp,'x',p.position_x,'y',p.position_y,'z',p.position_z,'trackingState',p.tracking_state)
        FROM arkit_pose_samples p WHERE p.session_id=a.session_id AND p.ar_session_id=a.ar_session_id ORDER BY p.timestamp DESC,p.sequence DESC LIMIT 1) AS "lastPose",
      (SELECT max(created_at) FROM arkit_pose_samples p WHERE p.session_id=a.session_id AND p.ar_session_id=a.ar_session_id) AS "lastReceivedAt",
      r.result,r.generated_at AS "generatedAt"
      FROM arkit_sessions a LEFT JOIN arkit_trajectory_results r ON r.session_id=a.session_id AND r.ar_session_id=a.ar_session_id AND r.algorithm_version=$2
      WHERE a.session_id=$1 ORDER BY a.created_at,a.ar_session_id`, [sessionId,ARKIT_ALGORITHM])).rows;
  },
  async save(db: DbClient, sessionId: string, arSessionId: string, result: TrajectoryResult) {
    const geometry = (g: unknown) => g ? JSON.stringify(g) : null;
    await db.query(`INSERT INTO arkit_trajectory_results(session_id,ar_session_id,algorithm_version,result,aligned_geom,corrected_geom)
      VALUES($1,$2,$3,$4,ST_SetSRID(ST_GeomFromGeoJSON($5),5186),ST_SetSRID(ST_GeomFromGeoJSON($6),5186))
      ON CONFLICT(session_id,ar_session_id,algorithm_version) DO UPDATE SET result=excluded.result,aligned_geom=excluded.aligned_geom,corrected_geom=excluded.corrected_geom,generated_at=now()`,
      [sessionId,arSessionId,ARKIT_ALGORITHM,JSON.stringify(result),geometry(lineGeometry(result.aligned)),geometry(lineGeometry(result.corrected))]);
  },
};
