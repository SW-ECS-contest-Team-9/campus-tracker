// Turns the model's path description into exact coordinates (docs/EDITOR_MCP_PLAN.md 7.1–7.2). The model never has to
// reproduce coordinates of existing objects: it references them ("at"), and connections become explicit anchors that the
// editor service honors even when the geometry only touches. Heights default to the terrain.
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { Uuid } from '../../common/dto.js';
import { projectOnLine, type XYZ } from '../editor/topology.js';
import type { Anchor } from '../editor/editor.dto.js';
import { fusionConfigV4 } from '../fusion/fusion.config.js';
import { median } from '../trajectory/geometry.js';
import { clearHeightDifference } from '../trajectory/height-difference.js';
import { simplify3D } from './corridor.js';
import { simplifyIndices } from './geometry.js';

export const PathItem = z.object({
  xy: z.tuple([z.number(), z.number()]).optional().describe('[x, y] in EPSG:5186'),
  z: z.number().optional().describe('Height for xy. Omit to use the terrain (zMode "terrain")'),
  at: z.object({
    roadId: Uuid.optional(),
    vertexIndex: z.number().int().min(0).optional().describe('With roadId: that vertex'),
    measureM: z.number().min(0).optional().describe('With roadId: the point this far along the road'),
    nearest: z.tuple([z.number(), z.number()]).optional().describe('With roadId: the point of the road closest to this [x, y]'),
    nodeId: Uuid.optional(),
    placeId: Uuid.optional(),
    cursorOf: z.string().max(32).optional().describe('collectorId of a connected person: their cursor position'),
  }).optional().describe('An exact position on an existing object. A road reference also connects the new line to that road there'),
  run: z.object({ runId: Uuid, fromSeq: z.number().int(), toSeq: z.number().int(), simplifyM: z.number().min(0).max(10).default(0.5) }).optional()
    .describe('A stretch of a fusion run track (seq order; fromSeq > toSeq walks it backwards)'),
  canonical: z.object({ pathId: Uuid, fromIdx: z.number().int().min(0).optional(), toIdx: z.number().int().min(0).optional(), simplifyM: z.number().min(0).max(10).default(0.3) }).optional()
    .describe('A stretch of a canonical path'),
}).describe('One path element: exactly one of xy, at, run, canonical');
export type PathItem = z.infer<typeof PathItem>;

export interface ResolveDeps {
  road(id: string): Promise<{ id: string; levelId: string | null; status: string; coordinates: XYZ[] }>;
  node(id: string): Promise<{ coordinate: XYZ }>;
  place(id: string): Promise<{ coordinate: XYZ }>;
  cursorOf(collectorId: string): XYZ | null;
  /** FINAL track in EPSG:5186; h = absolute height or null */
  runTrack(runId: string): Promise<{ seq: number; x: number; y: number; h: number | null; t?: number; sigmaZ?: number | null }[]>;
  canonical(pathId: string): Promise<{ idx: number; x: number; y: number }[]>;
  /** Terrain height or null outside the DEM */
  ground(x: number, y: number): number | null;
}
export interface ResolveOptions {
  zMode: 'terrain' | 'explicit';
  terrainOffsetM: number;
  /** Add vertices where the straight line between terrain-height vertices leaves the DEM by more than 0.3 m */
  densify: boolean;
  runZ: 'terrain' | 'run_h';
  /** Level of the line being drawn; referenced roads must be on it */
  levelId: string | null;
  /** Stairs/elevators/ramps join levels: they may reference roads of another level */
  crossLevel: boolean;
}
export const DEFAULT_RESOLVE: ResolveOptions = { zMode: 'terrain', terrainOffsetM: 0, densify: true, runZ: 'terrain', levelId: null, crossLevel: false };

interface Vertex { p: XYZ; draped: boolean; anchor?: { roadId: string; measureM: number }; nodeId?: string }
export interface ResolvedPath {
  coordinates: XYZ[];
  anchors: Anchor[];
  /** vertices given as {at:{nodeId}}: the caller checks that the saved road really ends on that node */
  nodeRefs: { vertexIndex: number; nodeId: string }[];
  sources: Record<string, unknown>[];
  warnings: string[];
}

const DENSIFY_STEP_M = 2, DENSIFY_TOLERANCE_M = 0.3;

function measureAtVertex(points: XYZ[], index: number) {
  let m = 0;
  for (let i = 1; i <= index; i++) m += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return m;
}
function pointAt(points: XYZ[], measure: number): XYZ {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (walked + length >= measure || i === points.length - 1) {
      const f = length > 0 ? Math.max(0, Math.min(1, (measure - walked) / length)) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    walked += length;
  }
  return [...points[0]] as XYZ;
}

