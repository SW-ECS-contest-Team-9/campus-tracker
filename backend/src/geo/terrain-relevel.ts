import { bilinear, type Grid } from './dem.js';

type XYZ = [number, number, number];
export interface RelevelRoad {
  id: string; structure: string; buildingId: string | null; levelId: string | null;
  fromNodeId: string; toNodeId: string; coordinates: XYZ[];
}
export interface RelevelNode { id: string; coordinate: XYZ }
export interface RelevelOptions {
  /** A vertex counts as lying on the FROM terrain when its height is within this of the surface. */
  onTerrainM: number;
  /** Terrain changes smaller than this at a vertex are not reported as refused (draped vertices follow any change). */
  minDeltaM: number;
  /** x,y of FROM-terrain samples whose height was copied onto other vertices as a reference level (see RELEVEL_FIELD). Empty = draped rule only. */
  references: [number, number][];
  /** A height counts as a copy of a reference when it is within this of the reference sample (0.01 m storage rounding). */
  referenceMatchM: number;
  /** A copy moves only when it is within this of the ground both before the move (FROM terrain) and after it (TO terrain). */
  referenceNearGroundM: number;
}
/** 0.05 m: heights draped by the editor are the surface rounded to 0.01 m; the nearest independent height in the 2026-10-09 network is 0.07 m off (docs/audit/t03). */
export const RELEVEL_DEFAULTS: RelevelOptions = { onTerrainM: 0.05, minDeltaM: 0.005, references: [], referenceMatchM: 0.006, referenceNearGroundM: 0.5 };
/** The sports-field reference: the 2015 DEM reads 141.7326 m at this vertex of road 3910b4a5, and that value was copied as "field level"
 * onto node 561a12b4 and roads 8e71c240, 45682ee7 (docs/audit/e06, docs/audit/e07). It is a DEM sample, not a measurement. */
export const RELEVEL_FIELD: RelevelOptions = { ...RELEVEL_DEFAULTS, references: [[201157.08, 557248.59]] };

export type RelevelRefusal = 'indoor' | 'own-heights';
export type NodeRefusal = 'shared-with-indoor' | 'shared-with-own-heights' | 'node-off-terrain';
export interface RelevelPlan {
  /** Roads to rewrite: full new coordinates plus the vertices that changed. */
  roads: { id: string; coordinates: XYZ[]; vertices: { index: number; fromZ: number; toZ: number }[] }[];
  /** Nodes that move with every road end on them. rule: 'draped' = by the terrain change at the node, 'reference' = by the change at the copied reference sample. */
  nodes: { id: string; coordinate: XYZ; fromZ: number; roadIds: string[]; rule: 'draped' | 'reference' }[];
  /** Roads with vertices on changed terrain that stay (vertices that moved are not counted). aboveBefore/After = road height minus terrain, [min, max] over those vertices.
   * referenceCopies = how many of them carry a copied reference height but are not near the ground it would move them to. */
  refusedRoads: { id: string; reason: RelevelRefusal; vertices: number; referenceCopies: number; deltaM: [number, number]; aboveBeforeM: [number, number]; aboveAfterM: [number, number] }[];
  /** Nodes on changed terrain that end a draped road but stay: the road end keeps the node height, so no gap opens, only the last segment's slope changes. */
  refusedNodes: { id: string; reason: NodeRefusal; deltaM: number; aboveBeforeM: number; aboveAfterM: number; drapedRoadIds: string[]; otherRoadIds: string[] }[];
}

/** 1e-6 m keeps the reverse run exact for heights stored with up to 6 decimals. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const isOutdoor = (r: RelevelRoad) => r.levelId === null && r.buildingId === null && r.structure !== 'indoor_corridor' && r.structure !== 'elevator';

/**
 * Height changes that carry roads from terrain `from` to terrain `to` (same grid). Only roads draped on `from` move:
 * outdoor roads whose interior vertices all lie on the surface. Each such vertex gets z + (to - from) at its x,y, so running
 * the plan with the grids swapped undoes it. Roads with their own heights (estimated levels, stairs, underground passages,
 * everything indoor) are reported, not moved. A node moves only when it lies on the surface and every road on it is draped.
 *
 * opts.references adds one more class: an outdoor height that is a copy of the FROM terrain at a reference point (not at its own x,y).
 * Such a node or interior vertex gets z + (to - from) at the reference point, so it stays "at the reference level" and the swapped run
 * undoes it. It moves only when it is near the ground before and after (referenceNearGroundM); a node additionally only when no indoor
 * road uses it, and then every road end on it follows. Copies that fail this are counted in refusedRoads.referenceCopies.
 */
