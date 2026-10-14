/**
 * Read-only comparison of sessions over the same sensor-time span, with the checked-out fusion code, in memory.
 * Nothing is written (no run rows, no fused positions): safe against a production database opened read-only.
 *
 *   npm run fusion:compare -- --session=<uuid> --session=<uuid> --cutoff=2026-10-13T13:06:02.238Z [--from=<iso>]
 *                             [--version=fusion-v4] [--set stepTimeBased=true] [--json=out.json]
 *
 * Per session: raw input statistics, then AS_RECEIVED forward / SENSOR_TIME forward / FINAL (smoothed) of the rows
 * captured up to the cutoff. The numbers describe the results; none of them is a position accuracy.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { spatial } from '../src/geo/spatial.js';
import { terrain } from '../src/geo/terrain.js';
import { sessionRepository } from '../src/modules/sessions/session.repository.js';
import { resolveAlgorithm } from '../src/modules/fusion/fusion.algorithms.js';
import { fusionRepository } from '../src/modules/fusion/fusion.repository.js';
import { fusionRunsRepository } from '../src/modules/fusion/fusion-runs.repository.js';
import { countOutOfOrderBatches, replayAsReceived, replayInMemory, withTerrain } from '../src/modules/fusion/fusion.pipeline.js';
import { cutRawSamples, inputStats, summarizeReplayInput, trackStats } from '../src/modules/fusion/fusion.replay-input.js';
import { buildTimeline, type RawSamples } from '../src/modules/fusion/fusion.timeline.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';
import type { FusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { parseOverrides } from './fusion-replay-args.js';

const { values: args } = parseArgs({
  options: {
    session: { type: 'string', multiple: true }, cutoff: { type: 'string' }, from: { type: 'string' },
    version: { type: 'string', default: 'fusion-v4' }, set: { type: 'string', multiple: true }, json: { type: 'string' },
  },
});
if (!args.session?.length) throw new Error('--session=<uuid> is required (repeat for several sessions)');
const cutoff = args.cutoff ? Date.parse(args.cutoff) : null;
const from = args.from ? Date.parse(args.from) : -Infinity;
if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error('--cutoff is not a valid time');
const overrides = parseOverrides(args.set);
const algo = resolveAlgorithm(args.version!, overrides);
const q = (sorted: number[], p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] * 10) / 10 : null);
const windowed = (o: FusedOutput[]) => o.filter((x) => x.timestamp >= from && (cutoff === null || x.timestamp <= cutoff));

/** Median distance between two tracks at the same output second: how much they DIFFER, not how wrong either is. */
function difference(a: FusedOutput[], b: FusedOutput[]) {
  const at = new Map(b.map((o) => [Math.round(o.timestamp / 1000), o]));
  const d = a.flatMap((o) => {
    const p = at.get(Math.round(o.timestamp / 1000));
    return p ? [Math.hypot(o.x - p.x, o.y - p.y)] : [];
  }).sort((x, y) => x - y);
  return { seconds: d.length, p50: q(d, 0.5), p90: q(d, 0.9), max: q(d, 1) };
}

