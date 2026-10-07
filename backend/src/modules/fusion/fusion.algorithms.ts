import { env } from '../../config/env.js';
import { fusionConfigV1, fusionConfigV2, fusionConfigV21, fusionConfigV4, type FusionConfigV4 } from './fusion.config.js';
import type { FusionSessionContext } from './fusion.stride.js';
import { flushFusion, processObservation, type FusionEvent } from './fusion.engine.js';
import { describeEventV2, flushFusionV2, processObservationV2, summarizeV2, type FusionEventV2 } from './fusion-v2.engine.js';
import { createFusionState, type FusionState } from './fusion-state.js';
import { createFusionStateV2, type FusionStateV2 } from './fusion-state-v2.js';
import { describeEventV21, flushFusionV21, processObservationV21, summarizeV21, type FusionEventV21 } from './fusion-v21.engine.js';
import { createFusionStateV21, type FusionStateV21 } from './fusion-state-v21.js';
import type { Observation } from './fusion.timeline.js';
import type { FusedOutput } from './fusion.types.js';
import { createFusionStateV3, describeEventV3, flushFusionV3, processObservationV3, summarizeV3, fusionV3Config } from './fusion-v3.engine.js';
import type { FusionStateV3 } from './fusion-state-v3.js';
import type { FusionEventV3 } from './fusion-v3.engine.js';
import { createFusionStateV31, describeEventV31, flushFusionV31, processObservationV31, summarizeV31, fusionConfigV31 } from './fusion-v31.engine.js';
import type { FusionStateV31 } from './fusion-state-v31.js';
import type { FusionEventV31 } from './fusion-v31.engine.js';
import { createFusionStateV4, describeEventV4, finalizeFusionV4, flushFusionV4, processObservationV4, summarizeV4, type FusionEventV4 } from './fusion-v4.engine.js';
import type { FusionStateV4 } from './fusion-state-v4.js';
import { diagnosticsFromEvents, diagnosticsV4, type RunDiagnostics } from './fusion.diagnostics.js';

export interface AlgorithmSummary {
  gpsAccepted: number;
  gpsRejected: number;
  rejectReasons: Record<string, number>;
  maxRejectedInnovation: number | null;
  stationaryMs: number | null;
  reanchors?: number;
  divergences?: number;
  motionGaps?: number;
  altimeterRebases?: number;
  verticalRejected?: number;
  trackingStatus?: string;
  headingStatus?: string;
  fallbackStepDistance?: number;
  horizontalUncertainty?: number;
  // v4
  stepsDetected?: number;
  stairSteps?: number;
  slopeSteps?: number;
  verticalUnknownSteps?: number;
  headingSegments?: number;
  headingSegmentsWithHeading?: number | null;
  strideM?: number | null;
  strideSource?: 'APPLE_HEALTH' | 'SESSION_PEDOMETER' | 'DEFAULT';
  healthStrideM?: number | null;
  healthStrideBlend?: number | null;
  terrain?: { versionId: string | null; datumSource: string; contacts: number; datumSigmaM: number | null; driftRangeM: number | null; geoidSeparationM: number | null } | null;
}

/**
 * One registered algorithm version. Realtime processing and historical replay both go through this
 * interface, so each version has exactly one implementation. Results are stored per version
 * (fused_positions.algorithm_version) and can be compared side by side.
 */
