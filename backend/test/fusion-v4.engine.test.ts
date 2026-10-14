// fusion-v4 unit tests on a synthetic walk with known ground truth (no DB).  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { finalizeFusionV4, processObservationV4, type FusionEventV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { createFusionStateV4, type FusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';
import { tmForward } from '../src/geo/tm.js';
import type { TerrainContext } from '../src/geo/terrain.js';
import type { StartHeightMap } from '../src/geo/start-height-map.js';

const ORIGIN = { latitude: 37.6158, longitude: 127.0118, height: 0 };
const T0 = Date.parse('2026-10-02T06:00:00.000Z');
const THETA_TRUE = 1.0; // device yaw frame is arbitrary: walking direction = -yaw + THETA_TRUE

// deterministic pseudo-random (LCG) + Box-Muller
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

/**
 * vzMps: the barometer moves while walking = stairs (0.3 m tread; CMPedometer keeps its flat stride), or with slope a
 * ramp / hill road (full steps of strideM). uncounted: steps CMPedometer does not count (fidgeting on the spot).
 */
interface Leg { durationS: number; headingDeg: number; walking: boolean; vzMps?: number; slope?: boolean; strideM?: number; uncounted?: boolean }
/** Truth + raw observations: 50 Hz motion (2 steps/s), CMPedometer every 2.5 s, 1 Hz barometer, GPS every 2 s. */
function simulate(legs: Leg[], opts: { gpsSigma?: number; gpsAccuracy?: number; seed?: number; stride?: number } = {}) {
  const r = rng(opts.seed ?? 7);
  const stride = opts.stride ?? 0.75;
  const obs: Observation[] = [];
  const truth: { t: number; x: number; y: number }[] = [];
  let seq = 0;
  let x = 0, y = 0, z = 0, steps = 0, dist = 0, t = 0;
  let heading = legs[0].headingDeg * Math.PI / 180;
  let lastStepAt = -1;
  const dt = 0.02;
  for (const leg of legs) {
    const target = leg.headingDeg * Math.PI / 180;
    for (let i = 0; i < leg.durationS / dt; i++, t += dt) {
      heading += Math.max(-0.05, Math.min(0.05, target - heading)); // turn over ~0.5 s
      const ms = T0 + Math.round(t * 1000);
      const phase = 2 * Math.PI * 2 * t;
      const az = leg.walking ? 0.2 * Math.sin(phase) + 0.01 * r.n() : 0.005 * r.n();
      obs.push({ kind: 'motion', t: ms, seq: seq++, yaw: -(heading - THETA_TRUE), ax: 0.005 * r.n(), ay: 0.005 * r.n(), az, gx: 0, gy: 0, gz: -1 });
      if (leg.walking && Math.floor(t * 2) !== lastStepAt) {
        lastStepAt = Math.floor(t * 2);
        const stairs = Boolean(leg.vzMps) && !leg.slope;
        const L = leg.uncounted ? 0 : stairs ? 0.3 : (leg.strideM ?? stride);
        x += L * Math.sin(heading); y += L * Math.cos(heading);
        if (!leg.uncounted) { steps++; dist += stairs ? stride : L; } // CMPedometer uses a flat stride even on stairs
      }
      z += (leg.vzMps ?? 0) * dt;
      truth.push({ t: ms, x, y });
      const k = Math.round(t / dt);
      if (k % 125 === 0) obs.push({ kind: 'pedometer', t: ms, seq: seq++, steps, distance: dist });
      if (k % 50 === 25) obs.push({ kind: 'altimeter', t: ms, seq: seq++, relativeAltitude: z });
      if (k % 100 === 60) {
        const p = localToWgs84(ORIGIN, { x: x + (opts.gpsSigma ?? 8) * r.n(), y: y + (opts.gpsSigma ?? 8) * r.n(), z: 0 });
        obs.push({ kind: 'gps', t: ms, seq: seq++, latitude: p.latitude, longitude: p.longitude, altitude: 60, ellipsoidalAltitude: 90 + z, horizontalAccuracy: opts.gpsAccuracy ?? 12, verticalAccuracy: 8, speed: -1, course: -1 });
      }
    }
  }
  return { obs: obs.sort(compareObservations), truth };
}