async function compare(sessionId: string) {
  const session = await sessionRepository.findView(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const spatialContext = await spatial.context(session.spatialMapVersionId);
  // SELECT only: terrain.sessionVersion() pins the version with an UPDATE, which a read-only connection refuses
  const terrainVersionId = algo.usesTerrain
    ? (await pool.query<{ id: string | null }>('SELECT terrain_version_id AS id FROM collection_sessions WHERE id = $1', [sessionId])).rows[0]?.id ?? null
    : null;
  const terrainContext = await terrain.context(terrainVersionId);
  const client = await pool.connect();
  let absoluteAltitudeEnabled = false;
  let all: RawSamples, arrival: RawSamples[], delays: { stream: string; rows: number; p50: number; p95: number; max: number }[], batches: { n: number; ooo: number };
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    all = await fusionRepository.loadRawSamples(sessionId, client);
    arrival = await fusionRunsRepository.loadArrivalBatches(sessionId, client);
    absoluteAltitudeEnabled = await sessionRepository.getAbsoluteAltitudeEnabled(sessionId, client);
    delays = (await client.query(
      `WITH s AS (
         SELECT 'locations' AS stream, "timestamp" AS ts, created_at AS rcv FROM location_samples WHERE session_id = $1
         UNION ALL SELECT 'motion', "timestamp", created_at FROM motion_samples WHERE session_id = $1
         UNION ALL SELECT 'altimeter', "timestamp", created_at FROM altimeter_samples WHERE session_id = $1
         UNION ALL SELECT 'absoluteAltitude', "timestamp", created_at FROM absolute_altitude_samples WHERE session_id = $1
         UNION ALL SELECT 'pedometer', "timestamp", created_at FROM pedometer_samples WHERE session_id = $1)
       SELECT stream, count(*)::int AS rows,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM rcv - ts)))::numeric, 2)::float8 AS p50,
              round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM rcv - ts)))::numeric, 2)::float8 AS p95,
              round(max(extract(epoch FROM rcv - ts))::numeric, 2)::float8 AS max
         FROM s WHERE ($2::timestamptz IS NULL OR ts <= $2) GROUP BY stream ORDER BY stream`,
      [sessionId, cutoff === null ? null : new Date(cutoff)],
    )).rows;
    batches = (await client.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE out_of_order)::int AS ooo FROM received_batches WHERE session_id = $1`, [sessionId])).rows[0];
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const raw = cutRawSamples(all, cutoff);
  const annotate = (s: RawSamples) => withTerrain(spatial.annotate(buildTimeline(s, { sessionStartedAt: session.startedAt }), spatialContext), terrainContext);
  const timeline = annotate(raw);
  const arrivalBatches = arrival.map((b) => annotate(cutRawSamples(b, cutoff))).filter((b) => b.length);

  // same height policy as the session's runs: an opted-in session never assumes a ground-level start
  const context = { strideCalibration: null, absoluteAltitudeEnabled };
  const received = replayAsReceived(algo, arrivalBatches, env.FUSION_REORDER_WINDOW_MS, context);
  const sensor = replayInMemory(algo, timeline, { finalize: true, context });
  const s = sensor.state as FusionStateV4;
  const fixWindow = s.fixes.map((f, i) => ({ f, w: s.smoothed?.fixWeights[i] ?? null, r: s.smoothed?.fixResiduals[i] ?? null })).filter(({ f }) => f.t >= from);
  const residuals = fixWindow.flatMap(({ r }) => (r === null ? [] : [r])).sort((a, b) => a - b);
  const byAccuracy = [[0, 10], [10, 20], [20, 35], [35, 51]].map(([lo, hi]) => {
    const rows = fixWindow.filter(({ f, r }) => f.accuracy >= lo && f.accuracy < hi && r !== null);
    const res = rows.map(({ r }) => r!).sort((a, b) => a - b);
    return { reportedAccuracyM: `${lo}-${hi}`, fixes: rows.length, residualP50: q(res, 0.5), residualP90: q(res, 0.9), residualAboveReported: rows.filter(({ f, r }) => r! > f.accuracy).length, downweighted: rows.filter(({ w }) => (w ?? 1) < 0.5).length };
  });
  const stepsIn = (state: unknown) => {
    const steps = (state as FusionStateV4).steps.filter((p) => p.t >= from);
    return { steps: steps.length, stairs: steps.filter((p) => p.stairs).length, slope: steps.filter((p) => p.slope).length, verticalUnknown: steps.filter((p) => p.verticalUnknown).length };
  };
  const stride = (state: unknown) => {
    const v = state as FusionStateV4;
    return { effectiveM: v.strideEffectiveM ?? null, source: v.strideSource ?? 'DEFAULT', levelStepsUsed: v.strideLevelSteps, calibrationWeight: Math.round(v.strideB * 10) / 10 };
  };
  const events = (list: unknown[]) => (list as { type: string; t: number; [k: string]: unknown }[])
    .filter((e) => ['heading-segment', 'heading', 'heading-fit-pending', 'reanchor', 'initialized'].includes(e.type))
    .map(({ type, t, ...rest }) => ({ at: new Date(t).toISOString().slice(11, 19), type, ...rest }));
  const vertical = {
    forwardContacts: s.contacts.length,
    gpsHeightsNearGround: s.gpsOffsets.length,
    gpsHeightSamples: s.datumSamples.length,
    final: s.smoothed ? { datumSource: s.smoothed.datumSource, contacts: s.smoothed.contacts, datumSigmaM: s.smoothed.datumSigma } : null,
    barometerSamples: s.zLog.length,
    altimeterRebases: s.counters.altimeterRebases,
  };
  return {
    session: { id: sessionId, collector: session.collectorId, platform: session.device.platform, status: session.status, startedAt: session.startedAt, finishRequestedAt: session.finishRequestedAt },
    algorithm: { version: algo.version, revision: algo.revision, overrides, terrainVersionId, spatialMapVersionId: session.spatialMapVersionId },
    input: { ...summarizeReplayInput(raw, cutoff), batches: batches.n, outOfOrderBatchesRecorded: batches.ooo, arrivalBatchesInCut: arrivalBatches.length, lateBeyondReorderWindowInCut: countOutOfOrderBatches(arrivalBatches, env.FUSION_REORDER_WINDOW_MS) },
    inputStats: { ...inputStats(raw, { sessionStartedAt: session.startedAt }), receiveDelayS: delays },
    asReceived: { skippedLateObservations: received.skippedLate, ...stepsIn(received.state), stride: stride(received.state), track: trackStats(windowed(received.forward)) },
    sensorForward: { ...stepsIn(sensor.state), stride: stride(sensor.state), track: trackStats(windowed(sensor.forward)), events: events(sensor.events) },
    final: { track: trackStats(windowed(sensor.outputs)), fixes: fixWindow.length, residualM: { p50: q(residuals, 0.5), p90: q(residuals, 0.9), max: q(residuals, 1) }, downweighted: fixWindow.filter(({ w }) => (w ?? 1) < 0.5).length, byAccuracy, segments: s.smoothed?.segments, segmentsWithHeading: s.smoothed?.segmentsWithHeading },
    vertical,
    differences: {
      asReceivedVsSensorForward: difference(windowed(received.forward), windowed(sensor.forward)),
      sensorForwardVsFinal: difference(windowed(sensor.forward), windowed(sensor.outputs)),
    },
  };
}

const out = [];
for (const id of args.session) out.push(await compare(id));
if (args.json) writeFileSync(args.json, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await pool.end();
