// Synthetic walks with known ground truth (docs/MOBILITY_MAP_PLAN.md 4.5). Produces raw samples in exactly the
// shape the DB rows have (RawSamples), so they go through the same pipeline as real sessions: unit tests,
// the pathfusion tests and `npm run sim:session` (stored as synthetic sessions for the Lab) all use this.
//
// GPS error = white noise + a LOCATION-BOUND bias field (the same at the same place in every pass, like
// multipath next to a building) + optional outliers / dropouts. Averaging passes removes the first, not the second.
import { CAMPUS_FRAME, fromCampus, type CampusPoint } from '../geo/campus-frame.js';
import type { RawSamples } from '../modules/fusion/fusion.timeline.js';

/** Deterministic PRNG (LCG) + Box-Muller. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

export interface BiasZone { center: CampusPoint; radiusM: number; biasM: CampusPoint }

export interface GpsModel {
  intervalS: number;
  /** independent per-fix noise (1 sigma per axis) */
  sigmaM: number;
  /** reported horizontalAccuracy; default ≈ 1.5 x total error */
  accuracyM?: number;
  /** time-correlated noise (Gauss-Markov), independent per pass */
  correlatedSigmaM: number;
  correlatedTauS: number;
  /** location-bound bias: shared by every pass through the zone (multipath) */
  zones: BiasZone[];
  outlierRate: number;
  outlierM: number;
  /** [startS, endS) without fixes, seconds from the walk start */
  dropouts: [number, number][];
}

export const DEFAULT_GPS: GpsModel = { intervalS: 1, sigmaM: 4, correlatedSigmaM: 3, correlatedTauS: 30, zones: [], outlierRate: 0, outlierM: 40, dropouts: [] };

export interface WalkOptions {
  /** waypoints in the campus frame (m) */
  path: CampusPoint[];
  startMs: number;
  seed: number;
  speedMps?: number; // walking speed (2 steps/s, stride = speed / 2)
  /** device yaw frame offset: walking direction = -yaw + theta (rad) */
  thetaRad?: number;
  /** standing still before / after walking, s */
  pauseStartS?: number;
  pauseEndS?: number;
  gps?: Partial<GpsModel>;
  /** ground orthometric height (flat), phone 1 m above it */
  groundH?: number;
  /** ground orthometric height at a campus point (e.g. the DEM); overrides groundH, the barometer follows it */
  groundAt?: (x: number, y: number) => number | null;
}

export interface TruthPoint { t: number; x: number; y: number; z: number }
export interface SyntheticWalk { raw: RawSamples; truth: TruthPoint[]; startedAt: Date; endedAt: Date }

/** Point at distance s along a polyline and the segment heading (rad, clockwise from North). */
export function along(path: CampusPoint[], s: number): { x: number; y: number; heading: number } {
  let rest = Math.max(0, s);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const heading = Math.atan2(b.x - a.x, b.y - a.y);
    if (rest <= len || i === path.length - 1) {
      const f = len > 0 ? Math.min(rest / len, 1) : 0;
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y), heading };
    }
    rest -= len;
  }
  return { ...path[0], heading: 0 };
}

export const pathLength = (path: CampusPoint[]) => path.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

export function zoneBias(zones: BiasZone[], x: number, y: number): CampusPoint {
  let bx = 0, by = 0;
  for (const z of zones) {
    const w = Math.exp(-((x - z.center.x) ** 2 + (y - z.center.y) ** 2) / (2 * z.radiusM ** 2));
    bx += w * z.biasM.x;
    by += w * z.biasM.y;
  }
  return { x: bx, y: by };
}

/**
 * One walk along `path`: 50 Hz motion (2 steps/s), CMPedometer every 2.5 s (cumulative), 1 Hz barometer,
 * GPS per the model. Sequences start at 1 per sensor like the iPhone's.
 */
