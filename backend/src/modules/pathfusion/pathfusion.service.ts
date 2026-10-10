// Routes, passes, canonical paths and validation (docs/MOBILITY_MAP_PLAN.md 4.7–4.10) on top of run snapshots.
import { pool, withTransaction } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { codeRef } from '../../common/code-ref.js';
import { CAMPUS_FRAME, fromCampus, toCampus, type CampusPoint } from '../../geo/campus-frame.js';
import { fusionRunsRepository, type RunPosition } from '../fusion/fusion-runs.repository.js';
import { replaySession } from '../fusion/fusion.service.js';
import { resampleTrack, reverseStations, type Station, type TrackPoint } from '../trajectory/resample.js';
import { extractPasses, type PassWindow } from '../trajectory/passes.js';
import { median, quantile } from '../trajectory/geometry.js';
import { buildCanonical, leaveOneOut, PATHFUSION_VERSION, paramsHash, pathfusionParamsV1, type CanonicalResult, type PassInput, type PathfusionParams, type ValidationResult } from './pathfusion-v1.js';

export interface RouteRow {
  id: string;
  name: string;
  frameId: string;
  a: CampusPoint;
  b: CampusPoint;
  radiusM: number;
  widthM: number;
  fusionVersion: string;
  fusionVariant: string | null;
  notes: string | null;
}

interface PassRow {
  id: string;
  routeId: string;
  runId: string;
  sessionId: string;
  tStart: number;
  tEnd: number;
  direction: 'AB' | 'BA';
  source: 'AUTO' | 'MANUAL';
  excluded: boolean;
  status: string | null;
  reasons: string[];
  flipped: boolean;
  metrics: Record<string, unknown>;
}

const ROUTE_COLUMNS = `id, name, frame_id AS "frameId", a_x, a_y, b_x, b_y, radius_m AS "radiusM", width_m AS "widthM",
  fusion_version AS "fusionVersion", fusion_variant AS "fusionVariant", notes`;
const PASS_COLUMNS = `id, route_id AS "routeId", run_id AS "runId", session_id AS "sessionId",
  (extract(epoch FROM t_start) * 1000)::float8 AS "tStart", (extract(epoch FROM t_end) * 1000)::float8 AS "tEnd",
  direction, source, excluded, status, reasons, flipped, metrics`;

type RawRoute = Omit<RouteRow, 'a' | 'b'> & { a_x: number; a_y: number; b_x: number; b_y: number };
const toRoute = (r: RawRoute): RouteRow => {
  const { a_x, a_y, b_x, b_y, ...rest } = r;
  // ends also in WGS84 for the map
  return { ...rest, a: { x: a_x, y: a_y, ...fromCampus(a_x, a_y) }, b: { x: b_x, y: b_y, ...fromCampus(b_x, b_y) } };
};

/** Run positions -> track points; h is relative (barometric) when the run has no absolute height datum. */
export function trackPoints(positions: RunPosition[]): { points: TrackPoint[]; hRelative: boolean } {
  const absolute = positions.filter((p) => p.h !== null && (p.zDatumSource === 'TERRAIN' || p.zDatumSource === 'GPS')).length;
  const hRelative = absolute < positions.length / 2;
  return {
    hRelative,
    points: positions.map((p) => ({ t: p.t, x: p.x, y: p.y, h: hRelative ? p.zRel : p.h, sigmaH: p.sigmaH, hRelative })),
  };
}

