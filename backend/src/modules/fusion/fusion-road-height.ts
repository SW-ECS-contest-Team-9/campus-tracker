import type { StartHeightRoad } from '../../geo/start-height-map.js';
import type { FusionConfigV4 } from './fusion.config.js';

export interface RoadHeightContact { t: number; offset: number; variance: number; roadId: string }
export interface RoadHeightPoint { t: number; x: number; y: number; z: number; sigmaXY: number; headingRad: number }
interface Projection { road: StartHeightRoad; distance: number; height: number; measure: number; heading: number; slope: number }
export interface RoadHeightTracker {
  run?: { roadId: string; direction: number; firstT: number; lastT: number; firstMeasure: number; lastMeasure: number;
    samples: { t: number; offset: number }[]; lastEmitT?: number };
}

function project(road: StartHeightRoad, x: number, y: number): Projection | null {
  let best: Projection | null = null;
  let measure = 0;
  for (let i = 1; i < road.coordinates.length; i++) {
    const a = road.coordinates[i - 1], b = road.coordinates[i];
    if (![...a, ...b].every(Number.isFinite)) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < 1e-4) continue;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length * length)));
    const distance = Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy);
    if (!best || distance < best.distance) best = { road, distance, height: a[2] + u * (b[2] - a[2]),
      measure: measure + u * length, heading: Math.atan2(dx, dy), slope: Math.abs(b[2] - a[2]) / length };
    measure += length;
  }
  return best;
}

const angle = (r: number) => Math.atan2(Math.sin(r), Math.cos(r));
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2; };

/** A sequence of real walking steps must follow one unique road in XY, heading, and barometric shape.
 * This only observes the Z zero; it never snaps XY to the road used to judge the match.
 */
export function roadHeightContact(tracker: RoadHeightTracker, roads: StartHeightRoad[], p: RoadHeightPoint | null,
  c: FusionConfigV4, heightReference: { heightM: number; sigma: number } | null = null): RoadHeightContact | null {
  const reset = () => { tracker.run = undefined; return null; };
  if (!c.roadHeightAnchorsEnabled || !p || !Object.values(p).every(Number.isFinite)
    || p.sigmaXY > c.roadHeightAnchorMaxPositionSigmaM) return reset();
  let matches = roads.flatMap((road) => {
    if (road.status !== 'APPROVED' && !(c.roadHeightAnchorIncludeDrafts && road.status === 'DRAFT')) return [];
    if (c.roadHeightAnchorLevelId && road.levelId !== c.roadHeightAnchorLevelId) return [];
    const hit = project(road, p.x, p.y);
    if (!hit || hit.distance > c.roadHeightAnchorRadiusM) return [];
    const error = Math.min(Math.abs(angle(p.headingRad - hit.heading)), Math.abs(angle(p.headingRad - hit.heading - Math.PI)));
    return error <= c.roadHeightAnchorMaxHeadingDeg * Math.PI / 180 ? [hit] : [];
  });
  if (!matches.length) return reset();
  const heights = matches.map((m) => m.height);
  if (Math.max(...heights) - Math.min(...heights) > c.startHeightAmbiguityM) {
    if (!heightReference || heightReference.sigma > c.startHeightGpsMaxSigmaM) return reset();
    matches.sort((a, b) => Math.abs(a.height + c.phoneHeightM - heightReference.heightM) - Math.abs(b.height + c.phoneHeightM - heightReference.heightM));
    const best = matches[0];
    const error = Math.abs(best.height + c.phoneHeightM - heightReference.heightM);
    if (error > heightReference.sigma || matches.some((m) => Math.abs(m.height - best.height) > c.startHeightAmbiguityM
      && Math.abs(m.height + c.phoneHeightM - heightReference.heightM) - error <= 2 * heightReference.sigma)) return reset();
    matches = matches.filter((m) => Math.abs(m.height - best.height) <= c.startHeightAmbiguityM);
  }
  // Preserve identity while following a road; choosing the nearest afresh would flicker at junctions.
  const hit = matches.find((m) => m.road.id === tracker.run?.roadId) ?? matches.sort((a, b) => a.distance - b.distance || a.road.id.localeCompare(b.road.id))[0];
  const direction = Math.cos(p.headingRad - hit.heading) >= 0 ? 1 : -1;
  const prior = tracker.run;
  const dt = prior ? p.t - prior.lastT : 0;
  if (!prior || prior.roadId !== hit.road.id || prior.direction !== direction || dt <= 0 || dt > c.roadHeightAnchorMaxGapMs
    || direction * (hit.measure - prior.lastMeasure) < -0.75
    || Math.abs(hit.measure - prior.lastMeasure) > c.roadHeightAnchorMaxSpeedMps * dt / 1000 + 0.5) {
    tracker.run = { roadId: hit.road.id, direction, firstT: p.t, lastT: p.t, firstMeasure: hit.measure, lastMeasure: hit.measure, samples: [] };
  }
  const run = tracker.run!;
  const offset = hit.height + c.phoneHeightM - p.z;
  // Different vertical shapes (e.g. stairs beside a flat road) cannot establish the same offset.
  const offsets = [...run.samples.map((s) => s.offset), offset];
  if (Math.max(...offsets) - Math.min(...offsets) > c.roadHeightAnchorMaxBaroResidualM) return reset();
  run.lastT = p.t;
  run.lastMeasure = hit.measure;
  run.samples.push({ t: p.t, offset });
  if (run.samples.length > 120) run.samples.shift();
  if (p.t - run.firstT < c.roadHeightAnchorMinSpanMs || direction * (hit.measure - run.firstMeasure) < c.roadHeightAnchorMinTravelM
    || run.samples.length < c.roadHeightAnchorMinSamples || (run.lastEmitT !== undefined && p.t - run.lastEmitT < c.roadHeightAnchorIntervalMs)) return null;
  run.lastEmitT = p.t;
  return { t: p.t, roadId: hit.road.id, offset: median(run.samples.map((s) => s.offset)),
    variance: c.roadHeightAnchorSigmaM ** 2 + (p.sigmaXY * hit.slope) ** 2 + c.phoneHeightSigmaM ** 2 };
}
