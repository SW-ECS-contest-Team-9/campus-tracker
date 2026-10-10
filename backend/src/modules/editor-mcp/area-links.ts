// Open areas (mobility.open_areas) as walkable space for the network check: an area is one flat floor, so every network
// node standing on it at its height is an access point, and two access points are joined by the shortest walk that stays
// inside the polygon (straight when they see each other, around corners and holes otherwise). The links are built on
// demand and never stored as roads.
import type { ReachNode, ReachRoad } from './reachability.js';

type XY = readonly [number, number];
export interface WalkArea {
  id: number | string; name: string | null; elevationM: number | null; floor: string | null;
  /** rings[0] is the boundary, the rest are holes; closed or open rings, EPSG:5186 */
  rings: (readonly number[])[][];
}
export interface AreaLink extends ReachRoad { areaId: WalkArea['id']; coordinates: [number, number][] }
export const AREA_LINK_DEFAULTS = { heightToleranceM: 0.5, edgeToleranceM: 0.5 };

const EPS = 1e-9;
const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function nearestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

export class Polygon {
  readonly edges: [XY, XY][] = [];
  readonly corners: XY[] = [];
  constructor(rings: (readonly number[])[][]) {
    for (const ring of rings) {
      const pts = ring.map((p) => [p[0], p[1]] as XY);
      if (pts.length > 1 && dist(pts[0], pts.at(-1)!) < EPS) pts.pop();
      if (pts.length < 3) continue;
      pts.forEach((p, i) => this.edges.push([p, pts[(i + 1) % pts.length]]));
      this.corners.push(...pts);
    }
  }
  nearestOnBoundary(p: XY) {
    let best: { point: XY; d: number } = { point: p, d: Infinity };
    for (const [a, b] of this.edges) {
      const q = nearestOnSegment(p, a, b), d = dist(p, q);
      if (d < best.d) best = { point: q, d };
    }
    return best;
  }
  /** Inside or on the boundary; holes are outside (even-odd over all rings). */
  covers(p: XY) {
    if (this.nearestOnBoundary(p).d < 1e-6) return true;
    let inside = false;
    for (const [a, b] of this.edges) {
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
    }
    return inside;
  }
  /** True when the whole segment lies in the area: cut it wherever it meets the boundary and test each piece. */
  sees(p: XY, q: XY) {
    const len = dist(p, q);
    if (len < EPS) return true;
    const cuts = [0, 1];
    for (const [a, b] of this.edges) {
      const d1 = cross(p, q, a), d2 = cross(p, q, b);
      if (Math.abs(d1) < 1e-7 * len && Math.abs(d2) < 1e-7 * len) { // boundary edge along the segment
        for (const c of [a, b]) cuts.push(((c[0] - p[0]) * (q[0] - p[0]) + (c[1] - p[1]) * (q[1] - p[1])) / (len * len));
      } else if ((d1 > 0) !== (d2 > 0) || Math.abs(d1) < 1e-7 * len || Math.abs(d2) < 1e-7 * len) {
        const t = cross(a, b, p) / (cross(a, b, p) - cross(a, b, q));
        if (Number.isFinite(t)) cuts.push(t);
      }
    }
    const ts = cuts.filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] < 1e-9) continue;
      const m = (ts[i] + ts[i - 1]) / 2;
      if (!this.covers([p[0] + m * (q[0] - p[0]), p[1] + m * (q[1] - p[1])])) return false;
    }
    return true;
  }
}

/** Implicit links between the network nodes that stand on each area. Areas without a floor height are skipped. */
export function areaLinks(areas: WalkArea[], nodes: (ReachNode & { levelId?: string | null })[], options: Partial<typeof AREA_LINK_DEFAULTS> = {}): AreaLink[] {
  const o = { ...AREA_LINK_DEFAULTS, ...options };
  const links: AreaLink[] = [];
  for (const area of areas) {
    if (area.elevationM == null) continue;
    const polygon = new Polygon(area.rings);
    const access: { id: string; at: XY }[] = [];
    for (const n of nodes) {
      if (Math.abs(n.coordinate[2] - area.elevationM) > o.heightToleranceM || (area.floor && n.levelId !== area.floor)) continue;
      const p: XY = [n.coordinate[0], n.coordinate[1]];
      if (polygon.covers(p)) { access.push({ id: n.id, at: p }); continue; }
      const edge = polygon.nearestOnBoundary(p);
      if (edge.d <= o.edgeToleranceM) access.push({ id: n.id, at: edge.point });
    }
    if (access.length < 2) continue;
    // visibility graph over the access points and the polygon corners, then the shortest walk from each access point
    const points = [...access.map((a) => a.at), ...polygon.corners];
    const seen: number[][] = points.map(() => []);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      if (polygon.sees(points[i], points[j])) { seen[i].push(j); seen[j].push(i); }
    }
    for (let from = 0; from < access.length; from++) {
      const best = points.map(() => Infinity), via = points.map(() => -1), done = points.map(() => false);
      best[from] = 0;
      while (true) {
        let current = -1;
        for (let i = 0; i < points.length; i++) if (!done[i] && best[i] < Infinity && (current < 0 || best[i] < best[current])) current = i;
        if (current < 0) break;
        done[current] = true;
        for (const next of seen[current]) {
          const d = best[current] + dist(points[current], points[next]);
          if (d < best[next]) { best[next] = d; via[next] = current; }
        }
      }
      for (let to = from + 1; to < access.length; to++) {
        if (best[to] === Infinity) continue;
        const coordinates: [number, number][] = [];
        for (let i = to; i >= 0; i = via[i]) coordinates.unshift([points[i][0], points[i][1]]);
        links.push({
          id: `area:${area.id}:${access[from].id}:${access[to].id}`, areaId: area.id, name: area.name, structure: 'area',
          fromNodeId: access[from].id, toNodeId: access[to].id, lengthM: best[to], coordinates,
          pedestrianAccess: 'allowed', vehicleAccess: 'unknown', wheelchairAccess: 'unknown', pedestrianDirection: 'both', vehicleDirection: 'unknown',
        });
      }
    }
  }
  return links;
}
