// Replay input boundary and comparison diagnostics (pure: no DB, no clock).
//  - one run sees ONE consistent set of raw rows (read in one snapshot, cut at a sensor-time cutoff), identified by a hash
//  - track / input statistics for comparing runs of different sessions over the same time span.
// None of these numbers is a position accuracy: there is no ground truth in them.
import { createHash } from 'node:crypto';
import { preSessionCutoff, type RawSamples } from './fusion.timeline.js';
import type { FusedOutput } from './fusion.types.js';

const ms = (t: string | Date) => (t instanceof Date ? t.getTime() : Date.parse(t));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Samples with sensor time <= cutoff (null = everything). Rows are not changed or reordered. */
export function cutRawSamples<T extends RawSamples>(raw: T, cutoff: number | null): T {
  if (cutoff === null) return raw;
  const keep = <S extends { timestamp: string | Date }>(rows: S[]) => rows.filter((r) => ms(r.timestamp) <= cutoff);
  return { ...raw, locations: keep(raw.locations), motion: keep(raw.motion), altimeter: keep(raw.altimeter), pedometer: keep(raw.pedometer) };
}

export interface ReplayInputSummary {
  /** sensor-time cutoff of the run (ISO), null = all raw rows of the snapshot */
  cutoff: string | null;
  counts: { locations: number; motion: number; altimeter: number; pedometer: number };
  firstSensorAt: string | null;
  lastSensorAt: string | null;
  /** sha256 over (stream, sequence, sensor time, values fusion reads) in sensor-time order: same hash = same fusion input */
  hash: string;
}

/**
 * Identity of a run's input. Independent of row order and of when / in which batches the rows arrived, so the
 * SENSOR_TIME and AS_RECEIVED runs of one cutoff carry the same hash.
 */
export function summarizeReplayInput(raw: RawSamples, cutoff: number | null): ReplayInputSummary {
  const lines: string[] = [];
  let first = Infinity;
  let last = -Infinity;
  const add = (stream: string, t: number, key: number | string, values: unknown[]) => {
    if (!Number.isFinite(t)) return;
    first = Math.min(first, t);
    last = Math.max(last, t);
    lines.push(`${stream}|${t}|${key}|${values.map((v) => (v === null || v === undefined ? '' : String(v))).join(',')}`);
  };
  for (const l of raw.locations) add('L', ms(l.timestamp), l.sequence, [l.latitude, l.longitude, l.altitude, l.ellipsoidalAltitude, l.horizontalAccuracy, l.verticalAccuracy, l.speed, l.course]);
  for (const m of raw.motion) add('M', ms(m.timestamp), m.sequence, [m.yaw, m.ax, m.ay, m.az, m.gx, m.gy, m.gz, m.segment]);
  for (const a of raw.altimeter) add('A', ms(a.timestamp), a.sequence, [a.relativeAltitude, a.segment]);
  for (const p of raw.pedometer) add('P', ms(p.timestamp), '', [p.numberOfSteps, p.distance, p.segment]);
  lines.sort();
  const hash = createHash('sha256');
  for (const line of lines) hash.update(line).update('\n');
  const iso = (v: number) => (Number.isFinite(v) ? new Date(v).toISOString() : null);
  return {
    cutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
    counts: { locations: raw.locations.length, motion: raw.motion.length, altimeter: raw.altimeter.length, pedometer: raw.pedometer.length },
    firstSensorAt: iso(first),
    lastSensorAt: iso(last),
    hash: hash.digest('hex').slice(0, 24),
  };
}

export interface TrackStats {
  outputs: number;
  firstAt: string | null;
  lastAt: string | null;
  /** sum of the distances between consecutive outputs (local frame), and the largest single one */
  pathLengthM: number;
  maxJumpM: number;
  /** outputs without a heading / all outputs; seconds = outputs x output interval is NOT assumed: counted from timestamps */
  headingUnknownOutputs: number;
  headingUnknownSeconds: number;
  firstHeadingAt: string | null;
  headingSources: Record<string, number>;
  /** outputs with an absolute height (a vertical datum was found) */
  absoluteHeightOutputs: number;
  firstAbsoluteHeightAt: string | null;
  zDatumSources: Record<string, number>;
  /** range of the engine's relative Z (barometric, continued over sensor restarts), null without a barometer */
  relativeZRangeM: number | null;
  sources: Record<string, number>;
}

/** Shape of a stored track, for comparing processing stages. Describes the result only: not how right it is. */
export function trackStats(outputs: FusedOutput[]): TrackStats {
  const count = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const headingSources: Record<string, number> = {};
  const zDatumSources: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let path = 0, jump = 0, unknown = 0, unknownMs = 0, absolute = 0;
  let firstHeading: number | null = null, firstAbsolute: number | null = null;
  let zMin = Infinity, zMax = -Infinity;
  outputs.forEach((o, i) => {
    const prev = outputs[i - 1];
    if (prev) {
      const d = Math.hypot(o.x - prev.x, o.y - prev.y);
      path += d;
      jump = Math.max(jump, d);
    }
    if (o.headingDegrees === null) {
      unknown++;
      if (prev) unknownMs += o.timestamp - prev.timestamp;
    } else firstHeading ??= o.timestamp;
    if (o.ellipsoidalAltitude !== null) {
      absolute++;
      firstAbsolute ??= o.timestamp;
    }
    count(headingSources, o.headingSource ?? 'UNKNOWN');
    count(zDatumSources, o.zDatumSource ?? 'NONE');
    count(sources, o.source);
    if (o.relativeAltitude !== null && o.relativeAltitude !== undefined) {
      zMin = Math.min(zMin, o.relativeAltitude);
      zMax = Math.max(zMax, o.relativeAltitude);
    }
  });
  const iso = (v: number | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());
  return {
    outputs: outputs.length, firstAt: iso(outputs[0]?.timestamp), lastAt: iso(outputs.at(-1)?.timestamp),
    pathLengthM: round(path, 1), maxJumpM: round(jump, 1),
    headingUnknownOutputs: unknown, headingUnknownSeconds: round(unknownMs / 1000, 1), firstHeadingAt: iso(firstHeading), headingSources,
    absoluteHeightOutputs: absolute, firstAbsoluteHeightAt: iso(firstAbsolute), zDatumSources,
    relativeZRangeM: zMax >= zMin ? round(zMax - zMin) : null, sources,
  };
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : null);

