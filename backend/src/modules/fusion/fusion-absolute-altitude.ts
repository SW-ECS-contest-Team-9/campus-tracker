import type { FusionConfigV4 } from './fusion.config.js';
import type { Observation } from './fusion.timeline.js';
import type { DatumV4 } from './fusion-state-v4.js';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y), i = a.length >> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};

/** `b` is in the APPLE_MSL frame (Apple sea-level height − relative Z); conversion happens when the datum is used. */
export interface AbsoluteCandidate { t: number; seq: number; b: number; accuracy: number; alignmentM: number }
export interface RelativeHeightRun {
  from: number;
  through: number;
  candidates: AbsoluteCandidate[];
  /** appleGeoid: the session's Apple geoid height known when the anchor was set (null = not yet measured) */
  anchor?: { t: number; seq: number; b: number; sigma: number; appleGeoid: number | null };
  gpsOffsets: number[];
  gpsEllipsoidalOffsets: number[];
}
export interface AbsoluteAltitudeTracker {
  enabled: boolean;
  runs: RelativeHeightRun[];
  lastT?: number;
  segment?: string | null;
  accepted: number;
  rejected: Record<string, number>;
  /**
   * ellipsoidalAltitude − altitude of this phone's own location fixes: the geoid height of the sea level the
   * phone reports. Apple's sea level is not the map's (campus: 22.6 m vs the map's 23.377 m), so APPLE_MSL is
   * converted through this, not through the map geoid. Android fixes never meet an absolute observation.
   */
  geoidSamples: number[];
}
export const createAbsoluteAltitudeTracker = (enabled = false): AbsoluteAltitudeTracker => ({
  enabled, runs: [], accepted: 0, rejected: {}, geoidSamples: [],
});

/** Device geoid height measured in this session (median of its fixes), null before the first fix with both heights. */
export function deviceGeoid(tracker: AbsoluteAltitudeTracker): number | null {
  return tracker.geoidSamples.length ? median(tracker.geoidSamples) : null;
}

/** A location fix carrying both heights (verticalAccuracy <= 0: iOS has no altitude and reports 0 for both). */
export function observeDeviceGeoid(tracker: AbsoluteAltitudeTracker, o: { altitude: number | null;
  ellipsoidalAltitude: number | null; verticalAccuracy: number | null }) {
  if (!finite(o.altitude) || !finite(o.ellipsoidalAltitude) || !finite(o.verticalAccuracy) || o.verticalAccuracy <= 0) return;
  tracker.geoidSamples.push(o.ellipsoidalAltitude - o.altitude);
}

export function validateAbsoluteAltitudeConfig(c: FusionConfigV4) {
  if (!['off', 'shadow', 'fallback'].includes(c.absoluteAltitudeMode)) throw new Error('Invalid absoluteAltitudeMode');
  for (const [key, value] of Object.entries(c)) {
    if (!key.startsWith('absoluteAltitude') || key === 'absoluteAltitudeMode') continue;
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (key !== 'absoluteAltitudeDatumOffsetM' && value <= 0)) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(c.absoluteAltitudeMinSamples) || c.absoluteAltitudeMinSamples < 2
    || c.absoluteAltitudeMinSpanMs > c.absoluteAltitudeWindowMs) throw new Error('Invalid absolute altitude candidate window');
}


/** Relative Z may continue numerically over a restart, but its absolute reference cannot cross an unknown gap. */
export function relativeHeightSample(tracker: AbsoluteAltitudeTracker, t: number, restarted: boolean) {
  if (!tracker.runs.length || restarted) tracker.runs.push({ from: t, through: t, candidates: [], gpsOffsets: [], gpsEllipsoidalOffsets: [] });
  else tracker.runs.at(-1)!.through = t;
}

export function relativeHeightRunAt(tracker: AbsoluteAltitudeTracker, t: number): RelativeHeightRun | undefined {
  for (let i = tracker.runs.length - 1; i >= 0; i--) {
    const r = tracker.runs[i];
    if (t >= r.from && (i === tracker.runs.length - 1 || t <= r.through)) return r;
  }
  // Before the first barometer sample relative Z is the zero that sample starts from, as in the legacy policy.
  // Only a gap between two runs is unknown movement.
  const first = tracker.runs[0];
  return first && t < first.from ? first : undefined;
}

export interface AbsoluteAltitudeDecision { reason: string; seq: number; runFrom: number | null; b?: number; sigma?: number }

