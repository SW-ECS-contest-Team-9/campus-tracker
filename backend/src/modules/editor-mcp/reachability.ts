// "Can you get from A to B?" as a network check, not a router (docs/EDITOR_MCP_PLAN.md 13 #8): it answers whether the
// drawn network connects two nodes for one travel mode and, if not, where it stops. Unknown or restricted access does
// not count as passable unless the caller says so.
import type { XYZ } from '../editor/topology.js';

export type TravelMode = 'pedestrian' | 'vehicle' | 'wheelchair';
export interface ReachRoad {
  id: string; name: string | null; structure: string; fromNodeId: string; toNodeId: string; lengthM: number;
  pedestrianAccess: string; vehicleAccess: string; wheelchairAccess: string; pedestrianDirection: string; vehicleDirection: string;
}
export interface ReachNode { id: string; coordinate: XYZ }

/** Why a road cannot be used in a mode, or null when it can. */
export function blockedReason(road: ReachRoad, mode: TravelMode, assumeUnknown: boolean): string | null {
  const ok = (value: string, what: string) => (value === 'allowed' || (assumeUnknown && value === 'unknown') ? null : `${what} is "${value}"`);
  if (mode === 'vehicle') return ok(road.vehicleAccess, 'vehicleAccess');
  const walk = ok(road.pedestrianAccess, 'pedestrianAccess');
  if (walk || mode === 'pedestrian') return walk;
  if (road.structure === 'stairs') return 'stairs';
  return ok(road.wheelchairAccess, 'wheelchairAccess');
}

function directions(road: ReachRoad, mode: TravelMode, assumeUnknown: boolean): { forward: boolean; backward: boolean } {
  const d = mode === 'vehicle' ? road.vehicleDirection : road.pedestrianDirection;
  if (d === 'both' || (d === 'unknown' && assumeUnknown)) return { forward: true, backward: true };
  return { forward: d === 'forward', backward: d === 'backward' };
}

export function checkReachability(roads: ReachRoad[], nodes: ReachNode[], fromNodeId: string, toNodeId: string, mode: TravelMode, assumeUnknown = false) {
  const out = new Map<string, { to: string; road: ReachRoad }[]>();
  const link = (a: string, b: string, road: ReachRoad) => out.set(a, [...(out.get(a) ?? []), { to: b, road }]);
  const blocked: { road: ReachRoad; reason: string }[] = [];
  for (const road of roads) {
    const reason = blockedReason(road, mode, assumeUnknown);
    const dir = directions(road, mode, assumeUnknown);
    if (reason) { blocked.push({ road, reason }); continue; }
    if (!dir.forward && !dir.backward) { blocked.push({ road, reason: `${mode === 'vehicle' ? 'vehicleDirection' : 'pedestrianDirection'} is "unknown"` }); continue; }
    if (dir.forward) link(road.fromNodeId, road.toNodeId, road);
    if (dir.backward) link(road.toNodeId, road.fromNodeId, road);
  }
  // Dijkstra on road length; the network is small, so a linear scan for the next node is enough.
  const dist = new Map<string, number>([[fromNodeId, 0]]);
  const via = new Map<string, { from: string; road: ReachRoad }>();
  const done = new Set<string>();
  while (true) {
    let current: string | null = null;
    for (const [n, d] of dist) if (!done.has(n) && (current === null || d < dist.get(current)!)) current = n;
    if (current === null || current === toNodeId) break;
    done.add(current);
    for (const edge of out.get(current) ?? []) {
      const d = dist.get(current)! + edge.road.lengthM;
      if (d < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, d); via.set(edge.to, { from: current, road: edge.road }); }
    }
  }
  if (dist.has(toNodeId)) {
    const path: ReachRoad[] = [];
    for (let n = toNodeId; via.has(n); n = via.get(n)!.from) path.unshift(via.get(n)!.road);
    return { reachable: true as const, lengthM: dist.get(toNodeId)!, roads: path.map((r) => ({ roadId: r.id, name: r.name, lengthM: r.lengthM })) };
  }
  // Not reachable: report how far the search got and which unusable roads leave the reached area.
  const position = new Map(nodes.map((n) => [n.id, n.coordinate]));
  const target = position.get(toNodeId);
  let closest: { nodeId: string; distanceM: number } | null = null;
  for (const n of dist.keys()) {
    const c = position.get(n);
    if (!c || !target) continue;
    const d = Math.hypot(c[0] - target[0], c[1] - target[1]);
    if (!closest || d < closest.distanceM) closest = { nodeId: n, distanceM: d };
  }
  const frontier = blocked.filter(({ road }) => dist.has(road.fromNodeId) !== dist.has(road.toNodeId) || (dist.has(road.fromNodeId) && dist.has(road.toNodeId)));
  return {
    reachable: false as const, reachedNodes: dist.size, closestReached: closest,
    blockedRoadsAtFrontier: frontier.slice(0, 20).map(({ road, reason }) => ({ roadId: road.id, name: road.name, reason })),
    hint: frontier.length ? 'Roads at the edge of the reachable area cannot be used in this mode (see reasons). If nothing is listed, the network is simply not connected there: run validate_network.'
      : 'No road leaves the reachable area toward the target: the network is not connected there. Run validate_network.',
  };
}