export interface MotionSegmentStats {
  segment: string | null;
  samples: number;
  firstAt: string;
  lastAt: string;
  /** from the median sensor-time interval (not from the arrival times, not from the reported motionUpdateHz) */
  medianHz: number | null;
  p95IntervalMs: number | null;
  maxIntervalMs: number | null;
  /** intervals longer than gapMs inside this segment */
  gaps: number;
  duplicateTimestamps: number;
}

export interface InputStats {
  /** denominator of every motion number below: motion samples at or before the cutoff */
  motionSamples: number;
  gapMs: number;
  segments: MotionSegmentStats[];
  /** intervals longer than gapMs between consecutive motion samples of the whole stream (including segment changes) */
  motionGaps: { at: string; ms: number; segmentChanged: boolean }[];
  /** server receive time - sensor time, per stream; denominator = rows of that stream with a receive time */
  receiveDelayS: Record<'locations' | 'motion' | 'altimeter' | 'pedometer', { rows: number; p50: number | null; p95: number | null; max: number | null } | null>;
  gps: {
    fixes: number;
    preSession: number;
    /** reported horizontalAccuracy of fixes with a valid (> 0) value — the phone's own claim, not a measured error */
    reportedAccuracyM: { valid: number; p50: number | null; p90: number | null; max: number | null; over50m: number };
  };
}

/**
 * How the raw input looks on the sensor time axis and how late it arrived. receivedAt (per stream, aligned with the
 * rows) is optional: without it the delay block is null rather than guessed.
 */
export function inputStats(
  raw: RawSamples,
  opts: { gapMs?: number; sessionStartedAt?: string | Date | null; receivedAt?: Partial<Record<keyof RawSamples, (string | Date | null)[]>> } = {},
): InputStats {
  const gapMs = opts.gapMs ?? 2000;
  const motion = raw.motion.map((m) => ({ t: ms(m.timestamp), seq: m.sequence, segment: m.segment ?? null })).sort((a, b) => a.t - b.t || a.seq - b.seq);
  const bySegment = new Map<string | null, typeof motion>();
  for (const m of motion) bySegment.set(m.segment, [...(bySegment.get(m.segment) ?? []), m]);
  const segments: MotionSegmentStats[] = [...bySegment.entries()].map(([segment, rows]) => {
    const dt: number[] = [];
    let duplicates = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].t - rows[i - 1].t;
      if (d === 0) duplicates++;
      else dt.push(d);
    }
    const sorted = [...dt].sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    return {
      segment, samples: rows.length, firstAt: new Date(rows[0].t).toISOString(), lastAt: new Date(rows.at(-1)!.t).toISOString(),
      medianHz: median ? round(1000 / median, 1) : null, p95IntervalMs: quantile(sorted, 0.95), maxIntervalMs: sorted.at(-1) ?? null,
      gaps: dt.filter((d) => d > gapMs).length, duplicateTimestamps: duplicates,
    };
  }).sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1));
  const motionGaps: InputStats['motionGaps'] = [];
  for (let i = 1; i < motion.length; i++) {
    const d = motion[i].t - motion[i - 1].t;
    if (d > gapMs) motionGaps.push({ at: new Date(motion[i - 1].t).toISOString(), ms: d, segmentChanged: motion[i].segment !== motion[i - 1].segment });
  }
  const delay = (stream: keyof RawSamples) => {
    const received = opts.receivedAt?.[stream];
    if (!received) return null;
    const rows = raw[stream] as { timestamp: string | Date }[];
    const d: number[] = [];
    rows.forEach((r, i) => {
      const at = received[i];
      if (at !== null && at !== undefined) d.push((ms(at) - ms(r.timestamp)) / 1000);
    });
    d.sort((a, b) => a - b);
    const q = (v: number | null) => (v === null ? null : round(v));
    return { rows: d.length, p50: q(quantile(d, 0.5)), p95: q(quantile(d, 0.95)), max: q(d.at(-1) ?? null) };
  };
  const pre = preSessionCutoff(opts.sessionStartedAt);
  const acc = raw.locations.map((l) => l.horizontalAccuracy).filter((v): v is number => typeof v === 'number' && v > 0).sort((a, b) => a - b);
  return {
    motionSamples: motion.length, gapMs, segments, motionGaps,
    receiveDelayS: { locations: delay('locations'), motion: delay('motion'), altimeter: delay('altimeter'), pedometer: delay('pedometer') },
    gps: {
      fixes: raw.locations.length,
      preSession: raw.locations.filter((l) => ms(l.timestamp) < pre).length,
      reportedAccuracyM: { valid: acc.length, p50: quantile(acc, 0.5), p90: quantile(acc, 0.9), max: acc.at(-1) ?? null, over50m: acc.filter((v) => v > 50).length },
    },
  };
}