/** Causal, sensor-time-only selection. The absolute observation never changes relative Z or XY. */
export function observeAbsoluteAltitude(tracker: AbsoluteAltitudeTracker,
  o: Extract<Observation, { kind: 'absoluteAltitude' }>,
  relative: { t: number; z: number; speed: number } | null, transformAvailable: boolean,
  c: FusionConfigV4): AbsoluteAltitudeDecision {
  tracker.enabled = true;
  const run = tracker.runs.at(-1);
  const decision = (reason: string): AbsoluteAltitudeDecision => {
    tracker.rejected[reason] = (tracker.rejected[reason] ?? 0) + 1;
    return { reason, seq: o.seq, runFrom: run?.from ?? null };
  };
  if (tracker.lastT !== undefined && o.t <= tracker.lastT) return decision('NON_INCREASING_TIME');
  tracker.lastT = o.t;
  if (tracker.segment !== undefined && tracker.segment !== (o.segment ?? null) && run) run.candidates = [];
  tracker.segment = o.segment ?? null;
  if (o.verticalReference !== 'APPLE_MSL') return decision('UNSUPPORTED_REFERENCE');
  if (o.invalidReason || !finite(o.altitude) || !finite(o.accuracy) || o.accuracy <= 0) return decision('INVALID_SAMPLE');
  if (o.accuracy > c.absoluteAltitudeMaxAccuracyM) return decision('ACCURACY_TOO_LARGE');
  if (!transformAvailable) return decision('NO_VERTICAL_TRANSFORM');
  if (!run || !relative || relative.t < run.from || o.t < relative.t
    || o.t - relative.t > c.absoluteAltitudeMaxRelativeAgeMs) return decision('NO_RELATIVE_MATCH');
  const alignmentM = Math.abs(relative.speed) * (o.t - relative.t) / 1000;
  if (alignmentM > c.absoluteAltitudeMaxAlignmentErrorM) return decision('TIME_ALIGNMENT_UNCERTAIN');
  const b = o.altitude - relative.z; // APPLE_MSL frame
  const sigma = Math.max(c.absoluteAltitudeMinSigmaM, Math.hypot(o.accuracy, alignmentM, c.absoluteAltitudeDatumSigmaM));
  if (run.anchor && Math.abs(b - run.anchor.b) > c.absoluteAltitudeMaxOffsetRangeM) {
    run.candidates = [];
    return decision('DATUM_CONFLICT');
  }
  // An established reference stays fixed. Later reports diagnose consistency, not independent precision.
  if (run.anchor) return { reason: 'ANCHOR_HELD', seq: o.seq, runFrom: run.from, b: run.anchor.b, sigma: run.anchor.sigma };
  run.candidates = run.candidates.filter((a) => a.t >= o.t - c.absoluteAltitudeWindowMs);
  run.candidates.push({ t: o.t, seq: o.seq, b, accuracy: o.accuracy, alignmentM });
  const rows = run.candidates;
  if (rows.length < c.absoluteAltitudeMinSamples || o.t - rows[0].t < c.absoluteAltitudeMinSpanMs) return decision('CANDIDATE');
  const centre = median(rows.map((a) => a.b));
  const mad = median(rows.map((a) => Math.abs(a.b - centre)));
  if (mad > c.absoluteAltitudeMaxMadM || Math.max(...rows.map((a) => a.b)) - Math.min(...rows.map((a) => a.b)) > c.absoluteAltitudeMaxOffsetRangeM) {
    return decision('OFFSET_UNSTABLE');
  }
  run.anchor = { t: o.t, seq: o.seq, b: centre, appleGeoid: deviceGeoid(tracker),
    sigma: Math.max(sigma, c.absoluteAltitudeMinSigmaM, Math.hypot(Math.max(...rows.map((a) => a.accuracy)),
      Math.max(...rows.map((a) => a.alignmentM)), 1.4826 * mad, c.absoluteAltitudeDatumSigmaM)) };
  tracker.accepted++;
  return { reason: 'ACCEPTED', seq: o.seq, runFrom: run.from, b: centre, sigma: run.anchor.sigma };
}

/**
 * APPLE_MSL -> map orthometric height: H = MSL + N_device − N_map + absoluteAltitudeDatumOffsetM.
 * N_device is the session's measured geoid height (forward: as known when the anchor was set, so the track
 * never steps; replay: the whole session's median). Without one, Apple's sea level is taken as the map's.
 * The phone height is already in the observation (no +phoneHeightM); the output adds N_map once more.
 */
export function absoluteAltitudeDatum(tracker: AbsoluteAltitudeTracker, t: number, c: FusionConfigV4,
  mapGeoid: number | null | undefined, retrospective = false): DatumV4 | null {
  const run = relativeHeightRunAt(tracker, t), a = run?.anchor;
  if (!a || !finite(mapGeoid) || (!retrospective && t < a.t)) return null;
  const geoid = (retrospective ? deviceGeoid(tracker) : a.appleGeoid) ?? mapGeoid;
  const drift = c.baroDriftMPerHour * Math.abs(t - a.t) / 3_600_000;
  return { b: a.b + geoid - mapGeoid + c.absoluteAltitudeDatumOffsetM, sigma: Math.hypot(a.sigma, drift),
    source: 'CM_ABSOLUTE', frame: 'ORTHO' };
}
