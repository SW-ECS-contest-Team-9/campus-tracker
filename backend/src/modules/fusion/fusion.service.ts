import { createHash } from 'node:crypto';
import { pool, withTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../common/logger.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { realtimeState } from '../../realtime/realtime-state.service.js';
import { sessionRepository } from '../sessions/session.repository.js';
import { buildTimeline, type Observation, type RawSamples } from './fusion.timeline.js';
import { FUSION_ALGORITHMS, REALTIME_FUSION_VERSION, resolveAlgorithm, type FusionAlgorithm } from './fusion.algorithms.js';
import type { FusedOutput, SpatialGpsDecision } from './fusion.types.js';
import { computeFusionMetrics } from './fusion.metrics.js';
import { spatial } from '../../geo/spatial.js';
import { fusionRepository } from './fusion.repository.js';
import type { FusedPositionEvent } from './fusion.dto.js';
import { terrain } from '../../geo/terrain.js';
import { CAMPUS_FRAME } from '../../geo/campus-frame.js';
import { codeRef } from '../../common/code-ref.js';
import { loadReplayInputs, ReorderBuffer, replayAsReceived, replayInMemory, runObservations, withTerrain, type ReplayResult } from './fusion.pipeline.js';
import { fusionRunsRepository, type ReplayMode } from './fusion-runs.repository.js';
import { qcService } from '../qc/qc.service.js';

/**
 * Orchestrates fusion around the raw pipeline. Fusion is DERIVED processing:
 *  - it runs only after the raw batch COMMIT and never delays or fails the phone's ACK;
 *  - a failure is logged and the in-memory state dropped; the next batch (or a reprocess) rebuilds it
 *    from the raw tables, which fusion only reads.
 * Realtime (one version: REALTIME_FUSION_VERSION) and replay (any version) use the same algorithm object.
 * Work per session is serialized in a promise queue so batches are fused in arrival order.
 */

interface LiveSession {
  collectorId: string;
  state: unknown;
  /** realtime reorder buffer: observations wait FUSION_REORDER_WINDOW_MS so slightly late samples (GPS vs 50 Hz motion) stay in order */
  reorder: ReorderBuffer;
  /** after a replay that realtime continues: observations up to here are already in the replayed state */
  replayedThroughT?: number;
}

const live = new Map<string, LiveSession>(); // sessionId -> realtime state of REALTIME_FUSION_VERSION
const queues = new Map<string, Promise<void>>();
/** Debounced final replays: one replay after uploads go idle, not one per batch. */
const finalizeTimers = new Map<string, NodeJS.Timeout>();
const LOCK_MS = 10 * 60_000;

/** Backpressure: at most one full replay at a time in this process (raw ingest is never blocked by it). */
let replayChain: Promise<unknown> = Promise.resolve();
function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  const p = replayChain.then(fn);
  replayChain = p.catch(() => undefined);
  return p;
}

const realtimeAlgo = () => FUSION_ALGORITHMS[REALTIME_FUSION_VERSION];

function spatialGpsDecisions(events: unknown[]): SpatialGpsDecision[] {
  const decisions: SpatialGpsDecision[] = [];
  for (const value of events) {
    if (!value || typeof value !== 'object') continue;
    const event = value as Record<string, unknown>;
    if (event.type !== 'spatial-gps-accepted' && event.type !== 'spatial-gps-rejected') continue;
    decisions.push({
      sequence: Number(event.seq), timestamp: Number(event.t),
      spatialMapVersionId: typeof event.mapVersionId === 'string' ? event.mapVersionId : null,
      campusStatus: String(event.campus ?? 'MAP_UNAVAILABLE'), anchorAccepted: event.type === 'spatial-gps-accepted',
      reason: String(event.reason ?? 'UNKNOWN'), horizontalAccuracy: typeof event.accuracy === 'number' ? event.accuracy : null,
      boundaryDistanceM: typeof event.boundaryDistanceM === 'number' ? event.boundaryDistanceM : null,
      buildingId: typeof event.buildingId === 'string' ? event.buildingId : null,
      buildingName: typeof event.buildingName === 'string' ? event.buildingName : null,
    });
  }
  return decisions;
}