/** Position of a run at time t (linear between outputs; null outside the run or across a > 10 s gap). */
export function positionAt(positions: RunPosition[], t: number): CampusPoint | null {
  if (!positions.length || t < positions[0].t || t > positions.at(-1)!.t) return null;
  let lo = 0, hi = positions.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (positions[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = positions[lo], b = positions[hi];
  if (b.t - a.t > 10_000) return Math.abs(t - a.t) < Math.abs(b.t - t) ? a : b;
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
}

const positionsCache = new Map<string, RunPosition[]>();
async function finalPositions(runId: string): Promise<RunPosition[]> {
  let p = positionsCache.get(runId);
  if (!p) {
    p = await fusionRunsRepository.positions(runId, 'FINAL');
    if (positionsCache.size > 200) positionsCache.clear();
    positionsCache.set(runId, p); // snapshots are immutable
  }
  return p;
}

/** Stations of one pass (oriented A→B). */
export async function passStations(p: { runId: string; tStart: number; tEnd: number; direction: 'AB' | 'BA' }, ds = pathfusionParamsV1.ds): Promise<{ stations: Station[]; hRelative: boolean; sigmaZ: number | null }> {
  const positions = (await finalPositions(p.runId)).filter((x) => x.t >= p.tStart && x.t <= p.tEnd);
  const { points, hRelative } = trackPoints(positions);
  const st = resampleTrack(points, { ds }).stations;
  // sigma of the run's height zero over this pass: decides whether a height difference to another pass is clear
  const sigmaZ = median(positions.flatMap((x) => (x.zDatumSigma !== null ? [x.zDatumSigma] : [])));
  return { stations: p.direction === 'BA' ? reverseStations(st) : st, hRelative, sigmaZ };
}

export const pathfusionService = {
  async listRoutes() {
    const { rows } = await pool.query<RawRoute & { passes: number; canonicalPathId: string | null }>(
      `SELECT ${ROUTE_COLUMNS},
              (SELECT count(*)::int FROM route_passes p WHERE p.route_id = r.id) AS passes,
              (SELECT c.id FROM canonical_paths c WHERE c.route_id = r.id ORDER BY c.created_at DESC LIMIT 1) AS "canonicalPathId"
         FROM routes r ORDER BY name`,
    );
    return rows.map((r) => ({ ...toRoute(r), passes: (r as { passes: number }).passes, canonicalPathId: (r as { canonicalPathId: string | null }).canonicalPathId }));
  },

  async getRoute(id: string): Promise<RouteRow> {
    const { rows } = await pool.query<RawRoute>(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = $1`, [id]);
    if (!rows.length) throw AppError.notFound('ROUTE_NOT_FOUND', 'Route not found');
    return toRoute(rows[0]);
  },

  async findRouteByName(name: string): Promise<RouteRow | null> {
    const { rows } = await pool.query<RawRoute>(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE name = $1`, [name]);
    return rows.length ? toRoute(rows[0]) : null;
  },

  /** Ends are given in WGS84 (map clicks) or in the campus frame. */
  async createRoute(r: { name: string; a: CampusPoint | { latitude: number; longitude: number }; b: CampusPoint | { latitude: number; longitude: number }; radiusM?: number; widthM?: number; fusionVersion?: string; fusionVariant?: string | null; notes?: string | null }) {
    const c = (p: CampusPoint | { latitude: number; longitude: number }) => ('latitude' in p ? toCampus(p.latitude, p.longitude) : p);
    const a = c(r.a);
    const b = c(r.b);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO routes (name, frame_id, a_x, a_y, b_x, b_y, radius_m, width_m, fusion_version, fusion_variant, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (name) DO UPDATE SET a_x = EXCLUDED.a_x, a_y = EXCLUDED.a_y, b_x = EXCLUDED.b_x, b_y = EXCLUDED.b_y,
         radius_m = EXCLUDED.radius_m, width_m = EXCLUDED.width_m, fusion_version = EXCLUDED.fusion_version,
         fusion_variant = EXCLUDED.fusion_variant, notes = EXCLUDED.notes, updated_at = now()
       RETURNING id`,
      [r.name, CAMPUS_FRAME.id, a.x, a.y, b.x, b.y, r.radiusM ?? 15, r.widthM ?? 20, r.fusionVersion ?? 'fusion-v4', r.fusionVariant ?? null, r.notes ?? null],
    );
    return this.getRoute(rows[0].id);
  },

  async deleteRoute(id: string) {
    await pool.query('DELETE FROM routes WHERE id = $1', [id]);
  },

  async passes(routeId: string): Promise<PassRow[]> {
    const { rows } = await pool.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM route_passes WHERE route_id = $1 ORDER BY t_start`, [routeId]);
    return rows;
  },

  /** The run snapshot that feeds a route for a session: the latest of the route's version/variant (replayed if none). */
  async runFor(sessionId: string, route: RouteRow): Promise<string> {
    const id = await fusionRunsRepository.latest(sessionId, route.fusionVersion, route.fusionVariant);
    if (id) return id;
    if (route.fusionVariant) throw AppError.conflict('NO_VARIANT_RUN', `No ${route.fusionVersion} ${route.fusionVariant} run for session ${sessionId}: create it with fusion:replay`);
    return (await replaySession(sessionId, route.fusionVersion, 'lab', { publish: false })).runId;
  },

  /**
   * Finds passes (A→B / B→A) in the given sessions (default: every finished, non-synthetic session — synthetic
   * ones with includeSynthetic) and replaces the route's AUTO passes of those sessions. MANUAL passes stay.
   */
  async detectPasses(routeId: string, opts: { sessionIds?: string[]; includeSynthetic?: boolean } = {}) {
    const route = await this.getRoute(routeId);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM collection_sessions WHERE status <> 'ACTIVE' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
          AND ($1::uuid[] IS NOT NULL OR $2 OR NOT synthetic) ORDER BY started_at`,
      [opts.sessionIds ?? null, opts.includeSynthetic ?? false],
    );
    const found: (PassWindow & { sessionId: string; runId: string })[] = [];
    for (const s of rows) {
      const runId = await this.runFor(s.id, route);
      const { points } = trackPoints(await finalPositions(runId));
      for (const w of extractPasses(points, { a: route.a, b: route.b, radiusM: route.radiusM })) found.push({ ...w, sessionId: s.id, runId });
    }
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM route_passes WHERE route_id = $1 AND source = 'AUTO' AND session_id = ANY($2::uuid[])`, [routeId, rows.map((r) => r.id)]);
      for (const f of found) {
        await client.query(
          `INSERT INTO route_passes (route_id, run_id, session_id, t_start, t_end, direction, source, metrics)
           VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, 'AUTO', $7) ON CONFLICT DO NOTHING`,
          [routeId, f.runId, f.sessionId, f.tStart, f.tEnd, f.direction, JSON.stringify({ startDistanceM: f.startDistanceM, endDistanceM: f.endDistanceM })],
        );
      }
    });
    return { sessions: rows.length, passes: found.length, ab: found.filter((f) => f.direction === 'AB').length, ba: found.filter((f) => f.direction === 'BA').length };
  },

  async addManualPass(routeId: string, p: { sessionId: string; tStart: number; tEnd: number; direction?: 'AB' | 'BA' }) {
    const route = await this.getRoute(routeId);
    if (!(p.tEnd > p.tStart)) throw AppError.badRequest('INVALID_PASS', 'tEnd must be after tStart');
    const runId = await this.runFor(p.sessionId, route);
    const pts = (await finalPositions(runId)).filter((x) => x.t >= p.tStart && x.t <= p.tEnd);
    if (pts.length < 5) throw AppError.badRequest('INVALID_PASS', 'The time range contains too few fused positions');
    const d = (q: CampusPoint, e: CampusPoint) => Math.hypot(q.x - e.x, q.y - e.y);
    const direction = p.direction ?? (d(pts[0], route.a) + d(pts.at(-1)!, route.b) <= d(pts[0], route.b) + d(pts.at(-1)!, route.a) ? 'AB' : 'BA');
    await pool.query(
      `INSERT INTO route_passes (route_id, run_id, session_id, t_start, t_end, direction, source)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, 'MANUAL') ON CONFLICT DO NOTHING`,
      [routeId, runId, p.sessionId, p.tStart, p.tEnd, direction],
    );
    return { runId, direction };
  },

  async setPassExcluded(routeId: string, passId: string, excluded: boolean) {
    await pool.query('UPDATE route_passes SET excluded = $3 WHERE route_id = $1 AND id = $2', [routeId, passId, excluded]);
  },

  async passInputs(routeId: string): Promise<PassInput[]> {
    const passes = (await this.passes(routeId)).filter((p) => !p.excluded);
    const out: PassInput[] = [];
    for (const p of passes) {
      const { stations, hRelative, sigmaZ } = await passStations(p);
      out.push({ id: p.id, stations, hRelative, run: p.runId, sigmaZ });
    }
    return out;
  },

  /** Builds and stores the canonical path of a route from its (non-excluded) passes; updates the passes' outcome. */
  async buildCanonical(routeId: string, params: Partial<PathfusionParams> = {}) {
    const route = await this.getRoute(routeId);
    const inputs = await this.passInputs(routeId);
    if (!inputs.length) throw AppError.conflict('NO_PASSES', 'The route has no passes: detect or add passes first');
    const result = buildCanonical(inputs, params);
    const id = await this.storeCanonical(route, result, inputs);
    return { canonicalPathId: id, ...summarizeCanonical(result) };
  },

  async storeCanonical(route: RouteRow, c: CanonicalResult, inputs: PassInput[]): Promise<string> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO canonical_paths (route_id, algorithm, params, params_hash, frame_id, fusion_version, fusion_variant, pass_ids, passes, metrics, code_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11) RETURNING id`,
        [route.id, c.version, JSON.stringify(c.params), c.paramsHash, CAMPUS_FRAME.id, route.fusionVersion, route.fusionVariant,
          inputs.map((x) => x.id), JSON.stringify(c.passes), JSON.stringify(summarizeCanonical(c)), codeRef()],
      );
      const id = rows[0].id;
      const pts = c.points;
      const ll = pts.map((p) => fromCampus(p.x, p.y));
      for (let i = 0; i < pts.length; i += 5000) {
        const chunk = pts.slice(i, i + 5000);
        const lc = ll.slice(i, i + 5000);
        await client.query(
          `INSERT INTO canonical_points (canonical_path_id, idx, s, x, y, z, latitude, longitude, sample_count, sigma_xy, sigma_z, se_xy, half_width_m, confidence, low_samples, contributors)
           SELECT $1, t.idx, t.s, t.x, t.y, t.z, t.lat, t.lon, t.n, t.sxy, t.sz, t.se, t.hw, t.conf, t.low, string_to_array(t.contrib, ',')
             FROM unnest($2::int[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::int[], $10::float8[],
                         $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::boolean[], $16::text[])
               AS t(idx, s, x, y, z, lat, lon, n, sxy, sz, se, hw, conf, low, contrib)`,
          [id, chunk.map((_, k) => i + k), chunk.map((p) => p.s), chunk.map((p) => p.x), chunk.map((p) => p.y), chunk.map((p) => p.z),
            lc.map((p) => p.latitude), lc.map((p) => p.longitude), chunk.map((p) => p.sampleCount), chunk.map((p) => p.sigmaXY), chunk.map((p) => p.sigmaZ),
            chunk.map((p) => p.seXY), chunk.map((p) => p.halfWidthM), chunk.map((p) => p.confidence), chunk.map((p) => p.lowSamples), chunk.map((p) => p.contributors.join(','))],
        );
      }
      for (const p of c.passes) {
        await client.query(
          `UPDATE route_passes SET status = $2, reasons = $3, flipped = $4, metrics = metrics || $5::jsonb WHERE id = $1`,
          [p.id, p.status, p.reasons, p.flipped, JSON.stringify({ coverage: p.coverage, lengthRatio: p.lengthRatio, dtwMeanM: Number.isFinite(p.dtwMeanM) ? p.dtwMeanM : null, range: p.range, outlierVoteFraction: p.outlierVoteFraction, zOffsetM: p.zOffsetM })],
        );
      }
      return id;
    });
  },

  async canonicalPath(id: string) {
    const { rows } = await pool.query(
      `SELECT id, route_id AS "routeId", algorithm, params, params_hash AS "paramsHash", frame_id AS "frameId", fusion_version AS "fusionVersion",
              fusion_variant AS "fusionVariant", pass_ids AS "passIds", passes, metrics, code_ref AS "codeRef", created_at AS "createdAt"
         FROM canonical_paths WHERE id = $1`, [id],
    );
    if (!rows.length) throw AppError.notFound('CANONICAL_NOT_FOUND', 'Canonical path not found');
    const { rows: points } = await pool.query(
      `SELECT idx, s, x, y, z, latitude, longitude, sample_count AS "sampleCount", sigma_xy AS "sigmaXY", sigma_z AS "sigmaZ", se_xy AS "seXY",
              half_width_m AS "halfWidthM", confidence, low_samples AS "lowSamples", contributors
         FROM canonical_points WHERE canonical_path_id = $1 ORDER BY idx`, [id],
    );
    return { ...rows[0], points };
  },

  /** Leave-one-pass-out validation of a route + raw rejection ratio + marker consistency; stored as a report. */
  async validate(routeId: string, params: Partial<PathfusionParams> = {}, benchId: string | null = null) {
    const route = await this.getRoute(routeId);
    const passes = (await this.passes(routeId)).filter((p) => !p.excluded);
    const inputs = await this.passInputs(routeId);
    const v = leaveOneOut(inputs, params);
    const extra = await windowStats(passes);
    const metrics = validationMetrics(v, extra);
    const { rows: latest } = await pool.query<{ id: string }>('SELECT id FROM canonical_paths WHERE route_id = $1 ORDER BY created_at DESC LIMIT 1', [routeId]);
    const p = { ...pathfusionParamsV1, ...params };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO validation_reports (route_id, canonical_path_id, algorithm, params_hash, fusion_version, fusion_variant, method, metrics, errors, bench_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [routeId, latest[0]?.id ?? null, PATHFUSION_VERSION, paramsHash(p), route.fusionVersion, route.fusionVariant, v.method,
        JSON.stringify(metrics), JSON.stringify(v.passes.map((x) => ({ id: x.id, errors: x.errors.map((e) => {
          const p = fromCampus(e.x, e.y);
          const f = fromCampus(e.fx, e.fy);
          return { s: e.s, latitude: p.latitude, longitude: p.longitude, footLatitude: f.latitude, footLongitude: f.longitude, d: round(e.d), dz: round(e.dz), inside: e.inside };
        }) }))), benchId],
    );
    return { reportId: rows[0].id, ...metrics };
  },

  async validationReport(id: string) {
    const { rows } = await pool.query(
      `SELECT id, route_id AS "routeId", canonical_path_id AS "canonicalPathId", algorithm, params_hash AS "paramsHash", fusion_version AS "fusionVersion",
              fusion_variant AS "fusionVariant", method, metrics, errors, created_at AS "createdAt" FROM validation_reports WHERE id = $1`, [id],
    );
    if (!rows.length) throw AppError.notFound('REPORT_NOT_FOUND', 'Validation report not found');
    return rows[0];
  },

  async latestReports(routeId: string) {
    const { rows } = await pool.query(
      `SELECT id, method, metrics, fusion_version AS "fusionVersion", fusion_variant AS "fusionVariant", created_at AS "createdAt"
         FROM validation_reports WHERE route_id = $1 ORDER BY created_at DESC LIMIT 10`, [routeId],
    );
    return rows;
  },
};

const round = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function summarizeCanonical(c: CanonicalResult) {
  const pts = c.points;
  const sig = pts.map((p) => p.sigmaXY).filter((v): v is number => v !== null);
  const by = (s: string) => c.passes.filter((p) => p.status === s).length;
  return {
    algorithm: c.version, paramsHash: c.paramsHash, points: pts.length, lengthM: round(c.lengthM, 1), iterations: c.iterations, medoid: c.medoid, zRelative: c.zRelative,
    passes: { total: c.passes.length, accepted: by('ACCEPTED'), partial: by('PARTIAL'), rejected: by('REJECTED'), flipped: c.passes.filter((p) => p.flipped).length },
    sigmaXY: { median: round(median(sig)), p95: round(quantile(sig, 0.95)) },
    halfWidthM: { median: round(median(pts.map((p) => p.halfWidthM))) },
    confidence: { median: round(median(pts.map((p) => p.confidence))) },
    lowSampleFraction: pts.length ? round(pts.filter((p) => p.lowSamples).length / pts.length) : null,
  };
}

/** Raw GPS rejection (qc-v1) and fusion down-weighting inside the pass windows; spread of markers of one type at one place. */
async function windowStats(passes: { runId: string; sessionId: string; tStart: number; tEnd: number }[]) {
  let raw = 0, rejected = 0, fixes = 0, downweighted = 0;
  const markers: { type: string; x: number; y: number }[] = [];
  for (const p of passes) {
    const { rows: q } = await pool.query<{ n: number; r: number }>(
      `SELECT count(*)::int n, count(*) FILTER (WHERE status = 'REJECTED')::int r FROM raw_location_qc
        WHERE session_id = $1 AND qc_version = 'qc-v1' AND "timestamp" BETWEEN to_timestamp($2 / 1000.0) AND to_timestamp($3 / 1000.0)`,
      [p.sessionId, p.tStart, p.tEnd],
    );
    raw += q[0].n;
    rejected += q[0].r;
    const { rows: f } = await pool.query<{ n: number; d: number }>(
      `SELECT count(*)::int n, count(*) FILTER (WHERE NOT forward_used AND final_weight IS NULL OR final_weight < 0.5)::int d FROM fusion_run_fixes
        WHERE run_id = $1 AND "timestamp" BETWEEN to_timestamp($2 / 1000.0) AND to_timestamp($3 / 1000.0)`,
      [p.runId, p.tStart, p.tEnd],
    );
    fixes += f[0].n;
    downweighted += f[0].d;
    const { rows: m } = await pool.query<{ type: string; t: number }>(
      `SELECT type, (extract(epoch FROM "timestamp") * 1000)::float8 t FROM event_markers
        WHERE session_id = $1 AND "timestamp" BETWEEN to_timestamp($2 / 1000.0 - 5) AND to_timestamp($3 / 1000.0 + 5)`,
      [p.sessionId, p.tStart, p.tEnd],
    );
    const positions = await finalPositions(p.runId);
    for (const k of m) {
      const at = positionAt(positions, k.t);
      if (at) markers.push({ type: k.type, x: at.x, y: at.y });
    }
  }
  return { raw, rejected, fixes, downweighted, markerClusters: markerClusters(markers) };
}

/** Markers of one type within 10 m of each other = one place: spread of the fused positions where they were tapped. */
export function markerClusters(markers: { type: string; x: number; y: number }[], radiusM = 10) {
  const clusters: { type: string; members: { x: number; y: number }[] }[] = [];
  for (const m of markers) {
    const c = clusters.find((k) => k.type === m.type && k.members.some((q) => Math.hypot(q.x - m.x, q.y - m.y) <= radiusM));
    if (c) c.members.push(m);
    else clusters.push({ type: m.type, members: [m] });
  }
  return clusters
    .filter((c) => c.members.length >= 2)
    .map((c) => {
      const cx = median(c.members.map((q) => q.x))!;
      const cy = median(c.members.map((q) => q.y))!;
      return { type: c.type, count: c.members.length, x: round(cx, 1), y: round(cy, 1), medianSpreadM: round(median(c.members.map((q) => Math.hypot(q.x - cx, q.y - cy)))) };
    });
}

export function validationMetrics(v: ValidationResult, extra: Awaited<ReturnType<typeof windowStats>> | null) {
  const spreads = extra?.markerClusters.map((c) => c.medianSpreadM).filter((x): x is number => x !== null) ?? [];
  return {
    method: v.method,
    passes: v.passes.length,
    pooled: {
      stations: v.pooled.stations,
      medianXY: round(v.pooled.medianXY), p95XY: round(v.pooled.p95XY), maxXY: round(v.pooled.maxXY),
      medianZ: round(v.pooled.medianZ), p95Z: round(v.pooled.p95Z), corridorCoverage: round(v.pooled.corridorCoverage, 3),
    },
    perPass: v.passes.map((x) => ({ id: x.id, stations: x.stations, medianXY: round(x.medianXY), p95XY: round(x.p95XY), maxXY: round(x.maxXY), medianZ: round(x.medianZ), corridorCoverage: round(x.corridorCoverage, 3) })),
    rejectedPointRatio: extra && extra.raw ? round(extra.rejected / extra.raw, 3) : null,
    fusionDownweightedRatio: extra && extra.fixes ? round(extra.downweighted / extra.fixes, 3) : null,
    markerClusters: extra?.markerClusters ?? [],
    markerSpreadM: round(median(spreads)),
  };
}

// ---------------------------------------------------------------------------------------------
// bench (4.10): one algorithm setting over a suite of routes, nothing published
// ---------------------------------------------------------------------------------------------

export interface BenchCandidate { version: string; variant: string | null; overrides: Record<string, unknown> | null }

/** Sessions that feed a route (its non-excluded passes). */
async function routeSessions(routeId: string): Promise<string[]> {
  const { rows } = await pool.query<{ session_id: string }>('SELECT DISTINCT session_id FROM route_passes WHERE route_id = $1 AND NOT excluded', [routeId]);
  return rows.map((r) => r.session_id);
}

/**
 * Metrics of a route for one fusion setting: passes found automatically in that setting's runs (manual passes
 * do not apply: their time ranges belong to other runs), canonical path, leave-one-out validation, window stats.
 * The registered config (no overrides) reuses the latest snapshots; a candidate is replayed (unpublished).
 */
export async function benchRoute(route: RouteRow, c: BenchCandidate) {
  const sessions = await routeSessions(route.id);
  const passes: { id: string; runId: string; sessionId: string; tStart: number; tEnd: number; direction: 'AB' | 'BA' }[] = [];
  for (const sessionId of sessions) {
    const registered = !c.overrides && !c.variant && c.version === route.fusionVersion;
    const runId = registered
      ? await pathfusionService.runFor(sessionId, route)
      : (await replaySession(sessionId, c.version, 'bench', { variant: c.variant ?? 'bench', overrides: c.overrides, publish: false })).runId;
    const { points } = trackPoints(await finalPositions(runId));
    extractPasses(points, { a: route.a, b: route.b, radiusM: route.radiusM }).forEach((w, k) => passes.push({ id: `${sessionId.slice(0, 8)}#${k}`, runId, sessionId, ...w }));
  }
  const inputs: PassInput[] = [];
  for (const p of passes) {
    const { stations, hRelative, sigmaZ } = await passStations(p);
    inputs.push({ id: p.id, stations, hRelative, run: p.runId, sigmaZ });
  }
  const canonical = inputs.length ? summarizeCanonical(buildCanonical(inputs)) : null;
  const validation = validationMetrics(leaveOneOut(inputs), await windowStats(passes));
  return { route: route.name, sessions: sessions.length, passes: passes.length, canonical, validation: { ...validation, perPass: undefined } };
}

export async function storeBench(suite: string, candidate: BenchCandidate, metrics: object, baselineId: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO bench_results (suite, candidate, baseline_id, metrics, code_ref) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [suite, JSON.stringify(candidate), baselineId, JSON.stringify(metrics), codeRef()],
  );
  return rows[0].id;
}

export async function benchResult(id: string) {
  const { rows } = await pool.query(
    'SELECT id, suite, candidate, baseline_id AS "baselineId", metrics, code_ref AS "codeRef", created_at AS "createdAt" FROM bench_results WHERE id = $1', [id],
  );
  if (!rows.length) throw AppError.notFound('BENCH_NOT_FOUND', 'Bench result not found');
  return rows[0];
}

export async function listBench(limit = 30) {
  const { rows } = await pool.query(
    'SELECT id, suite, candidate, baseline_id AS "baselineId", metrics, code_ref AS "codeRef", created_at AS "createdAt" FROM bench_results ORDER BY created_at DESC LIMIT $1', [limit],
  );
  return rows;
}
