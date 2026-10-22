import type { FusionConfigV4 } from './fusion.config.js';
import type { StepV4 } from './fusion-state-v4.js';
import type { SmootherEvent, Vec3 } from './fusion-v4.smoother.js';

export interface CircularAxis { buildingId: string; x: number; y: number; footprintRadiusM: number }
export interface CircularRun { from: number; to: number; steps: number; turnDeg: number; inferredRadiusM: number }
export interface CircularSummary {
  reason: 'DISABLED' | 'AXIS_UNAVAILABLE' | 'NO_CONFIRMED_LOOP' | 'APPLIED';
  axis: CircularAxis | null; radiusM: number | null; anchors: number; runs: CircularRun[];
}

/** Fit the actual circular footprint, not its bounding box. Coordinates stay in EPSG:5186.
 * An irregular or rectangular building does not supply an automatic elevator-axis prior.
 */
export function circularFootprintAxis(buildingId: string, ring: [number, number][]): CircularAxis | null {
  const points = ring.filter((p, i) => p.every(Number.isFinite) && (!i || p[0] !== ring[0][0] || p[1] !== ring[0][1]));
  if (points.length < 8) return null;
  const ox = points.reduce((s, p) => s + p[0], 0) / points.length, oy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const a = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points) {
    const x = p[0] - ox, y = p[1] - oy, row = [x, y, 1], b = -(x * x + y * y);
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) a[i][j] += row[i] * row[j]; a[i][3] += row[i] * b; }
  }
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const d = a[i][i]; if (Math.abs(d) < 1e-8) return null;
    for (let j = i; j < 4; j++) a[i][j] /= d;
    for (let k = 0; k < 3; k++) if (k !== i) { const f = a[k][i]; for (let j = i; j < 4; j++) a[k][j] -= f * a[i][j]; }
  }
  const x = ox - a[0][3] / 2, y = oy - a[1][3] / 2;
  const distances = points.map((p) => Math.hypot(p[0] - x, p[1] - y));
  const radius = distances.reduce((a, b) => a + b, 0) / distances.length;
  const residual = Math.sqrt(distances.reduce((s, d) => s + (d - radius) ** 2, 0) / distances.length);
  if (!(radius >= 2) || residual / radius > 0.08) return null;
  return { buildingId, x, y, footprintRadiusM: radius };
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2; };
const angle = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));

/** Replay-only prior for a user-selected circular hallway. Flat barometric plateaus and a mostly
 * one-direction turn establish loops. Stairs, elevator motion, straight walks and unknown yaw segments do not.
 * Radius comes from walked arc length / accumulated turn; GPS does not decide each floor's centre.
 */
export function circularCorridorAnchors(steps: StepV4[], headings: { theta: number | null }[],
  points: { t: number; x: Vec3 }[], axis: CircularAxis | null, originXY: { x: number; y: number },
  firstIndex: number, c: FusionConfigV4): { anchors: SmootherEvent[]; summary: CircularSummary } {
  const summary: CircularSummary = { reason: c.circularCorridorEnabled ? 'AXIS_UNAVAILABLE' : 'DISABLED', axis, radiusM: null, anchors: 0, runs: [] };
  if (!c.circularCorridorEnabled || !axis) return { anchors: [], summary };
  const centre = { x: axis.x - originXY.x, y: axis.y - originXY.y };
  const at = new Map<number, Vec3>(); for (const p of points) at.set(p.t, p.x);
  const groups: StepV4[][] = [];
  let group: StepV4[] = [];
  const flush = () => { if (group.length) groups.push(group); group = []; };
  for (const p of steps) {
    const xy = at.get(p.t);
    if (p.z === undefined || p.stairs || p.slope || p.verticalUnknown || headings[p.segment]?.theta == null
      || !xy || Math.hypot(xy[0] - centre.x, xy[1] - centre.y) > c.circularCorridorMaxCentreOffsetM) { flush(); continue; }
    const last = group.at(-1);
    if (last && (p.segment !== last.segment || p.t - last.t > c.circularCorridorMaxStepGapMs
      || Math.abs(p.z - group[0].z!) > c.circularCorridorMaxHeightRangeM)) flush();
    group.push(p);
  }
  flush();
  const loops = groups.flatMap((run) => {
    if (run.length < c.circularCorridorMinSteps) return [];
    const changes = run.slice(1).map((p, i) => angle(p.rel - run[i].rel));
    if (changes.some((v) => Math.abs(v) > 2 * Math.PI / 3)) return [];
    const turn = changes.reduce((s, v) => s + v, 0), total = changes.reduce((s, v) => s + Math.abs(v), 0);
    if (Math.abs(turn) < c.circularCorridorMinTurnDeg * Math.PI / 180 || Math.abs(turn) / Math.max(total, 1e-6) < c.circularCorridorMinTurnPurity) return [];
    const radius = run.slice(1).reduce((s, p) => s + p.length, 0) / Math.abs(turn);
    if (radius < c.circularCorridorMinRadiusM || radius > c.circularCorridorMaxRadiusM) return [];
    return [{ run, turn, radius }];
  });
  summary.reason = 'NO_CONFIRMED_LOOP';
  if (!loops.length) return { anchors: [], summary };
  const radius = c.circularCorridorRadiusM > 0 ? c.circularCorridorRadiusM : median(loops.map((p) => p.radius));
  if (radius < c.circularCorridorMinRadiusM || radius > c.circularCorridorMaxRadiusM) return { anchors: [], summary };
  const anchors: SmootherEvent[] = [];
  for (const { run, turn, radius: measured } of loops) {
    if (Math.abs(measured - radius) > Math.max(1.5, radius * 0.35)) continue;
    summary.runs.push({ from: run[0].t, to: run.at(-1)!.t, steps: run.length, turnDeg: turn * 180 / Math.PI, inferredRadiusM: measured });
    let lastT = -Infinity;
    for (const p of run) {
      if (p.t - lastT < c.circularCorridorAnchorIntervalMs) continue;
      lastT = p.t;
      const h = p.rel + headings[p.segment].theta!;
      const direction = Math.sign(turn);
      anchors.push({ kind: 'fix', t: p.t, index: firstIndex + anchors.length,
        x: centre.x - direction * radius * Math.cos(h), y: centre.y + direction * radius * Math.sin(h),
        sigma: c.circularCorridorAnchorSigmaM, vehicle: false });
    }
  }
  summary.radiusM = radius;
  summary.anchors = anchors.length;
  if (anchors.length) summary.reason = 'APPLIED';
  return { anchors, summary };
}
