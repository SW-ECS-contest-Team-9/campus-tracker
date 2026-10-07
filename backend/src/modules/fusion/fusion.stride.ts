import { createHash } from 'node:crypto';
import { z } from 'zod';

export const STRIDE_CALIBRATION_SOURCE = 'APPLE_HEALTH_WALKING_STEP_LENGTH' as const;
export const STRIDE_CALIBRATION_AGGREGATION = 'median_mad_v1' as const;
export const STRIDE_CALIBRATION_SOURCE_POLICY = 'IPHONE_AUTOMATIC_V1' as const;

export const StrideCalibrationSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal(STRIDE_CALIBRATION_SOURCE),
  aggregationVersion: z.literal(STRIDE_CALIBRATION_AGGREGATION),
  sourcePolicy: z.literal(STRIDE_CALIBRATION_SOURCE_POLICY),
  stepLengthM: z.number().finite().min(0.2).max(1.5),
  sampleCount: z.number().int().min(0).max(5000),
  observedDays: z.number().int().min(0).max(29),
  dispersionM: z.number().finite().min(0).max(1.5),
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  latestSampleAt: z.string().datetime({ offset: true }),
  computedAt: z.string().datetime({ offset: true }),
}).strict();

export type StrideCalibration = z.infer<typeof StrideCalibrationSchema>;
export type StrideCalibrationReason = 'MISSING' | 'INVALID_FORMAT' | 'UNSUPPORTED_VERSION' | 'INSUFFICIENT_DATA' | 'STALE'
  | 'OUT_OF_RANGE' | 'EXCESSIVE_DISPERSION' | 'INVALID_TIME';
export type StrideCalibrationDecision = {
  status: 'ACCEPTED' | 'FALLBACK';
  reason: StrideCalibrationReason | null;
  calibration: StrideCalibration | null;
};

const DAY_MS = 86_400_000;
const WINDOW_TOLERANCE_MS = 1000;
const MAX_AGE_AT_START_MS = 14 * DAY_MS;
const MAX_COMPUTE_AGE_MS = DAY_MS;
const WALK_STRIDE_MIN_M = 0.35;
const WALK_STRIDE_MAX_M = 1.1;

function fallback(reason: StrideCalibrationReason): StrideCalibrationDecision {
  return { status: 'FALLBACK', reason, calibration: null };
}

/** Validates the optional app summary without allowing a bad calibration to reject session capture. */
export function evaluateStrideCalibration(raw: unknown, startedAt: string | null, now = Date.now()): StrideCalibrationDecision {
  if (raw === undefined || raw === null) return fallback('MISSING');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback('INVALID_FORMAT');
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.aggregationVersion !== STRIDE_CALIBRATION_AGGREGATION
      || record.source !== STRIDE_CALIBRATION_SOURCE || record.sourcePolicy !== STRIDE_CALIBRATION_SOURCE_POLICY) {
    return fallback('UNSUPPORTED_VERSION');
  }
  const parsed = StrideCalibrationSchema.safeParse(raw);
  if (!parsed.success) return fallback('INVALID_FORMAT');
  const c = parsed.data;
  if (c.sampleCount < 20 || c.observedDays < 3 || c.observedDays > c.sampleCount) return fallback('INSUFFICIENT_DATA');
  if (c.dispersionM > 0.2) return fallback('EXCESSIVE_DISPERSION');
  if (c.stepLengthM < WALK_STRIDE_MIN_M || c.stepLengthM > WALK_STRIDE_MAX_M) return fallback('OUT_OF_RANGE');
  if (!startedAt) return fallback('INVALID_TIME');

  const start = Date.parse(startedAt);
  const windowStart = Date.parse(c.windowStart);
  const windowEnd = Date.parse(c.windowEnd);
  const latest = Date.parse(c.latestSampleAt);
  const computed = Date.parse(c.computedAt);
  const ordered = [start, windowStart, windowEnd, latest, computed].every(Number.isFinite)
    && Math.abs(windowEnd - computed) <= WINDOW_TOLERANCE_MS
    && Math.abs((windowEnd - windowStart) - 28 * DAY_MS) <= WINDOW_TOLERANCE_MS
    && windowStart <= latest && latest <= windowEnd
    && latest <= start && computed <= start;
  if (!ordered) return fallback('INVALID_TIME');
  if (start - computed > MAX_COMPUTE_AGE_MS) return fallback('STALE');
  if (latest < start - MAX_AGE_AT_START_MS) return fallback('STALE');
  if (start - latest > MAX_AGE_AT_START_MS || start - computed > MAX_COMPUTE_AGE_MS) return fallback('STALE');

  return { status: 'ACCEPTED', reason: null, calibration: c };
}

export function strideCalibrationHash(calibration: StrideCalibration | null): string {
  return createHash('sha256').update(calibration ? JSON.stringify(calibration) : 'NO_HEALTH_STRIDE').digest('hex').slice(0, 64);
}

export function strideCalibrationConfig(calibration: StrideCalibration | null) {
  return calibration ? {
    schemaVersion: calibration.schemaVersion,
    source: calibration.source,
    aggregationVersion: calibration.aggregationVersion,
    sourcePolicy: calibration.sourcePolicy,
    stepLengthM: calibration.stepLengthM,
    sampleCount: calibration.sampleCount,
    observedDays: calibration.observedDays,
    dispersionM: calibration.dispersionM,
    windowStart: calibration.windowStart,
    windowEnd: calibration.windowEnd,
    latestSampleAt: calibration.latestSampleAt,
    computedAt: calibration.computedAt,
  } : null;
}

export type FusionSessionContext = { strideCalibration: StrideCalibration | null };
