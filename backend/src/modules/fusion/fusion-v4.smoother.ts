// fusion-v4 building blocks (pure): 3x3 Kalman algebra, heading-offset fit, forward filter + RTS smoother.
// State vector: [x (East m), y (North m), theta (rad)]; walking direction = rel + theta, rel = -CMAttitude.yaw.
import type { FusionConfigV4 } from './fusion.config.js';

export type Vec3 = [number, number, number];
export type Mat3 = number[]; // row-major 3x3

export const I3 = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const diag3 = (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return r;
}
export const tr3 = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const add3 = (a: Mat3, b: Mat3): Mat3 => a.map((v, i) => v + b[i]);
export const sub3 = (a: Mat3, b: Mat3): Mat3 => a.map((v, i) => v - b[i]);
export function inv3(a: Mat3): Mat3 {
  const [p, q, r, s, t, u, v, w, x] = a;
  const c0 = t * x - u * w, c1 = -(s * x - u * v), c2 = s * w - t * v;
  const det = p * c0 + q * c1 + r * c2;
  const d = 1 / det;
  return [c0 * d, -(q * x - r * w) * d, (q * u - r * t) * d, c1 * d, (p * x - r * v) * d, -(p * u - r * s) * d, c2 * d, -(p * w - q * v) * d, (p * t - q * s) * d];
}
export const mulv3 = (a: Mat3, v: Vec3): Vec3 => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];
const sym = (a: Mat3): Mat3 => [a[0], (a[1] + a[3]) / 2, (a[2] + a[6]) / 2, (a[1] + a[3]) / 2, a[4], (a[5] + a[7]) / 2, (a[2] + a[6]) / 2, (a[5] + a[7]) / 2, a[8]];
export const sigmaXY = (P: Mat3) => Math.sqrt(Math.max(0, (P[0] + P[4]) / 2));

export interface Prediction { x: Vec3; F: Mat3; Q: Mat3 }

/** One step of length L along rel + theta (heading known). */
export function predictStep(x: Vec3, L: number, rel: number, sigmaFraction: number, headingRw: number): Prediction {
  const h = rel + x[2];
  const s = Math.sin(h);
  const c = Math.cos(h);
  const sa2 = (sigmaFraction * L) ** 2;
  return {
    x: [x[0] + L * s, x[1] + L * c, x[2]],
    F: [1, 0, L * c, 0, 1, -L * s, 0, 0, 1],
    Q: [sa2 * s * s, sa2 * s * c, 0, sa2 * s * c, sa2 * c * c, 0, 0, 0, headingRw * headingRw],
  };
}

/** A step (or walked distance) in an unknown direction: position stays, its uncertainty grows by L. */
export function predictUnheaded(x: Vec3, P: Mat3, L: number): Prediction {
  const add = (2 * sigmaXY(P) + L) * L;
  return { x: [...x], F: I3(), Q: diag3(add, add, 0) };
}

export const predictTime = (x: Vec3, varAdd: number): Prediction => ({ x: [...x], F: I3(), Q: diag3(varAdd, varAdd, 0) });

/** New heading segment: theta is replaced by the segment's estimate (prior), position carries over. */
export const predictThetaReset = (x: Vec3, theta: number, thetaVar: number): Prediction => ({
  x: [x[0], x[1], theta],
  F: [1, 0, 0, 0, 1, 0, 0, 0, 0],
  Q: diag3(0, 0, thetaVar),
});

export function applyPrediction(P: Mat3, p: Prediction): Mat3 {
  return sym(add3(mul3(mul3(p.F, P), tr3(p.F)), p.Q));
}

/** Position measurement (x, y) with isotropic variance r. Returns the squared Mahalanobis distance too. */
export function gpsUpdate(x: Vec3, P: Mat3, zx: number, zy: number, r: number): { x: Vec3; P: Mat3; d2: number } {
  const nx = zx - x[0];
  const ny = zy - x[1];
  const s00 = P[0] + r, s01 = P[1], s10 = P[3], s11 = P[4] + r;
  const det = s00 * s11 - s01 * s10;
  const i00 = s11 / det, i01 = -s01 / det, i10 = -s10 / det, i11 = s00 / det;
  const d2 = nx * (i00 * nx + i01 * ny) + ny * (i10 * nx + i11 * ny);
  // K = P[:,0:2] * Sinv  (3x2)
  const K: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = P[3 * i], b = P[3 * i + 1];
    K.push(a * i00 + b * i10, a * i01 + b * i11);
  }
  const xn: Vec3 = [x[0] + K[0] * nx + K[1] * ny, x[1] + K[2] * nx + K[3] * ny, x[2] + K[4] * nx + K[5] * ny];
  // P - K * P[0:2, :]
  const Pn = P.slice();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Pn[3 * i + j] -= K[2 * i] * P[j] + K[2 * i + 1] * P[3 + j];
  return { x: xn, P: sym(Pn), d2 };
}

export function floorPosition(P: Mat3, floorM: number): Mat3 {
  const f = floorM * floorM;
  const q = P.slice();
  if (q[0] < f) q[0] = f;
  if (q[4] < f) q[4] = f;
  return q;
}

