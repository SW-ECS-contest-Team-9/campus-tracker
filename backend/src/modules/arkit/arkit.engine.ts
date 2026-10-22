import { tmForward } from '../../geo/tm.js';
import { CAMPUS_FRAME } from '../../geo/campus-frame.js';

export const ARKIT_ALGORITHM = 'arkit-rigid-relative-v1';
export interface PosePoint { sequence: number; timestamp: number; frameTimestamp: number; x: number; y: number; z: number; trackingState: 'normal' | 'limited' | 'notAvailable' }
export interface GpsPoint { timestamp: number; latitude: number; longitude: number; horizontalAccuracy: number | null; altitude: number | null; ellipsoidalAltitude: number | null; verticalAccuracy: number | null }
export interface FusionPoint { timestamp: number; latitude: number; longitude: number; ellipsoidalAltitude: number | null; segment: number }
export interface Anchor { u: number; v: number; up: number; e: number; n: number; h: number | null; accuracy: number; verticalAccuracy: number | null; timestamp: number }
export interface Transform { angle: number; e: number; n: number; verticalOffset: number | null }
export interface Alignment { status: 'pending' | 'rejected' | 'aligned'; reason: string; transform: Transform | null; rms: number | null; anchors: number; inliers: number; verticalRms: number | null }
export interface MapPoint { timestamp: number; e: number; n: number; h: number | null; source: string }
export interface TrajectoryResult { algorithmVersion: string; poseCount: number; gpsCount: number; fusionCount: number; alignment: Alignment; aligned: MapPoint[][]; corrected: MapPoint[][]; reference: 'camera' }

/** Binary search on measurement time, never on frameTimestamp or receive time. */
function nearest<T extends { timestamp: number }>(list: T[], t: number, tolerance: number): T | null {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].timestamp < t) lo = mid + 1; else hi = mid; }
  const candidates = [list[lo - 1], list[lo]].filter(Boolean);
  const p = candidates.sort((a, b) => Math.abs(a.timestamp - t) - Math.abs(b.timestamp - t))[0];
  return p && Math.abs(p.timestamp - t) <= tolerance ? p : null;
}

export function pairAnchors(poses: PosePoint[], gps: GpsPoint[]): Anchor[] {
  const result: Anchor[] = [];
  for (const g of gps) {
    if (g.horizontalAccuracy == null || g.horizontalAccuracy <= 0 || g.horizontalAccuracy > 10) continue;
    const p = nearest(poses, g.timestamp, 250);
    if (!p || p.trackingState !== 'normal') continue;
    // Distinct GPS times and a 1s spacing prevent a burst of correlated fixes from dominating.
    if (result.length && g.timestamp - result.at(-1)!.timestamp < 1000) continue;
    const projected = tmForward(g.latitude, g.longitude);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || Math.hypot(projected.x-CAMPUS_FRAME.originE,projected.y-CAMPUS_FRAME.originN)>5000) continue;
    result.push({ u: p.x, v: -p.z, up: p.y, e: projected.x, n: projected.y,
      h: g.verticalAccuracy != null && g.verticalAccuracy > 0 && g.verticalAccuracy <= 10
        ? g.altitude ?? (g.ellipsoidalAltitude == null ? null : g.ellipsoidalAltitude - CAMPUS_FRAME.geoidN) : null,
      accuracy: g.horizontalAccuracy, verticalAccuracy: g.verticalAccuracy, timestamp: g.timestamp });
  }
  // Bounded robust fit, spread across the entire session (all raw observations remain stored).
  return result.length <= 512 ? result : Array.from({ length: 512 }, (_, i) => result[Math.round(i * (result.length - 1) / 511)]);
}