export function planRelevel(grid: Grid, from: Float32Array, to: Float32Array, roads: RelevelRoad[], nodes: RelevelNode[],
  opts: RelevelOptions = RELEVEL_DEFAULTS): RelevelPlan {
  const at = (p: XYZ) => {
    const a = bilinear(grid, from, p[0], p[1]), b = bilinear(grid, to, p[0], p[1]);
    return a === null || b === null ? null : { above: p[2] - a, delta: b - a };
  };
  const changed = (p: XYZ) => { const s = at(p); return s !== null && Math.abs(s.delta) >= opts.minDeltaM; };
  const onTerrain = (p: XYZ) => { const s = at(p); return s !== null && Math.abs(s.above) <= opts.onTerrainM; };
  const draped = new Set(roads.filter((r) => {
    const interior = r.coordinates.slice(1, -1);
    return isOutdoor(r) && (interior.length ? interior : r.coordinates).every(onTerrain);
  }).map((r) => r.id));
  const refs = opts.references.flatMap(([x, y]) => {
    const a = bilinear(grid, from, x, y), b = bilinear(grid, to, x, y);
    return a === null || b === null || Math.abs(b - a) < opts.minDeltaM ? [] : [{ z: a, shift: b - a }];
  });
  const refCopy = (p: XYZ) => refs.find((r) => Math.abs(p[2] - r.z) <= opts.referenceMatchM);
  /** Shift for a copied reference height that is near the ground on both terrains, else null. */
  const refShift = (p: XYZ) => {
    const r = refCopy(p), s = at(p);
    return r && s && Math.abs(s.above) <= opts.referenceNearGroundM && Math.abs(s.above + r.shift - s.delta) <= opts.referenceNearGroundM ? r.shift : null;
  };

  const byNode = new Map<string, RelevelRoad[]>();
  for (const r of roads) for (const id of new Set([r.fromNodeId, r.toNodeId])) byNode.set(id, [...(byNode.get(id) ?? []), r]);
  const plan: RelevelPlan = { roads: [], nodes: [], refusedRoads: [], refusedNodes: [] };
  const movedNodeZ = new Map<string, number>();
  for (const n of nodes) {
    const users = byNode.get(n.id) ?? [], s = at(n.coordinate);
    const drapedIds = users.filter((r) => draped.has(r.id)).map((r) => r.id);
    if (!s || s.delta === 0) continue;
    const others = users.filter((r) => !draped.has(r.id));
    const reason: NodeRefusal | null = others.some((r) => !isOutdoor(r)) ? 'shared-with-indoor' : others.length ? 'shared-with-own-heights'
      : Math.abs(s.above) > opts.onTerrainM ? 'node-off-terrain' : null;
    const shift = reason === null || reason === 'shared-with-indoor' ? null : refShift(n.coordinate);
    if (shift !== null) {
      const z = round6(n.coordinate[2] + shift);
      movedNodeZ.set(n.id, z);
      plan.nodes.push({ id: n.id, coordinate: [n.coordinate[0], n.coordinate[1], z], fromZ: n.coordinate[2], roadIds: users.map((r) => r.id), rule: 'reference' });
      continue;
    }
    if (!drapedIds.length) continue;
    if (reason) {
      if (Math.abs(s.delta) >= opts.minDeltaM) plan.refusedNodes.push({ id: n.id, reason, deltaM: s.delta, aboveBeforeM: s.above, aboveAfterM: s.above - s.delta, drapedRoadIds: drapedIds, otherRoadIds: others.map((r) => r.id) });
      continue;
    }
    const z = round6(n.coordinate[2] + s.delta);
    movedNodeZ.set(n.id, z);
    plan.nodes.push({ id: n.id, coordinate: [n.coordinate[0], n.coordinate[1], z], fromZ: n.coordinate[2], roadIds: drapedIds, rule: 'draped' });
  }

  for (const r of roads) {
    const last = r.coordinates.length - 1, isDraped = draped.has(r.id);
    const coordinates = r.coordinates.map((p, i): XYZ => {
      const nodeZ = i === 0 ? movedNodeZ.get(r.fromNodeId) : i === last ? movedNodeZ.get(r.toNodeId) : undefined;
      if (i === 0 || i === last) return nodeZ === undefined ? p : [p[0], p[1], nodeZ];
      const shift = isDraped ? at(p)?.delta ?? 0 : isOutdoor(r) ? refShift(p) ?? 0 : 0;
      return shift !== 0 ? [p[0], p[1], round6(p[2] + shift)] : p;
    });
    const vertices = coordinates.flatMap((p, index) => (p[2] === r.coordinates[index][2] ? [] : [{ index, fromZ: r.coordinates[index][2], toZ: p[2] }]));
    if (vertices.length) plan.roads.push({ id: r.id, coordinates, vertices });
    if (isDraped) continue;
    const kept = r.coordinates.filter((p, i) => coordinates[i][2] === p[2] && changed(p));
    const hit = kept.map((p) => at(p)!);
    const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];
    if (hit.length) plan.refusedRoads.push({ id: r.id, reason: isOutdoor(r) ? 'own-heights' : 'indoor', vertices: hit.length,
      referenceCopies: isOutdoor(r) ? kept.filter((p) => refCopy(p)).length : 0,
      deltaM: range(hit.map((s) => s.delta)), aboveBeforeM: range(hit.map((s) => s.above)), aboveAfterM: range(hit.map((s) => s.above - s.delta)) });
  }
  return plan;
}
