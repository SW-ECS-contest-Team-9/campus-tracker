import { createFusionStateV21, type FusionStateV21 } from './fusion-state-v21.js';
import type { Observation } from './fusion.timeline.js';
import type { SpatialContext } from '../../geo/spatial.js';

export interface AnchorCandidateV3 {
  observation: Extract<Observation, { kind: 'gps' }>;
  pedometerTotal: number;
}

export interface FusionStateV3 {
  inner: FusionStateV21;
  trusted: boolean;
  candidates: AnchorCandidateV3[];
  context: SpatialContext | null;
  mapUnavailable: boolean;
  segmentId: number;
}

export function createFusionStateV3(): FusionStateV3 {
  return { inner: createFusionStateV21(), trusted: false, candidates: [], context: null, mapUnavailable: true, segmentId: 0 };
}
