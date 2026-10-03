import { z } from 'zod';
import { OptionalNumber, SensorTimestamp, Uuid } from '../../common/dto.js';

// Known types (stored as free string, unknown types are accepted too):
// entrance, intersection, stairStart, stairEnd, rampStart, rampEnd, elevator, stop, custom
export const MarkerCreateRequest = z.object({
  markerId: Uuid,
  sessionId: Uuid.nullish(), // may be omitted when clientSessionId is given (session started offline)
  clientSessionId: Uuid.nullish(),
  timestamp: SensorTimestamp,
  type: z.string().trim().min(1).max(32),
  note: z.string().max(2000).nullish(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: OptionalNumber,
  ellipsoidalAltitude: OptionalNumber,
  horizontalAccuracy: OptionalNumber,
  verticalAccuracy: OptionalNumber,
}).refine((m) => m.sessionId || m.clientSessionId, { message: 'sessionId or clientSessionId is required', path: ['sessionId'] });
export type MarkerCreateRequest = z.infer<typeof MarkerCreateRequest>;

export interface MarkerView {
  markerId: string;
  sessionId: string;
  timestamp: Date;
  type: string;
  note: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  ellipsoidalAltitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  /** The fused estimate at the marker time (preferred fusion-v4): its height replaces the phone's unreliable altitude. */
  fused?: {
    algorithmVersion: string;
    latitude: number;
    longitude: number;
    ellipsoidalAltitude: number | null;
    heightAboveGround: number | null;
    zDatumSource: string | null;
    buildingName: string | null;
  } | null;
}
