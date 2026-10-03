import { z } from 'zod';

// Shared DTO primitives.
// Timestamps must be ISO-8601 strings with a timezone (Z or +09:00). Fractional seconds are
// accepted at any precision; iOS should use ISO8601DateFormatter with .withFractionalSeconds.
export const IsoDateTime = z.iso.datetime({ offset: true });

const MIN_SENSOR_TIME = Date.parse('2020-01-01T00:00:00Z');
const MAX_FUTURE_MS = Number(process.env.MAX_FUTURE_TIMESTAMP_MS ?? 86_400_000);
/**
 * Sensor timestamp: ISO-8601 and physically plausible. Data arriving minutes or hours late is normal
 * (background / offline upload); clearly wrong clocks (before 2020, or more than a day in the future) are not.
 */
export const SensorTimestamp = IsoDateTime.refine(
  (v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= MIN_SENSOR_TIME && t <= Date.now() + MAX_FUTURE_MS;
  },
  { message: 'timestamp is not plausible (before 2020 or too far in the future)' },
);

// Optional background metadata (backward compatible: old clients send none).
export const CaptureSource = z.string().trim().min(1).max(24).transform((v) => v.toUpperCase()); // LIVE | HISTORICAL_RECOVERY
export const AppState = z.string().trim().min(1).max(16).transform((v) => v.toUpperCase()); // FOREGROUND | BACKGROUND | UNKNOWN
export const SensorSegmentId = z.string().trim().min(1).max(64);
// z.guid(): any 8-4-4-4-12 hex UUID (case-insensitive), no RFC version check.
export const Uuid = z.guid();
export const OptionalNumber = z.number().nullish();
export const OptionalString = (max: number) => z.string().max(max).nullish();
