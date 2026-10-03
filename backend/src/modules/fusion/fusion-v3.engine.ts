/** Fusion v3: strict campus-scoped Core Location anchors with bounded PDR between anchors. */
import { headingRadToDeg, wrapHeadingRad } from '../../geo/angles.js';
import { spatial, type CoordinateClassification } from '../../geo/spatial.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { fusionConfigV21, fusionConfigV3 } from './fusion.config.js';
import { createFusionStateV3, type FusionStateV3 } from './fusion-state-v3.js';
import type { Observation } from './fusion.timeline.js';
import { describeEventV21, flushFusionV21, processObservationV21, summarizeV21, type FusionEventV21 } from './fusion-v21.engine.js';
import type { FusedOutput } from './fusion.types.js';

export type FusionEventV3 =
  | { type: 'engine'; event: FusionEventV21 }
  | {
      type: 'spatial-gps-rejected'; t: number; seq: number; reason: string; accuracy: number | null;
      campus: string; mapVersionId: string | null; boundaryDistanceM: number | null; buildingId: string | null; buildingName: string | null;
    }
  | {
      type: 'spatial-gps-accepted'; t: number; seq: number; reason: string; accuracy: number | null;
      campus: string; mapVersionId: string | null; boundaryDistanceM: number | null; buildingId: string | null; buildingName: string | null;
    }
  | { type: 'anchor-qualified'; t: number; seq: number; fixes: number; spanMs: number; accuracy: number }
  | { type: 'spatial-output-rejected'; t: number; seq: number; reason: string };

const usable = (o: Extract<Observation, { kind: 'gps' }>, s: FusionStateV3) => {
  const c = o.spatialClassification;
  return !!s.context && c?.campus === 'INSIDE' && Number.isFinite(o.horizontalAccuracy)
    && o.horizontalAccuracy! > 0 && o.horizontalAccuracy! <= fusionConfigV3.anchorAccuracyM;
};

function emptyGpsForTimeline(o: Extract<Observation, { kind: 'gps' }>): Observation {
  // Keep the observation timestamp in the engine timeline while preventing any GPS-dependent state change.
  return { ...o, latitude: Number.NaN, longitude: Number.NaN, horizontalAccuracy: -1, verticalAccuracy: -1, speed: -1, course: -1 };
}

function plausibleNext(
  previous: Extract<Observation, { kind: 'gps' }>,
  next: Extract<Observation, { kind: 'gps' }>,
) {
  const seconds = (next.t - previous.t) / 1000;
  if (seconds <= 0 || seconds > fusionConfigV3.anchorMaxGapMs / 1000) return false;
  const meters = wgs84ToLocal(
    { latitude: previous.latitude, longitude: previous.longitude, height: 0 },
    next.latitude,
    next.longitude,
    0,
  );
  const allowance = fusionConfigV3.walkingSpeedCeilingMps * seconds
    + (previous.horizontalAccuracy ?? 0) + (next.horizontalAccuracy ?? 0) + 2;
  return Math.hypot(meters.x, meters.y) <= allowance;
}

function guardOutputs(state: FusionStateV3, outputs: FusedOutput[], events: FusionEventV21[]): { outputs: FusedOutput[]; events: FusionEventV3[] } {
  const kept: FusedOutput[] = [];
  const extras: FusionEventV3[] = [];
  const rejectedSequences = new Set<number>();
  for (const output of outputs) {
    const c = spatial.classify(output.latitude, output.longitude, output.horizontalUncertainty ?? output.gpsHorizontalAccuracy, state.context);
    output.spatialMapVersionId = state.context?.mapVersionId ?? null;
    output.spatialStatus = c.campus;
    output.spatialSegmentId = state.segmentId;
    output.buildingId = c.buildingId;
    output.buildingName = c.buildingName;
    output.buildingMatchStatus = c.buildingMatchStatus;
    const overUncertainty = output.horizontalUncertainty !== null && output.horizontalUncertainty !== undefined
      && output.horizontalUncertainty > fusionConfigV3.maximumHorizontalUncertaintyM;
    if (c.campus === 'INSIDE' && !overUncertainty) kept.push(output);
    else {
      rejectedSequences.add(output.fusionSequence);
      const reason = overUncertainty ? 'UNCERTAINTY_LIMIT' : c.campus;
      extras.push({ type: 'spatial-output-rejected', t: output.timestamp, seq: output.fusionSequence, reason });
      if (c.campus === 'OUTSIDE' || overUncertainty) {
        const lastSequence = state.inner.fusionSequence;
        const skippedLate = state.inner.skippedLateObservations;
        const next = createFusionStateV3().inner;
        next.fusionSequence = lastSequence;
        next.skippedLateObservations = skippedLate;
        state.inner = next;
        state.trusted = false;
        state.candidates = [];
        state.segmentId++;
      }
    }
  }
  const wrapped = events
    .filter((event) => event.type !== 'output' || !rejectedSequences.has(event.output.fusionSequence))
    .map((event) => ({ type: 'engine', event }) as FusionEventV3);
  return { outputs: kept, events: [...wrapped, ...extras] };
}

