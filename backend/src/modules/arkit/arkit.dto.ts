import { z } from 'zod';
import { SensorTimestamp, Uuid } from '../../common/dto.js';
import { AppError } from '../../common/errors/app-error.js';

export const ARKIT_MAX_BYTES = 4096;
const Vector = z.object({ x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000), z: z.number().finite().min(-1_000_000).max(1_000_000) }).strict();
export const ArkitPose = z.object({
  type: z.literal('arkit.pose'),
  schemaVersion: z.literal(1),
  sessionId: Uuid,
  arSessionId: Uuid,
  deviceId: z.string().min(1).max(128),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().int().min(0).max(8_640_000_000_000_000).refine(
    t => SensorTimestamp.safeParse(new Date(t).toISOString()).success, 'Invalid epoch milliseconds'),
  frameTimestamp: z.number().finite().nonnegative(),
  position: Vector,
  rotation: Vector.extend({ w: z.number().finite() }).strict().refine(
    q => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) <= 0.02, 'Quaternion must have unit norm (tolerance 0.02)'),
  trackingState: z.enum(['normal', 'limited', 'notAvailable']),
}).strict();
export type ArkitPose = z.infer<typeof ArkitPose>;

export function parseArkitPose(payload: unknown): ArkitPose {
  const json = JSON.stringify(payload);
  if (!json || Buffer.byteLength(json) > ARKIT_MAX_BYTES) throw AppError.badRequest('ARKIT_MESSAGE_SIZE', 'ARKit payload exceeds 4096 bytes');
  return ArkitPose.parse(payload);
}