// ---------------------------------------------------------------------------------------------
// Heading offset from the walked shape vs GPS fixes
// ---------------------------------------------------------------------------------------------

export interface FitStep { t: number; rel: number; length: number }
export interface FitFix { t: number; x: number; y: number; sigma: number }
export interface HeadingFit { theta: number; sigma: number; tx: number; ty: number; endX: number; endY: number; medianResidual: number; fixes: number; extent: number }

/**
 * Grid search over theta: the step polyline (shape known up to rotation) is rotated and translated onto the
 * fixes with a robust (Cauchy) cost, so a few bad indoor fixes cannot pull it. Returns null when the walk is
 * too short / straight-line evidence too weak, or when two clearly different headings fit about equally well.
 */
export function fitHeading(steps: FitStep[], fixes: FitFix[], c: FusionConfigV4): HeadingFit | null {
  if (steps.length < c.headingFitMinSteps || fixes.length < c.headingFitMinFixes) return null;
  // shape in the "rel" frame
  const ux = [0];
  const uy = [0];
  for (const s of steps) {
    ux.push(ux.at(-1)! + s.length * Math.sin(s.rel));
    uy.push(uy.at(-1)! + s.length * Math.cos(s.rel));
  }
  const at = (t: number) => {
    let lo = 0, hi = steps.length; // number of steps with time <= t
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const idx = fixes.map((f) => at(f.t));
  const fx = idx.map((i) => ux[i]);
  const fy = idx.map((i) => uy[i]);
  const cx = fx.reduce((a, b) => a + b, 0) / fx.length;
  const cy = fy.reduce((a, b) => a + b, 0) / fy.length;
  const extent = Math.max(...fx.map((x, i) => Math.hypot(x - cx, fy[i] - cy)));
  if (extent < c.headingFitMinExtentM) return null;

  const evaluate = (theta: number) => {
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const px = fx.map((x, i) => x * cs + fy[i] * sn);
    const py = fx.map((x, i) => -x * sn + fy[i] * cs);
    let tx = 0, ty = 0, wsum = 0;
    for (let i = 0; i < fixes.length; i++) {
      const w = 1 / fixes[i].sigma ** 2;
      tx += w * (fixes[i].x - px[i]); ty += w * (fixes[i].y - py[i]); wsum += w;
    }
    tx /= wsum; ty /= wsum;
    for (let it = 0; it < 4; it++) {
      let ax = 0, ay = 0, ws = 0;
      for (let i = 0; i < fixes.length; i++) {
        const r = Math.hypot(px[i] + tx - fixes[i].x, py[i] + ty - fixes[i].y) / fixes[i].sigma;
        const w = 1 / (1 + r * r) / fixes[i].sigma ** 2;
        ax += w * (fixes[i].x - px[i]); ay += w * (fixes[i].y - py[i]); ws += w;
      }
      tx = ax / ws; ty = ay / ws;
    }
    let cost = 0;
    const res: number[] = [];
    for (let i = 0; i < fixes.length; i++) {
      const d = Math.hypot(px[i] + tx - fixes[i].x, py[i] + ty - fixes[i].y);
      res.push(d);
      cost += Math.log(1 + (d / fixes[i].sigma) ** 2);
    }
    return { cost, tx, ty, res };
  };

  const step = (c.headingFitGridDeg * Math.PI) / 180;
  const n = Math.round((2 * Math.PI) / step);
  const costs: number[] = [];
  let best = 0;
  for (let k = 0; k < n; k++) {
    costs.push(evaluate(k * step).cost);
    if (costs[k] < costs[best]) best = k;
  }
  const amb = Math.round(c.headingFitAmbiguityDeg / c.headingFitGridDeg);
  let alt = Infinity;
  for (let k = 0; k < n; k++) {
    const d = Math.min(Math.abs(k - best), n - Math.abs(k - best));
    if (d >= amb) alt = Math.min(alt, costs[k]);
  }
  if (alt - costs[best] < c.headingFitMinCostGap) return null;
  // curvature => 1-sigma (cost ~ chi^2 near the minimum)
  const c0 = costs[best], cp = costs[(best + 1) % n], cm = costs[(best - 1 + n) % n];
  const d2 = Math.max(cp + cm - 2 * c0, 1e-6);
  const sigma = Math.min(Math.max(1.5 * step * Math.sqrt(2 / d2), (3 * Math.PI) / 180), (30 * Math.PI) / 180);
  const theta = best * step;
  const e = evaluate(theta);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const sorted = [...e.res].sort((a, b) => a - b);
  return {
    theta, sigma, tx: e.tx, ty: e.ty,
    endX: ux.at(-1)! * cs + uy.at(-1)! * sn + e.tx,
    endY: -ux.at(-1)! * sn + uy.at(-1)! * cs + e.ty,
    medianResidual: sorted[Math.floor((sorted.length - 1) / 2)],
    fixes: fixes.length,
    extent,
  };
}

// ---------------------------------------------------------------------------------------------
// Smoother: forward EKF over the recorded events, then Rauch-Tung-Striebel backward pass
// ---------------------------------------------------------------------------------------------

export type SmootherEvent =
  | { kind: 'segment'; t: number; theta: number | null; thetaVar: number }
  | { kind: 'step'; t: number; rel: number; length: number; stairs: boolean }
  | { kind: 'walked'; t: number; distance: number } // pedometer distance while motion was missing
  | { kind: 'fix'; t: number; index: number; x: number; y: number; sigma: number; vehicle: boolean };

export interface SmoothedPoint { t: number; x: Vec3; P: Mat3; event: SmootherEvent }

/**
 * Runs the filter over events sorted by time and smooths it. weights[i] scales fix i's variance (1 / w);
 * w = 0 skips the fix. gate = chi-square gate applied in the forward pass (null = no gate).
 */
export function smoothEvents(events: SmootherEvent[], weights: number[], gate: number | null, c: FusionConfigV4) {
  const n = events.length;
  const xs: Vec3[] = new Array(n);
  const Ps: Mat3[] = new Array(n);
  const xp: Vec3[] = new Array(n);
  const Pp: Mat3[] = new Array(n);
  const Fs: Mat3[] = new Array(n);
  const gated = new Set<number>();
  let x: Vec3 = [0, 0, 0];
  let P = diag3(1e8, 1e8, 1);
  let lastT = events[0]?.t ?? 0;
  let thetaKnown = false;
  let vehicle = false;
  const rw = (c.headingRandomWalkDegPerStep * Math.PI) / 180;
  for (let k = 0; k < n; k++) {
    const e = events[k];
    const dt = Math.max(0, (e.t - lastT) / 1000);
    lastT = e.t;
    // time noise, then the event's own prediction; combined into one transition for RTS
    const qTime = (vehicle ? c.vehicleProcessNoiseM2PerS : c.idleProcessNoiseM2PerS) * dt;
    let pred: Prediction = predictTime(x, qTime);
    let Pk = applyPrediction(P, pred);
    let F = pred.F;
    if (e.kind === 'segment') {
      thetaKnown = e.theta !== null;
      const p2 = predictThetaReset(pred.x, e.theta ?? 0, thetaKnown ? e.thetaVar : 1);
      Pk = applyPrediction(Pk, p2);
      F = mul3(p2.F, F);
      pred = { x: p2.x, F, Q: p2.Q };
    } else if (e.kind === 'step') {
      vehicle = false;
      const p2 = thetaKnown
        ? predictStep(pred.x, e.length, e.rel, e.stairs ? c.stairStrideSigmaFraction : c.strideSigmaFraction, rw)
        : predictUnheaded(pred.x, Pk, e.length);
      Pk = applyPrediction(Pk, p2);
      F = mul3(p2.F, F);
      pred = { x: p2.x, F, Q: p2.Q };
    } else if (e.kind === 'walked') {
      const p2 = predictUnheaded(pred.x, Pk, e.distance);
      Pk = applyPrediction(Pk, p2);
      pred = { x: p2.x, F, Q: p2.Q };
    }
    xp[k] = pred.x;
    Pp[k] = Pk;
    Fs[k] = F;
    let xu = pred.x;
    let Pu = Pk;
    if (e.kind === 'fix') {
      if (e.vehicle) vehicle = true;
      const w = weights[e.index] ?? 1;
      if (w > 0) {
        const u = gpsUpdate(xu, Pu, e.x, e.y, (e.sigma * e.sigma) / w);
        if (gate !== null && u.d2 > gate && Pk[0] < 1e6) gated.add(e.index); // never gate while the position is unknown
        else {
          xu = u.x;
          // the floor keeps biased indoor GPS from making the track overconfident; precise map anchors keep their sigma
          Pu = e.sigma >= c.gpsSigmaFloorM ? floorPosition(u.P, c.positionSigmaFloorM) : u.P;
        }
      }
    }
    xs[k] = xu;
    Ps[k] = Pu;
    x = xu;
    P = Pu;
  }
  // RTS backward pass
  const sx: Vec3[] = new Array(n);
  const sP: Mat3[] = new Array(n);
  if (n) {
    sx[n - 1] = xs[n - 1];
    sP[n - 1] = Ps[n - 1];
  }
  for (let k = n - 2; k >= 0; k--) {
    const C = mul3(mul3(Ps[k], tr3(Fs[k + 1])), inv3(Pp[k + 1]));
    const dx = [sx[k + 1][0] - xp[k + 1][0], sx[k + 1][1] - xp[k + 1][1], sx[k + 1][2] - xp[k + 1][2]] as Vec3;
    const corr = mulv3(C, dx);
    sx[k] = [xs[k][0] + corr[0], xs[k][1] + corr[1], xs[k][2] + corr[2]];
    sP[k] = sym(add3(Ps[k], mul3(mul3(C, sub3(sP[k + 1], Pp[k + 1])), tr3(C))));
  }
  return { points: events.map((event, k): SmoothedPoint => ({ t: event.t, x: sx[k], P: sP[k], event })), gated };
}
