import { withTransaction } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { signAccessToken, type CollectorIdentity } from '../../common/auth/jwt.js';
import { logger } from '../../common/logger.js';
import { realtimeState } from '../../realtime/realtime-state.service.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { disconnectCollectorSockets } from '../../realtime/collector.gateway.js';
import { fusionService } from '../fusion/fusion.service.js';
import { RAW_COLLECTOR_WS_PATH, closeRawCollectorConnections } from '../../realtime/raw-ws.gateway.js';
import { collectorRepository } from './collector.repository.js';
import { sessionRepository } from '../sessions/session.repository.js';
import {
  COLLECTOR_DELETE_CONFIRM_TEXT,
  type CollectorStatusRequest,
  type CreateCollectorRequest,
  type LoginRequest,
  type LoginResponse,
} from './collector.dto.js';

export const collectorService = {
  async login(req: LoginRequest, serverOrigin: string): Promise<LoginResponse> {
    const collector = await collectorRepository.findByCode(req.collectorId);
    if (!collector) {
      throw AppError.notFound('COLLECTOR_NOT_FOUND', `Collector ${req.collectorId} is not registered`);
    }
    const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, req.deviceId, {
      platform: req.platform ?? 'ios',
      deviceModel: req.deviceModel,
      systemVersion: req.systemVersion,
      appVersion: req.appVersion,
    });
    const accessToken = signAccessToken({
      collectorId: collector.collector_code,
      collectorDatabaseId: collector.id,
      deviceDatabaseId,
      clientDeviceId: req.deviceId,
    });
    logger.info('collector.login', { collectorId: collector.collector_code, deviceId: req.deviceId, deviceModel: req.deviceModel });
    return {
      collectorId: collector.collector_code,
      accessToken,
      socketUrl: serverOrigin,
      socketNamespace: '/collector',
      webSocketURL: `${serverOrigin.replace(/^http/, 'ws')}${RAW_COLLECTOR_WS_PATH}`, // http->ws, https->wss
    };
  },

  /** Socket handshake check: the token's device must still exist (DB may have been reset in dev). */
  async touchDevice(identity: CollectorIdentity): Promise<void> {
    const ok = await collectorRepository.touchDevice(identity.deviceDatabaseId, identity.collectorDatabaseId);
    if (!ok) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device for this token no longer exists, login again');
  },

  socketConnected(identity: CollectorIdentity) {
    previewBroadcast.collectorConnected(realtimeState.connected(identity.collectorId));
  },

  socketDisconnected(identity: CollectorIdentity) {
    const state = realtimeState.disconnected(identity.collectorId);
    if (state) previewBroadcast.collectorDisconnected(state);
  },

  /** Periodic status from the phone: memory + preview only, not persisted. */
  reportStatus(identity: CollectorIdentity, status: CollectorStatusRequest) {
    previewBroadcast.collectorStatus(realtimeState.statusReported(identity.collectorId, status));
    return { ok: true as const };
  },

  /** All registered collectors merged with in-memory realtime state, for the preview sidebar. */
  async listWithState() {
    realtimeState.hydrate(await sessionRepository.activeSessionsByCollector());
    const collectors = await collectorRepository.listAll();
    return collectors.map((c) => realtimeState.get(c.collector_code) ?? realtimeState.empty(c.collector_code));
  },

  // ---- ID management (preview) ----

  /** Issues a new collector ID. Explicit code -> 409 if taken; no code -> next free C<nn>. */
  async create(req: CreateCollectorRequest) {
    let created = null;
    if (req.collectorId) {
      created = await collectorRepository.insert(req.collectorId);
      if (!created) throw AppError.conflict('COLLECTOR_EXISTS', `Collector ${req.collectorId} already exists`);
    } else {
      // Retry covers two browsers issuing at the same moment.
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        created = await collectorRepository.insert(await collectorRepository.nextAutoCode());
      }
      if (!created) throw AppError.conflict('COLLECTOR_CODE_RACE', 'Could not allocate a collector ID, try again');
    }
    logger.info('collector.created', { collectorId: created.collector_code });
    const state = realtimeState.empty(created.collector_code);
    previewBroadcast.collectorCreated(state);
    return state;
  },

  async getSummary(code: string) {
    const summary = await collectorRepository.summary(code);
    if (!summary) throw AppError.notFound('COLLECTOR_NOT_FOUND', `Collector ${code} is not registered`);
    return summary;
  },

  /**
   * Deletes the collector ID with all of its devices, sessions and raw data.
   * Guarded by the exact confirmation text so it cannot happen by a stray click/request.
   */
  async remove(code: string, confirmText: string) {
    if (confirmText.trim() !== COLLECTOR_DELETE_CONFIRM_TEXT) {
      throw AppError.badRequest('CONFIRMATION_REQUIRED', `Type "${COLLECTOR_DELETE_CONFIRM_TEXT}" to delete`);
    }
    const summary = await this.getSummary(code);
    const removedSessionIds = await withTransaction(async (client) => {
      const collector = await collectorRepository.findByCode(code, client);
      if (!collector) throw AppError.notFound('COLLECTOR_NOT_FOUND', `Collector ${code} is not registered`);
      return collectorRepository.deleteWithData(client, collector.id);
    });

    // ---- after COMMIT ----
    // Kick the phone: its token now points at a deleted device, so reconnect fails with DEVICE_NOT_FOUND.
    const kicked = disconnectCollectorSockets(code) + closeRawCollectorConnections(code);
    realtimeState.remove(code);
    fusionService.forget(removedSessionIds);
    previewBroadcast.collectorRemoved({ collectorId: code, sessionIds: removedSessionIds });
    logger.warn('collector.deleted', { ...summary, kickedSockets: kicked });
    return { ok: true as const, collectorId: code, deleted: summary };
  },
};