function run(obs: Observation[]) {
  const s = createFusionStateV4();
  const outputs: FusedOutput[] = [];
  const events: FusionEventV4[] = [];
  for (const o of obs) {
    const r = processObservationV4(s, o, cfg);
    outputs.push(...r.outputs);
    events.push(...r.events);
  }
  return { s, outputs, events };
}

/** Error of each output against the truth, in the frame of the first GPS fix (the engine's origin). */
function errors(s: FusionStateV4, outputs: FusedOutput[], truth: { t: number; x: number; y: number }[]) {
  const ox = localToWgs84(ORIGIN, { x: 0, y: 0, z: 0 });
  const dx = (s.origin!.longitude - ox.longitude) * Math.PI / 180 * 6371008.8 * Math.cos(ORIGIN.latitude * Math.PI / 180);
  const dy = (s.origin!.latitude - ox.latitude) * Math.PI / 180 * 6371008.8;
  return outputs.map((o) => {
    const tr = truth.reduce((best, p) => (Math.abs(p.t - o.timestamp) < Math.abs(best.t - o.timestamp) ? p : best));
    return Math.hypot(o.x + dx - tr.x, o.y + dy - tr.y);
  });
}
const rms = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);

test('provisional Z uses the best vertical accuracy, preserves barometric rise, and survives replay', () => {
  const gps = (t: number, height: number, accuracy: number): Observation => ({
    kind: 'gps', t: T0 + t, seq: t, latitude: ORIGIN.latitude, longitude: ORIGIN.longitude,
    altitude: null, ellipsoidalAltitude: height, horizontalAccuracy: 12, verticalAccuracy: accuracy, speed: -1, course: -1,
  });
  const { s, outputs } = run([
    { kind: 'altimeter', t: T0, seq: 0, relativeAltitude: 10 },
    gps(0, 100, 40),
    { kind: 'altimeter', t: T0 + 1000, seq: 1, relativeAltitude: 12 },
    gps(2000, 110, 25),
    gps(3000, 150, 35),
    { kind: 'altimeter', t: T0 + 4000, seq: 2, relativeAltitude: 13 },
    gps(5000, 150, 35),
  ]);
  assert.equal(outputs[0].ellipsoidalAltitude, 100);
  assert.equal(outputs[0].zDatumSource, 'GPS_FALLBACK');
  assert.equal(outputs[0].zDatumSigma, 40);
  const last = outputs.at(-1)!;
  assert.equal(last.ellipsoidalAltitude, 111); // best fix at Z=2, then one more meter
  assert.equal(last.z, 3);
  assert.equal(last.zDatumSigma, 25);
  const replay = finalizeFusionV4(s, cfg).outputs;
  assert.ok(replay.length > 0);
  assert.ok(replay.every((o) => o.zDatumSource === 'GPS_FALLBACK' && o.zDatumSigma === 25));
  assert.equal(s.smoothed!.datumSource, 'GPS_FALLBACK');
  assert.equal(replay.at(-1)!.ellipsoidalAltitude, 111);
});

test('provisional Z ignores invalid/pre-session heights and does not require horizontal acceptance', () => {
  const s = createFusionStateV4();
  const gps = (t: number, height: number | null, accuracy: number | null, extra = {}) => processObservationV4(s, {
    kind: 'gps', t: T0 + t, seq: t, latitude: ORIGIN.latitude, longitude: ORIGIN.longitude,
    altitude: null, ellipsoidalAltitude: height, horizontalAccuracy: 12, verticalAccuracy: accuracy, speed: -1, course: -1, ...extra,
  }, cfg);
  for (const [i, accuracy] of [null, -1, 0, NaN, Infinity].entries()) {
    const out = gps(i * 1000, 100, accuracy).outputs.at(-1)!;
    assert.equal(out.ellipsoidalAltitude, null);
    assert.equal(out.zDatumSource, 'NONE');
  }
  gps(5000, null, 1);
  gps(6000, NaN, 1);
  gps(7000, 999, 1, { preSession: true });
  assert.equal(s.bestGpsDatum, undefined);
  const out = gps(8000, 120, 25, { horizontalAccuracy: cfg.gpsMaxAccuracyM + 1 }).outputs.at(-1)!;
  assert.equal(out.gpsUsed, false);
  assert.equal(out.ellipsoidalAltitude, 120);
  assert.equal(out.zDatumSource, 'GPS_FALLBACK');
});

