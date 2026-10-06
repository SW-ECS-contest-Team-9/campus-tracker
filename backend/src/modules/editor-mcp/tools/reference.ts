// Read-only reference material for drawing: terrain, fusion tracks, canonical paths, buildings, coordinate conversion.
import { z } from 'zod';
import { pool } from '../../../config/database.js';
import { Uuid } from '../../../common/dto.js';
import { AppError } from '../../../common/errors/app-error.js';
import { CAMPUS_FRAME } from '../../../geo/campus-frame.js';
import { terrain } from '../../../geo/terrain.js';
import { tmForward, tmInverse } from '../../../geo/tm.js';
import { fusionRunsRepository } from '../../fusion/fusion-runs.repository.js';
import { pathfusionService } from '../../pathfusion/pathfusion.service.js';
import { SCOPE_READ, defineTool } from '../mcp.context.js';
import { lineLength, round2, simplifyIndices } from '../geometry.js';
import { terrainContext } from '../terrain-access.js';

const Xy = z.tuple([z.number(), z.number()]).describe('[x, y] in EPSG:5186 meters');
const Bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[minX, minY, maxX, maxY] in EPSG:5186');
const readOnly = { readOnlyHint: true, idempotentHint: true };
const MAX_TRACK_POINTS = 400;

const sampleTerrain = defineTool({
  name: 'sample_terrain',
  title: 'Ground height',
  description: 'Ground height (orthometric Z) from the active DEM at points, or along a line at a spacing (a height profile). '
    + 'Also returns the DEM uncertainty, slope (rise/run) and the building at each point. z is null outside the DEM.',
  input: z.object({
    points: z.array(Xy).min(1).max(500).optional(),
    line: z.array(Xy).min(2).max(200).optional().describe('Sampled every spacingM, including its vertices'),
    spacingM: z.number().min(0.5).max(50).default(5),
  }).refine((v) => !!v.points !== !!v.line, 'Give either points or line'),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run(a) {
    const ctx = await terrainContext();
    if (!ctx) throw AppError.notFound('TERRAIN_UNAVAILABLE', 'No active terrain version');
    let targets: { x: number; y: number; measureM?: number }[] = (a.points ?? []).map(([x, y]) => ({ x, y }));
    if (a.line) {
      targets = [];
      let measure = 0;
      for (let i = 1; i < a.line.length; i++) {
        const [ax, ay] = a.line[i - 1], [bx, by] = a.line[i];
        const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / a.spacingM));
        for (let s = i === 1 ? 0 : 1; s <= steps; s++) targets.push({ x: ax + (bx - ax) * s / steps, y: ay + (by - ay) * s / steps, measureM: round2(measure + len * s / steps) });
        measure += len;
      }
      if (targets.length > 1000) throw AppError.badRequest('TOO_MANY_SAMPLES', 'Increase spacingM: the profile would exceed 1000 samples');
    }
    return {
      terrainVersion: ctx.versionId,
      samples: targets.map((t) => {
        const s = terrain.sampleXY(ctx, t.x, t.y);
        const b = s ? terrain.buildingAt(ctx, t.x, t.y).building : null;
        return { x: round2(t.x), y: round2(t.y), ...(t.measureM !== undefined ? { measureM: t.measureM } : {}),
          z: s ? round2(s.height) : null, ...(s ? { sigmaM: round2(s.sigma), slope: round2(s.slope) } : {}), ...(b ? { buildingId: b.buildingId } : {}) };
      }),
    };
  },
});

