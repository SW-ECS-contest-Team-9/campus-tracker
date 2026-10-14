// ACTIVE snapshot isolation + finish / late upload / restart idempotency against a real database.
// Only an explicitly supplied disposable PostGIS test database is used. Never defaults to .env DATABASE_URL.
//   FUSION_TEST_DATABASE_URL=postgresql://.../campus_fusion_test npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RawSamples } from '../src/modules/fusion/fusion.timeline.js';
import { batch, T0, walk } from './helpers/walk.js';

const V = 'fusion-v4';
const raw = walk(120);
const iso = (ms: number) => new Date(ms).toISOString();

/** Raw rows of [from, to) seconds as an upload batch (telemetry DTO shape). */
function upload(sessionId: string, from: number, to: number, batchId: string = randomUUID()) {
  const b: RawSamples = batch(raw, from, to);
  return {
    batchId, sessionId,
    locations: b.locations.map((l) => ({ ...l, timestamp: l.timestamp as string })),
    motion: b.motion.map((m) => ({
      sequence: m.sequence, timestamp: m.timestamp as string, sensorSegmentId: m.segment,
      userAcceleration: { x: m.ax, y: m.ay, z: m.az }, gravity: { x: m.gx, y: m.gy, z: m.gz }, attitude: { yaw: m.yaw },
    })),
    altimeter: b.altimeter.map((a) => ({ sequence: a.sequence, timestamp: a.timestamp as string, relativeAltitude: a.relativeAltitude, sensorSegmentId: a.segment })),
    pedometer: b.pedometer.map((p) => ({ timestamp: p.timestamp as string, numberOfSteps: p.numberOfSteps, distance: p.distance, sensorSegmentId: p.segment })),
  };
}

