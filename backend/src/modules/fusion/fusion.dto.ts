import { z } from 'zod';
import { FUSION_ALGORITHMS, REALTIME_FUSION_VERSION } from './fusion.algorithms.js';

const AlgorithmVersion = z
  .string()
  .trim()
  .refine((v) => v in FUSION_ALGORITHMS, { message: `Known versions: ${Object.keys(FUSION_ALGORITHMS).join(', ')}` });

export const FusedPositionsQuery = z.object({
  algorithmVersion: AlgorithmVersion.default(REALTIME_FUSION_VERSION),
});

export const ReprocessRequest = z.object({
  algorithmVersion: AlgorithmVersion.default(REALTIME_FUSION_VERSION),
  /** false: skip when this session was already processed with the same version + code + config. */
  force: z.boolean().default(false),
});

export interface FusedPositionView {
  fusionSequence: number;
  timestamp: Date;
  longitude: number;
  latitude: number;
  ellipsoidalAltitude: number | null;
  localX: number | null;
  localY: number | null;
  localZ: number | null;
  heading: number | null;
  horizontalConfidence: number;
  verticalConfidence: number;
  overallConfidence: number;
  gpsHorizontalAccuracy: number | null;
  gpsVerticalAccuracy: number | null;
  source: string;
  algorithmVersion: string;
  // diagnostics (fusion-v2+, null for v1)
  gpsUsed: boolean | null;
  gpsRejectReason: string | null;
  gpsSequence: number | null;
  innovationDistance: number | null;
  stationary: boolean | null;
  headingSource: string | null;
  horizontalUncertainty: number | null;
  // v2.1 diagnostics
  gpsQuality: string | null;
  pdrApplied: boolean | null;
  pdrRejectReason: string | null;
  relativeAltitude: number | null;
  reanchored: boolean | null;
  reanchorReason: string | null;
  divergenceDetected: boolean | null;
  spatialMapVersionId: string | null;
  spatialStatus: string | null;
  buildingId: string | null;
  buildingName: string | null;
  buildingMatchStatus: string | null;
  spatialSegmentId: number | null;
  // v4 rev 2: absolute height
  terrainHeight: number | null;
  heightAboveGround: number | null;
  zDatumSource: string | null;
  zDatumSigma: number | null;
}

/** /preview position:fused payload */
export interface FusedPositionEvent extends Omit<FusedPositionView, 'timestamp'> {
  collectorId: string;
  sessionId: string;
  timestamp: string;
}