function sensorEventRows(version: string, events: unknown[]) {
  if (version !== 'fusion-v3.1') return [] as { timestamp: number; eventType: string; details: object }[];
  const persisted = new Set(['tracking-status', 'heading-status', 'gps-anchor-decision', 'anchor-applied',
    'stationary-state', 'sensor-gap', 'position-suppressed']);
  return events.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const e = value as Record<string, unknown>;
    if (typeof e.type !== 'string' || typeof e.t !== 'number') return [];
    if (!persisted.has(e.type) && e.type !== 'pedometer-delta' && e.type !== 'altimeter-update') return [];
    return [{ timestamp: e.t, eventType: e.type, details: e }];
  });
}

export function configHash(algo: FusionAlgorithm, mapVersionId: string | null = null, terrainVersionId: string | null = null): string {
  // version + engine revision + exact config: identical hash => identical results for the same raw data
  const hash = createHash('sha256').update(`${algo.version}#${algo.revision}`);
  if (algo.requiresSpatialMap) hash.update(`#${mapVersionId ?? 'NO_MAP'}`);
  if (algo.usesTerrain) hash.update(`#terrain:${terrainVersionId ?? 'NONE'}`);
  return hash.update(JSON.stringify(algo.config)).digest('hex').slice(0, 16);
}

function enqueue(sessionId: string, label: string, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(sessionId) ?? Promise.resolve()).then(task).catch((err) => {
    live.delete(sessionId); // retry path: rebuilt from raw data on the next batch
    logger.error('fusion.failed', { sessionId, step: label, message: err instanceof Error ? err.message : String(err) });
  });
  queues.set(sessionId, next);
  void next.finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  });
  return next;
}

export function toFusedEvent(collectorId: string, sessionId: string, version: string, o: FusedOutput): FusedPositionEvent {
  return {
    collectorId,
    sessionId,
    fusionSequence: o.fusionSequence,
    longitude: o.longitude,
    latitude: o.latitude,
    ellipsoidalAltitude: o.ellipsoidalAltitude,
    heading: o.headingDegrees,
    horizontalConfidence: o.horizontalConfidence,
    verticalConfidence: o.verticalConfidence,
    overallConfidence: o.overallConfidence,
    gpsHorizontalAccuracy: o.gpsHorizontalAccuracy,
    gpsVerticalAccuracy: o.gpsVerticalAccuracy,
    source: o.source,
    algorithmVersion: version,
    timestamp: new Date(o.timestamp).toISOString(),
    localX: o.x,
    localY: o.y,
    localZ: o.z,
    gpsUsed: o.gpsUsed ?? null,
    gpsRejectReason: o.gpsRejectReason ?? null,
    gpsSequence: o.gpsSequence ?? null,
    innovationDistance: o.innovationDistance ?? null,
    stationary: o.stationary ?? null,
    headingSource: o.headingSource ?? null,
    horizontalUncertainty: o.horizontalUncertainty ?? null,
    gpsQuality: o.gpsQuality ?? null,
    pdrApplied: o.pdrApplied ?? null,
    pdrRejectReason: o.pdrRejectReason ?? null,
    relativeAltitude: o.relativeAltitude ?? null,
    reanchored: o.reanchored ?? null,
    reanchorReason: o.reanchorReason ?? null,
    divergenceDetected: o.divergenceDetected ?? null,
    spatialMapVersionId: o.spatialMapVersionId ?? null,
    spatialStatus: o.spatialStatus ?? null,
    buildingId: o.buildingId ?? null,
    buildingName: o.buildingName ?? null,
    buildingMatchStatus: o.buildingMatchStatus ?? null,
    spatialSegmentId: o.spatialSegmentId ?? null,
    terrainHeight: o.terrainHeight ?? null,
    heightAboveGround: o.heightAboveGround ?? null,
    zDatumSource: o.zDatumSource ?? null,
    zDatumSigma: o.zDatumSigma ?? null,
  };
}

/** FUSION_DEBUG=true: realtime decisions (not replays, which would print thousands of lines). */
function debugLog(algo: FusionAlgorithm, sessionId: string, events: unknown[]) {
  if (!env.FUSION_DEBUG) return;
  for (const e of events) {
    const d = algo.describeEvent(e);
    if (d) logger.info(d.event, { sessionId, ...d.fields });
  }
}

export type ReplayTrigger = 'api' | 'cli' | 'auto-finalize' | 'auto-rebuild' | 'lab' | 'bench';

export interface ReplayOptions {
  /** experiment variant label; with overrides the run is never published */
  variant?: string | null;
  overrides?: Record<string, unknown> | null;
  mode?: ReplayMode;
  /**
   * Write the result to fused_positions (the version's published result) and track the session's fusion state.
   * Default: true for a plain SENSOR_TIME replay of the registered config, false otherwise.
   */
  publish?: boolean;
}