export interface FusionAlgorithm<S = any, E = any> {
  version: string;
  /** Bump when the engine CODE of this version changes (config changes are hashed automatically). */
  revision: number;
  description: string;
  config: object;
  requiresSpatialMap?: boolean;
  /** Uses the session's terrain version (DEM) when there is one: part of the reproducibility hash. */
  usesTerrain?: boolean;
  createState(context?: FusionSessionContext): S;
  process(state: S, obs: Observation): { outputs: FusedOutput[]; events: E[] };
  flush(state: S): { outputs: FusedOutput[]; events: E[] };
  /** Replay only (not for a session that continues live): replaces all outputs, e.g. with a smoothed trajectory. */
  finalize?(state: S): { outputs: FusedOutput[]; events: E[] };
  skippedLate(state: S): number;
  summarize(state: S, events: E[]): AlgorithmSummary;
  describeEvent(e: E): { event: string; fields: Record<string, unknown> } | null;
  /** Run snapshot diagnostics after a replay (per-fix decisions, engine events); see fusion.diagnostics.ts. */
  diagnostics?(state: S, events: E[]): RunDiagnostics;
  /** Builds the same version with a modified config (experiment variants). Absent: the version has no variants. */
  withConfig?(config: object): FusionAlgorithm<S, E>;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

const makeV1 = (cfg: typeof fusionConfigV1): FusionAlgorithm<FusionState, FusionEvent> => ({
  version: 'fusion-v1',
  revision: 1,
  description: 'Complementary fusion: every valid fix pulls the position with an accuracy-dependent weight.',
  config: cfg,
  createState: createFusionState,
  process: (s, o) => processObservation(s, o, cfg),
  flush: (s) => flushFusion(s, cfg),
  withConfig: (c) => makeV1(c as typeof fusionConfigV1),
  diagnostics: (_s, events) => diagnosticsFromEvents(events),
  skippedLate: (s) => s.skippedLateObservations,
  summarize(_s, events) {
    let accepted = 0;
    let rejected = 0;
    for (const e of events) {
      // the initializing fix is used as the anchor, like v2 counts it
      if (e.type === 'gps-correction' || e.type === 'initialized') accepted++;
      else if (e.type === 'gps-rejected') rejected++;
    }
    const rejectReasons: Record<string, number> = rejected ? { INVALID_ACCURACY: rejected } : {};
    return { gpsAccepted: accepted, gpsRejected: rejected, rejectReasons, maxRejectedInnovation: null, stationaryMs: null };
  },
  describeEvent(e) {
    switch (e.type) {
      case 'initialized':
        return { event: 'fusion.initialized', fields: { accuracy: r1(e.horizontalAccuracy) } };
      case 'gps-correction':
        return { event: 'fusion.gps_correction', fields: { quality: e.quality, accuracy: r1(e.horizontalAccuracy), weight: e.weight, shift: r1(e.shift) } };
      case 'gps-rejected':
        return { event: 'fusion.gps_rejected', fields: { reason: e.reason } };
      case 'heading-anchor':
        return { event: 'fusion.heading_anchor', fields: { source: e.source, heading: r1(e.headingDeg) } };
      case 'pedometer':
        return { event: 'fusion.pedometer', fields: { delta: r1(e.delta), moved: e.moved } };
      case 'output':
        return { event: 'fusion.output', fields: { seq: e.output.fusionSequence, source: e.output.source, confidence: Math.round(e.output.overallConfidence * 100) / 100 } };
      default:
        return null;
    }
  },
});
const fusionV1 = makeV1(fusionConfigV1);

const makeV2 = (cfg: typeof fusionConfigV2): FusionAlgorithm<FusionStateV2, FusionEventV2> => ({
  version: 'fusion-v2',
  revision: 4,
  description: 'Conservative fusion: quality/innovation/physical-jump gates, stationary XY lock, uncertainty-based confidence.',
  config: cfg,
  createState: createFusionStateV2,
  process: (s, o) => processObservationV2(s, o, cfg),
  flush: (s) => flushFusionV2(s, cfg),
  skippedLate: (s) => s.skippedLateObservations,
  summarize: summarizeV2,
  describeEvent: describeEventV2,
  diagnostics: (_s, events) => diagnosticsFromEvents(events),
  withConfig: (c) => makeV2(c as typeof fusionConfigV2),
});
const fusionV2 = makeV2(fusionConfigV2);

const makeV21 = (cfg: typeof fusionConfigV21): FusionAlgorithm<FusionStateV21, FusionEventV21> => ({
  version: 'fusion-v2.1',
  revision: 6, // 3: motion gap / segment yaw baseline, altimeter + pedometer segment rebase; 4: vertical innovation gate; 5: pre-session GPS; 6: pedometer high-water mark
  description: 'v2 fixed: wider GPS classes, two-point heading bootstrap, GPS cluster/track re-anchor, divergence guard, anchor-based Z.',
  config: cfg,
  createState: createFusionStateV21,
  process: (s, o) => processObservationV21(s, o, cfg),
  flush: (s) => flushFusionV21(s, cfg),
  skippedLate: (s) => s.skippedLateObservations,
  summarize: summarizeV21,
  describeEvent: describeEventV21,
  diagnostics: (_s, events) => diagnosticsFromEvents(events),
  withConfig: (c) => makeV21(c as typeof fusionConfigV21),
});
const fusionV21 = makeV21(fusionConfigV21);

const fusionV3: FusionAlgorithm<FusionStateV3, FusionEventV3> = {
  version: 'fusion-v3',
  revision: 2, // runs the v2.1 engine inside: 2 = v2.1 rev 6 (pedometer high-water mark)
  description: 'Campus-scoped fusion: repeated high-quality Core Location anchors, bounded pedestrian dead reckoning, and spatial output filtering.',
  requiresSpatialMap: true,
  config: { base: fusionConfigV21, trust: fusionV3Config },
  createState: createFusionStateV3,
  process: processObservationV3,
  flush: flushFusionV3,
  skippedLate: (s) => s.inner.skippedLateObservations,
  summarize: summarizeV3,
  describeEvent: describeEventV3,
  diagnostics: (_s, events) => diagnosticsFromEvents(events),
};

const fusionV31: FusionAlgorithm<FusionStateV31, FusionEventV31> = {
  version: 'fusion-v3.1',
  revision: 3, // 3: pedometer high-water mark
  description: 'Sensor-led pedestrian tracking with sparse GPS anchors, relative barometric height, and campus output gating.',
  requiresSpatialMap: true,
  config: fusionConfigV31,
  createState: createFusionStateV31,
  process: processObservationV31,
  flush: flushFusionV31,
  skippedLate: (s) => s.skippedLateObservations,
  summarize: (s) => summarizeV31(s),
  describeEvent: describeEventV31,
  diagnostics: (_s, events) => diagnosticsFromEvents(events),
};

const makeV4 = (cfg: FusionConfigV4): FusionAlgorithm<FusionStateV4, FusionEventV4> => ({
  version: 'fusion-v4',
  // 2: terrain (DEM) Z datum from ground contacts + barometric drift, height above ground; 3: indoor stair anchors;
  // 4: diagnostics only (per-fix smoother weights/residuals, kept ground contacts) — outputs identical to rev 3;
  // 5: long straight ramps retain a calibrated stride; 6: Health stride prior + uncertain vertical movement uses stride,
  //    confirmed stair classification is separated from barometric vertical-motion detection.
  revision: 6,
  usesTerrain: true,
  description: 'Step-level PDR (50 Hz steps, stair- and slope-aware stride) + Kalman filter over position and heading offset with weighted GPS; replay is RTS-smoothed.',
  config: cfg,
  createState: (context) => createFusionStateV4(cfg.healthStrideEnabled ? context : undefined),
  process: (s, o) => processObservationV4(s, o, cfg),
  flush: (s) => flushFusionV4(s, cfg),
  finalize: (s) => finalizeFusionV4(s, cfg),
  skippedLate: (s) => s.skippedLateObservations,
  summarize: (s) => summarizeV4(s),
  describeEvent: describeEventV4,
  diagnostics: diagnosticsV4,
  withConfig: (c) => makeV4(c as FusionConfigV4),
});
const fusionV4 = makeV4(fusionConfigV4);

export const FUSION_ALGORITHMS: Record<string, FusionAlgorithm> = {
  [fusionV1.version]: fusionV1,
  [fusionV2.version]: fusionV2,
  [fusionV21.version]: fusionV21,
  [fusionV3.version]: fusionV3,
  [fusionV31.version]: fusionV31,
  [fusionV4.version]: fusionV4,
};

/** Version computed live for collecting phones (ACTIVE_FUSION_VERSION, default fusion-v4). Only one is computed live. */
export const REALTIME_FUSION_VERSION = env.ACTIVE_FUSION_VERSION;
if (!(REALTIME_FUSION_VERSION in FUSION_ALGORITHMS)) {
  throw new Error(`ACTIVE_FUSION_VERSION=${REALTIME_FUSION_VERSION} is not registered (${Object.keys(FUSION_ALGORITHMS).join(', ')})`);
}

export type { FusedOutput };

/** Deep-merges parameter overrides into a config; unknown keys are rejected (typos must not pass silently). */
export function mergeConfig(base: object, overrides: Record<string, unknown>): object {
  const out: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = out;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== 'object' || node[k] === null) throw new Error(`Unknown config key ${path}`);
      node = node[k] as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (!(last in node)) throw new Error(`Unknown config key ${path}`);
    if (typeof node[last] !== typeof value) throw new Error(`Config key ${path} expects a ${typeof node[last]}`);
    node[last] = value;
  }
  return out;
}

/** The registered version, or a variant of it with parameter overrides (keys like "gpsGateChi2" or "a.b"). */
export function resolveAlgorithm(version: string, overrides: Record<string, unknown> | null | undefined): FusionAlgorithm {
  const algo = FUSION_ALGORITHMS[version];
  if (!algo) throw new Error(`Unknown algorithm version ${version}`);
  if (!overrides || Object.keys(overrides).length === 0) return algo;
  if (!algo.withConfig) throw new Error(`${version} does not support parameter variants`);
  return algo.withConfig(mergeConfig(algo.config, overrides));
}
