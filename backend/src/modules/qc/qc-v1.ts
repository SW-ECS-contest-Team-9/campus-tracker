// qc-v1: rule-based quality decision for raw Core Location fixes (docs/MOBILITY_MAP_PLAN.md 4.4).
// Pure and deterministic; independent of every fusion version (it does not change what a fusion version uses).
// Used to keep bad points out of the mobility map (passes, canonical paths) and to explain them in the Lab.
import type { SpatialContext } from '../../geo/spatial.js';
import { spatial } from '../../geo/spatial.js';
import { toCampus } from '../../geo/campus-frame.js';
import type { RawSamples } from '../fusion/fusion.timeline.js';
import { PRE_SESSION_GPS_TOLERANCE_MS } from '../fusion/fusion.timeline.js';

export const QC_VERSION = 'qc-v1';

export const qcConfigV1 = {
  maxAccuracyM: 50, // > : LOW_ACCURACY (same limit as fusion-v4)
  weakAccuracyM: 20, // > : WEAK_ACCURACY (suspect)
  sigmaFloorM: 5,
  walkingMaxSpeedMps: 3, // JUMP: farther than walking speed allows, plus both accuracies
  jumpSlackM: 5,
  jumpRecoverCount: 3, // consecutive mutually consistent JUMP fixes => relocation (the previous fix was the bad one)
  spikeMaxGapMs: 10_000,
  spikeSigmas: 3,
  vehicleSpeedMps: 3, // reported speed sustained this long without steps => VEHICLE (suspect)
  vehicleMinDurationMs: 10_000,
  vehicleMaxStepsPerS: 0.3,
};
export type QcConfig = typeof qcConfigV1;

export type QcStatus = 'ACCEPTED' | 'SUSPECT' | 'REJECTED';
export type QcReason = 'INVALID' | 'PRE_SESSION' | 'DUPLICATE' | 'LOW_ACCURACY' | 'WEAK_ACCURACY' | 'OUTSIDE_CAMPUS' | 'JUMP' | 'SPIKE' | 'VEHICLE';
export interface QcDecision { seq: number; t: number; status: QcStatus; reasons: QcReason[]; details: Record<string, number | boolean | string> }

const REJECTING: ReadonlySet<QcReason> = new Set(['INVALID', 'PRE_SESSION', 'DUPLICATE', 'LOW_ACCURACY', 'OUTSIDE_CAMPUS', 'JUMP', 'SPIKE']);
const ms = (t: string | Date) => (t instanceof Date ? t.getTime() : Date.parse(t));
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Fix { seq: number; t: number; lat: number; lon: number; x: number; y: number; acc: number | null; speed: number | null; d: QcDecision }

function statusOf(reasons: QcReason[]): QcStatus {
  if (reasons.some((r) => REJECTING.has(r))) return 'REJECTED';
  return reasons.length ? 'SUSPECT' : 'ACCEPTED';
}

