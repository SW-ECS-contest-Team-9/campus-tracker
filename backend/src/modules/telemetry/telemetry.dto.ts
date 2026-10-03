import { z } from 'zod';
import { AppState, CaptureSource, IsoDateTime, OptionalNumber, SensorSegmentId, SensorTimestamp, Uuid } from '../../common/dto.js';

// Per-array upper bound. A 20Hz motion stream is 1 200 samples/minute, so this allows ~15 min per batch.
const MAX_SAMPLES = 20_000;
const Sequence = z.number().int().nonnegative();
const Vector3 = z.object({ x: OptionalNumber, y: OptionalNumber, z: OptionalNumber });
/** Optional per-sample background metadata; falls back to the batch-level value, then LIVE / UNKNOWN / null. */
const SampleMeta = {
  captureSource: CaptureSource.nullish(),
  appState: AppState.nullish(),
  sensorSegmentId: SensorSegmentId.nullish(),
};

export const LocationSample = z.object({
  ...SampleMeta,
  sequence: Sequence,
  timestamp: SensorTimestamp,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: OptionalNumber,
  ellipsoidalAltitude: OptionalNumber,
  horizontalAccuracy: OptionalNumber,
  verticalAccuracy: OptionalNumber,
  speed: OptionalNumber,
  speedAccuracy: OptionalNumber,
  course: OptionalNumber,
  courseAccuracy: OptionalNumber,
  floor: z.number().int().nullish(),
});
export type LocationSample = z.infer<typeof LocationSample>;

// CMDeviceMotion, nested like the iOS structs.
export const MotionSample = z.object({
  ...SampleMeta,
  sequence: Sequence,
  timestamp: SensorTimestamp,
  userAcceleration: Vector3.nullish(),
  rotationRate: Vector3.nullish(),
  gravity: Vector3.nullish(),
  attitude: z.object({ roll: OptionalNumber, pitch: OptionalNumber, yaw: OptionalNumber }).nullish(),
});
export type MotionSample = z.infer<typeof MotionSample>;

export const AltimeterSample = z.object({
  ...SampleMeta,
  sequence: Sequence,
  timestamp: SensorTimestamp,
  relativeAltitude: OptionalNumber,
  pressure: OptionalNumber,
});
export type AltimeterSample = z.infer<typeof AltimeterSample>;

export const PedometerSample = z.object({
  ...SampleMeta,
  /** optional client sequence (dedupe key stays (session, timestamp)) */
  sequence: Sequence.nullish(),
  timestamp: SensorTimestamp,
  numberOfSteps: z.number().int().nullish(),
  distance: OptionalNumber,
  currentPace: OptionalNumber,
  currentCadence: OptionalNumber,
  floorsAscended: z.number().int().nullish(),
  floorsDescended: z.number().int().nullish(),
});
export type PedometerSample = z.infer<typeof PedometerSample>;

export const TelemetryBatchRequest = z
  .object({
  batchId: Uuid,
  /** server session id; may be omitted when clientSessionId is given (session started while offline) */
  sessionId: Uuid.nullish(),
  clientSessionId: Uuid.nullish(),
  createdAt: IsoDateTime.nullish(),
  // batch-level defaults for the samples' background metadata
  captureSource: CaptureSource.nullish(),
  appState: AppState.nullish(),
  sensorSegmentId: SensorSegmentId.nullish(),
  locations: z.array(LocationSample).max(MAX_SAMPLES).nullish().transform((v) => v ?? []),
  motion: z.array(MotionSample).max(MAX_SAMPLES).nullish().transform((v) => v ?? []),
  altimeter: z.array(AltimeterSample).max(MAX_SAMPLES).nullish().transform((v) => v ?? []),
  pedometer: z.array(PedometerSample).max(MAX_SAMPLES).nullish().transform((v) => v ?? []),
  })
  .refine((b) => b.sessionId || b.clientSessionId, { message: 'sessionId or clientSessionId is required', path: ['sessionId'] });
export type TelemetryBatchRequest = z.infer<typeof TelemetryBatchRequest>;

export interface TelemetryBatchAck {
  ok: true;
  batchId: string;
  receivedAt: string;
  duplicate: boolean;
}
