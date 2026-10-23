// Declared route (사용자 지정 길): before Start the collector says which way they will walk — ordered network nodes
// (start, via points, end) and how each leg is walked (on foot, stairs up/down, elevator n→m). It is stored with the
// session as ground truth and drawn on the road graph here: the shortest path through the points, leg by leg.
import { z } from 'zod';
import { Uuid } from '../../common/dto.js';
import { checkReachability, type ReachNode, type ReachRoad, type TravelMode } from '../editor-mcp/reachability.js';
import { FLOOR_NAME } from '../markers/marker-anchor.js';

const FloorName = z.string().trim().toUpperCase().regex(FLOOR_NAME, 'floor must look like 1F, 12F or B1');

/** How one leg (nodeKeys[i] → nodeKeys[i + 1]) is walked. */
export const DeclaredSegment = z.object({
  mode: z.enum(['walk', 'stairs', 'elevator']).default('walk'),
  /** stairs: up or down */
  direction: z.enum(['up', 'down']).nullish(),
  fromFloor: FloorName.nullish(),
  toFloor: FloorName.nullish(),
}).superRefine((s, ctx) => {
  if (s.mode === 'stairs' && !s.direction) ctx.addIssue({ code: 'custom', message: 'stairs need direction up or down', path: ['direction'] });
  if (s.mode === 'elevator' && (!s.fromFloor || !s.toFloor)) ctx.addIssue({ code: 'custom', message: 'elevator needs fromFloor and toFloor', path: ['fromFloor'] });
});
export type DeclaredSegment = z.infer<typeof DeclaredSegment>;

/** `declaredRoute` on session:start. segments[i] is the leg from nodeKeys[i] to nodeKeys[i + 1]; missing legs are walked. */
export const DeclaredRoute = z.object({
  nodeKeys: z.array(Uuid).min(2).max(50),
  segments: z.array(DeclaredSegment).max(49).default([]),
  /** the collector's own words or the app's summary ("본관 1F 정문 → 계단 상행 → 3F 복도") */
  text: z.string().trim().max(500).nullish(),
}).refine((r) => r.segments.length <= r.nodeKeys.length - 1, { message: 'segments must not outnumber the legs (nodeKeys.length - 1)', path: ['segments'] })
  .transform((r) => ({ ...r, segments: r.nodeKeys.slice(1).map((_, i) => r.segments[i] ?? { mode: 'walk' as const }), text: r.text ?? null }));
export type DeclaredRoute = z.infer<typeof DeclaredRoute>;

/** Raw data must never be lost over a bad route: an invalid one is dropped (null) with the reason, the session starts anyway. */
export function evaluateDeclaredRoute(input: unknown): { route: DeclaredRoute | null; status: 'NONE' | 'ACCEPTED' | 'REJECTED'; reason: string | null } {
  if (input === undefined || input === null) return { route: null, status: 'NONE', reason: null };
  const parsed = DeclaredRoute.safeParse(input);
  if (parsed.success) return { route: parsed.data, status: 'ACCEPTED', reason: null };
  const issue = parsed.error.issues[0];
  return { route: null, status: 'REJECTED', reason: `${issue.path.join('.') || 'declaredRoute'}: ${issue.message}`.slice(0, 200) };
}

export interface PathRoad extends ReachRoad { coordinates: (readonly number[])[] }

const STRUCTURE_OF: Record<DeclaredSegment['mode'], string | null> = { walk: null, stairs: 'stairs', elevator: 'elevator' };

/**
 * The declared path on the graph: each leg is the shortest path between its two nodes (reachability.ts), then the legs
 * are joined. A leg declared as stairs or elevator should use a road of that structure; when it does not, a warning says
 * so (the graph or the declaration is wrong — never silently changed). Coordinates follow the walking direction.
 */
export function declaredPath(roads: PathRoad[], nodes: ReachNode[], route: Pick<DeclaredRoute, 'nodeKeys' | 'segments'>, mode: TravelMode = 'pedestrian', assumeUnknownAllowed = true) {
  const byId = new Map(roads.map((r) => [r.id, r]));
  const height = new Map(nodes.map((n) => [n.id, n.coordinate[2]]));
  const known = new Set(height.keys());
  const legs = route.nodeKeys.slice(1).map((toNodeId, i) => {
    const fromNodeId = route.nodeKeys[i];
    const segment = route.segments[i] ?? { mode: 'walk' as const };
    const missing = [fromNodeId, toNodeId].filter((id) => !known.has(id));
    if (missing.length) return { index: i, fromNodeId, toNodeId, segment, reachable: false as const, reason: 'NODE_NOT_IN_NETWORK', missingNodes: missing, warnings: [] as string[] };
    if (fromNodeId === toNodeId) return { index: i, fromNodeId, toNodeId, segment, reachable: true as const, lengthM: 0, roads: [], coordinates: [] as number[][], warnings: ['SAME_NODE'] };
    const result = checkReachability(roads, nodes, fromNodeId, toNodeId, mode, assumeUnknownAllowed);
    if (!result.reachable) return { index: i, fromNodeId, toNodeId, segment, reachable: false as const, reason: 'NOT_CONNECTED', closestReached: result.closestReached, warnings: [] as string[] };
    // Walk the roads from the leg's start so every road's coordinates point the way the collector walks.
    let at = fromNodeId;
    const coordinates: number[][] = [];
    const used = result.roads.map(({ roadId }) => {
      const road = byId.get(roadId)!;
      const forward = road.fromNodeId === at;
      // open-area links are flat and 2D: they take the height of the node they leave from
      const points = (forward ? road.coordinates : [...road.coordinates].reverse()).map((p) => (p.length >= 3 ? [...p] : [p[0], p[1], height.get(at)!]));
      coordinates.push(...(coordinates.length ? points.slice(1) : points));
      at = forward ? road.toNodeId : road.fromNodeId;
      return { roadId, name: road.name, structure: road.structure, lengthM: Math.round(road.lengthM * 100) / 100 };
    });
    const warnings: string[] = [];
    const wanted = STRUCTURE_OF[segment.mode];
    if (wanted && !used.some((r) => r.structure === wanted)) warnings.push(`DECLARED_${segment.mode.toUpperCase()}_NOT_ON_PATH`);
    if (!wanted && used.some((r) => r.structure === 'elevator')) warnings.push('UNDECLARED_ELEVATOR_ON_PATH');
    return { index: i, fromNodeId, toNodeId, segment, reachable: true as const, lengthM: Math.round(result.lengthM * 100) / 100, roads: used, coordinates, warnings };
  });
  const coordinates: number[][] = [];
  for (const leg of legs) if (leg.reachable) coordinates.push(...(coordinates.length ? leg.coordinates.slice(1) : leg.coordinates));
  const reachable = legs.every((l) => l.reachable);
  return {
    reachable,
    lengthM: reachable ? Math.round(legs.reduce((s, l) => s + (l.reachable ? l.lengthM : 0), 0) * 100) / 100 : null,
    legs,
    /** EPSG:5186 [x, y, z] of the whole path (reachable legs only) */
    coordinates,
  };
}