function stepInner(state: FusionStateV3, observation: Observation) {
  const result = processObservationV21(state.inner, observation, fusionConfigV21);
  return guardOutputs(state, result.outputs, result.events);
}

function rejectGps(state: FusionStateV3, observation: Extract<Observation, { kind: 'gps' }>, reason: string) {
  state.trusted = false;
  state.candidates = [];
  const result = stepInner(state, emptyGpsForTimeline(observation));
  result.events = result.events.filter((event) => !(event.type === 'engine' && event.event.type === 'gps-decision'));
  result.events.push(spatialDecision(state, observation, false, reason));
  return result;
}

function deferGps(state: FusionStateV3, observation: Extract<Observation, { kind: 'gps' }>) {
  const result = stepInner(state, emptyGpsForTimeline(observation));
  result.events = result.events.filter((event) => !(event.type === 'engine' && event.event.type === 'gps-decision'));
  result.events.push(spatialDecision(state, observation, false, 'WAITING_FOR_STREAK'));
  return result;
}

function spatialDecision(state: FusionStateV3, o: Extract<Observation, { kind: 'gps' }>, accepted: boolean, reason: string): FusionEventV3 {
  const c = o.spatialClassification;
  const common = {
    t: o.t, seq: o.seq, reason, accuracy: o.horizontalAccuracy,
    campus: c?.campus ?? 'MAP_UNAVAILABLE', mapVersionId: c?.mapVersionId ?? null,
    boundaryDistanceM: c?.boundaryDistanceM ?? null, buildingId: c?.buildingId ?? null, buildingName: c?.buildingName ?? null,
  };
  return accepted ? { type: 'spatial-gps-accepted', ...common } : { type: 'spatial-gps-rejected', ...common };
}

function rejectReason(o: Extract<Observation, { kind: 'gps' }>, state: FusionStateV3): string {
  const status = o.spatialClassification?.campus ?? 'MAP_UNAVAILABLE';
  if (status !== 'INSIDE') return status;
  if (!Number.isFinite(o.horizontalAccuracy) || o.horizontalAccuracy! <= 0) return 'INVALID_ACCURACY';
  if (o.horizontalAccuracy! > fusionConfigV3.anchorAccuracyM) return 'POOR_ACCURACY';
  if (state.context === null) return 'MAP_UNAVAILABLE';
  return 'INCONSISTENT_STREAK';
}

