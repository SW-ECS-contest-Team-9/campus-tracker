import { Router } from 'express';
import { z } from 'zod';
import { Uuid } from '../../common/dto.js';
import { pool } from '../../config/database.js';
import { arkitRepository } from './arkit.repository.js';
import { arkitService } from './arkit.service.js';

// Same read-only internal preview policy as existing session/fusion endpoints.
export const arkitRoutes = Router({ mergeParams:true });
arkitRoutes.get('/',async(req,res) => {
  const sessionId = Uuid.parse((req.params as Record<string,string>).sessionId);
  res.json({sessionId,sessions:await arkitRepository.sessions(sessionId)});
});
arkitRoutes.get('/:arSessionId/poses',async(req,res) => {
  const sessionId = Uuid.parse((req.params as Record<string,string>).sessionId), arSessionId = Uuid.parse(req.params.arSessionId);
  const q = z.object({ afterId:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(10000).default(1000),
    from:z.coerce.number().nonnegative().max(8_640_000_000_000_000).optional(), to:z.coerce.number().nonnegative().max(8_640_000_000_000_000).optional() }).parse(req.query);
  // Immutable id cursor is safe when offline uploads add older capture times during pagination.
  const {rows} = await pool.query(`SELECT id,sequence,extract(epoch FROM timestamp)*1000::float8 AS timestamp,frame_timestamp AS "frameTimestamp",
    position_x AS x,position_y AS y,position_z AS z,rotation_x AS "rotationX",rotation_y AS "rotationY",rotation_z AS "rotationZ",rotation_w AS "rotationW",
    tracking_state AS "trackingState",created_at AS "receivedAt" FROM arkit_pose_samples
    WHERE session_id=$1 AND ar_session_id=$2 AND id>$3 AND ($5::timestamptz IS NULL OR timestamp >= $5) AND ($6::timestamptz IS NULL OR timestamp <= $6)
    ORDER BY id LIMIT $4`,[sessionId,arSessionId,q.afterId,q.limit,q.from==null?null:new Date(q.from),q.to==null?null:new Date(q.to)]);
  res.json({poses:rows,nextAfterId:rows.length===q.limit?rows.at(-1)!.id:null});
});
arkitRoutes.post('/reprocess',async(req,res) => res.json(await arkitService.reprocess(Uuid.parse((req.params as Record<string,string>).sessionId))));