const listFusionRuns = defineTool({
  name: 'list_fusion_runs',
  title: 'Recorded walks (fusion runs)',
  description: 'Collection sessions and their fusion runs whose FINAL track can be traced into a road. Shows collector, time, track length, '
    + 'point count, bounding box and how many points carry an absolute height. Sessions without a snapshot run are listed as not traceable.',
  input: z.object({
    collectorId: z.string().max(32).optional(),
    bbox: Bbox.optional().describe('Only runs whose track enters this box'),
    includeSynthetic: z.boolean().default(false),
  }),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run(a) {
    const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
    const { rows } = await pool.query<any>(
      `SELECT s.id "sessionId", c.collector_code "collectorId", s.started_at "startedAt", s.ended_at "endedAt", s.synthetic,
              r.id "runId", r.algorithm_version "algorithmVersion", r.variant, r.published, p.n::int points, p.with_h::int "pointsWithHeight",
              p.min_x + $1 "minX", p.min_y + $2 "minY", p.max_x + $1 "maxX", p.max_y + $2 "maxY", p.first_seq "firstSeq", p.last_seq "lastSeq"
         FROM collection_sessions s JOIN collectors c ON c.id = s.collector_id
         LEFT JOIN fusion_runs r ON r.session_id = s.id AND r.snapshot AND r.status = 'COMPLETED'
         LEFT JOIN LATERAL (SELECT count(*) n, count(h) with_h, min(x) min_x, min(y) min_y, max(x) max_x, max(y) max_y, min(seq) first_seq, max(seq) last_seq
                              FROM fusion_run_positions WHERE run_id = r.id AND stage = 'FINAL') p ON r.id IS NOT NULL
        WHERE ($3::text IS NULL OR c.collector_code = upper($3)) AND ($4 OR NOT s.synthetic)
        ORDER BY s.started_at DESC, r.published DESC, r.created_at DESC`, [ox, oy, a.collectorId ?? null, a.includeSynthetic]);
    const sessions = new Map<string, any>();
    for (const r of rows) {
      const s = sessions.get(r.sessionId) ?? { sessionId: r.sessionId, collectorId: r.collectorId, startedAt: r.startedAt, endedAt: r.endedAt, ...(r.synthetic ? { synthetic: true } : {}), runs: [] };
      sessions.set(r.sessionId, s);
      if (!r.runId || !r.points) continue;
      if (a.bbox && (r.maxX < a.bbox[0] || r.minX > a.bbox[2] || r.maxY < a.bbox[1] || r.minY > a.bbox[3])) continue;
      s.runs.push({ runId: r.runId, algorithmVersion: r.algorithmVersion, variant: r.variant, published: r.published, points: r.points,
        pointsWithHeight: r.pointsWithHeight, seqRange: [r.firstSeq, r.lastSeq], bbox: [r.minX, r.minY, r.maxX, r.maxY].map(round2) });
    }
    const list = [...sessions.values()].filter((s) => !a.bbox || s.runs.length);
    return {
      sessions: list.map((s) => ({ ...s, traceable: s.runs.length > 0 })),
      note: 'Sessions with traceable=false need a Lab replay (not available through MCP) before their track can be used.',
    };
  },
});

const getRunTrack = defineTool({
  name: 'get_run_track',
  title: 'Track of a fusion run',
  description: `The FINAL track of a run as [seq, x, y, h] in EPSG:5186 (h = absolute height or null; it is the phone height, not the ground). `
    + `Simplified by default and capped at ${MAX_TRACK_POINTS} points: narrow with fromSeq/toSeq or bbox for detail. `
    + 'To draw a road along it, pass {run:{runId, fromSeq, toSeq}} in a road path instead of copying coordinates.',
  input: z.object({
    runId: Uuid,
    fromSeq: z.number().int().optional(),
    toSeq: z.number().int().optional(),
    bbox: Bbox.optional(),
    simplifyM: z.number().min(0).max(20).default(0.5),
  }),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run(a) {
    const run = await fusionRunsRepository.get(a.runId);
    if (!run) throw AppError.notFound('RUN_NOT_FOUND', 'Run not found');
    const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
    const all = (await fusionRunsRepository.positions(a.runId, 'FINAL')).map((p) => ({ seq: p.seq, x: p.x + ox, y: p.y + oy, h: p.h }));
    if (!all.length) throw AppError.notFound('RUN_HAS_NO_TRACK', 'This run has no FINAL positions (only snapshot runs keep them)');
    const part = all.filter((p) => (a.fromSeq === undefined || p.seq >= a.fromSeq) && (a.toSeq === undefined || p.seq <= a.toSeq)
      && (!a.bbox || (p.x >= a.bbox[0] && p.x <= a.bbox[2] && p.y >= a.bbox[1] && p.y <= a.bbox[3])));
    const xy = part.map((p) => [p.x, p.y] as [number, number]);
    let tolerance = a.simplifyM, kept = simplifyIndices(xy, tolerance);
    while (kept.length > MAX_TRACK_POINTS) { tolerance = Math.max(0.25, tolerance * 2); kept = simplifyIndices(xy, tolerance); }
    return {
      runId: a.runId, sessionId: (run as any).sessionId, totalPoints: all.length, seqRange: [all[0].seq, all.at(-1)!.seq],
      selectedPoints: part.length, selectedLengthM: round2(lineLength(xy)), simplifyM: tolerance,
      pointsWithHeight: part.filter((p) => p.h !== null).length,
      points: kept.map((i) => [part[i].seq, round2(part[i].x), round2(part[i].y), part[i].h === null ? null : round2(part[i].h!)]),
    };
  },
});