/**
 * Replays one session with one algorithm version from ALL raw samples (read-only) through the shared pipeline
 * (fusion.pipeline.ts) and stores an immutable run snapshot (fusion_run_positions / fixes / events).
 *  - published replay (default for the registered config): also replaces that version's fused_positions in one
 *    transaction, protected by the cross-process lock; for the realtime version it maintains the session's fusion
 *    state (PROCESSING -> CLEAN / DIRTY / FAILED). Used by the API, the CLI and automatic finalization.
 *  - experiment replay (variant / overrides / AS_RECEIVED / publish=false): only the snapshot; nothing else changes.
 * Deterministic: same raw data + same config => same rows. Recorded in fusion_runs.
 */
export async function replaySession(sessionId: string, version: string, trigger: ReplayTrigger, opts: ReplayOptions = {}) {
  if (!FUSION_ALGORITHMS[version]) throw AppError.badRequest('UNKNOWN_ALGORITHM', `Unknown algorithm version ${version}`);
  let algo: FusionAlgorithm;
  try {
    algo = resolveAlgorithm(version, opts.overrides);
  } catch (err) {
    throw AppError.badRequest('INVALID_OVERRIDES', err instanceof Error ? err.message : 'Invalid overrides');
  }
  const mode: ReplayMode = opts.mode ?? 'SENSOR_TIME';
  const isVariant = Boolean(opts.variant) || Boolean(opts.overrides && Object.keys(opts.overrides).length);
  const publish = opts.publish ?? (!isVariant && mode === 'SENSOR_TIME');
  if (publish && (isVariant || mode !== 'SENSOR_TIME')) {
    throw AppError.badRequest('NOT_PUBLISHABLE', 'Only a SENSOR_TIME replay of the registered config can be published');
  }
  const session = await sessionRepository.findView(sessionId);
  if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
  const tracksState = publish && version === REALTIME_FUSION_VERSION;
  const mapVersionId = session.spatialMapVersionId;
  if (algo.requiresSpatialMap && !(await spatial.context(mapVersionId))) {
    throw AppError.conflict('SPATIAL_MAP_UNAVAILABLE', `${version} requires a valid spatial map pinned to this session`);
  }
  const lock = publish ? await fusionRepository.tryLock(sessionId, LOCK_MS, tracksState) : null;
  if (publish && !lock) throw new AppError(409, 'FUSION_BUSY', 'This session is being reprocessed right now', undefined, true);

  const started = Date.now();
  // An ACTIVE session continues in realtime from the replayed state, so its last partial tick is not flushed.
  const continuesLive = session.status === 'ACTIVE' && tracksState;
  let lastT = -Infinity;
  let outcome: 'success' | 'failed' = 'failed';
  const terrainVersionId = algo.usesTerrain ? await terrain.sessionVersion(sessionId) : null;
  const runConfig = algo.requiresSpatialMap || algo.usesTerrain
    ? { algorithm: algo.config, spatialMapVersionId: mapVersionId, terrainVersionId }
    : algo.config;
  const runId = await fusionRepository.createRun(sessionId, version, trigger, runConfig, configHash(algo, mapVersionId, terrainVersionId), {
    revision: algo.revision, variant: opts.variant ?? (isVariant ? 'custom' : null), overrides: opts.overrides ?? null, mode, codeRef: codeRef(), published: publish,
  });
  try {
    const inputs = await loadReplayInputs(sessionId, algo);
    const { raw, timeline, terrainContext } = inputs;
    lastT = timeline.at(-1)?.t ?? -Infinity;
    let r: ReplayResult;
    if (mode === 'AS_RECEIVED') {
      const spatialContext = await spatial.context(mapVersionId);
      const batches = (await fusionRunsRepository.loadArrivalBatches(sessionId))
        .map((b) => withTerrain(spatial.annotate(buildTimeline(b, { sessionStartedAt: session.startedAt }), spatialContext), terrainContext));
      r = replayAsReceived(algo, batches, env.FUSION_REORDER_WINDOW_MS);
    } else {
      r = replayInMemory(algo, timeline, { finalize: !continuesLive });
    }
    const { state, outputs, events } = r;
    const history = sensorEventRows(version, events);
    await withTransaction(async (client) => {
      if (publish) {
        await fusionRepository.replaceOutputs(client, sessionId, version, outputs, spatialGpsDecisions(events));
        if (version === 'fusion-v3.1') await fusionRepository.replaceSensorEvents(client, sessionId, version, history);
      }
      await fusionRunsRepository.saveSnapshot(client, runId, {
        forward: r.forward !== outputs ? r.forward : null,
        final: outputs,
        diagnostics: algo.diagnostics ? algo.diagnostics(state, events) : null,
        geoidN: terrainContext?.geoidSeparation ?? CAMPUS_FRAME.geoidN,
      });
    });
    const summary = algo.summarize(state, events);
    const metrics = computeFusionMetrics(timeline, outputs, summary);
    const rawCounts = { locations: raw.locations.length, motion: raw.motion.length, altimeter: raw.altimeter.length, pedometer: raw.pedometer.length };
    await fusionRepository.completeRun(runId, {
      raw: rawCounts,
      outputs: outputs.length,
      accepted: summary.gpsAccepted,
      rejected: summary.gpsRejected,
      reanchors: summary.reanchors ?? null,
      divergences: summary.divergences ?? null,
      metrics,
      warnings: metrics.validation.warnings,
    });
    if (publish) for (const w of metrics.validation.warnings) logger.warn('fusion.validation', { sessionId, version, ...w });
    outcome = 'success';
    return { session, state, outputs, events, metrics, runId, continuesLive, lastT, observations: timeline.length, rawCounts, durationMs: Date.now() - started, published: publish };
  } catch (err) {
    await fusionRepository.failRun(runId, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    throw err;
  } finally {
    if (lock) await fusionRepository.unlock(sessionId, tracksState ? outcome : 'none', lock, continuesLive).catch(() => undefined);
  }
}

/** Server-side replay: also refreshes the live state and tells previews to reload. */
async function reprocessNow(sessionId: string, version: string, trigger: ReplayTrigger) {
  const r = await runLimited(() => replaySession(sessionId, version, trigger));
  const collectorId = r.session.collectorId;
  if (version === REALTIME_FUSION_VERSION) {
    if (r.continuesLive) live.set(sessionId, { collectorId, state: r.state, reorder: new ReorderBuffer(env.FUSION_REORDER_WINDOW_MS), replayedThroughT: r.lastT });
    const last = r.outputs.at(-1);
    if (last) previewBroadcast.collectorStatus(realtimeState.fusedUpdated(collectorId, toFusedEvent(collectorId, sessionId, version, last)));
  }
  previewBroadcast.fusionReprocessed({ sessionId, collectorId, algorithmVersion: version, count: r.outputs.length });
  const sensorEvents = sensorEventRows(version, r.events);
  if (sensorEvents.length) previewBroadcast.fusionSensorEvents({
    sessionId, collectorId, algorithmVersion: version,
    events: sensorEvents.map((e) => ({ timestamp: new Date(e.timestamp).toISOString(), eventType: e.eventType, details: e.details })),
  });
  const summary = {
    sessionId,
    algorithmVersion: version,
    runId: r.runId,
    observations: r.observations,
    rawCounts: r.rawCounts,
    outputs: r.outputs.length,
    metrics: r.metrics,
    durationMs: r.durationMs,
  };
  logger.info('fusion.reprocessed', { ...summary, metrics: undefined, gpsAccepted: r.metrics.gpsAccepted, gpsRejected: r.metrics.gpsRejected, trigger });
  return summary;
}

export const fusionService = {
  /** session:start (new session): fresh state, uninitialized until the first usable GPS fix. */
  sessionStarted(sessionId: string, collectorId: string) {
    void enqueue(sessionId, 'start', async () => {
      if (!live.has(sessionId)) live.set(sessionId, { collectorId, state: realtimeAlgo().createState(), reorder: new ReorderBuffer(env.FUSION_REORDER_WINDOW_MS) });
    });
  },

  /**
   * Realtime best effort for an ACTIVE session, after the raw COMMIT (never awaited by the ACK).
   * Samples wait in a short reorder buffer; anything older than the state is skipped by the engine — such
   * sessions are already marked DIRTY in the DB and get the authoritative full replay at finalization.
   */
  processBatch(collectorId: string, sessionId: string, sessionStartedAt: Date, samples: RawSamples) {
    void enqueue(sessionId, 'batch', async () => {
      const entry = live.get(sessionId);
      if (!entry) {
        // No state (server restart / previous fusion error): rebuild from the raw tables (they contain this batch).
        await reprocessNow(sessionId, REALTIME_FUSION_VERSION, 'auto-rebuild');
        return;
      }
      // Pre-session cached fixes are rejected by the engine anyway; dropping them here keeps them from counting as late.
      // ...and observations already contained in a replay this realtime state continues from are not applied twice.
      const through = entry.replayedThroughT ?? -Infinity;
      const mapVersionId = await spatial.sessionMapVersion(sessionId);
      const context = await spatial.context(mapVersionId);
      const terrainContext = realtimeAlgo().usesTerrain ? await terrain.context(await terrain.sessionVersion(sessionId)) : null;
      const incoming = withTerrain(spatial.annotate(buildTimeline(samples, { sessionStartedAt }), context), terrainContext)
        .filter((o) => !(o.kind === 'gps' && o.preSession) && o.t > through);
      if (incoming.length === 0) return;
      await this.applyLive(entry, sessionId, entry.reorder.push(incoming));
    });
  },

  async applyLive(entry: LiveSession, sessionId: string, observations: Observation[]) {
    const algo = realtimeAlgo();
    const skippedBefore = algo.skippedLate(entry.state);
    const { outputs, events } = runObservations(algo, entry.state, observations);
    debugLog(algo, sessionId, events);
    const skipped = algo.skippedLate(entry.state) - skippedBefore;
    if (skipped > 0) {
      logger.info('fusion.late_observations', { sessionId, skipped, hint: 'session is DIRTY; full replay at finalization' });
      await fusionRepository.markDirty(sessionId);
    }
    await this.store(entry.collectorId, sessionId, outputs, events);
  },

  /** session:finish / INTERRUPTED: flush realtime state, then the debounced authoritative replay. */
  sessionFinished(sessionId: string, collectorId: string) {
    void enqueue(sessionId, 'finish', async () => {
      const entry = live.get(sessionId);
      if (entry) {
        await this.applyLive(entry, sessionId, entry.reorder.drain());
        const algo = realtimeAlgo();
        const r = algo.flush(entry.state);
        debugLog(algo, sessionId, r.events);
        await this.store(collectorId, sessionId, r.outputs);
        live.delete(sessionId);
      }
    });
    this.finalizeSoon(sessionId);
  },

  /**
   * Debounced finalization: once the session is no longer ACTIVE and no raw batch arrived for `delayMs`,
   * replay all raw by sensor time (authoritative result). Every new late batch restarts the timer.
   * Fallback for clients that never send session:syncComplete.
   */
  finalizeSoon(sessionId: string, delayMs = env.SESSION_REPROCESS_IDLE_DELAY_MS) {
    clearTimeout(finalizeTimers.get(sessionId));
    finalizeTimers.set(
      sessionId,
      setTimeout(() => {
        finalizeTimers.delete(sessionId);
        void enqueue(sessionId, 'finalize', async () => {
          const session = await sessionRepository.findById(sessionId);
          if (!session || session.status === 'ACTIVE') return; // still collecting: realtime keeps going
          try {
            await reprocessNow(sessionId, REALTIME_FUSION_VERSION, 'auto-finalize');
            // raw GPS quality decisions (qc-v1) for the Lab / mobility map; never blocks or fails finalization
            await qcService.run(sessionId).catch((e) => logger.warn('qc.failed', { sessionId, message: e instanceof Error ? e.message : String(e) }));
          } catch (err) {
            if (err instanceof AppError && err.code === 'FUSION_BUSY') {
              this.finalizeSoon(sessionId); // a CLI / API replay holds the lock: try again later
              return;
            }
            throw err;
          }
          live.delete(sessionId);
        });
      }, delayMs),
    );
  },

  /** Server start: ended sessions whose final replay never happened (timers are in memory) are finalized again. */
  async recoverPending() {
    const ids = await fusionRepository.pendingFinalization();
    ids.forEach((id, i) => this.finalizeSoon(id, 2000 + i * 500));
    if (ids.length) logger.info('fusion.recovery_scheduled', { sessions: ids.length });
  },

  async store(collectorId: string, sessionId: string, outputs: FusedOutput[], events: unknown[] = []) {
    const decisions = spatialGpsDecisions(events);
    await fusionRepository.insertSpatialDecisions(pool, sessionId, REALTIME_FUSION_VERSION, decisions);
    if (decisions.length) previewBroadcast.spatialGpsDecisions({ sessionId, collectorId, algorithmVersion: REALTIME_FUSION_VERSION, decisions });
    const sensorEvents = sensorEventRows(REALTIME_FUSION_VERSION, events);
    if (sensorEvents.length) {
      await fusionRepository.insertSensorEvents(pool, sessionId, REALTIME_FUSION_VERSION, sensorEvents);
      previewBroadcast.fusionSensorEvents({ sessionId, collectorId, algorithmVersion: REALTIME_FUSION_VERSION,
        events: sensorEvents.map((e) => ({ timestamp: new Date(e.timestamp).toISOString(), eventType: e.eventType, details: e.details })) });
    }
    if (outputs.length === 0) return;
    const inserted = new Set(await fusionRepository.insertOutputs(pool, sessionId, REALTIME_FUSION_VERSION, outputs));
    let last: FusedPositionEvent | null = null;
    for (const o of outputs) {
      if (!inserted.has(o.fusionSequence)) continue;
      last = toFusedEvent(collectorId, sessionId, REALTIME_FUSION_VERSION, o);
      previewBroadcast.positionFused(last); // after the fused rows are committed
    }
    if (last) previewBroadcast.collectorStatus(realtimeState.fusedUpdated(collectorId, last));
  },

  /** POST /sessions/:id/fusion/reprocess — queued behind live batches of the same session. */
  async reprocess(sessionId: string, version: string, force: boolean) {
    const algo = FUSION_ALGORITHMS[version];
    const mapVersionId = await spatial.sessionMapVersion(sessionId);
    if (algo.requiresSpatialMap && !(await spatial.context(mapVersionId))) {
      throw AppError.conflict('SPATIAL_MAP_UNAVAILABLE', `${version} requires a valid spatial map pinned to this session`);
    }
    const terrainVersionId = algo?.usesTerrain ? await terrain.sessionVersion(sessionId) : null;
    if (!force && algo && (await fusionRepository.hasCompletedRun(sessionId, version, configHash(algo, mapVersionId, terrainVersionId)))) {
      const run = (await fusionRepository.latestRuns(sessionId)).find((r) => r.algorithmVersion === version);
      return { sessionId, algorithmVersion: version, skipped: true, reason: 'already processed with the same code and config (use force)', run };
    }
    let summary: Awaited<ReturnType<typeof reprocessNow>> | undefined;
    let failure: unknown;
    await enqueue(sessionId, 'reprocess', async () => {
      try {
        summary = await reprocessNow(sessionId, version, 'api');
      } catch (err) {
        failure = err;
      }
    });
    if (failure) throw failure;
    return summary!;
  },

  async list(sessionId: string, version: string) {
    if (!(await sessionRepository.findById(sessionId))) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    return fusionRepository.list(sessionId, version);
  },

  async spatialDecisions(sessionId: string, version: string) {
    if (!(await sessionRepository.findById(sessionId))) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    return fusionRepository.spatialDecisions(sessionId, version);
  },

  async sensorEvents(sessionId: string, version: string) {
    if (!(await sessionRepository.findById(sessionId))) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    return fusionRepository.sensorEvents(sessionId, version);
  },

  async summary(sessionId: string) {
    if (!(await sessionRepository.findById(sessionId))) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    const [stored, runs] = await Promise.all([fusionRepository.versionsSummary(sessionId), fusionRepository.latestRuns(sessionId)]);
    const entry = live.get(sessionId);
    const liveFusionState = entry?.state as { initialized?: boolean; trackingStatus?: string; headingStatus?: string } | undefined;
    return {
      sessionId,
      realtimeVersion: REALTIME_FUSION_VERSION,
      availableVersions: Object.keys(FUSION_ALGORITHMS),
      stored,
      runs,
      live: entry ? { initialized: liveFusionState?.initialized ?? (liveFusionState?.trackingStatus === 'TRACKING'),
        trackingStatus: liveFusionState?.trackingStatus ?? null, headingStatus: liveFusionState?.headingStatus ?? null, buffered: entry.reorder.buffer.length } : null,
      finalizePending: finalizeTimers.has(sessionId),
    };
  },

  async versions() {
    const activeMapVersion = await spatial.activeMapVersion();
    const activeTerrainVersion = await terrain.activeVersion();
    return {
      active: REALTIME_FUSION_VERSION,
      versions: Object.values(FUSION_ALGORITHMS).map((a) => ({ version: a.version, description: a.description, configHash: configHash(a, activeMapVersion, activeTerrainVersion) })),
    };
  },

  /** Collector deleted: its sessions (and fused rows, by cascade) are gone. */
  forget(sessionIds: string[]) {
    for (const id of sessionIds) {
      live.delete(id);
      clearTimeout(finalizeTimers.get(id));
      finalizeTimers.delete(id);
    }
  },
};