test('ACTIVE forward state vs unpublished finalized snapshot; finish, lost ACK, late upload and restart', { skip: !process.env.FUSION_TEST_DATABASE_URL, timeout: 120_000 }, async () => {
  const url = new URL(process.env.FUSION_TEST_DATABASE_URL!);
  assert.match(url.pathname, /_test$/, 'Use a disposable database whose name ends in _test');
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_REPROCESS_IDLE_DELAY_MS = '300';
  const { pool } = await import('../src/config/database.js');
  const { migrate } = await import('../src/db/migrator.js');
  const { sessionService } = await import('../src/modules/sessions/session.service.js');
  const { telemetryService } = await import('../src/modules/telemetry/telemetry.service.js');
  const { TelemetryBatchRequest } = await import('../src/modules/telemetry/telemetry.dto.js');
  const { fusionService, replaySession } = await import('../src/modules/fusion/fusion.service.js');
  const { fusionRunsRepository } = await import('../src/modules/fusion/fusion-runs.repository.js');
  const { FUSION_ALGORITHMS } = await import('../src/modules/fusion/fusion.algorithms.js');
  const { replayInMemory } = await import('../src/modules/fusion/fusion.pipeline.js');
  const { buildTimeline } = await import('../src/modules/fusion/fusion.timeline.js');
  const { AppError } = await import('../src/common/errors/app-error.js');

  const collector = randomUUID(), device = randomUUID(), code = `FT${collector.slice(0, 6)}`;
  const one = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as T;
  const until = async (label: string, check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`timed out: ${label}`);
  };
  try {
    await migrate();
    await pool.query('INSERT INTO collectors(id, collector_code) VALUES ($1, $2)', [collector, code]);
    await pool.query('INSERT INTO devices(id, collector_id, client_device_id) VALUES ($1, $2, $3)', [device, collector, 'fusion-test-phone']);
    const identity = { collectorId: code, collectorDatabaseId: collector, deviceDatabaseId: device, clientDeviceId: 'fusion-test-phone' };
    const started = await sessionService.start(identity, { clientSessionId: randomUUID(), deviceId: 'fusion-test-phone', sensorCapabilities: {}, startedAt: iso(T0) } as any);
    const id = started.sessionId;
    const ingest = (from: number, to: number, batchId?: string) => telemetryService.ingestBatch(identity, TelemetryBatchRequest.parse(upload(id, from, to, batchId)));
    const state = () => one(`SELECT status, fusion_state, needs_reprocess, finalized_at, finish_requested_at, ended_at, last_received_at::text, out_of_order_batches FROM collection_sessions WHERE id = $1`, [id]);
    const fused = () => one<{ n: number; last: string | null }>(`SELECT count(*)::int AS n, max(created_at)::text AS last FROM fused_positions WHERE session_id = $1 AND algorithm_version = $2`, [id, V]);
    const counts = () => one<{ m: number; l: number; a: number; p: number }>(
      `SELECT (SELECT count(*) FROM motion_samples WHERE session_id = $1)::int m, (SELECT count(*) FROM location_samples WHERE session_id = $1)::int l,
              (SELECT count(*) FROM altimeter_samples WHERE session_id = $1)::int a, (SELECT count(*) FROM pedometer_samples WHERE session_id = $1)::int p`, [id]);

    // ---- collecting: batches, a resend after a lost ACK ----
    const firstBatch = randomUUID();
    assert.equal((await ingest(0, 10, firstBatch)).duplicate, false);
    assert.equal((await ingest(0, 10, firstBatch)).duplicate, true, 'resend after a lost ACK is answered as stored');
    for (const from of [10, 20, 30]) await ingest(from, from + 10);
    assert.equal((await counts()).m, 2000, 'no duplicate rows');

    // ---- published replay of an ACTIVE session: forward only, realtime continues from it ----
    const published = await fusionService.reprocess(id, V, true) as any;
    const pubRun = await fusionRunsRepository.get(published.runId);
    assert.equal(pubRun.published, true);
    assert.deepEqual([pubRun.metrics.replay.continuesLive, pubRun.metrics.replay.finalizeApplied, pubRun.metrics.replay.sessionStatusAtRun], [true, false, 'ACTIVE']);
    assert.equal((await fusionRunsRepository.positions(published.runId, 'FORWARD')).length, 0, 'one stage only: the forward pass');
    const before = { state: await state(), fused: await fused(), live: (await fusionService.summary(id)).live };
    assert.deepEqual([before.state.status, before.state.fusion_state, before.state.finalized_at], ['ACTIVE', 'CLEAN', null]);
    assert.ok(before.live, 'realtime state continues from the replay');

    // ---- unpublished experiments with a cutoff: their own snapshot, nothing operational changes ----
    const cutoff = new Date(T0 + 30_000);
    const exp = await replaySession(id, V, 'lab', { publish: false, cutoff });
    assert.deepEqual([exp.published, exp.replay.finalizeApplied, exp.replay.continuesLive, exp.replay.input.cutoff], [false, true, false, cutoff.toISOString()]);
    assert.equal(exp.replay.input.counts.motion, 1501);
    const [fin, fwd] = [await fusionRunsRepository.positions(exp.runId, 'FINAL'), await fusionRunsRepository.positions(exp.runId, 'FORWARD')];
    assert.ok(fin.length > 20 && fwd.length > 20, 'FORWARD and FINAL stages are both stored');
    assert.ok(Math.max(...fin.map((p) => p.t)) <= cutoff.getTime() + 1000, 'nothing after the cutoff');
    assert.ok(exp.replay.stages.final!.headingUnknownOutputs <= exp.replay.stages.forward.headingUnknownOutputs);
    const forwardOnly = await replaySession(id, V, 'lab', { publish: false, cutoff, finalize: false });
    assert.equal(forwardOnly.replay.finalizeApplied, false);
    assert.equal(forwardOnly.replay.stages.final, null);
    const received = await replaySession(id, V, 'lab', { publish: false, cutoff, mode: 'AS_RECEIVED' });
    assert.equal(received.replay.input.hash, exp.replay.input.hash, 'same cutoff => same input, whatever the ordering mode');
    assert.deepEqual([received.replay.ordering, received.replay.asReceived!.skippedLateObservations], ['ARRIVAL_BATCHES', 0]);
    await assert.rejects(replaySession(id, V, 'lab', { publish: true, cutoff }), (e: unknown) => e instanceof AppError && e.code === 'NOT_PUBLISHABLE');
    assert.deepEqual({ state: await state(), fused: await fused() }, { state: before.state, fused: before.fused }, 'experiments left the session and its published result alone');
    assert.deepEqual((await fusionService.summary(id)).live, before.live, 'and the realtime state');

    // ---- realtime goes on; then a backlog arrives after newer data (out of order) ----
    await ingest(40, 50);
    await until('realtime appended outputs', async () => (await fused()).n > before.fused.n);
    await ingest(70, 80);
    await ingest(50, 70); // captured before data the server already has
    const dirty = await state();
    assert.deepEqual([dirty.status, dirty.out_of_order_batches, dirty.needs_reprocess], ['ACTIVE', 1, true]);
    assert.equal((await counts()).m, 4000, 'late rows are stored');

    // ---- finish (phone still holds 80-120 s), the same finish again after a lost ACK ----
    const lastMotion = raw.motion.at(-1)!.sequence;
    const f1 = await sessionService.finish(identity, { sessionId: id, endedAt: iso(T0 + 120_000), lastSequences: { motion: lastMotion } } as any);
    assert.deepEqual([f1.status, f1.sync!.synchronized, f1.sync!.streams.motion.server], ['FINISHED', false, 3999]);
    const f2 = await sessionService.finish(identity, { sessionId: id, endedAt: iso(T0 + 999_000), lastSequences: { motion: lastMotion } } as any);
    assert.equal(f2.endedAt, f1.endedAt, 'the first finish wins');
    await until('final replay after uploads go idle', async () => (await state()).finalized_at !== null);
    const detail = await sessionService.detail(id) as any;
    assert.deepEqual([detail.finalization.manifestSynchronized, detail.finalization.pendingOnDevice, detail.finalization.lastPublishedRun.trigger], [false, 'SOME', 'auto-finalize']);

    // ---- late upload after finish, then a server restart before the debounced replay ran ----
    await ingest(80, 120);
    const late = await state();
    assert.deepEqual([late.status, late.finalized_at, late.needs_reprocess], ['FINISHED', null, true], 'new raw reopens finalization, not collection');
    fusionService.forget([id]); // process memory (live state, timers) is gone
    await fusionService.recoverPending();
    await until('final replay recovered after restart', async () => (await state()).finalized_at !== null);
    const done = await state();
    assert.deepEqual([done.status, done.fusion_state, done.needs_reprocess], ['FINISHED', 'CLEAN', false]);
    assert.deepEqual(await counts(), { m: raw.motion.length, l: raw.locations.length, a: raw.altimeter.length, p: raw.pedometer.length }, 'no raw loss, no duplicates');

    // ---- the stored result is the sensor-time FINAL of all raw rows, whatever order they arrived in ----
    const expected = replayInMemory(FUSION_ALGORITHMS[V], buildTimeline(raw, { sessionStartedAt: iso(T0) }), { finalize: true }).outputs;
    const stored = (await pool.query(`SELECT local_x x, local_y y FROM fused_positions WHERE session_id = $1 AND algorithm_version = $2 ORDER BY fusion_sequence`, [id, V])).rows;
    assert.equal(stored.length, expected.length);
    stored.forEach((p, i) => assert.ok(Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < 1e-6, `output ${i}`));

    // ---- syncComplete (twice): the manifest now agrees ----
    const sync = await sessionService.syncComplete(identity, { sessionId: id, lastSequences: { motion: lastMotion } } as any);
    assert.equal(sync.synchronized, true);
    assert.equal((await sessionService.syncComplete(identity, { sessionId: id, lastSequences: { motion: lastMotion } } as any)).synchronized, true);
    await until('final replay after syncComplete', async () => (await state()).finalized_at !== null && (await state()).fusion_state === 'CLEAN');
    assert.equal(((await sessionService.detail(id)) as any).finalization.pendingOnDevice, 0);

    // ---- the trace connects finish -> final replay ----
    await until('trace written', async () => (await sessionService.diagnosticEventList(id)).filter((e) => e.eventType === 'SERVER_SYNC_COMPLETE_RECEIVED').length === 2);
    const trace = (await sessionService.diagnosticEventList(id)).filter((e) => e.source === 'server');
    const of = (type: string) => trace.filter((e) => e.eventType === type);
    assert.deepEqual(of('SERVER_FINISH_RECEIVED').map((e) => e.metadata!.duplicate), [false, true]);
    assert.ok(of('SERVER_FINALIZE_COMPLETED').length >= 2);
    assert.equal(of('SERVER_FINALIZE_FAILED').length, 0);
  } finally {
    await new Promise((r) => setTimeout(r, 600)); // let debounced work settle before the rows go away
    await pool.query('DELETE FROM collectors WHERE id = $1', [collector]).catch(() => undefined);
    await pool.end();
  }
});