test('a trusted GPS datum replaces provisional Z', () => {
  const { outputs } = run([30, 8].map((accuracy, i): Observation => ({
    kind: 'gps', t: T0 + i * 1000, seq: i, latitude: ORIGIN.latitude, longitude: ORIGIN.longitude,
    altitude: null, ellipsoidalAltitude: 100 + i, horizontalAccuracy: 12, verticalAccuracy: accuracy, speed: -1, course: -1,
  })));
  assert.equal(outputs[0].zDatumSource, 'GPS_FALLBACK');
  assert.equal(outputs[1].zDatumSource, 'GPS');
  assert.equal(outputs[1].ellipsoidalAltitude, 101);
});

test('confirmed mapped road passage corrects indoor Z retrospectively, preserves later barometric climb, and leaves XY independent', () => {
  const xy = tmForward(ORIGIN.latitude, ORIGIN.longitude);
  const terrain: TerrainContext = { versionId: 't',
    grid: { originX: xy.x - 200, originY: xy.y - 200, resolution: 2, width: 250, height: 250 },
    heights: new Float32Array(62500).fill(100), sigma: new Float32Array(62500).fill(1), modified: new Uint8Array(62500), geoidSeparation: 23,
    buildings: [{ buildingId: 'b', name: 'indoor', groundFloors: 5, undergroundFloors: 1, heightM: 20, floorLabels: [],
      polygons: [[[[xy.x - 150, xy.y - 150], [xy.x + 150, xy.y - 150], [xy.x + 150, xy.y + 150], [xy.x - 150, xy.y + 150], [xy.x - 150, xy.y - 150]]]] }],
  };
  const map: StartHeightMap = { mapVersionId: 'm', floors: [], roads: [{ id: 'indoor-road', buildingId: 'b', levelId: 'L2', status: 'APPROVED', revision: 1,
    coordinates: [[xy.x, xy.y, 110], [xy.x, xy.y + 120, 110]] }] };
  const { obs } = simulate([{ durationS: 60, headingDeg: 0, walking: true }, { durationS: 20, headingDeg: 90, walking: true, vzMps: 0.1, slope: true }], { gpsSigma: 1, gpsAccuracy: 3 });
  const finals: FusedOutput[][] = [];
  for (const enabled of [false, true]) {
    const c = { ...cfg, roadHeightAnchorsEnabled: enabled };
    const s = createFusionStateV4({ strideCalibration: null, startHeightMap: map });
    const live: FusedOutput[] = [];
    for (const o of obs) live.push(...processObservationV4(s, { ...o, terrainContext: terrain }, c).outputs);
    if (enabled) {
      assert.ok(s.roadHeightContacts.length > 0);
      assert.ok(live.some((p) => p.zDatumSource === 'ROAD_ANCHOR'));
    }
    const fin = finalizeFusionV4(s, c).outputs;
    finals.push(fin);
    assert.ok(fin.length > 0);
    assert.ok(fin.every((p) => p.zDatumSource === (enabled ? 'ROAD_ANCHOR' : 'TERRAIN_FALLBACK')));
    if (enabled) {
      assert.ok(s.roadHeightContacts.length > 0);
      assert.ok(fin.every((p) => Math.abs(p.ellipsoidalAltitude! - p.z - 134) < 0.1));
      assert.ok(fin.at(-1)!.ellipsoidalAltitude! - fin[0].ellipsoidalAltitude! > 1.5);
      // A cached forward match is not evidence if the final path does not pass that road.
      s.startHeightMap = { ...map, roads: map.roads.map((r) => ({ ...r,
        coordinates: r.coordinates.map(([x, y, z]): [number, number, number] => [x - 30, y, z]),
      })) };
      const invalidated = finalizeFusionV4(s, c).outputs;
      assert.equal(s.roadHeightContacts.length, 0);
      assert.ok(invalidated.length > 0);
      assert.ok(invalidated.every((p) => p.zDatumSource === 'TERRAIN_FALLBACK'));
    }
  }
  assert.deepEqual(finals[0].map((p) => [p.timestamp, p.x, p.y]), finals[1].map((p) => [p.timestamp, p.x, p.y]));
});