function fit(a: Anchor[]): Transform {
  let w = 0, u = 0, v = 0, e = 0, n = 0;
  for (const p of a) { const q = 1 / Math.max(1, p.accuracy ** 2); w += q; u += q * p.u; v += q * p.v; e += q * p.e; n += q * p.n; }
  u /= w; v /= w; e /= w; n /= w;
  let dot = 0, cross = 0;
  for (const p of a) { const q = 1 / Math.max(1, p.accuracy ** 2); dot += q * ((p.u - u) * (p.e - e) + (p.v - v) * (p.n - n)); cross += q * ((p.u - u) * (p.n - n) - (p.v - v) * (p.e - e)); }
  const angle = Math.atan2(cross, dot), c = Math.cos(angle), s = Math.sin(angle);
  return { angle, e: e - c * u + s * v, n: n - s * u - c * v, verticalOffset: null };
}
const residual = (p: Anchor, t: Transform) => Math.hypot(Math.cos(t.angle) * p.u - Math.sin(t.angle) * p.v + t.e - p.e, Math.sin(t.angle) * p.u + Math.cos(t.angle) * p.v + t.n - p.n);
const threshold = (p: Anchor) => Math.max(3, Math.min(8, p.accuracy * 1.5));
function baseline(a: Anchor[], local: boolean) {
  let max = 0;
  for (const p of a) max = Math.max(max, Math.hypot((local ? p.u : p.e) - (local ? a[0].u : a[0].e), (local ? p.v : p.n) - (local ? a[0].v : a[0].n)));
  return max;
}
export function estimateAlignment(a: Anchor[]): Alignment {
  const pending = (reason: string): Alignment => ({ status: 'pending', reason, transform: null, rms: null, anchors: a.length, inliers: 0, verticalRms: null });
  if (a.length < 4) return pending('Need at least four accurate, time-matched GPS anchors');
  if (baseline(a, true) < 5 || baseline(a, false) < 5) return pending('Need at least five meters of movement');
  let inliers: Anchor[] = [];
  let bestCost = Infinity;
  // Deterministic RANSAC hypotheses: at most 32 spread anchors -> 496 candidate pairs.
  const seeds = a.length <= 32 ? a : Array.from({ length: 32 }, (_, i) => a[Math.round(i * (a.length - 1) / 31)]);
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) {
    if (Math.hypot(seeds[j].u - seeds[i].u, seeds[j].v - seeds[i].v) < 5) continue;
    const t = fit([seeds[i], seeds[j]]), subset = a.filter(p => residual(p, t) <= threshold(p));
    const cost = subset.reduce((sum, p) => sum + residual(p, t) ** 2, 0);
    if (subset.length > inliers.length || subset.length === inliers.length && cost < bestCost) { inliers = subset; bestCost = cost; }
  }
  const rejected: Alignment = { ...pending('Inconsistent GPS / VIO geometry'), status: 'rejected', inliers: inliers.length };
  if (inliers.length < 4 || inliers.length / a.length < 0.65 || baseline(inliers, true) < 5 || baseline(inliers, false) < 5) return rejected;
  let t = fit(inliers);
  inliers = inliers.filter(p => residual(p, t) <= threshold(p));
  if (inliers.length < 4 || inliers.length / a.length < 0.65) return rejected;
  t = fit(inliers);
  const weight = inliers.reduce((sum, p) => sum + 1 / Math.max(1, p.accuracy ** 2), 0);
  const rms = Math.sqrt(inliers.reduce((sum, p) => sum + residual(p, t) ** 2 / Math.max(1, p.accuracy ** 2), 0) / weight);
  if (!Number.isFinite(rms) || ![t.angle,t.e,t.n].every(Number.isFinite) || rms > 5) return { ...rejected, rms };
  const vertical = inliers.filter(p => p.h != null);
  let verticalRms: number | null = null;
  if (vertical.length >= 3) {
    const offsets = vertical.map(p => p.h! - p.up).sort((a, b) => a - b);
    const median = offsets[Math.floor(offsets.length / 2)];
    const good = vertical.filter(p => Math.abs(p.h! - p.up - median) <= 5);
    if (good.length >= 3) {
      const w = good.reduce((sum, p) => sum + 1 / Math.max(1, p.verticalAccuracy! ** 2), 0);
      const offset = good.reduce((sum, p) => sum + (p.h! - p.up) / Math.max(1, p.verticalAccuracy! ** 2), 0) / w;
      verticalRms = Math.sqrt(good.reduce((sum, p) => sum + (p.h! - p.up - offset) ** 2, 0) / good.length);
      if (verticalRms <= 3) t.verticalOffset = offset;
    }
  }
  return { status: 'aligned', reason: 'Weighted rigid fit; scale fixed at one', transform: t, rms, anchors: a.length, inliers: inliers.length, verticalRms };
}
export function projectPose(p: PosePoint, t: Transform): MapPoint {
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  return { timestamp: p.timestamp, e: c * p.x + s * p.z + t.e, n: s * p.x - c * p.z + t.n,
    h: t.verticalOffset == null ? null : p.y + t.verticalOffset, source: p.trackingState };
}