const listRoutes = defineTool({
  name: 'list_routes',
  title: 'Lab routes',
  description: 'Routes measured repeatedly in the Lab, with the id of their latest canonical path (the fused centerline of all passes).',
  input: z.object({}),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run() {
    const routes = await pathfusionService.listRoutes() as any[];
    return { routes: routes.map((r) => ({ routeId: r.id, name: r.name, passes: r.passes, canonicalPathId: r.canonicalPathId })) };
  },
});

const getCanonicalPath = defineTool({
  name: 'get_canonical_path',
  title: 'Canonical path points',
  description: 'Points of a canonical path as [idx, x, y, z, confidence] in EPSG:5186, about 1 m apart. z comes from fused phone heights, '
    + 'not the ground. To draw a road along it, pass {canonical:{pathId, fromIdx, toIdx}} in a road path.',
  input: z.object({ pathId: Uuid, fromIdx: z.number().int().min(0).optional(), toIdx: z.number().int().min(0).optional() }),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run(a) {
    const path = await pathfusionService.canonicalPath(a.pathId) as any;
    const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
    const points = (path.points as any[]).filter((p) => (a.fromIdx === undefined || p.idx >= a.fromIdx) && (a.toIdx === undefined || p.idx <= a.toIdx));
    return {
      pathId: path.id, routeId: path.routeId, algorithm: path.algorithm, fusionVersion: path.fusionVersion, passCount: path.passIds?.length ?? null,
      totalPoints: path.points.length, lengthM: round2(path.points.at(-1)?.s ?? 0),
      points: points.map((p) => [p.idx, round2(p.x + ox), round2(p.y + oy), p.z === null ? null : round2(p.z), p.confidence === null ? null : round2(p.confidence)]),
    };
  },
});

const listBuildings = defineTool({
  name: 'list_buildings',
  title: 'Campus buildings',
  description: 'Buildings of the active campus scene: buildingId (use it for the buildingId attribute), name, footprint center, '
    + 'ground floors, base and roof heights.',
  input: z.object({}),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run() {
    const { rows } = await pool.query(
      `SELECT b.building_id "buildingId", b.name, b.ground_floors "groundFloors", round(b.base_m::numeric, 2)::float8 "baseZ", round(b.roof_m::numeric, 2)::float8 "roofZ",
              round(ST_X(ST_PointOnSurface(b.geom))::numeric, 2)::float8 x, round(ST_Y(ST_PointOnSurface(b.geom))::numeric, 2)::float8 y,
              round(ST_Area(b.geom)::numeric, 0)::float8 "footprintM2"
         FROM scene_buildings b JOIN scene_versions v ON v.id = b.scene_version_id AND v.active ORDER BY b.name NULLS LAST, b.building_id`);
    return { buildings: rows };
  },
});

const Frame = z.enum(['wgs84', 'epsg5186', 'campus']);
const convertCoordinates = defineTool({
  name: 'convert_coordinates',
  title: 'Convert coordinates',
  description: 'Convert points between WGS84 ("wgs84": [longitude, latitude] degrees), EPSG:5186 ("epsg5186": [x, y] meters, what every '
    + 'editor tool uses) and the campus-local frame ("campus": EPSG:5186 minus the campus origin, used by fusion runs).',
  input: z.object({ points: z.array(z.tuple([z.number(), z.number()])).min(1).max(500), from: Frame, to: Frame }),
  scope: SCOPE_READ,
  annotations: readOnly,
  async run(a) {
    const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
    const points = a.points.map(([u, v]) => {
      const abs = a.from === 'wgs84' ? tmForward(v, u) : a.from === 'campus' ? { x: u + ox, y: v + oy } : { x: u, y: v };
      if (a.to === 'wgs84') { const g = tmInverse(abs.x, abs.y); return [Number(g.longitude.toFixed(8)), Number(g.latitude.toFixed(8))]; }
      return a.to === 'campus' ? [round2(abs.x - ox), round2(abs.y - oy)] : [round2(abs.x), round2(abs.y)];
    });
    return { from: a.from, to: a.to, order: a.to === 'wgs84' ? '[longitude, latitude]' : '[x, y]', points };
  },
});

export const referenceTools = [sampleTerrain, listFusionRuns, getRunTrack, listRoutes, getCanonicalPath, listBuildings, convertCoordinates];
