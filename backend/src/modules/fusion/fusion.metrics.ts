import type { Observation } from './fusion.timeline.js';
import type { FusedOutput } from './fusion.types.js';
import type { AlgorithmSummary } from './fusion.algorithms.js';
import { validateFusion, type FusionValidation } from './fusion.validation.js';

/**
 * Per-run debug metrics. None of these is a position accuracy (there is no ground truth):
 * they describe how much the algorithm trusted / rejected GPS and how the two paths compare.
 */
export interface FusionMetrics {
  rawGpsCount: number;
  fusionOutputCount: number;
  gpsAccepted: number;
  gpsRejected: number;
  rejectedPct: number | null;
  rejectReasons: Record<string, number>;
  stationarySeconds: number | null;
  medianGpsHorizontalAccuracy: number | null;
  maxRejectedInnovation: number | null;
  fusedPathLengthM: number;
  rawGpsPathLengthM: number;
  sources: Record<string, number>;
  reanchors: number | null;
  divergences: number | null;
  motionGaps: number | null;
  altimeterRebases: number | null;
  gpsHeightsRejected: number | null;
  sensorTracking: {
    trackingStatus: string;
    headingStatus: string;
    fallbackStepDistanceM: number;
    horizontalUncertaintyM: number | null;
  } | null;
  pdr: { stepsDetected: number; stairSteps: number; headingSegments: number; headingSegmentsWithHeading: number | null; strideM: number | null } | null;
  terrain: AlgorithmSummary['terrain'] | null;
  validation: FusionValidation;
}

const R = 6371008.8;
const RAD = Math.PI / 180;

export function computeFusionMetrics(timeline: Observation[], outputs: FusedOutput[], summary: AlgorithmSummary): FusionMetrics {
  const fixes = timeline.filter((o): o is Extract<Observation, { kind: 'gps' }> => o.kind === 'gps');
  const valid = fixes.filter((f) => f.horizontalAccuracy !== null && f.horizontalAccuracy > 0);
  const accuracies = valid.map((f) => f.horizontalAccuracy!).sort((a, b) => a - b);
  let rawPath = 0;
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1];
    const b = valid[i];
    rawPath += Math.hypot((b.longitude - a.longitude) * RAD * Math.cos(((a.latitude + b.latitude) / 2) * RAD), (b.latitude - a.latitude) * RAD) * R;
  }
  let fusedPath = 0;
  for (let i = 1; i < outputs.length; i++) fusedPath += Math.hypot(outputs[i].x - outputs[i - 1].x, outputs[i].y - outputs[i - 1].y);
  const sources: Record<string, number> = {};
  for (const o of outputs) sources[o.source] = (sources[o.source] ?? 0) + 1;
  const judged = summary.gpsAccepted + summary.gpsRejected;
  const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    rawGpsCount: fixes.length,
    fusionOutputCount: outputs.length,
    gpsAccepted: summary.gpsAccepted,
    gpsRejected: summary.gpsRejected,
    rejectedPct: judged ? round((100 * summary.gpsRejected) / judged) : null,
    rejectReasons: summary.rejectReasons,
    stationarySeconds: summary.stationaryMs === null ? null : round(summary.stationaryMs / 1000),
    medianGpsHorizontalAccuracy: accuracies.length ? round(accuracies[Math.floor((accuracies.length - 1) / 2)]) : null,
    maxRejectedInnovation: summary.maxRejectedInnovation === null ? null : round(summary.maxRejectedInnovation),
    fusedPathLengthM: round(fusedPath),
    rawGpsPathLengthM: round(rawPath),
    sources,
    reanchors: summary.reanchors ?? null,
    divergences: summary.divergences ?? null,
    motionGaps: summary.motionGaps ?? null,
    altimeterRebases: summary.altimeterRebases ?? null,
    gpsHeightsRejected: summary.verticalRejected ?? null,
    sensorTracking: summary.trackingStatus ? {
      trackingStatus: summary.trackingStatus,
      headingStatus: summary.headingStatus ?? 'UNKNOWN',
      fallbackStepDistanceM: round(summary.fallbackStepDistance ?? 0),
      horizontalUncertaintyM: Number.isFinite(summary.horizontalUncertainty) ? round(summary.horizontalUncertainty!) : null,
    } : null,
    pdr: summary.stepsDetected === undefined ? null : {
      stepsDetected: summary.stepsDetected,
      stairSteps: summary.stairSteps ?? 0,
      headingSegments: summary.headingSegments ?? 0,
      headingSegmentsWithHeading: summary.headingSegmentsWithHeading ?? null,
      strideM: summary.strideM ?? null,
    },
    terrain: summary.terrain ?? null,
    validation: validateFusion(timeline, outputs.map((o) => ({ latitude: o.latitude, longitude: o.longitude, height: o.geomZ }))),
  };
}