export async function resolvePath(items: PathItem[], deps: ResolveDeps, options: Partial<ResolveOptions> = {}): Promise<ResolvedPath> {
  const o = { ...DEFAULT_RESOLVE, ...options };
  const vertices: Vertex[] = [];
  const sources: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const drape = (x: number, y: number, what: string): Vertex => {
    const g = deps.ground(x, y);
    if (g === null) throw AppError.badRequest('OUTSIDE_TERRAIN', `${what} is outside the terrain coverage`, { x, y });
    return { p: [x, y, g + o.terrainOffsetM], draped: true };
  };

  for (const [i, item] of items.entries()) {
    const kinds = [item.xy, item.at, item.run, item.canonical].filter((v) => v !== undefined).length;
    if (kinds !== 1) throw AppError.badRequest('INVALID_PATH_ITEM', `path[${i}] must have exactly one of xy, at, run, canonical`);
    if (item.xy) {
      if (item.z !== undefined) vertices.push({ p: [item.xy[0], item.xy[1], item.z], draped: false });
      else if (o.zMode === 'explicit') throw AppError.badRequest('Z_REQUIRED', `path[${i}] needs z because zMode is "explicit"`);
      else vertices.push(drape(item.xy[0], item.xy[1], `path[${i}]`));
    } else if (item.at) {
      const at = item.at;
      if (at.roadId) {
        const road = await deps.road(at.roadId);
        if (road.status !== 'DRAFT' && road.status !== 'APPROVED') throw AppError.conflict('ROAD_NOT_FOUND', `path[${i}]: road ${at.roadId} was removed or replaced`);
        if (road.levelId !== o.levelId && !o.crossLevel) throw AppError.badRequest('LEVEL_MISMATCH', `path[${i}]: road ${at.roadId} is on level ${JSON.stringify(road.levelId)}, this line on ${JSON.stringify(o.levelId)}; they would not connect`, { roadLevelId: road.levelId });
        let measureM: number;
        if (at.vertexIndex !== undefined) {
          if (!road.coordinates[at.vertexIndex]) throw AppError.badRequest('INVALID_VERTEX', `path[${i}]: road has ${road.coordinates.length} vertices`);
          measureM = measureAtVertex(road.coordinates, at.vertexIndex);
          vertices.push({ p: [...road.coordinates[at.vertexIndex]] as XYZ, draped: false, anchor: { roadId: road.id, measureM } });
        } else {
          if (at.measureM !== undefined) measureM = Math.min(at.measureM, measureAtVertex(road.coordinates, road.coordinates.length - 1));
          else if (at.nearest) measureM = projectOnLine(road.coordinates, [at.nearest[0], at.nearest[1], 0])!.measure;
          else throw AppError.badRequest('INVALID_PATH_ITEM', `path[${i}].at with roadId needs vertexIndex, measureM or nearest`);
          vertices.push({ p: pointAt(road.coordinates, measureM), draped: false, anchor: { roadId: road.id, measureM } });
        }
      } else if (at.nodeId) vertices.push({ p: [...(await deps.node(at.nodeId)).coordinate] as XYZ, draped: false, nodeId: at.nodeId });
      else if (at.placeId) vertices.push({ p: [...(await deps.place(at.placeId)).coordinate] as XYZ, draped: false });
      else if (at.cursorOf) {
        const cursor = deps.cursorOf(at.cursorOf.toUpperCase());
        if (!cursor) throw AppError.conflict('CURSOR_UNAVAILABLE', `path[${i}]: ${at.cursorOf} is not connected to the editor or has not placed a cursor`);
        vertices.push({ p: [...cursor] as XYZ, draped: false });
      } else throw AppError.badRequest('INVALID_PATH_ITEM', `path[${i}].at needs roadId, nodeId, placeId or cursorOf`);
    } else {
      // A stretch of a recorded track: simplified in XY, heights from the terrain unless run heights are requested.
      let points: { key: number; x: number; y: number; h: number | null; sigmaZ?: number | null }[];
      let simplifyM: number;
      if (item.run) {
        const { runId, fromSeq, toSeq } = item.run;
        const lo = Math.min(fromSeq, toSeq), hi = Math.max(fromSeq, toSeq);
        points = (await deps.runTrack(runId)).filter((q) => q.seq >= lo && q.seq <= hi).map((q) => ({ key: q.seq, x: q.x, y: q.y, h: q.h, sigmaZ: q.sigmaZ }));
        if (fromSeq > toSeq) points.reverse();
        simplifyM = item.run.simplifyM;
        if (o.runZ === 'run_h') {
          const withH = points.filter((q) => q.h !== null);
          if (withH.length < points.length) warnings.push(`path[${i}]: ${points.length - withH.length} run points without an absolute height were skipped`);
          points = withH;
          warnings.push(`path[${i}]: run heights are phone heights, not the road surface`);
        } else {
          // Terrain heights drop what the walk measured. Say so when the walk is clearly and consistently off the ground (a floor, a bridge, an underground passage).
          const above = points.flatMap((q) => { const g = q.h === null ? null : deps.ground(q.x, q.y); return g === null ? [] : [q.h! - fusionConfigV4.phoneHeightM - g]; });
          const sigmas = points.flatMap((q) => (q.sigmaZ != null && Number.isFinite(q.sigmaZ) ? [q.sigmaZ] : []));
          const d = clearHeightDifference(above, median(sigmas) ?? Infinity);
          if (d.clear) warnings.push(`path[${i}]: MEASURED_HEIGHT_DROPPED: this walk is ${Math.abs(d.medianM!).toFixed(1)} m ${d.medianM! > 0 ? 'above' : 'below'} the ground along the whole stretch, and terrain heights drop that. If it is a floor, a bridge or an underground passage use runZ "run_h" or create_corridor`);
        }
      } else {
        const c = item.canonical!;
        points = (await deps.canonical(c.pathId)).filter((q) => (c.fromIdx === undefined || q.idx >= c.fromIdx) && (c.toIdx === undefined || q.idx <= c.toIdx))
          .map((q) => ({ key: q.idx, x: q.x, y: q.y, h: null }));
        simplifyM = c.simplifyM;
      }
      if (points.length < 2) throw AppError.badRequest('TRACK_RANGE_EMPTY', `path[${i}]: fewer than two track points in that range`);
      // Measured heights are simplified in 3D: where a level stretch turns into stairs on a straight plan line, that vertex stays.
      const xyz = item.run && o.runZ === 'run_h' ? points.map((q) => [q.x, q.y, q.h!] as XYZ) : null;
      const keptXyz = xyz && new Set(simplify3D(xyz, simplifyM));
      const kept = keptXyz ? points.filter((_, k) => keptXyz.has(xyz![k]))
        : simplifyIndices(points.map((q) => [q.x, q.y] as [number, number]), simplifyM).map((k) => points[k]);
      for (const q of kept) {
        vertices.push(item.run && o.runZ === 'run_h' ? { p: [q.x, q.y, q.h!], draped: false } : drape(q.x, q.y, `path[${i}] track point ${q.key}`));
      }
      sources.push(item.run ? { run: item.run.runId, seq: [kept[0].key, kept.at(-1)!.key], points: kept.length } : { canonical: item.canonical!.pathId, idx: [kept[0].key, kept.at(-1)!.key], points: kept.length });
    }
  }

  // Consecutive duplicates collapse into one vertex; a referenced (anchored) vertex wins over a free one.
  const merged: Vertex[] = [];
  for (const v of vertices) {
    const last = merged.at(-1);
    if (last && Math.hypot(last.p[0] - v.p[0], last.p[1] - v.p[1], last.p[2] - v.p[2]) < 0.02) { if ((v.anchor && !last.anchor) || (v.nodeId && !last.nodeId && !last.anchor)) merged[merged.length - 1] = v; }
    else merged.push(v);
  }

  let out = merged;
  if (o.densify && o.zMode === 'terrain') {
    out = [];
    const fill = (a: Vertex, b: Vertex) => {
      const length = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      const steps = Math.floor(length / DENSIFY_STEP_M);
      let worst = 0, best: Vertex | null = null;
      for (let s = 1; s < steps; s++) {
        const f = s / steps, x = a.p[0] + (b.p[0] - a.p[0]) * f, y = a.p[1] + (b.p[1] - a.p[1]) * f;
        const g = deps.ground(x, y);
        if (g === null) continue;
        const d = Math.abs(g + o.terrainOffsetM - (a.p[2] + (b.p[2] - a.p[2]) * f));
        if (d > worst) { worst = d; best = { p: [x, y, g + o.terrainOffsetM], draped: true }; }
      }
      if (best && worst > DENSIFY_TOLERANCE_M) { fill(a, best); out.push(best); fill(best, b); }
    };
    merged.forEach((v, i) => {
      // Only between two terrain-height vertices: a segment touching a measured or referenced height keeps its straight profile.
      if (i > 0 && merged[i - 1].draped && v.draped) fill(merged[i - 1], v);
      out.push(v);
    });
    if (out.length > merged.length) sources.push({ densified: out.length - merged.length });
  }

  return {
    coordinates: out.map((v) => v.p),
    anchors: out.flatMap((v, vertexIndex) => (v.anchor ? [{ ...v.anchor, vertexIndex }] : [])),
    nodeRefs: out.flatMap((v, vertexIndex) => (v.nodeId ? [{ vertexIndex, nodeId: v.nodeId }] : [])),
    sources, warnings,
  };
}
