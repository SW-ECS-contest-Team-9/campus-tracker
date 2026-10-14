import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPLAUSIBLE_TIMESTAMP, TelemetryBatchRequest } from '../src/modules/telemetry/telemetry.dto.js';
import { LastSequences } from '../src/modules/sessions/session.dto.js';
import { telemetryRepository } from '../src/modules/telemetry/telemetry.repository.js';
import { sessionRepository } from '../src/modules/sessions/session.repository.js';
import { sessionService } from '../src/modules/sessions/session.service.js';
import { collectorRepository } from '../src/modules/collectors/collector.repository.js';
import { pool } from '../src/config/database.js';
import { buildTimeline, type RawSamples, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import { FUSION_ALGORITHMS } from '../src/modules/fusion/fusion.algorithms.js';
import { createFusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { processObservationV4, finalizeFusionV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { replayAsReceived, replayInMemory, ReorderBuffer } from '../src/modules/fusion/fusion.pipeline.js';
import { cutRawSamples, summarizeReplayInput } from '../src/modules/fusion/fusion.replay-input.js';
import { computeFusionMetrics } from '../src/modules/fusion/fusion.metrics.js';
import { tmForward } from '../src/geo/tm.js';
import type { TerrainContext } from '../src/geo/terrain.js';
import { walk, T0 } from './helpers/walk.js';

const LAT = 37.6158, LON = 127.0118;
const iso = (t: number) => new Date(t).toISOString();
function indoorTerrain(): TerrainContext {
  const p = tmForward(LAT, LON);
  return { versionId: 'test-terrain', grid: { originX: p.x - 200, originY: p.y - 200, resolution: 2, width: 200, height: 200 },
    heights: new Float32Array(40000).fill(100), sigma: new Float32Array(40000).fill(1), modified: new Uint8Array(40000), geoidSeparation: 23,
    buildings: [{ buildingId: 'b', name: 'test building', groundFloors: 10, undergroundFloors: 1, heightM: 40, floorLabels: [],
      polygons: [[[[p.x - 150, p.y - 150], [p.x + 150, p.y - 150], [p.x + 150, p.y + 150], [p.x - 150, p.y + 150], [p.x - 150, p.y - 150]]]] }] };
}
function rawHeight(seconds = 40): RawSamples {
  const raw = walk(seconds);
  // the phone's sea level = the map's (N 23 m) unless a test says otherwise
  raw.locations = raw.locations.map((l) => ({ ...l, altitude: l.ellipsoidalAltitude! - 23, horizontalAccuracy: 25, verticalAccuracy: 30 }));
  raw.absoluteAltitude = [1, 4, 7, 11, 15].map((sec, i) => ({ sequence: i, timestamp: iso(T0 + sec * 1000),
    altitude: 121 + (i % 2 ? 0.1 : 0), accuracy: 4, precision: 0.1, verticalReference: 'APPLE_MSL', segment: 'ABS-A' }));
  return raw;
}
function run(raw: RawSamples, mode = cfg.absoluteAltitudeMode, enabled = true) {
  const algo = FUSION_ALGORITHMS['fusion-v4'].withConfig!({ ...cfg, absoluteAltitudeMode: mode });
  const terrain = indoorTerrain();
  const timeline = buildTimeline(raw).map((o) => ({ ...o, terrainContext: terrain }));
  return replayInMemory(algo, timeline, { finalize: true, context: { strideCalibration: null, absoluteAltitudeEnabled: enabled } });
}

test('wire contract preserves optional absolute observations, null invalid values and negative heights', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const base = { batchId: id, sessionId: id };
  assert.equal(TelemetryBatchRequest.parse(base).absoluteAltitude, undefined);
  assert.equal(TelemetryBatchRequest.parse({ ...base, absoluteAltitude: null }).absoluteAltitude, undefined);
  const rows = [{ sequence: 0, timestamp: iso(T0), altitude: -3, accuracy: 4, precision: 0.1,
    verticalReference: 'APPLE_MSL', invalidReason: null },
  { sequence: 1, timestamp: iso(T0 + 1000), altitude: null, accuracy: null, precision: null,
    verticalReference: 'APPLE_MSL', invalidReason: 'NON_FINITE_ALTITUDE' }];
  const batch = TelemetryBatchRequest.parse({ ...base, absoluteAltitude: rows });
  assert.deepEqual(batch.absoluteAltitude, rows);
  assert.equal(LastSequences.parse({ absoluteAltitude: 1 }).absoluteAltitude, 1);
  assert.throws(() => TelemetryBatchRequest.parse({ ...base, absoluteAltitude: [{ ...rows[0], verticalReference: 'ELLIPSOIDAL' }] }));
  let sql = '', params: any[] = [];
  const db = { query: async (q: string, p: any[]) => { sql = q; params = p; return { rowCount: 2 }; } };
  assert.equal(await telemetryRepository.insertAbsoluteAltitude(db as any, id, batch.absoluteAltitude!), 2);
  assert.match(sql, /ON CONFLICT \(session_id, sequence\) DO NOTHING/);
  assert.deepEqual(params[3], [-3, null]);
  assert.deepEqual(params[7], [null, 'NON_FINITE_ALTITUDE']);
});

test('finish synchronization waits for the absolute stream, and old manifests remain compatible', async (t) => {
  t.mock.method(sessionRepository, 'maxSequences', async () => ({ location: null, motion: null, altimeter: null, pedometer: null, pedometer_count: 0, absoluteAltitude: 2 }));
  t.mock.method(sessionRepository, 'setSyncManifest', async () => {});
  assert.equal((await sessionService.compareManifest('s', { absoluteAltitude: 3 })).synchronized, false);
  assert.equal((await sessionService.compareManifest('s', { absoluteAltitude: 2 })).synchronized, true);
  const old = await sessionService.compareManifest('s', { altimeter: -1 });
  assert.equal(old.synchronized, true);
  assert.equal('absoluteAltitude' in old.streams, false);
});

test('a resumed session advertises absoluteAltitudeV1, so an older handshake cannot strand stored samples', async (t) => {
  const identity = { collectorId: 'C01', collectorDatabaseId: 'collector', deviceDatabaseId: 'device', clientDeviceId: 'phone' };
  t.mock.method(pool, 'connect', async () => ({ query: async () => ({}), release() {} }));
  t.mock.method(collectorRepository, 'upsertDevice', async () => {});
  t.mock.method(sessionRepository, 'insert', async () => null);
  t.mock.method(sessionRepository, 'findByClientSessionId', async () => ({
    id: 'session', client_session_id: 'client', collector_id: 'collector', device_id: 'device',
    started_at: new Date(T0), ended_at: new Date(T0 + 1000), status: 'FINISHED',
    stride_calibration: null, stride_calibration_status: 'FALLBACK', stride_calibration_reason: 'MISSING',
  }));
  const ack = await sessionService.start(identity, { clientSessionId: 'client', deviceId: 'phone', sensorCapabilities: {}, startedAt: iso(T0) });
  assert.equal(ack.resumed, true);
  assert.deepEqual(ack.supportedTelemetryFeatures, ['absoluteAltitudeV1']);
});

test('invalid candidate windows and mode overrides fail before replay', () => {
  const algo = FUSION_ALGORITHMS['fusion-v4'];
  for (const overrides of [{ absoluteAltitudeMode: 'typo' }, { absoluteAltitudeMinSamples: 0 },
    { absoluteAltitudeMaxAccuracyM: -1 }, { absoluteAltitudeMinSpanMs: 60_000 }]) {
    assert.throws(() => algo.withConfig!({ ...cfg, ...overrides }));
  }
});

test('flat indoor walk gets a provisional phone height without a 4m climb or double geoid/phone offset', () => {
  const r = run(rawHeight());
  const out = r.outputs.filter((p) => p.zDatumSource === 'CM_ABSOLUTE');
  assert.ok(out.length > 20);
  assert.ok(out.every((p) => Math.abs(p.ellipsoidalAltitude! - 144) < 0.15)); // 121 MSL + 23 N, no +1 phone offset
  assert.ok(out.every((p) => p.zDatumSigma! >= 5));
  const state = r.state as ReturnType<typeof createFusionStateV4>;
  assert.equal(state.absoluteAltitude.accepted, 1);
  assert.equal(state.smoothed!.datumSource, 'CM_ABSOLUTE');
  assert.ok(r.forward.some((p) => p.zDatumSource === 'NONE'));
  assert.ok(r.forward.some((p) => p.zDatumSource === 'CM_ABSOLUTE'));
});

test('APPLE_MSL is converted through the phone\'s measured geoid, not the map geoid (campus: 22.6 vs 23 m)', () => {
  const raw = rawHeight();
  raw.locations = raw.locations.map((l) => ({ ...l, altitude: l.ellipsoidalAltitude! - 22.6 }));
  const r = run(raw);
  const out = r.outputs.filter((p) => p.zDatumSource === 'CM_ABSOLUTE');
  assert.ok(out.length > 20);
  // ellipsoidal = Apple MSL + Apple geoid (121 + 22.6); the map geoid only converts to and from orthometric
  assert.ok(out.every((p) => Math.abs(p.ellipsoidalAltitude! - 143.6) < 0.15));
  const forward = r.forward.filter((p) => p.zDatumSource === 'CM_ABSOLUTE');
  assert.ok(forward.length && forward.every((p) => Math.abs(p.ellipsoidalAltitude! - 143.6) < 0.15), 'fix before the anchor: no step');
  const frame = FUSION_ALGORITHMS['fusion-v4'].summarize(r.state, r.events).absoluteAltitude!.verticalFrame;
  assert.ok(Math.abs(frame.deviceGeoidM! - 22.6) < 1e-9);
  assert.equal(frame.mapGeoidM, 23);
  // no fix with both heights: Apple's sea level is taken as the map's (identity, as before)
  const none = rawHeight();
  none.locations = none.locations.map((l) => ({ ...l, altitude: null }));
  assert.ok(run(none).outputs.filter((p) => p.zDatumSource === 'CM_ABSOLUTE').every((p) => Math.abs(p.ellipsoidalAltitude! - 144) < 0.15));
});

test('an absolute-altitude row with an implausible time is kept for the manifest but cannot reject the batch', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const future = new Date(Date.now() + 25 * 365 * 86_400_000).toISOString(); // old iOS clock mapping
  const batch = TelemetryBatchRequest.parse({ batchId: id, sessionId: id,
    locations: [{ sequence: 1, timestamp: iso(T0), latitude: LAT, longitude: LON }],
    absoluteAltitude: [{ sequence: 1, timestamp: future, altitude: 150, accuracy: 4, precision: 0.5, verticalReference: 'APPLE_MSL' },
      { sequence: 2, timestamp: iso(T0), altitude: 150, accuracy: 4, precision: 0.5, verticalReference: 'APPLE_MSL' }] });
  assert.equal(batch.locations.length, 1);
  assert.deepEqual(batch.absoluteAltitude!.map((a) => a.invalidReason ?? null), [IMPLAUSIBLE_TIMESTAMP, null]);
  assert.throws(() => TelemetryBatchRequest.parse({ batchId: id, sessionId: id,
    locations: [{ sequence: 1, timestamp: future, latitude: LAT, longitude: LON }] }), 'primary streams stay strict');
});

test('missing or inaccurate absolute height stays unknown for opted-in sessions; legacy results are preserved', () => {
  const missing = rawHeight(); missing.absoluteAltitude = [];
  assert.ok(run(missing).outputs.every((p) => p.zDatumSource === 'NONE' && p.ellipsoidalAltitude === null));
  const bad = rawHeight(); bad.absoluteAltitude = bad.absoluteAltitude!.map((a) => ({ ...a, accuracy: 30 }));
  assert.ok(run(bad).outputs.every((p) => p.zDatumSource === 'NONE'));
  assert.ok(run(missing, 'fallback', false).outputs.every((p) => p.zDatumSource === 'TERRAIN_FALLBACK'));
});

test('off and shadow reports do not change XY, relative Z, stationary time or output timestamps', () => {
  const raw = rawHeight(), plain = { ...raw, absoluteAltitude: [] };
  for (const mode of ['off', 'shadow'] as const) {
    const a = run(raw, mode), b = run(plain, mode);
    assert.deepEqual(a.forward, b.forward);
    assert.deepEqual(a.outputs, b.outputs);
    assert.equal((a.state as any).counters.stationaryMs, (b.state as any).counters.stationaryMs);
  }
  const baseline = run(plain, 'off'), active = run(raw);
  assert.deepEqual(active.outputs.map((p) => [p.timestamp, p.x, p.y, p.z]), baseline.outputs.map((p) => [p.timestamp, p.x, p.y, p.z]));
});

test('relative climb is preserved; a repeated bad absolute report cannot inject a height jump', () => {
  const raw = rawHeight();
  raw.altimeter = raw.altimeter.map((a) => ({ ...a, relativeAltitude: Math.max(0, (Date.parse(a.timestamp as string) - T0 - 20_000) / 1000) * 0.3 }));
  raw.absoluteAltitude!.push({ ...raw.absoluteAltitude![0], sequence: 99, timestamp: iso(T0 + 30_000), altitude: 200 });
  const r = run(raw), last = r.outputs.at(-1)!;
  assert.ok(last.z > 5);
  assert.ok(Math.abs(last.ellipsoidalAltitude! - (144 + last.z)) < 0.15);
  assert.equal((r.state as any).absoluteAltitude.rejected.DATUM_CONFLICT, 1);
});

test('an established trusted GPS reference takes precedence over the API fallback', () => {
  const raw = rawHeight();
  raw.locations = raw.locations.map((l) => ({ ...l, ellipsoidalAltitude: 124, horizontalAccuracy: 5, verticalAccuracy: 3 }));
  const r = run(raw);
  assert.ok(r.outputs.length > 20);
  // including the first output, before the first barometer sample: relative Z starts from that sample's zero
  assert.ok(r.outputs.every((p) => p.zDatumSource === 'GPS' && Math.abs(p.ellipsoidalAltitude! - 124) < 0.01));
});

test('a relative sensor restart does not carry an old height reference through unknown movement', () => {
  const raw = rawHeight();
  raw.altimeter = raw.altimeter.map((a) => Date.parse(a.timestamp as string) < T0 + 20_000 ? a : { ...a, segment: 'B', relativeAltitude: 0 });
  const r = run(raw);
  assert.ok(r.outputs.some((p) => p.zDatumSource === 'CM_ABSOLUTE'));
  assert.ok(r.outputs.filter((p) => p.timestamp > T0 + 21_000).every((p) => p.zDatumSource === 'NONE'));
  // unknown-height points keep relative Z in geomZ: the Z range check must not compare it with absolute heights
  const metrics = computeFusionMetrics(buildTimeline(raw), r.outputs, FUSION_ALGORITHMS['fusion-v4'].summarize(r.state, r.events));
  assert.deepEqual(metrics.validation.warnings.filter((w) => w.code.includes('Z_')), []);
  raw.absoluteAltitude!.push(...[22, 25, 28].map((sec, i) => ({ ...raw.absoluteAltitude![0], sequence: 100 + i, timestamp: iso(T0 + sec * 1000), altitude: 130 })));
  const recovered = run(raw);
  assert.ok(recovered.outputs.filter((p) => p.timestamp > T0 + 29_000).every((p) => Math.abs(p.ellipsoidalAltitude! - 153) < 0.01));
});

test('missing datum transform, stale relative samples and unstable candidates cannot establish a datum', () => {
  for (const scenario of ['no-transform', 'stale', 'unstable']) {
    const raw = rawHeight();
    if (scenario === 'stale') raw.altimeter = raw.altimeter.slice(0, 1);
    if (scenario === 'unstable') raw.absoluteAltitude = raw.absoluteAltitude!.map((a, i) => ({ ...a, altitude: 120 + i * 10 }));
    const s = createFusionStateV4({ strideCalibration: null, absoluteAltitudeEnabled: true });
    const terrain = indoorTerrain();
    for (const o of buildTimeline(raw)) processObservationV4(s, { ...o, terrainContext: scenario === 'no-transform' ? null : terrain }, cfg);
    assert.equal(s.absoluteAltitude.accepted, 0, scenario);
  }
});

test('new height input is hashed and cut by sensor time, and old algorithms ignore it entirely', () => {
  const raw = rawHeight();
  const hash = summarizeReplayInput(raw, null).hash;
  assert.notEqual(hash, summarizeReplayInput({ ...raw, absoluteAltitude: raw.absoluteAltitude!.map((a) => ({ ...a, accuracy: 7 })) }, null).hash);
  const cut = cutRawSamples(raw, T0 + 5000);
  assert.equal(cut.absoluteAltitude!.length, 2);
  assert.ok(run(cut).outputs.every((p) => p.ellipsoidalAltitude === null));
  const observations = buildTimeline(raw);
  for (const algo of Object.values(FUSION_ALGORITHMS).filter((a) => a.version !== 'fusion-v4')) {
    const a = replayInMemory(algo, observations, { finalize: true });
    const b = replayInMemory(algo, observations.filter((o) => o.kind !== 'absoluteAltitude'), { finalize: true });
    assert.deepEqual(a.outputs, b.outputs, algo.version);
    assert.deepEqual(a.state, b.state, algo.version);
  }
});

test('absolute reports never advance the reorder watermark; ordered arrival reproduces the forward pass', () => {
  const buffer = new ReorderBuffer(3500);
  const future: Observation = { kind: 'absoluteAltitude', t: T0 + 100_000, seq: 0, altitude: 121, accuracy: 4, precision: 1, verticalReference: 'APPLE_MSL' };
  assert.deepEqual(buffer.push([future]), []);
  assert.equal(buffer.maxSeenT, -Infinity);
  const raw = rawHeight(), terrain = indoorTerrain(), timeline = buildTimeline(raw).map((o) => ({ ...o, terrainContext: terrain }));
  const received = replayAsReceived(FUSION_ALGORITHMS['fusion-v4'], [timeline.slice(0, 500), timeline.slice(500)], 3500,
    { strideCalibration: null, absoluteAltitudeEnabled: true });
  assert.deepEqual(received.outputs, run(raw).forward);
});
