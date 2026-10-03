import { fusionConfigV21 as cfg } from './fusion.config.js';
import type { Observation } from './fusion.timeline.js';
import { checkPedometerCounter, createPedometerCounter, restartPedometerCounter } from './fusion.pedometer.js';

/**
 * Post-run sanity validation, independent of the algorithm that produced the outputs (works for v1, v2, v2.1 and
 * for rows read back from the DB). It flags physically implausible results:
 *   - horizontal: fused displacement from its start vs. what the evidence allows
 *     (max of walked pedometer distance and displacement of usable GPS fixes) + tolerance
 *   - vertical: fused Z range vs. barometer relative-altitude range (or GPS height range) + tolerance
 *   - output rate: far more outputs than the session duration at the configured interval
 * Thresholds: fusion.config.ts (validation*). These are not accuracy measures (no ground truth).
 */
export interface ValidationWarning {
  code: 'CRITICAL_DIVERGENCE' | 'DISPLACEMENT_EXCEEDS_EVIDENCE' | 'CRITICAL_Z_DIVERGENCE' | 'Z_RANGE_EXCEEDS_BAROMETER' | 'OUTPUT_RATE_HIGH';
  message: string;
}

export interface FusionValidation {
  durationS: number;
  pedometerPathM: number;
  usableGpsMaxDisplacementM: number;
  fusedMaxDisplacementM: number;
  allowedDisplacementM: number;
  displacementRatio: number | null;
  fusedZRangeM: number | null;
  altimeterRangeM: number | null;
  allowedZRangeM: number | null;
  outputsPerMinute: number | null;
  warnings: ValidationWarning[];
}

export interface OutputLike {
  latitude: number;
  longitude: number;
  /** absolute height (ellipsoidal or the state's estimate) */
  height: number | null;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const R = 6371008.8;
const RAD = Math.PI / 180;

export function validateFusion(timeline: Observation[], outputs: OutputLike[], outputIntervalMs = cfg.outputIntervalMs): FusionValidation {
  const warnings: ValidationWarning[] = [];
  const durationS = Math.max(0, ((timeline.at(-1)?.t ?? 0) - (timeline[0]?.t ?? 0)) / 1000);

  // walked distance: increases of the cumulative pedometer distance above its high-water mark (fusion.pedometer.ts)
  let pedometerPath = 0;
  const counter = createPedometerCounter();
  let pedometerSegment: string | null | undefined;
  let relMin = Infinity;
  let relMax = -Infinity;
  const usable: { lat: number; lon: number; h: number | null }[] = [];
  for (const o of timeline) {
    if (o.kind === 'pedometer' && o.distance !== null && Number.isFinite(o.distance)) {
      const steps = o.steps !== null && Number.isFinite(o.steps) ? o.steps : null;
      if (pedometerSegment === undefined || (o.segment ?? null) !== pedometerSegment) {
        restartPedometerCounter(counter, steps, o.distance);
        pedometerSegment = o.segment ?? null;
      } else {
        const before = counter.maxDistance ?? o.distance;
        if (checkPedometerCounter(counter, steps, o.distance) === 'OK') pedometerPath += o.distance - before;
      }
    } else if (o.kind === 'altimeter' && o.relativeAltitude !== null && Number.isFinite(o.relativeAltitude)) {
      relMin = Math.min(relMin, o.relativeAltitude);
      relMax = Math.max(relMax, o.relativeAltitude);
    } else if (o.kind === 'gps' && o.horizontalAccuracy !== null && o.horizontalAccuracy > 0 && o.horizontalAccuracy <= cfg.evidenceMaxAccuracy) {
      usable.push({ lat: o.latitude, lon: o.longitude, h: o.ellipsoidalAltitude });
    }
  }
  // Everything is measured from the FIRST fused position (lat/lon), so a poor start position cannot cause
  // false alarms: moving to where usable GPS fixes are is always explained by the evidence.
  const start = outputs[0];
  const metersFrom = (lat: number, lon: number) =>
    start ? Math.hypot((lon - start.longitude) * RAD * Math.cos(start.latitude * RAD), (lat - start.latitude) * RAD) * R : 0;
  let gpsMaxDisplacement = 0;
  for (const f of usable) gpsMaxDisplacement = Math.max(gpsMaxDisplacement, metersFrom(f.lat, f.lon));
  let fusedMax = 0;
  for (const o of outputs) fusedMax = Math.max(fusedMax, metersFrom(o.latitude, o.longitude));
  const allowed = Math.max(pedometerPath, gpsMaxDisplacement) + cfg.validationPathTolerance;
  const ratio = outputs.length ? fusedMax / allowed : null;
  if (ratio !== null && ratio > cfg.validationCriticalRatio) {
    warnings.push({ code: 'CRITICAL_DIVERGENCE', message: `fused displacement ${round(fusedMax)} m is ${round(ratio)}x the evidence (${round(allowed)} m)` });
  } else if (ratio !== null && ratio > 1) {
    warnings.push({ code: 'DISPLACEMENT_EXCEEDS_EVIDENCE', message: `fused displacement ${round(fusedMax)} m > allowed ${round(allowed)} m` });
  }

  const heights = outputs.map((o) => o.height).filter((h): h is number => h !== null && Number.isFinite(h));
  const fusedZRange = heights.length ? Math.max(...heights) - Math.min(...heights) : null;
  const gpsHeights = usable.map((u) => u.h).filter((h): h is number => h !== null);
  const altimeterRange = Number.isFinite(relMin) ? relMax - relMin : null;
  const referenceZ = altimeterRange ?? (gpsHeights.length ? Math.max(...gpsHeights) - Math.min(...gpsHeights) : null);
  const allowedZ = referenceZ === null ? null : referenceZ + cfg.validationZTolerance;
  if (fusedZRange !== null && allowedZ !== null) {
    if (fusedZRange > allowedZ * cfg.validationZCriticalRatio) {
      warnings.push({ code: 'CRITICAL_Z_DIVERGENCE', message: `fused Z range ${round(fusedZRange)} m vs barometer ${round(referenceZ!)} m` });
    } else if (fusedZRange > allowedZ) {
      warnings.push({ code: 'Z_RANGE_EXCEEDS_BAROMETER', message: `fused Z range ${round(fusedZRange)} m > allowed ${round(allowedZ)} m` });
    }
  }

  const perMinute = durationS > 0 ? (outputs.length / durationS) * 60 : null;
  const expectedPerMinute = 60_000 / outputIntervalMs;
  if (perMinute !== null && durationS >= 30 && perMinute > expectedPerMinute * 2) {
    warnings.push({ code: 'OUTPUT_RATE_HIGH', message: `${round(perMinute)} outputs/min, expected about ${expectedPerMinute}` });
  }

  return {
    durationS: round(durationS),
    pedometerPathM: round(pedometerPath),
    usableGpsMaxDisplacementM: round(gpsMaxDisplacement),
    fusedMaxDisplacementM: round(fusedMax),
    allowedDisplacementM: round(allowed),
    displacementRatio: ratio === null ? null : round(ratio, 2),
    fusedZRangeM: fusedZRange === null ? null : round(fusedZRange),
    altimeterRangeM: altimeterRange === null ? null : round(altimeterRange, 2),
    allowedZRangeM: allowedZ === null ? null : round(allowedZ),
    outputsPerMinute: perMinute === null ? null : round(perMinute),
    warnings,
  };
}