export function processObservationV3(state: FusionStateV3, observation: Observation) {
  if (observation.spatialContext !== undefined) {
    state.context = observation.spatialContext;
    state.mapUnavailable = observation.spatialContext === null;
  }
  if (observation.kind !== 'gps') return stepInner(state, observation);
  const gps = observation;
  if (!state.context || gps.preSession || !usable(gps, state)) return rejectGps(state, gps, gps.preSession ? 'PRE_SESSION' : rejectReason(gps, state));

  if (state.candidates.length && !plausibleNext(state.candidates.at(-1)!.observation, gps)) {
    state.trusted = false;
    state.candidates = [];
  }

  if (!state.trusted) {
    state.candidates.push({ observation: gps, pedometerTotal: state.inner.pedometerTotal });
    state.candidates = state.candidates.slice(-fusionConfigV3.anchorStreakCount);
    const first = state.candidates[0];
    const spanMs = gps.t - first.observation.t;
    const qualified = state.candidates.length === fusionConfigV3.anchorStreakCount && spanMs >= fusionConfigV3.anchorStreakSpanMs;
    if (!qualified) return deferGps(state, gps);
    // Keep the qualified evidence to bootstrap direction, then let v2.1 apply this single latest anchor.
    const fixes = state.candidates.slice();
    state.trusted = true;
    state.candidates = [];
    const result = stepInner(state, gps);
    if (state.inner.origin && state.inner.headingRad === undefined && !state.inner.stationary && fixes.length >= 2) {
      const a = fixes[0];
      const b = fixes.at(-1)!;
      const walked = b.pedometerTotal - a.pedometerTotal;
      const start = wgs84ToLocal(state.inner.origin, a.observation.latitude, a.observation.longitude, 0);
      const end = wgs84ToLocal(state.inner.origin, b.observation.latitude, b.observation.longitude, 0);
      if (walked >= 1 && Math.hypot(end.x - start.x, end.y - start.y) >= 5) {
        state.inner.headingRad = wrapHeadingRad(Math.atan2(end.x - start.x, end.y - start.y));
        state.inner.headingSource = 'GPS_TWO_POINT';
        state.inner.yawSinceAnchorRad = 0;
      }
    }
    result.events.push({ type: 'anchor-qualified', t: gps.t, seq: gps.seq, fixes: fixes.length, spanMs, accuracy: gps.horizontalAccuracy! });
    const decision = result.events.find((event) => event.type === 'engine' && event.event.type === 'gps-decision' && event.event.seq === gps.seq);
    if (decision?.type === 'engine' && decision.event.type === 'gps-decision') {
      result.events.push(spatialDecision(state, gps, decision.event.used, decision.event.reason ?? (decision.event.used ? 'ANCHOR_ACCEPTED' : 'ENGINE_REJECTED')));
    }
    return result;
  }

  const result = stepInner(state, gps);
  const decision = result.events.find((event) => event.type === 'engine' && event.event.type === 'gps-decision' && event.event.seq === gps.seq);
  if (decision?.type === 'engine' && decision.event.type === 'gps-decision') {
    result.events.push(spatialDecision(state, gps, decision.event.used, decision.event.reason ?? (decision.event.used ? 'ANCHOR_ACCEPTED' : 'ENGINE_REJECTED')));
  }
  return result;
}

export function flushFusionV3(state: FusionStateV3) {
  const result = flushFusionV21(state.inner, fusionConfigV21);
  return guardOutputs(state, result.outputs, result.events);
}

export function summarizeV3(state: FusionStateV3, events: FusionEventV3[]) {
  const engineEvents = events.filter((event): event is Extract<FusionEventV3, { type: 'engine' }> => event.type === 'engine').map((event) => event.event);
  const summary = summarizeV21(state.inner, engineEvents);
  const rejectReasons = { ...summary.rejectReasons };
  let rejected = 0;
  for (const event of events) if (event.type === 'spatial-gps-rejected') {
    rejected++;
    rejectReasons[event.reason] = (rejectReasons[event.reason] ?? 0) + 1;
  }
  return { ...summary, gpsRejected: summary.gpsRejected + rejected, rejectReasons };
}

export function describeEventV3(event: FusionEventV3) {
  if (event.type === 'engine') return describeEventV21(event.event);
  if (event.type === 'anchor-qualified') return { event: 'fusion.anchor_qualified', fields: { sequence: event.seq, fixes: event.fixes, spanMs: event.spanMs, accuracy: event.accuracy } };
  if (event.type === 'spatial-gps-rejected' || event.type === 'spatial-gps-accepted') return { event: event.type === 'spatial-gps-accepted' ? 'fusion.spatial_gps_accepted' : 'fusion.spatial_gps_rejected', fields: { sequence: event.seq, reason: event.reason, accuracy: event.accuracy, campus: event.campus } };
  return { event: 'fusion.spatial_output_rejected', fields: { sequence: event.seq, reason: event.reason } };
}

export { createFusionStateV3 };
export const fusionV3Config = fusionConfigV3;
