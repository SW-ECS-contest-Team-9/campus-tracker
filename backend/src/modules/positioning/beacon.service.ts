import { createHash } from 'node:crypto';
import { withTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../common/logger.js';
import { tmInverse } from '../../geo/tm.js';
import { sessionService } from '../sessions/session.service.js';
import { fusionService } from '../fusion/fusion.service.js';
import { REALTIME_FUSION_VERSION } from '../fusion/fusion.algorithms.js';
import { BEACON_RSSI_DEFAULTS } from './beacon-calibration.js';
import {
  AnchorCreate, AnchorUpdate, BeaconCreate, BeaconObservationBatch, BeaconUpdate, CalibrationUpsert, DiscoveredQuery, SurveyUuidCreate,
  beaconKey, checkObservation,
  type BeaconRowRejection,
} from './beacon.dto.js';
import { beaconRepository, type BeaconView } from './beacon.repository.js';
import { loadFusionBeacons } from './beacon-fusion-input.js';

const MAX_REJECTIONS_IN_ACK = 100;

export interface BeaconBatchAck {
  ok: true;
  batchId: string;
  receivedAt: string;
  duplicate: boolean;
  /** rows in the batch / rows newly stored / rows already stored by an earlier batch (same observationId) */
  received: number;
  inserted: number;
  duplicateObservations: number;
  /** identity resolution of the stored rows */
  registered: number;
  unregistered: number;
  disabled: number;
  /** rows refused by the row checks (not stored); at most 100 listed */
  rejected: { observationId: string; reason: BeaconRowRejection }[];
  rejectedCount: number;
}

/** Beacon config remote switches; all false while BEACON_POSITIONING=off. */
export function beaconFeatures() {
  const on = env.BEACON_POSITIONING === 'on';
  return {
    scanning: on && env.BEACON_CLIENT_SCANNING,
    upload: on && env.BEACON_CLIENT_UPLOAD,
    fusion: on && env.BEACON_CLIENT_FUSION,
    floorCorrection: on && env.BEACON_CLIENT_FLOOR_CORRECTION,
  };
}

function anchorJson(b: BeaconView) {
  if (!b.anchor) return null;
  const ll = tmInverse(b.anchor.position.x, b.anchor.position.y);
  return {
    anchorId: b.anchor.anchorId, anchorType: b.anchor.anchorType, buildingId: b.anchor.buildingId, floor: b.anchor.floor,
    floorHeightM: b.anchor.floorHeightM, position: b.anchor.position, latitude: ll.latitude, longitude: ll.longitude,
    horizontalAccuracyM: b.anchor.horizontalAccuracyM, verticalAccuracyM: b.anchor.verticalAccuracyM,
  };
}

export const beaconService = {
  /**
   * beacon.observations.v1: schema -> session (owner) -> per-row checks -> identity resolution -> BEGIN -> batch gate
   * -> rows (ON CONFLICT (session, observationId) DO NOTHING) -> last_observed_at -> COMMIT -> ACK -> fusion (after the ACK).
   * Duplicate batchId: no new rows, duplicate: true with the first receivedAt. Unregistered / disabled beacons are stored
   * (raw data) but never reach fusion.
   */
  async ingest(identity: CollectorIdentity, payload: unknown): Promise<BeaconBatchAck> {
    if (env.BEACON_POSITIONING !== 'on') {
      throw new AppError(503, 'BEACON_DISABLED', 'Beacon positioning is turned off on this server', undefined, false);
    }
    const batch = BeaconObservationBatch.parse(payload);
    const session = await sessionService.resolveOwnedSession(identity, batch.sessionId, batch.clientSessionId);

    const rejected: BeaconBatchAck['rejected'] = [];
    const seenIds = new Set<string>();
    const valid = batch.observations.filter((o) => {
      const id = o.observationId.toLowerCase();
      const reason = seenIds.has(id) ? 'DUPLICATE_IN_BATCH' : checkObservation(o);
      seenIds.add(id);
      if (reason) rejected.push({ observationId: o.observationId, reason });
      return !reason;
    });
    const keys = [...new Map(valid.map((o) => [beaconKey(o.protocol, o.uuid, o.major, o.minor), o])).values()];
    const registry = await beaconRepository.resolve(keys);

    const result = await withTransaction(async (db) => {
      const receivedAt = await beaconRepository.insertBatch(db, {
        batchId: batch.batchId, sessionId: session.id, deviceId: identity.deviceDatabaseId, schemaVersion: batch.schemaVersion,
        platform: batch.platform, clientCreatedAt: batch.createdAt ?? null, observationCount: batch.observations.length,
      });
      if (!receivedAt) {
        const existing = await beaconRepository.findBatch(db, batch.batchId);
        if (!existing) throw new Error('beacon batch conflict without existing row');
        if (existing.session_id !== session.id) throw AppError.conflict('BATCH_SESSION_CONFLICT', 'batchId was already used for another session');
        return { duplicate: true, receivedAt: existing.received_at, inserted: new Set<string>(), resolution: new Map<string, string>() };
      }
      const resolution = new Map<string, string>();
      const rows = valid.map((o) => {
        const id = registry.get(beaconKey(o.protocol, o.uuid, o.major, o.minor));
        const r = !id ? 'UNREGISTERED' : id.enabled && id.anchorActive ? 'REGISTERED' : 'DISABLED';
        resolution.set(o.observationId.toLowerCase(), r);
        return {
          observationId: o.observationId, protocol: o.protocol, uuid: o.uuid.toLowerCase(), major: o.major, minor: o.minor,
          beaconId: id?.beaconId ?? null, resolution: r, rssiDbm: o.rssiDbm, observedAt: o.observedAt,
          deviceModel: o.deviceModel ?? batch.deviceModel ?? null, proximity: o.proximity ?? null,
          platformDistanceM: o.platformEstimatedDistanceMeters != null && o.platformEstimatedDistanceMeters >= 0 ? o.platformEstimatedDistanceMeters : null,
          measuredPowerDbm: o.measuredPowerDbm ?? null, timeUncertaintyMs: o.observationTimeUncertaintyMs ?? null,
          rssiAggregation: o.rssiAggregation ?? null, sampleCount: o.sampleCount ?? null,
        };
      });
      const inserted = await beaconRepository.insertObservations(db, session.id, batch.batchId, batch.platform, rows);
      const lastSeen = new Map<string, string>();
      for (const r of rows) {
        if (!r.beaconId || !inserted.has(r.observationId.toLowerCase())) continue;
        const prev = lastSeen.get(r.beaconId);
        if (!prev || Date.parse(r.observedAt) > Date.parse(prev)) lastSeen.set(r.beaconId, r.observedAt);
      }
      await beaconRepository.touchLastObserved(db, lastSeen);
      const registered = [...inserted].filter((id) => resolution.get(id) === 'REGISTERED').length;
      await beaconRepository.finishBatch(db, batch.batchId, inserted.size, registered);
      return { duplicate: false, receivedAt, inserted, resolution };
    });

    // ---- after COMMIT ----
    const count = (r: string) => [...result.inserted].filter((id) => result.resolution.get(id) === r).length;
    const ack: BeaconBatchAck = {
      ok: true, batchId: batch.batchId, receivedAt: result.receivedAt.toISOString(), duplicate: result.duplicate,
      received: batch.observations.length, inserted: result.inserted.size,
      duplicateObservations: result.duplicate ? 0 : valid.length - result.inserted.size,
      registered: count('REGISTERED'), unregistered: count('UNREGISTERED'), disabled: count('DISABLED'),
      rejected: rejected.slice(0, MAX_REJECTIONS_IN_ACK), rejectedCount: rejected.length,
    };
    logger.info(result.duplicate ? 'beacon.batch.duplicate' : 'beacon.batch.received', {
      collectorId: identity.collectorId, sessionId: session.id, batchId: batch.batchId, platform: batch.platform,
      received: ack.received, inserted: ack.inserted, registered: ack.registered, unregistered: ack.unregistered,
      disabled: ack.disabled, rejected: ack.rejectedCount || undefined,
    });
    if (!result.duplicate && ack.registered > 0) this.feedFusion(identity, session.id, session.status, session.started_at,
      [...result.inserted].filter((id) => result.resolution.get(id) === 'REGISTERED'));
    return ack;
  },

  /** Derived, fire-and-forget: never blocks or fails the ACK. Finished sessions get a final replay instead. */
  feedFusion(identity: CollectorIdentity, sessionId: string, status: string, startedAt: Date, observationIds: string[]) {
    if (status !== 'ACTIVE') return fusionService.finalizeSoon(sessionId);
    void loadFusionBeacons(sessionId, undefined, observationIds)
      .then((beacons) => {
        if (beacons.length) fusionService.processBatch(identity.collectorId, sessionId, startedAt,
          { locations: [], motion: [], altimeter: [], pedometer: [], beacons });
      })
      .catch((err) => logger.warn('beacon.fusion_feed_failed', { sessionId, message: err instanceof Error ? err.message : String(err) }));
  },

  /**
   * GET /positioning/beacon-config: enabled beacons with their anchors and RSSI models. The version is the registry
   * revision; the ETag also covers the server switches so turning a feature off reaches cached apps.
   */
  async config() {
    const [{ revision, updatedAt }, beacons, calibrations, survey] = await Promise.all([
      beaconRepository.revision(), beaconRepository.listBeacons({ includeDisabled: false }), beaconRepository.calibrations(),
      beaconRepository.surveyUuids(),
    ]);
    const features = beaconFeatures();
    const visible = env.BEACON_POSITIONING === 'on' ? beacons.filter((b) => !b.anchor || b.anchor.status === 'ACTIVE') : [];
    const etag = `W/"beacon-config-${revision}-${createHash('sha256').update(JSON.stringify(features)).digest('hex').slice(0, 8)}"`;
    const body = {
      schemaVersion: 1,
      configVersion: revision,
      updatedAt: updatedAt.toISOString(),
      generatedAt: new Date().toISOString(),
      coordinateSystem: { horizontal: 'EPSG:5186', vertical: 'MSL_KVD_INCHEON', units: 'm',
        note: 'position.z = mounting height above MSL; floorHeightM = floor surface above MSL' },
      cachePolicy: { maxAgeSeconds: env.BEACON_CONFIG_MAX_AGE_S, staleMaxSeconds: env.BEACON_CONFIG_STALE_MAX_S },
      features,
      // registered beacons' UUIDs + survey UUIDs (new major/minor values of those are collected for registration)
      proximityUuids: env.BEACON_POSITIONING === 'on'
        ? [...new Set([...visible.map((b) => b.uuid.toLowerCase()), ...survey.map((u) => u.uuid.toLowerCase())])].sort() : [],
      rssiDefaults: BEACON_RSSI_DEFAULTS,
      defaultCalibrations: calibrations.filter((c) => c.beaconId === null),
      beacons: visible.map((b) => ({
        beaconId: b.beaconId, protocol: b.protocol, uuid: b.uuid, major: b.major, minor: b.minor, measuredPowerDbm: b.measuredPowerDbm,
        anchor: anchorJson(b),
        calibrations: calibrations.filter((c) => c.beaconId === b.beaconId).map(({ beaconId: _b, ...c }) => c),
      })),
    };
    return { etag, body };
  },

  // ---- admin (positioningAdminAuth) ----

  async createBeacon(input: unknown, actor: string) {
    const b = BeaconCreate.parse(input);
    const id = await withTransaction(async (db) => {
      if (b.anchorId && !(await beaconRepository.findAnchor(b.anchorId, db))) throw AppError.notFound('ANCHOR_NOT_FOUND', 'Spatial anchor not found');
      const anchorId = b.anchor ? await beaconRepository.insertAnchor(db, b.anchor, actor) : b.anchorId ?? null;
      const beaconId = await beaconRepository.insertBeacon(db, b, anchorId, actor);
      if (!beaconId) {
        const existing = await beaconRepository.findBeaconByIdentity(b.protocol, b.uuid, b.major, b.minor, db);
        throw AppError.conflict('BEACON_EXISTS', 'A beacon with this UUID / major / minor is already registered', { beaconId: existing });
      }
      await beaconRepository.bump(db);
      return beaconId;
    });
    logger.info('beacon.registry.created', { actor, beaconId: id });
    return (await beaconRepository.findBeacon(id))!;
  },

  async updateBeacon(beaconId: string, input: unknown, actor: string) {
    const u = BeaconUpdate.parse(input);
    await withTransaction(async (db) => {
      if (u.anchorId && !(await beaconRepository.findAnchor(u.anchorId, db))) throw AppError.notFound('ANCHOR_NOT_FOUND', 'Spatial anchor not found');
      const { anchor, ...fields } = u;
      if (anchor) {
        const current = await beaconRepository.findBeacon(beaconId, db);
        if (!current) throw AppError.notFound('BEACON_NOT_FOUND', 'Beacon not found');
        const own = current.anchor && (await beaconRepository.anchorUsers(db, current.anchor.anchorId)) === 1;
        if (own) await beaconRepository.replaceAnchor(db, current.anchor!.anchorId, anchor, actor);
        else fields.anchorId = await beaconRepository.insertAnchor(db, anchor, actor);
      }
      if (!(await beaconRepository.updateBeacon(db, beaconId, fields, actor))) throw AppError.notFound('BEACON_NOT_FOUND', 'Beacon not found');
      await beaconRepository.bump(db);
    });
    logger.info('beacon.registry.updated', { actor, beaconId, fields: Object.keys(u) });
    return (await beaconRepository.findBeacon(beaconId))!;
  },

  /** Soft delete: the row and every observation referencing it stay; the beacon leaves the config and fusion. */
  disableBeacon(beaconId: string, actor: string) {
    return this.updateBeacon(beaconId, { enabled: false }, actor);
  },

  async deleteBeacon(beaconId: string, actor: string) {
    await withTransaction(async (db) => {
      if (!(await beaconRepository.deleteBeacon(db, beaconId))) throw AppError.notFound('BEACON_NOT_FOUND', 'Beacon not found');
      await beaconRepository.bump(db);
    });
    logger.info('beacon.registry.deleted', { actor, beaconId });
    return { beaconId, deleted: true };
  },

  async getBeacon(beaconId: string) {
    const b = await beaconRepository.findBeacon(beaconId);
    if (!b) throw AppError.notFound('BEACON_NOT_FOUND', 'Beacon not found');
    return b;
  },

  async createAnchor(input: unknown, actor: string) {
    const a = AnchorCreate.parse(input);
    const id = await withTransaction(async (db) => {
      const anchorId = await beaconRepository.insertAnchor(db, a, actor);
      await beaconRepository.bump(db);
      return anchorId;
    });
    return (await beaconRepository.findAnchor(id))!;
  },

  async updateAnchor(anchorId: string, input: unknown, actor: string) {
    const u = AnchorUpdate.parse(input);
    await withTransaction(async (db) => {
      if (!(await beaconRepository.updateAnchor(db, anchorId, u, actor))) throw AppError.notFound('ANCHOR_NOT_FOUND', 'Spatial anchor not found');
      await beaconRepository.bump(db);
    });
    logger.info('beacon.registry.anchor_updated', { actor, anchorId, fields: Object.keys(u) });
    return (await beaconRepository.findAnchor(anchorId))!;
  },

  async addSurveyUuid(input: unknown, actor: string) {
    const u = SurveyUuidCreate.parse(input);
    await withTransaction(async (db) => {
      await beaconRepository.addSurveyUuid(db, u.uuid, u.label ?? null, actor);
      await beaconRepository.bump(db);
    });
    return { surveyUuids: await beaconRepository.surveyUuids() };
  },

  async removeSurveyUuid(uuid: string) {
    await withTransaction(async (db) => {
      if (!(await beaconRepository.removeSurveyUuid(db, uuid))) throw AppError.notFound('SURVEY_UUID_NOT_FOUND', 'Survey UUID not found');
      await beaconRepository.bump(db);
    });
    return { surveyUuids: await beaconRepository.surveyUuids() };
  },

  discovered(query: unknown) {
    const q = DiscoveredQuery.parse(query);
    return beaconRepository.discovered(q.sinceHours, q.limit, REALTIME_FUSION_VERSION);
  },

  async upsertCalibration(input: unknown, actor: string) {
    const c = CalibrationUpsert.parse(input);
    await withTransaction(async (db) => {
      if (c.beaconId && !(await beaconRepository.findBeacon(c.beaconId, db))) throw AppError.notFound('BEACON_NOT_FOUND', 'Beacon not found');
      await beaconRepository.upsertCalibration(db, c, actor);
      await beaconRepository.bump(db);
    });
    return { ok: true, calibrations: await beaconRepository.calibrations() };
  },
};
