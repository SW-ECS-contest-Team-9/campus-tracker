import { z } from 'zod';
import { OptionalNumber, SensorTimestamp, Uuid } from '../../common/dto.js';
import { FLOOR_NAME } from './marker-anchor.js';

// Known types (stored as free string, unknown types are accepted too):
// entrance, intersection, stairStart, stairEnd, rampStart, rampEnd, elevator, stop, custom
// Collection anchors (marker-anchor.ts): sessionStart, sessionEnd, elevatorBoard, elevatorExit, plus the anchor fields below.
const FloorName = z.string().trim().toUpperCase().regex(FLOOR_NAME, 'floor must look like 1F, 12F or B1');
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
  // ---- collection anchor (all optional: older apps send none of them) ----
  nodeId: Uuid.nullish(),
  /** campus_buildings.building_id, or "outdoor" */
  buildingId: z.string().trim().regex(/^[^\s#]{1,24}$/).nullish(),
  floor: FloorName.nullish(),
  direction: z.enum(['up', 'down']).nullish(),
  fromFloor: FloorName.nullish(),
  toFloor: FloorName.nullish(),
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
  nodeId: string | null;
  buildingId: string | null;
  floor: string | null;
  direction: 'up' | 'down' | null;
  fromFloor: string | null;
  toFloor: string | null;
  /** the named node (EPSG:5186, MSL floor height); current=false: gone from the network, as it was when the marker arrived */
  node?: { x: number; y: number; z: number; current: boolean } | null;
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