/** Split at capture gaps, tracking changes and non-monotonic frame clocks. */
export function localSegments(poses: PosePoint[]): PosePoint[][] {
  const result: PosePoint[][] = [];
  for (const p of poses) {
    const last = result.at(-1)?.at(-1);
    if (!last || p.timestamp - last.timestamp > 1000 || p.frameTimestamp <= last.frameTimestamp || Math.abs((p.timestamp - last.timestamp) / 1000 - (p.frameTimestamp - last.frameTimestamp)) > 0.5 || p.trackingState !== last.trackingState) result.push([]);
    result.at(-1)!.push(p);
  }
  return result;
}

export function buildTrajectory(poses: PosePoint[], gps: GpsPoint[], fusion: FusionPoint[]): TrajectoryResult {
  let alignment = estimateAlignment(pairAnchors(poses, gps));
  if (poses.some((p,i) => i > 0 && (p.frameTimestamp <= poses[i-1].frameTimestamp || Math.abs((p.timestamp - poses[i-1].timestamp)/1000 - (p.frameTimestamp - poses[i-1].frameTimestamp)) > 0.5))) {
    alignment = { ...alignment, status:'rejected', transform:null, reason:'Frame clock reset or time mapping jump: start a new arSessionId' };
  }
  const result: TrajectoryResult = { algorithmVersion: ARKIT_ALGORITHM, reference: 'camera', poseCount: poses.length, gpsCount: gps.length, fusionCount: fusion.length, alignment, aligned: [], corrected: [] };
  if (!alignment.transform) return result;
  result.aligned = localSegments(poses).filter(s => s[0].trackingState !== 'notAvailable').map(s => s.map(p => projectPose(p, alignment.transform!)));
  // C is opt-in by quality. No second IMU fusion and no averaging correlated pose + IMU estimates.
  if (alignment.rms! > 3 || alignment.inliers < 5 || alignment.inliers / alignment.anchors < 0.8) return result;
  const segmentIds = new Map<PosePoint,number>();
  localSegments(poses).forEach((segment,i) => segment.forEach(p => segmentIds.set(p,i)));
  let previous: { pose: PosePoint; output: MapPoint; segment: number } | null = null;
  let lastOutput: { output:MapPoint; segment:number } | null = null;
  for (const f of fusion) {
    if (!poses.length || f.timestamp < poses[0].timestamp || f.timestamp > poses.at(-1)!.timestamp) continue;
    const p = nearest(poses, f.timestamp, 250), g = nearest(gps, f.timestamp, 500);
    const base = tmForward(f.latitude, f.longitude);
    let output: MapPoint = { timestamp: f.timestamp, e: base.x, n: base.y, h: f.ellipsoidalAltitude == null ? null : f.ellipsoidalAltitude - CAMPUS_FRAME.geoidN, source: 'existing-fusion' };
    const continuous = !!(p && previous && f.segment === previous.segment && segmentIds.get(p) === segmentIds.get(previous.pose) && f.timestamp - previous.output.timestamp <= 1000 && p.frameTimestamp > previous.pose.frameTimestamp);
    if (p?.trackingState === 'normal') {
      if (g?.horizontalAccuracy != null && g.horizontalAccuracy > 0 && g.horizontalAccuracy <= 5
        && Math.hypot(tmForward(g.latitude,g.longitude).x-projectPose(p,alignment.transform).e,tmForward(g.latitude,g.longitude).y-projectPose(p,alignment.transform).n) <= Math.max(3,Math.min(8,g.horizontalAccuracy*1.5))) {
        const fixed = tmForward(g.latitude, g.longitude);
        output = { ...output, e: fixed.x, n: fixed.y, source: 'gps-anchor' };
      } else if (continuous && previous) {
        const now = projectPose(p, alignment.transform), before = projectPose(previous.pose, alignment.transform);
        output = { ...output, e: previous.output.e + now.e - before.e, n: previous.output.n + now.n - before.n, source: 'arkit-relative' };
      }
    }
    if (!lastOutput || f.segment !== lastOutput.segment || f.timestamp-lastOutput.output.timestamp>1000
      || (output.source==='existing-fusion') !== (lastOutput.output.source==='existing-fusion')
      || Math.hypot(output.e-lastOutput.output.e,output.n-lastOutput.output.n)>10) result.corrected.push([]);
    result.corrected.at(-1)!.push(output);
    lastOutput={output,segment:f.segment};
    previous = p?.trackingState === 'normal' ? { pose: p, output, segment: f.segment } : null;
  }
  return result;
}

export function lineGeometry(segments: MapPoint[][]) {
  const coordinates = segments.filter(s => s.length >= 2).map(s => s.map(p => [p.e, p.n]));
  return coordinates.length ? { type: 'MultiLineString', coordinates } : null;
}
