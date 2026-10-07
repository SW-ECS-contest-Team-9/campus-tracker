// Network QA over the active roads and nodes (docs/EDITOR_MCP_PLAN.md 6.3). Pure: callers load the data.
import { crossings, projectOnLine, type XYZ } from '../editor/topology.js';
import { round2, roundXYZ } from './geometry.js';

export interface QaRoad {
  id: string; name: string | null; structure: string; vehicleAccess: string; wheelchairAccess: string;
  levelId: string | null; fromNodeId: string; toNodeId: string; coordinates: XYZ[];
}
export interface QaNode { id: string; levelId: string | null; coordinate: XYZ }
export interface Finding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  roadIds: string[];
  nodeIds?: string[];
  location?: XYZ;
  suggestion?: string;
}
export interface QaOptions {
  /** A dangling end this close to another road was probably meant to connect. */
  danglingRadiusM: number;
  levelToleranceM: number;
  duplicateNodeM: number;
  offTerrainM: number;
  /** Ground height at an XY point, or null outside the DEM. Omit to skip the terrain check. */
  ground?: (x: number, y: number) => number | null;
  smallComponentM: number;
}
export const DEFAULT_QA: QaOptions = { danglingRadiusM: 2, levelToleranceM: 1.25, duplicateNodeM: 0.15, offTerrainM: 1.5, smallComponentM: 10 };

export const QA_CHECKS = ['DANGLING_END_NEAR_ROAD', 'UNCONNECTED_CROSSING', 'DUPLICATE_NODES', 'LEVEL_NODES_NOT_JOINED', 'OVERLAPPING_ROADS', 'OFF_TERRAIN', 'ATTRIBUTE_CONFLICT', 'ISOLATED_COMPONENT'] as const;
export type QaCheck = (typeof QA_CHECKS)[number];

const length = (c: XYZ[]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0);
const label = (r: QaRoad) => r.name || r.id.slice(0, 8);
const bboxOf = (c: XYZ[]) => c.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
const near = (a: number[], b: number[], pad: number) => a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];

