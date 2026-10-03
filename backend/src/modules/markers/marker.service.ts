import { AppError } from '../../common/errors/app-error.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { logger } from '../../common/logger.js';
import { realtimeState } from '../../realtime/realtime-state.service.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { sessionService } from '../sessions/session.service.js';
import { markerRepository } from './marker.repository.js';
import type { MarkerCreateRequest } from './marker.dto.js';
import { fusionRepository } from '../fusion/fusion.repository.js';
import type { FusedPositionView } from '../fusion/fusion.dto.js';

/** Markers are shown on the finished (replayed) fusion track: position and height at the marker time. */
const SNAP_VERSION = 'fusion-v4';
const SNAP_MAX_GAP_MS = 10_000;

function snapToTrack(track: FusedPositionView[], t: number) {
  if (!track.length) return null;
  let lo = 0;
  let hi = track.length - 1;
  const ms = (i: number) => new Date(track[i].timestamp).getTime();
  if (t < ms(0) - 3000 || t > ms(hi) + 3000) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ms(mid) <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const ta = ms(lo);
  const tb = ms(hi);
  // between two outputs (no long gap): interpolate; otherwise the nearest one
  const u = tb > ta && tb - ta <= SNAP_MAX_GAP_MS ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : Math.abs(t - ta) <= Math.abs(t - tb) ? 0 : 1;
  const lerp = (x: number | null, y: number | null) => (x === null || y === null ? (u < 0.5 ? x : y) : x + (y - x) * u);
  const near = u < 0.5 ? a : b;
  return {
    algorithmVersion: SNAP_VERSION,
    latitude: lerp(a.latitude, b.latitude)!,
    longitude: lerp(a.longitude, b.longitude)!,
    ellipsoidalAltitude: lerp(a.ellipsoidalAltitude, b.ellipsoidalAltitude),
    heightAboveGround: lerp(a.heightAboveGround, b.heightAboveGround),
    zDatumSource: near.zDatumSource,
    buildingName: near.buildingName,
  };
}

export const markerService = {
  async create(identity: CollectorIdentity, req: MarkerCreateRequest) {
    const session = await sessionService.resolveOwnedSession(identity, req.sessionId, req.clientSessionId);

    // Single INSERT statement -> atomic on its own, no explicit transaction needed.
    const created = await markerRepository.insert(session.id, req);
    if (!created) {
      const existingSessionId = await markerRepository.findSessionIdByMarkerId(req.markerId);
      if (existingSessionId !== session.id) {
        throw AppError.conflict('MARKER_SESSION_CONFLICT', 'markerId was already used for another session');
      }
      logger.info('marker.duplicate', { collectorId: identity.collectorId, markerId: req.markerId });
      return { ok: true as const, markerId: req.markerId, duplicate: true };
    }

    logger.info('marker.created', { collectorId: identity.collectorId, sessionId: session.id, markerId: req.markerId, type: req.type });
    previewBroadcast.markerCreated({ collectorId: identity.collectorId, ...created });
    previewBroadcast.collectorStatus(realtimeState.markerCreated(identity.collectorId));
    return { ok: true as const, markerId: req.markerId, duplicate: false };
  },

  async listBySession(sessionId: string) {
    await sessionService.get(sessionId);
    const [markers, track] = await Promise.all([markerRepository.findBySession(sessionId), fusionRepository.list(sessionId, SNAP_VERSION)]);
    return markers.map((m) => ({ ...m, fused: snapToTrack(track, new Date(m.timestamp).getTime()) }));
  },
};