export function syntheticWalk(o: WalkOptions): SyntheticWalk {
  const r = rng(o.seed);
  const g: GpsModel = { ...DEFAULT_GPS, ...o.gps };
  const speed = o.speedMps ?? 1.4;
  const theta = o.thetaRad ?? 1.0;
  const pauseStart = o.pauseStartS ?? 5;
  const pauseEnd = o.pauseEndS ?? 5;
  const len = pathLength(o.path);
  const walkS = len / speed;
  const total = pauseStart + walkS + pauseEnd;
  const flat = o.groundH ?? 133;
  const groundAt = (x: number, y: number) => o.groundAt?.(x, y) ?? flat;
  const h0 = groundAt(o.path[0].x, o.path[0].y);
  const dt = 0.02;
  const raw: RawSamples = { locations: [], motion: [], altimeter: [], pedometer: [] };
  const truth: TruthPoint[] = [];
  let seqM = 0, seqA = 0, seqL = 0;
  let steps = 0, dist = 0, lastStep = -1;
  let cx = 0, cy = 0; // correlated GPS noise
  const iso = (t: number) => new Date(o.startMs + Math.round(t * 1000)).toISOString();
  for (let i = 0; i * dt <= total; i++) {
    const t = i * dt;
    const walking = t >= pauseStart && t < pauseStart + walkS;
    const s = Math.min(Math.max(t - pauseStart, 0) * speed, len);
    const p = along(o.path, s);
    // motion: walking direction = -yaw + theta; vertical accel peaks at 2 Hz while walking
    const az = walking ? 0.2 * Math.sin(2 * Math.PI * 2 * (t - pauseStart)) + 0.01 * r.n() : 0.004 * r.n();
    raw.motion.push({ sequence: ++seqM, timestamp: iso(t), yaw: -(p.heading - theta), ax: 0.005 * r.n(), ay: 0.005 * r.n(), az, gx: 0, gy: 0, gz: -1, roll: 0, pitch: 0 });
    if (walking && Math.floor((t - pauseStart) * 2) !== lastStep) {
      lastStep = Math.floor((t - pauseStart) * 2);
      steps++;
      dist += speed / 2;
    }
    const ground = groundAt(p.x, p.y);
    if (i % 10 === 0) truth.push({ t: o.startMs + Math.round(t * 1000), x: p.x, y: p.y, z: ground + 1 });
    if (i % 125 === 0) raw.pedometer.push({ timestamp: iso(t), numberOfSteps: steps, distance: dist });
    if (i % 50 === 25) raw.altimeter.push({ sequence: ++seqA, timestamp: iso(t), relativeAltitude: ground - h0 + 0.02 * r.n() });
    const every = Math.max(1, Math.round(g.intervalS / dt));
    if (i % every === 0) {
      const a = Math.exp(-g.intervalS / g.correlatedTauS);
      cx = a * cx + Math.sqrt(1 - a * a) * g.correlatedSigmaM * r.n();
      cy = a * cy + Math.sqrt(1 - a * a) * g.correlatedSigmaM * r.n();
      if (g.dropouts.some(([s0, s1]) => t >= s0 && t < s1)) continue;
      const b = zoneBias(g.zones, p.x, p.y);
      let ex = b.x + cx + g.sigmaM * r.n();
      let ey = b.y + cy + g.sigmaM * r.n();
      const outlier = r.u() < g.outlierRate;
      if (outlier) {
        const ang = 2 * Math.PI * r.u();
        ex += g.outlierM * Math.sin(ang);
        ey += g.outlierM * Math.cos(ang);
      }
      const ll = fromCampus(p.x + ex, p.y + ey);
      const acc = g.accuracyM ?? Math.round(1.5 * Math.hypot(g.sigmaM, g.correlatedSigmaM) * 10) / 10;
      raw.locations.push({
        sequence: ++seqL, timestamp: iso(t), latitude: ll.latitude, longitude: ll.longitude,
        altitude: ground + 1 + 8 * r.n(), ellipsoidalAltitude: ground + 1 + CAMPUS_FRAME.geoidN + 8 * r.n(),
        horizontalAccuracy: acc, verticalAccuracy: 10, speed: walking ? speed : 0, course: walking ? ((p.heading * 180) / Math.PI + 360) % 360 : -1,
      });
    }
  }
  return { raw, truth, startedAt: new Date(o.startMs), endedAt: new Date(o.startMs + Math.round(total * 1000)) };
}

/** Concatenates walks (e.g. A→B then B→A) into one session's raw samples; later walks must start after earlier ones. */
export function concatWalks(walks: SyntheticWalk[]): SyntheticWalk {
  const raw: RawSamples = { locations: [], motion: [], altimeter: [], pedometer: [] };
  let seqM = 0, seqA = 0, seqL = 0, steps = 0, dist = 0, zBase = 0;
  for (const w of walks) {
    for (const m of w.raw.motion) raw.motion.push({ ...m, sequence: ++seqM });
    for (const a of w.raw.altimeter) raw.altimeter.push({ ...a, sequence: ++seqA, relativeAltitude: (a.relativeAltitude ?? 0) + zBase });
    for (const l of w.raw.locations) raw.locations.push({ ...l, sequence: ++seqL });
    const last = w.raw.pedometer.at(-1);
    for (const p of w.raw.pedometer) raw.pedometer.push({ ...p, numberOfSteps: (p.numberOfSteps ?? 0) + steps, distance: (p.distance ?? 0) + dist });
    steps += last?.numberOfSteps ?? 0;
    dist += last?.distance ?? 0;
    // the next walk's barometer continues from where this one ended (truth heights carry the absolute levels)
    if (w.truth.length) zBase += w.truth.at(-1)!.z - w.truth[0].z;
  }
  return { raw, truth: walks.flatMap((w) => w.truth), startedAt: walks[0].startedAt, endedAt: walks.at(-1)!.endedAt };
}

/** Reversed polyline (B→A). */
export const reversed = (path: CampusPoint[]) => [...path].reverse();