export function qcLocations(raw: Pick<RawSamples, 'locations' | 'pedometer'>, opts: { sessionStartedAt?: string | Date | null; spatial?: SpatialContext | null }, c: QcConfig = qcConfigV1): QcDecision[] {
  const cutoff = opts.sessionStartedAt == null ? -Infinity : ms(opts.sessionStartedAt) - PRE_SESSION_GPS_TOLERANCE_MS;
  const fixes: Fix[] = raw.locations
    .map((l) => {
      const t = ms(l.timestamp);
      const ok = Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180;
      const p = ok ? toCampus(l.latitude, l.longitude) : { x: NaN, y: NaN };
      return { seq: l.sequence, t, lat: l.latitude, lon: l.longitude, x: p.x, y: p.y, acc: l.horizontalAccuracy ?? null, speed: l.speed ?? null,
        d: { seq: l.sequence, t, status: 'ACCEPTED' as QcStatus, reasons: [] as QcReason[], details: {} as QcDecision['details'] } };
    })
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
  const sigma = (f: Fix) => Math.max(f.acc ?? c.maxAccuracyM, c.sigmaFloorM);

  // 1. single-point rules
  let prevT = -Infinity;
  for (const f of fixes) {
    const r = f.d.reasons;
    if (!Number.isFinite(f.x) || f.acc === null || !(f.acc > 0)) r.push('INVALID');
    if (f.t < cutoff) r.push('PRE_SESSION');
    if (f.t === prevT) r.push('DUPLICATE');
    prevT = f.t;
    if (f.acc !== null && f.acc > c.maxAccuracyM) r.push('LOW_ACCURACY');
    else if (f.acc !== null && f.acc > c.weakAccuracyM) r.push('WEAK_ACCURACY');
    if (opts.spatial && Number.isFinite(f.x)) {
      const k = spatial.classify(f.lat, f.lon, f.acc, opts.spatial);
      if (k.campus === 'OUTSIDE' && (k.boundaryDistanceM ?? 0) > (f.acc ?? 0)) {
        r.push('OUTSIDE_CAMPUS');
        f.d.details.boundaryDistanceM = r1(k.boundaryDistanceM ?? 0);
      }
    }
  }
  const basicOk = (f: Fix) => !f.d.reasons.some((r) => REJECTING.has(r));

  // 2. SPIKE: both neighbors agree with each other, this fix alone is far from them
  const usable = fixes.filter(basicOk);
  for (let i = 1; i + 1 < usable.length; i++) {
    const [a, p, b] = [usable[i - 1], usable[i], usable[i + 1]];
    if (p.t - a.t > c.spikeMaxGapMs || b.t - p.t > c.spikeMaxGapMs) continue;
    const sn = Math.max(sigma(a), sigma(b));
    if (Math.hypot(a.x - b.x, a.y - b.y) > 2 * sn) continue;
    const off = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2);
    if (off > c.spikeSigmas * Math.hypot(sn, sigma(p))) {
      p.d.reasons.push('SPIKE');
      p.d.details.spikeOffsetM = r1(off);
    }
  }

  // 3. JUMP: farther from the last accepted fix than walking allows; a consistent run of jumps is a relocation
  let last: Fix | null = null;
  let run: Fix[] = [];
  const bound = (a: Fix, b: Fix) => c.walkingMaxSpeedMps * Math.abs(b.t - a.t) / 1000 + 2 * Math.hypot(sigma(a), sigma(b)) + c.jumpSlackM;
  for (const f of fixes) {
    if (!basicOk(f)) continue;
    if (!last || Math.hypot(f.x - last.x, f.y - last.y) <= bound(last, f)) {
      last = f;
      run = [];
      continue;
    }
    const consistent = run.every((g) => Math.hypot(f.x - g.x, f.y - g.y) <= bound(g, f));
    run = consistent ? [...run, f] : [f];
    if (run.length >= c.jumpRecoverCount) {
      for (const g of run) g.d.details.relocated = true;
      last = f;
      run = [];
      continue;
    }
    f.d.reasons.push('JUMP');
    f.d.details.jumpM = r1(Math.hypot(f.x - last.x, f.y - last.y));
  }
  // relocated fixes were marked JUMP before the run was confirmed: undo
  for (const f of fixes) if (f.d.details.relocated) f.d.reasons = f.d.reasons.filter((r) => r !== 'JUMP');

  // 4. VEHICLE: sustained reported speed without walking
  const steps = raw.pedometer
    .map((p) => ({ t: ms(p.timestamp), steps: p.numberOfSteps ?? null }))
    .filter((p): p is { t: number; steps: number } => p.steps !== null && p.steps > 0)
    .sort((a, b) => a.t - b.t);
  const stepRate = (t0: number, t1: number) => {
    const inside = steps.filter((p) => p.t >= t0 && p.t <= t1);
    if (inside.length < 2) return null;
    return Math.max(0, inside.at(-1)!.steps - inside[0].steps) / Math.max((inside.at(-1)!.t - inside[0].t) / 1000, 1);
  };
  let i = 0;
  while (i < fixes.length) {
    if (!((fixes[i].speed ?? -1) >= c.vehicleSpeedMps)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < fixes.length && (fixes[j + 1].speed ?? -1) >= c.vehicleSpeedMps) j++;
    if (fixes[j].t - fixes[i].t >= c.vehicleMinDurationMs) {
      const rate = stepRate(fixes[i].t, fixes[j].t);
      if (rate === null || rate <= c.vehicleMaxStepsPerS) for (let k = i; k <= j; k++) fixes[k].d.reasons.push('VEHICLE');
    }
    i = j + 1;
  }

  for (const f of fixes) f.d.status = statusOf(f.d.reasons);
  return fixes.map((f) => f.d);
}