test('steps are detected from 50 Hz vertical acceleration (2 steps/s for 60 s)', () => {
  const { obs } = simulate([{ durationS: 60, headingDeg: 0, walking: true }]);
  const { s } = run(obs);
  assert.ok(Math.abs(s.steps.length - 120) <= 4, `steps ${s.steps.length}`);
});

test('heading offset is found from the walked shape vs noisy 12 m GPS (yaw frame arbitrary)', () => {
  const { obs } = simulate([{ durationS: 30, headingDeg: 0, walking: true }, { durationS: 30, headingDeg: 90, walking: true }]);
  const { s, events } = run(obs);
  const fit = events.find((e) => e.type === 'heading' && e.source === 'GPS_SHAPE_FIT');
  assert.ok(fit, 'heading acquired');
  const err = Math.abs(((s.x[2] - THETA_TRUE + Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI;
  assert.ok(err < 12, `theta error ${err.toFixed(1)} deg`);
});

test('smoothed replay follows the true L-shaped walk better than the raw GPS', () => {
  const { obs, truth } = simulate([{ durationS: 40, headingDeg: 0, walking: true }, { durationS: 40, headingDeg: 90, walking: true }], { gpsSigma: 10, gpsAccuracy: 15 });
  const fwd = run(obs);
  const fin = finalizeFusionV4(fwd.s, cfg);
  assert.ok(fin.outputs.length > 60, `outputs ${fin.outputs.length}`);
  const e = errors(fwd.s, fin.outputs, truth);
  // raw GPS error is ~ sigma * 1.25 (2D) = 12.5 m RMS
  assert.ok(rms(e) < 6, `smoothed RMS ${rms(e).toFixed(1)} m`);
  // a smooth path: no 1 s jump much larger than walking speed
  for (let i = 1; i < fin.outputs.length; i++) {
    const d = Math.hypot(fin.outputs[i].x - fin.outputs[i - 1].x, fin.outputs[i].y - fin.outputs[i - 1].y);
    assert.ok(d < 4, `jump ${d.toFixed(1)} m at ${i}`);
  }
});

test('short straight descent: neither stairs nor slope is confirmed, so the walking stride is kept (rev 6)', () => {
  // one straight flight (3.6 m): under slopeMinClimbM, and no foldback, so the barometer alone decides nothing.
  // Height change by itself no longer shortens the step to the stair tread (docs/STAIR_SLOPE_STRIDE_PLAN.md).
  const { obs } = simulate([{ durationS: 20, headingDeg: 0, walking: true }, { durationS: 12, headingDeg: 0, walking: true, vzMps: -0.3 }]);
  const { s } = run(obs);
  const unknown = s.steps.filter((p) => p.verticalUnknown);
  assert.ok(unknown.length >= 18, `vertical-unknown steps ${unknown.length}`);
  assert.ok(unknown.every((p) => p.length > cfg.stairTreadM), 'walking stride, not the stair tread');
  assert.equal(s.steps.filter((p) => p.stairs).length, 0);
  assert.equal(s.steps.filter((p) => p.slope).length, 0);
});

test('stairwell: a long descent that folds back (dog-leg flights, no pause on the landings) stays stairs', () => {
  const flights: Leg[] = [0, 180, 0, 180, 0].map((headingDeg) => ({ durationS: 6, headingDeg, walking: true, vzMps: -0.3 }));
  const { obs } = simulate([{ durationS: 20, headingDeg: 0, walking: true }, ...flights]); // 9 m down without a break
  const { s } = run(obs);
  const stairs = s.steps.filter((p) => p.stairs);
  assert.ok(stairs.length >= 50, `stair steps ${stairs.length}`);
  assert.ok(stairs.every((p) => p.length === cfg.stairTreadM));
  assert.equal(s.steps.filter((p) => p.slope).length, 0);
});

test('slope: a long straight descent (ramp / hill road) keeps the stride, taken from the pedometer on that slope', () => {
  // 60 s down a 0.2 m/s slope with 0.6 m steps (level stride 0.75): 12 m of descent, 72 m of walking
  const legs: Leg[] = [{ durationS: 30, headingDeg: 0, walking: true }, { durationS: 60, headingDeg: 0, walking: true, vzMps: -0.2, slope: true, strideM: 0.6 }];
  const { obs, truth } = simulate(legs, { gpsSigma: 10, gpsAccuracy: 15 });
  const fwd = run(obs);
  const onSlope = fwd.s.steps.filter((p) => p.t > T0 + 30_000);
  const slope = onSlope.filter((p) => p.slope);
  assert.ok(slope.length >= 110, `slope steps ${slope.length} of ${onSlope.length}`); // the 4 s barometer window lags the start
  assert.equal(onSlope.filter((p) => p.stairs).length, 0, 'the first 5 m were filed as stairs and are reclassified');
  assert.ok(slope.every((p) => Math.abs(p.length - 0.6) < 0.05), `slope stride ${slope[0].length}..${slope.at(-1)!.length}`);
  // the level stride is not disturbed by the slope
  assert.ok(Math.abs(fwd.s.strideA / fwd.s.strideB - 0.75) < 0.03, `level stride ${fwd.s.strideA / fwd.s.strideB}`);
  // live position caught up when the slope was recognised; the replay covers the whole distance
  const live = errors(fwd.s, fwd.outputs.slice(-5), truth);
  assert.ok(Math.max(...live) < 12, `live error at the end ${Math.max(...live).toFixed(1)} m`);
  const fin = finalizeFusionV4(fwd.s, cfg).outputs.filter((o) => o.timestamp > T0 + 30_000);
  const walked = Math.hypot(fin.at(-1)!.x - fin[0].x, fin.at(-1)!.y - fin[0].y);
  assert.ok(Math.abs(walked - 72) < 8, `slope length ${walked.toFixed(1)} m of 72`);
});

test('stride is calibrated from CMPedometer distance per detected level step', () => {
  const { obs } = simulate([{ durationS: 60, headingDeg: 0, walking: true }], { stride: 0.9 });
  const { s } = run(obs);
  const level = s.steps.filter((p) => !p.stairs).at(-1)!;
  assert.ok(Math.abs(level.length - 0.9) < 0.08, `stride ${level.length}`);
});

test('stride calibration ignores stairs (CMPedometer flat stride) and steps CMPedometer does not count', () => {
  const flights: Leg[] = [0, 180, 0].map((headingDeg) => ({ durationS: 6, headingDeg, walking: true, vzMps: 0.3 }));
  const { obs } = simulate([
    { durationS: 40, headingDeg: 0, walking: true }, ...flights, { durationS: 20, headingDeg: 0, walking: true },
    { durationS: 30, headingDeg: 0, walking: true, uncounted: true }, { durationS: 5, headingDeg: 0, walking: true },
  ]);
  const { s } = run(obs);
  assert.ok(Math.abs(s.strideA / s.strideB - 0.75) < 0.03, `stride ${s.strideA / s.strideB}`);
});

test('standing still with jittery indoor GPS: the position barely moves', () => {
  const { obs } = simulate([{ durationS: 120, headingDeg: 0, walking: false }], { gpsSigma: 20, gpsAccuracy: 25 });
  const fwd = run(obs);
  const fin = finalizeFusionV4(fwd.s, cfg);
  const xs = fin.outputs.map((o) => o.x);
  const ys = fin.outputs.map((o) => o.y);
  const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  assert.ok(spread < 8, `spread ${spread.toFixed(1)} m (raw GPS scatters ~40 m)`);
});

test('replay is deterministic', () => {
  const { obs } = simulate([{ durationS: 30, headingDeg: 45, walking: true }]);
  const a = finalizeFusionV4(run(obs).s, cfg).outputs;
  const b = finalizeFusionV4(run(obs).s, cfg).outputs;
  assert.deepEqual(a, b);
});