export function validateNetwork(roads: QaRoad[], nodes: QaNode[], checks: readonly QaCheck[] = QA_CHECKS, options: Partial<QaOptions> = {}): Finding[] {
  const o = { ...DEFAULT_QA, ...options };
  const on = (c: QaCheck) => checks.includes(c);
  const findings: Finding[] = [];
  const boxes = new Map(roads.map((r) => [r.id, bboxOf(r.coordinates)]));
  const degree = new Map<string, string[]>();
  for (const r of roads) for (const n of [r.fromNodeId, r.toNodeId]) degree.set(n, [...(degree.get(n) ?? []), r.id]);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  if (on('DANGLING_END_NEAR_ROAD')) {
    for (const [nodeId, roadIds] of degree) {
      const node = nodeById.get(nodeId);
      if (roadIds.length !== 1 || !node) continue;
      const own = roadIds[0];
      for (const other of roads) {
        if (other.id === own || other.levelId !== node.levelId) continue;
        if (!near(boxes.get(other.id)!, [node.coordinate[0], node.coordinate[1], node.coordinate[0], node.coordinate[1]], o.danglingRadiusM)) continue;
        const hit = projectOnLine(other.coordinates, node.coordinate);
        if (!hit || hit.distance > o.danglingRadiusM || Math.abs(hit.point[2] - node.coordinate[2]) > o.levelToleranceM) continue;
        findings.push({ code: 'DANGLING_END_NEAR_ROAD', severity: 'warning', roadIds: [own, other.id], nodeIds: [nodeId], location: roundXYZ(node.coordinate),
          message: `An end of ${label(roads.find((r) => r.id === own)!)} stops ${round2(hit.distance)} m from ${label(other)} without connecting`,
          suggestion: hit.distance <= 0.75 ? 'connect_roads at this location' : 'extend the road to the other one (update_road with an "at" reference), or confirm it is a dead end' });
      }
    }
  }

  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const a = roads[i], b = roads[j];
    if (a.levelId !== b.levelId || !near(boxes.get(a.id)!, boxes.get(b.id)!, 0.5)) continue;
    const shared = new Set([a.fromNodeId, a.toNodeId].filter((n) => n === b.fromNodeId || n === b.toNodeId));
    if (on('UNCONNECTED_CROSSING')) {
      // zTolerance = Infinity lists every XY crossing; the height gap decides how it is reported.
      for (const hit of crossings(a.coordinates, b.coordinates, Number.POSITIVE_INFINITY)) {
        const atSharedNode = [...shared].some((n) => { const c = nodeById.get(n)?.coordinate; return c && Math.hypot(c[0] - hit.x, c[1] - hit.y) < 0.2; });
        if (atSharedNode) continue;
        const connectable = hit.zDelta <= o.levelToleranceM;
        findings.push({ code: 'UNCONNECTED_CROSSING', severity: connectable ? 'error' : 'info', roadIds: [a.id, b.id], location: [round2(hit.x), round2(hit.y), round2(hit.z)],
          message: connectable ? `${label(a)} and ${label(b)} cross at the same height without a shared node`
            : `${label(a)} and ${label(b)} cross in plan but are ${round2(hit.zDelta)} m apart in height (overpass, or a wrong Z)`,
          suggestion: connectable ? 'connect_roads at this location' : undefined });
      }
    }
    if (on('OVERLAPPING_ROADS')) {
      // Sample the shorter road; a long run that stays within 0.3 m of the other is a duplicate/overlap.
      const [s, l] = length(a.coordinates) <= length(b.coordinates) ? [a, b] : [b, a];
      let run = 0, bestRun = 0, start: XYZ | null = null, bestStart: XYZ | null = null;
      for (let k = 1; k < s.coordinates.length; k++) {
        const p = s.coordinates[k - 1], q = s.coordinates[k];
        const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const mid: XYZ = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const hit = projectOnLine(l.coordinates, mid);
        if (hit && hit.distance < 0.3 && Math.abs(hit.point[2] - mid[2]) <= o.levelToleranceM) { if (!run) start = p; run += seg; if (run > bestRun) { bestRun = run; bestStart = start; } }
        else run = 0;
      }
      if (bestRun >= 1 && bestStart) findings.push({ code: 'OVERLAPPING_ROADS', severity: 'warning', roadIds: [a.id, b.id], location: roundXYZ(bestStart),
        message: `${label(a)} and ${label(b)} run on top of each other for about ${round2(bestRun)} m`, suggestion: 'retire or reshape one of them; overlaps are not merged automatically' });
    }
  }

  if (on('DUPLICATE_NODES') || on('LEVEL_NODES_NOT_JOINED')) {
    const used = nodes.filter((n) => degree.has(n.id));
    const byId = new Map(roads.map((r) => [r.id, r]));
    // the two ends of one elevator share x,y by design
    const elevatorEnds = (a: QaNode, b: QaNode) => roads.some((r) => r.structure === 'elevator' && ((r.fromNodeId === a.id && r.toNodeId === b.id) || (r.fromNodeId === b.id && r.toNodeId === a.id)));
    const onConnector = (n: QaNode) => degree.get(n.id)!.some((id) => ['stairs', 'elevator'].includes(byId.get(id)?.structure ?? ''));
    for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
      const a = used[i], b = used[j];
      if (Math.hypot(a.coordinate[0] - b.coordinate[0], a.coordinate[1] - b.coordinate[1]) > o.duplicateNodeM) continue;
      const dz = Math.abs(a.coordinate[2] - b.coordinate[2]);
      const roadIds = [...new Set([...degree.get(a.id)!, ...degree.get(b.id)!])];
      if (a.levelId === b.levelId) {
        if (on('DUPLICATE_NODES') && dz <= o.levelToleranceM && !elevatorEnds(a, b)) findings.push({ code: 'DUPLICATE_NODES', severity: 'error', roadIds, nodeIds: [a.id, b.id], location: roundXYZ(a.coordinate),
          message: 'Two separate nodes sit at the same place, so their roads are not connected', suggestion: 'connect_roads at this location, or merge_nodes' });
      } else if (on('LEVEL_NODES_NOT_JOINED') && dz <= 0.3 && (onConnector(a) || onConnector(b))) {
        findings.push({ code: 'LEVEL_NODES_NOT_JOINED', severity: 'warning', roadIds, nodeIds: [a.id, b.id], location: roundXYZ(a.coordinate),
          message: `Stairs/elevator end and a road of level ${JSON.stringify(a.levelId === b.levelId ? a.levelId : (onConnector(a) ? b.levelId : a.levelId))} meet here on separate nodes, so the floors are not connected`,
          suggestion: 'merge_nodes with these two nodes' });
      }
    }
  }

  if (on('OFF_TERRAIN') && o.ground) {
    for (const r of roads) {
      if (r.levelId !== null || r.structure === 'indoor_corridor' || r.structure === 'elevator') continue; // only outdoor ground roads are expected on the DEM
      let worst = 0, at: XYZ | null = null;
      for (const p of r.coordinates) {
        const g = o.ground(p[0], p[1]);
        if (g !== null && Math.abs(p[2] - g) > Math.abs(worst)) { worst = p[2] - g; at = p; }
      }
      if (at && Math.abs(worst) > o.offTerrainM) findings.push({ code: 'OFF_TERRAIN', severity: 'warning', roadIds: [r.id], location: roundXYZ(at),
        message: `${label(r)} is ${round2(Math.abs(worst))} m ${worst > 0 ? 'above' : 'below'} the terrain at its worst vertex`,
        suggestion: 'update_road with drapeToTerrain if it is a ground-level road; ignore for bridges and stairs with measured heights' });
    }
  }

  if (on('ATTRIBUTE_CONFLICT')) {
    for (const r of roads) {
      const problems = [
        r.structure === 'stairs' && r.vehicleAccess === 'allowed' ? 'stairs with vehicle access allowed' : null,
        r.structure === 'stairs' && r.wheelchairAccess === 'allowed' ? 'stairs with wheelchair access allowed' : null,
      ].filter(Boolean);
      if (problems.length) findings.push({ code: 'ATTRIBUTE_CONFLICT', severity: 'error', roadIds: [r.id], location: roundXYZ(r.coordinates[0]),
        message: `${label(r)}: ${problems.join('; ')}`, suggestion: 'update_road attrs' });
    }
  }

  if (on('ISOLATED_COMPONENT') && roads.length > 1) {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
    for (const r of roads) for (const n of [r.fromNodeId, r.toNodeId]) if (!parent.has(n)) parent.set(n, n);
    for (const r of roads) parent.set(find(r.fromNodeId), find(r.toNodeId));
    const groups = new Map<string, QaRoad[]>();
    for (const r of roads) { const k = find(r.fromNodeId); groups.set(k, [...(groups.get(k) ?? []), r]); }
    if (groups.size > 1) {
      const sorted = [...groups.values()].map((g) => ({ roads: g, lengthM: g.reduce((s, r) => s + length(r.coordinates), 0) })).sort((a, b) => b.lengthM - a.lengthM);
      for (const g of sorted.slice(1)) findings.push({ code: 'ISOLATED_COMPONENT', severity: g.lengthM < o.smallComponentM ? 'warning' : 'info', roadIds: g.roads.map((r) => r.id),
        location: roundXYZ(g.roads[0].coordinates[0]),
        message: `${g.roads.length} road(s), ${round2(g.lengthM)} m in total, are not connected to the largest part of the network (${sorted.length} separate parts)` });
    }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
