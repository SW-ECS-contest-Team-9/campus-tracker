// BLE beacon positioning (fusion-v4 rev 18), pure logic: shared fixtures, the measurement model, RSSI filtering,
// the EKF / proximity update, floor estimation and a simulated indoor walk with beacons on and off. No DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BEACON_RSSI_DEFAULTS, lnRangeSigma, modelRange, selectRssiModel, type CalibrationRow } from '../src/modules/positioning/beacon-calibration.js';
import { BeaconObservationBatch, beaconKey, checkObservation } from '../src/modules/positioning/beacon.dto.js';
import { toFusionBeacons } from '../src/modules/positioning/beacon-fusion-input.js';
import {
  beaconUpdate, createBeaconTracker, filterBeacon, updateFloor, voteFloor, type BeaconRangeMeasurement,
} from '../src/modules/fusion/fusion-beacon.js';
import { buildTimeline, compareObservations, type BeaconRawSample, type Observation, type RawSamples } from '../src/modules/fusion/fusion.timeline.js';
import { finalizeFusionV4, flushFusionV4, processObservationV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { createFusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { fusionConfigV4 as cfg, type FusionConfigV4 } from '../src/modules/fusion/fusion.config.js';
import { diag3, sigmaXY, type Mat3, type Vec3 } from '../src/modules/fusion/fusion-v4.smoother.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../src/geo/wgs84-to-local.js';
import { tmForward } from '../src/geo/tm.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/beacon');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// ---------------------------------------------------------------------------------------------
// contract + measurement model (the same fixture files are read by the Android and iOS tests)
// ---------------------------------------------------------------------------------------------

test('measurement model fixture: range and ln-range sigma match on every platform', () => {
  const f = fixture('measurement-model.json');
  assert.deepEqual(f.defaults, BEACON_RSSI_DEFAULTS);
  for (const k of f.modelCases) {
    assert.ok(Math.abs(modelRange(k.rssi, k) - k.expectedRangeM) < 1e-5, `range for ${k.rssi}`);
    assert.ok(Math.abs(lnRangeSigma(k.rssiVariance, k.pathLossExponent) - k.expectedLnSigma) < 1e-5);
  }
  for (const k of f.selectionCases) {
    const m = selectRssiModel(f.calibrationRows as CalibrationRow[], k.beaconId, k.platform, k.deviceModel, k.advertised, f.defaults);
    assert.equal(m.source, k.expectedSource, JSON.stringify(k));
    assert.equal(m.measuredPower1m, k.expectedMeasuredPower1m);
  }
  for (const k of f.noCalibrationCases) {
    const m = selectRssiModel([], 'x', 'ios', 'iPhone', k.advertised, f.defaults);
    assert.deepEqual([m.source, m.measuredPower1m], [k.expectedSource, k.expectedMeasuredPower1m]);
  }
});

test('beacon.observations.v1 fixture: unknown fields ignored, protocol / uuid case normalized, row checks', () => {
  const batch = BeaconObservationBatch.parse({ ...fixture('observations-batch.json'), futureField: 1 });
  assert.equal(batch.platform, 'android');
  assert.ok(batch.observations.every((o) => o.protocol === 'IBEACON'));
  const keys = batch.observations.map((o) => beaconKey(o.protocol, o.uuid, o.major, o.minor));
  assert.equal(keys[0], 'IBEACON:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2');
  assert.equal(new Set(keys).size, 3);
  const base = batch.observations[0];
  assert.equal(checkObservation(base), null);
  assert.equal(checkObservation({ ...base, rssiDbm: 0 }), 'RSSI_OUT_OF_RANGE'); // iOS "unknown"
  assert.equal(checkObservation({ ...base, rssiDbm: -127 }), 'RSSI_OUT_OF_RANGE');
  assert.equal(checkObservation({ ...base, observedAt: '2019-01-01T00:00:00Z' }), 'TIMESTAMP_IMPLAUSIBLE');
  assert.throws(() => BeaconObservationBatch.parse({ ...batch, schemaVersion: 2 }));
  assert.throws(() => BeaconObservationBatch.parse({ ...batch, sessionId: null, clientSessionId: null }));
  assert.throws(() => BeaconObservationBatch.parse({ ...batch, observations: [{ ...base, protocol: 'EDDYSTONE' }] }));
  assert.throws(() => BeaconObservationBatch.parse({ ...batch, observations: [{ ...base, major: 65536 }] }));
  assert.throws(() => BeaconObservationBatch.parse({ ...batch, observations: [] }));
});

test('fusion input: every row carries the most specific RSSI model; platforms are not mixed', () => {
  const row = { observationId: 'o', timestamp: new Date(0), beaconId: 'b1', rssi: -70, platform: 'ios', deviceModel: 'iPhone15,2', sampleCount: 9,
    advertisedPower: -58, anchorX: 1, anchorY: 2, anchorZ: 3, buildingId: 'B', floor: '1F', floorHeightM: 0.5, anchorHorizontalAccuracyM: 1 };
  const rows: CalibrationRow[] = [{ beaconId: 'b1', platform: 'android', deviceGroup: '*', measuredPower1m: -70, pathLossExponent: 3, rssiVariance: 10, sampleCount: 1 }];
  const [ios] = toFusionBeacons([row], rows);
  assert.equal(ios.measuredPower1m, -58); // the Android calibration is not applied to iOS: advertised power
  const [android] = toFusionBeacons([{ ...row, platform: 'android' }], rows);
  assert.deepEqual([android.measuredPower1m, android.pathLossExponent, android.rssiVariance], [-70, 3, 10]);
});

// ---------------------------------------------------------------------------------------------
// filtering, update, gating
// ---------------------------------------------------------------------------------------------

const input = (over: Partial<BeaconRawSample> = {}) => ({
  beaconId: 'b1', rssi: -70, platform: 'ios', anchorX: 200000, anchorY: 550000, anchorZ: 52.5, buildingId: 'B07', floor: '3F', floorHeightM: 50,
  anchorHorizontalAccuracyM: 0.5, measuredPower1m: -59, pathLossExponent: 2.2, rssiVariance: 36, sampleCount: 1, ...over,
});

test('RSSI filtering: window median, MAD outlier rejection, throttled updates, out-of-range and too-far rejection', () => {
  const tr = createBeaconTracker();
  const out: (BeaconRangeMeasurement | null)[] = [];
  for (let i = 0; i < 6; i++) out.push(filterBeacon(tr, 1000 + i * 250, input({ rssi: -75 + (i % 2) }), cfg));
  assert.equal(out.filter(Boolean).length, 2, 'one update per beacon per second');
  assert.equal(filterBeacon(tr, 2600, input({ rssi: -50 }), cfg), null, 'a 25 dB spike is rejected');
  assert.equal(tr.counters.rejected.RSSI_OUTLIER, 1);
  const m = filterBeacon(tr, 3100, input({ rssi: -74 }), cfg)!;
  assert.ok(Math.abs(m.range - modelRange(-74.5, { measuredPower1m: -59, pathLossExponent: 2.2 })) < 0.5, 'median of the window');
  assert.ok(m.dz > 1 && m.dz < 2, 'mount 2.5 m above floor, phone 1 m');
  assert.equal(filterBeacon(tr, 5000, input({ rssi: 0 }), cfg), null);
  assert.equal(filterBeacon(tr, 5100, input({ beaconId: 'far', rssi: -99 }), cfg), null);
  assert.deepEqual([tr.counters.rejected.RSSI_OUT_OF_RANGE, tr.counters.rejected.TOO_FAR], [1, 1]);
  // window samples older than beaconWindowMs are gone: the next update uses only fresh samples
  const tr2 = createBeaconTracker();
  filterBeacon(tr2, 0, input({ rssi: -60 }), cfg);
  const fresh = filterBeacon(tr2, 10_000, input({ rssi: -80 }), cfg)!;
  assert.equal(Math.round(fresh.range * 100) / 100, Math.round(modelRange(-80, { measuredPower1m: -59, pathLossExponent: 2.2 }) * 100) / 100);
});

test('an impossible 3-D range cannot be treated as beacon proximity', () => {
  const tr = createBeaconTracker();
  const sample = input({ rssi: -40, anchorZ: 60, floorHeightM: 50, anchorHorizontalAccuracyM: 0.1, rssiVariance: 1 });
  assert.equal(filterBeacon(tr, 1000, sample, cfg), null);
  assert.equal(tr.counters.rejected.INCONSISTENT_HEIGHT, 1);
  assert.equal(tr.counters.measurements, 0);
});

const meas = (over: Partial<BeaconRangeMeasurement>): BeaconRangeMeasurement => ({
  t: 0, beaconId: 'b', gridX: 0, gridY: 0, buildingId: 'B', floor: '1F', dz: 1.5, range: 10, lnRange: Math.log(10), variance: 0.1,
  upperRange: 10 * Math.exp(2 * Math.sqrt(0.1)), upperHorizontal: 10, proximity: false, samples: 1, ...over,
});

test('range update: moves along the anchor line only, shrinks uncertainty, symmetric covariance', () => {
  const x: Vec3 = [5, 0, 0.3];
  const P: Mat3 = diag3(9, 9, 0.01);
  const u = beaconUpdate(x, P, meas({ range: Math.hypot(10, 1.5), lnRange: Math.log(Math.hypot(10, 1.5)) }), { x: 0, y: 0 }, cfg);
  assert.ok(u.applied && u.mode === 'RANGE');
  assert.ok(u.x[0] > 5 && Math.abs(u.x[1]) < 1e-9, 'pushed outward along x');
  assert.ok(u.P[0] < P[0] && Math.abs(u.P[4] - P[4]) < 1e-9, 'only the radial direction is constrained');
  assert.ok(Math.abs(u.P[1] - u.P[3]) < 1e-12);
});

test('multiple beacons: sequential range updates converge on the true position', () => {
  const truth = [4, 3];
  const anchors = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }];
  let x: Vec3 = [0, 0, 0];
  let P: Mat3 = diag3(25, 25, 0.01);
  for (let it = 0; it < 8; it++) for (const a of anchors) {
    const d = Math.hypot(truth[0] - a.x, truth[1] - a.y, 1.5);
    const u = beaconUpdate(x, P, meas({ range: d, lnRange: Math.log(d), variance: 0.02 }), a, { ...cfg, beaconMaxShiftM: 100 });
    x = u.x; P = u.P;
    P = [P[0] + 0.05, P[1], P[2], P[3], P[4] + 0.05, P[5], P[6], P[7], P[8]]; // a little process noise between rounds
  }
  assert.ok(Math.hypot(x[0] - truth[0], x[1] - truth[1]) < 0.5, `ended at ${x[0].toFixed(2)},${x[1].toFixed(2)}`);
  assert.ok(sigmaXY(P) < 1.5);
});

test('single beacon: proximity is a region, not a jump to the anchor; a far spoof is gated', () => {
  const x: Vec3 = [8, 0, 0];
  const P: Mat3 = diag3(36, 36, 0.01);
  const near = meas({ range: 1, lnRange: 0, upperRange: 1.8, upperHorizontal: 1.8, proximity: true });
  const u = beaconUpdate(x, P, near, { x: 0, y: 0 }, cfg);
  assert.ok(u.applied && u.mode === 'PROXIMITY');
  assert.ok(Math.hypot(u.x[0] - 8, u.x[1]) <= cfg.beaconMaxShiftM + 1e-6, 'one update moves at most beaconMaxShiftM');
  assert.ok(u.x[0] < 8, 'toward the anchor');
  // confident state 40 m from a "very near" beacon: inconsistent (spoofed / moved beacon) -> rejected
  const spoof = beaconUpdate([40, 0, 0], diag3(4, 4, 0.01), near, { x: 0, y: 0 }, cfg);
  assert.deepEqual([spoof.applied, spoof.reason], [false, 'INNOVATION_GATED']);
  const ring = beaconUpdate([40, 0, 0], diag3(4, 4, 0.01), meas({}), { x: 0, y: 0 }, cfg);
  assert.deepEqual([ring.applied, ring.reason], [false, 'INNOVATION_GATED']);
  // position unknown: no linearization around it
  assert.equal(beaconUpdate([0, 0, 0], diag3(1e8, 1e8, 1), meas({ gridX: 0 }), { x: 30, y: 0 }, cfg).reason, 'PRIOR_TOO_WIDE');
});

// ---------------------------------------------------------------------------------------------
// floor estimation
// ---------------------------------------------------------------------------------------------

test('floor: confirmed after persistence; a beacon majority alone never changes it; barometer + persistence does', () => {
  const tr = createBeaconTracker();
  const ft = tr.floor;
  ft.floorHeights = { 'B07|3F': 50, 'B07|4F': 54 };
  const vote = (t: number, floor: string) => voteFloor(ft, meas({ t, floor, buildingId: 'B07', range: 2 }), cfg);
  const events = [];
  for (let t = 0; t <= 4000; t += 500) { vote(t, '3F'); events.push(updateFloor(ft, t, 0, false, cfg)); }
  assert.equal(ft.floor, '3F');
  assert.equal(events.filter(Boolean).length, 1);
  // 4F beacons dominate (floor leak / standing at a stairwell) but the barometer did not move: stays on 3F
  for (let t = 4500; t <= 16_000; t += 500) { vote(t, '4F'); updateFloor(ft, t, 0.2, false, cfg); }
  assert.equal(ft.floor, '3F');
  // the barometer rises one storey (anchor floor heights: 4 m) and 4F keeps leading: change
  let change = null;
  for (let t = 16_500; t <= 24_000 && !change; t += 500) { vote(t, '4F'); change = updateFloor(ft, t, 3.6, true, cfg); }
  assert.ok(change && change.to === '4F' && change.source === 'BEACON_BAROMETER');
  // no beacons, the barometer climbs two more storeys: barometer-only change
  for (let t = 40_000; t <= 50_000; t += 1000) updateFloor(ft, t, 3.6 + 8.1, false, cfg);
  assert.deepEqual([ft.floor, ft.source], ['6F', 'BAROMETER']);
  // basement numbering has no floor 0: 1F -> B1 is one storey
  const t2 = createBeaconTracker().floor;
  for (let t = 0; t <= 4000; t += 500) { voteFloor(t2, meas({ t, floor: '1F', buildingId: 'X', range: 2 }), cfg); updateFloor(t2, t, 0, false, cfg); }
  for (let t = 60_000; t <= 70_000; t += 1000) updateFloor(t2, t, -2.0, false, cfg); // half a storey: stays
  assert.equal(t2.floor, '1F');
  for (let t = 70_000; t <= 80_000; t += 1000) updateFloor(t2, t, -3.7, false, cfg);
  assert.equal(t2.floor, 'B1');
});

// ---------------------------------------------------------------------------------------------
// fusion-v4 with beacons: simulated walk, GPS outdoors only, PDR stride biased by 13 %
// ---------------------------------------------------------------------------------------------

const ORIGIN = { latitude: 37.6158, longitude: 127.0118, height: 0 };
const T0 = Date.parse('2026-10-15T01:00:00.000Z');

function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

interface Scenario { seconds: number; gpsUntilS: number; beaconFromS: number; beaconUntilS?: number; spoof?: boolean; floorLeak?: boolean; seed?: number }

/** East for half the time, then north. 2 steps/s of 0.85 m; CMPedometer says 0.75 m. Beacons every 10 m, alternating sides. */
function simulate(sc: Scenario) {
  const r = rng(sc.seed ?? 11);
  const raw: RawSamples = { locations: [], motion: [], altimeter: [], pedometer: [], beacons: [] };
  const truth: { t: number; x: number; y: number }[] = [];
  const grid = (x: number, y: number) => { const ll = localToWgs84(ORIGIN, { x, y, z: 0 }); return tmForward(ll.latitude, ll.longitude); };
  const anchors: { id: string; x: number; y: number; floor: string }[] = [];
  const half = sc.seconds / 2 * 2 * 0.85;
  for (let d = 5; d < sc.seconds * 2 * 0.85; d += 10) {
    // staggered on both sides of the corridor: a single straight line of beacons cannot tell left from right (mirror)
    const side = anchors.length % 2 ? 1.5 : -1.5;
    const [x, y] = d < half ? [d, side] : [half + side, d - half];
    anchors.push({ id: `b${anchors.length}`, x, y, floor: '1F' });
  }
  if (sc.floorLeak) for (const a of [...anchors]) anchors.push({ id: `${a.id}-2F`, x: a.x + 0.5, y: a.y, floor: '2F' });
  let x = 0, y = 0, steps = 0, lastStep = -1, seq = 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  for (let k = 0; k < sc.seconds * 50; k++) {
    const t = k / 50;
    const heading = t < sc.seconds / 2 ? Math.PI / 2 : 0; // east, then north
    const ts = iso(T0 + k * 20);
    raw.motion.push({ sequence: k, timestamp: ts, yaw: -(heading - 1), ax: 0.005 * r.n(), ay: 0.005 * r.n(), az: 0.2 * Math.sin(4 * Math.PI * t) + 0.01 * r.n(), gx: 0, gy: 0, gz: -1, segment: 'A' });
    if (Math.floor(t * 2) !== lastStep) {
      lastStep = Math.floor(t * 2);
      x += 0.85 * Math.sin(heading);
      y += 0.85 * Math.cos(heading);
      steps++;
    }
    if (k % 10 === 0) truth.push({ t: T0 + k * 20, x, y });
    if (k % 125 === 0) raw.pedometer.push({ timestamp: ts, numberOfSteps: steps, distance: steps * 0.75, segment: 'A' });
    if (k % 50 === 25) raw.altimeter.push({ sequence: k, timestamp: ts, relativeAltitude: 0, segment: 'A' });
    if (k % 100 === 60 && t < sc.gpsUntilS) {
      const p = localToWgs84(ORIGIN, { x: x + 3 * r.n(), y: y + 3 * r.n(), z: 0 });
      raw.locations.push({ sequence: k, timestamp: ts, latitude: p.latitude, longitude: p.longitude, altitude: 60, ellipsoidalAltitude: 90, horizontalAccuracy: 6, verticalAccuracy: 8, speed: -1, course: -1 });
    }
    if (k % 50 === 10 && t >= sc.beaconFromS && t < (sc.beaconUntilS ?? Infinity)) {
      // iOS-style ranging: one ~1 s aggregate per beacon in range
      for (const a of anchors) {
        const d = Math.hypot(a.x - x, a.y - y, 1.5);
        if (d > 20) continue;
        const rssi = Math.round(-59 - 22 * Math.log10(d) + 3 * r.n() - (a.floor === '2F' ? 12 : 0));
        const g = grid(a.x, a.y);
        raw.beacons!.push({ observationId: `o${seq++}`, timestamp: ts, beaconId: a.id, rssi, platform: 'ios', anchorX: g.x, anchorY: g.y, anchorZ: a.floor === '2F' ? 6.5 : 2.5,
          buildingId: 'B07', floor: a.floor, floorHeightM: a.floor === '2F' ? 4 : 0, anchorHorizontalAccuracyM: 0.3,
          measuredPower1m: -59, pathLossExponent: 2.2, rssiVariance: 9, sampleCount: 10 });
      }
      if (sc.spoof && t > sc.seconds * 0.8) {
        // a "beacon" claiming to be 60 m away from the walk, heard at -50 dBm
        const g = grid(x + 60, y);
        raw.beacons!.push({ observationId: `o${seq++}`, timestamp: ts, beaconId: 'spoof', rssi: -50, platform: 'ios', anchorX: g.x, anchorY: g.y, anchorZ: 2.5,
          buildingId: 'B07', floor: '1F', floorHeightM: 0, anchorHorizontalAccuracyM: 0.3, measuredPower1m: -59, pathLossExponent: 2.2, rssiVariance: 9, sampleCount: 10 });
      }
    }
  }
  return { raw, truth, anchors };
}

function run(raw: RawSamples, c: FusionConfigV4 = cfg) {
  const s = createFusionStateV4();
  const timeline: Observation[] = buildTimeline(raw).sort(compareObservations);
  const forward: FusedOutput[] = [];
  const events: unknown[] = [];
  for (const o of timeline) { const r = processObservationV4(s, o, c); forward.push(...r.outputs); events.push(...r.events); }
  forward.push(...flushFusionV4(s, c).outputs);
  const final = finalizeFusionV4(s, c).outputs;
  return { s, forward, final, events };
}

/** Mean / max horizontal error vs the truth over outputs with t >= fromS. */
function errors(outputs: FusedOutput[], truth: { t: number; x: number; y: number }[], fromS: number) {
  const e: number[] = [];
  for (const o of outputs) {
    if (o.timestamp < T0 + fromS * 1000) continue;
    const p = wgs84ToLocal(ORIGIN, o.latitude, o.longitude, 0);
    const g = truth.reduce((a, b) => (Math.abs(b.t - o.timestamp) < Math.abs(a.t - o.timestamp) ? b : a));
    e.push(Math.hypot(p.x - g.x, p.y - g.y));
  }
  return { mean: e.reduce((a, b) => a + b, 0) / e.length, max: Math.max(...e), n: e.length };
}

test('beacons off / absent: identical to rev 17 behaviour (no-beacon sessions do not change)', () => {
  const { raw } = simulate({ seconds: 80, gpsUntilS: 80, beaconFromS: 0 });
  const withoutRows = run({ ...raw, beacons: [] });
  const disabled = run(raw, { ...cfg, beaconFusionEnabled: false });
  assert.deepEqual(disabled.final, withoutRows.final);
  assert.deepEqual(disabled.forward, withoutRows.forward);
  assert.equal(disabled.s.beacon, undefined);
  assert.ok(withoutRows.final.every((o) => o.beaconUpdates === undefined && o.floorLabel === undefined));
});

test('indoor walk without GPS: beacons bound the PDR drift (forward and smoothed), compared with beacons off', () => {
  const sc = { seconds: 140, gpsUntilS: 45, beaconFromS: 40 };
  const { raw, truth } = simulate(sc);
  const on = run(raw);
  const off = run(raw, { ...cfg, beaconFusionEnabled: false });
  const eOn = errors(on.final, truth, 60), eOff = errors(off.final, truth, 60);
  const fOn = errors(on.forward, truth, 60), fOff = errors(off.forward, truth, 60);
  if (process.env.BEACON_REPORT) console.log(JSON.stringify({ smoothed: { on: eOn, off: eOff }, forward: { on: fOn, off: fOff } }));
  assert.ok(eOff.mean > 4, `the biased stride drifts without beacons (${eOff.mean.toFixed(1)} m)`);
  assert.ok(eOn.mean < 0.6 * eOff.mean, `smoothed: on ${eOn.mean.toFixed(2)} m vs off ${eOff.mean.toFixed(2)} m`);
  assert.ok(fOn.mean < 0.7 * fOff.mean, `forward: on ${fOn.mean.toFixed(2)} m vs off ${fOff.mean.toFixed(2)} m`);
  const summary = on.s.beacon!.counters;
  assert.ok(summary.applied > 50 && summary.measurements >= summary.applied);
  assert.ok(on.final.some((o) => (o.beaconUpdates ?? 0) > 0));
  assert.ok(on.forward.filter((o) => o.timestamp > T0 + 60_000).some((o) => o.source === 'FUSED' || o.source === 'BEACON_CORRECTED'));
});

test('no jumps: consecutive forward outputs never move more than walking + beaconMaxShiftM per update', () => {
  const { raw } = simulate({ seconds: 140, gpsUntilS: 45, beaconFromS: 40 });
  const on = run(raw);
  for (let i = 1; i < on.forward.length; i++) {
    const a = on.forward[i - 1], b = on.forward[i];
    const dt = (b.timestamp - a.timestamp) / 1000;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    // walking 1.7 m/s plus at most a few capped beacon updates per second
    assert.ok(step <= 1.7 * dt + 4 * cfg.beaconMaxShiftM + 1, `jump of ${step.toFixed(1)} m in ${dt} s`);
  }
});

test('beacon signal loss: tracking continues on PDR with growing uncertainty, no NaN', () => {
  const { raw, truth } = simulate({ seconds: 140, gpsUntilS: 45, beaconFromS: 40, beaconUntilS: 90 });
  const on = run(raw);
  const late = on.forward.filter((o) => o.timestamp > T0 + 95_000);
  assert.ok(late.length > 30 && late.every((o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude)));
  assert.ok(late.at(-1)!.horizontalUncertainty! > late[0].horizontalUncertainty!, 'uncertainty grows without measurements');
  assert.ok(late.every((o) => !o.beaconUpdates));
  // after the loss the stride bias drifts again, from the better position the beacons left behind
  const off = run(raw, { ...cfg, beaconFusionEnabled: false });
  assert.ok(errors(on.final, truth, 95).mean < errors(off.final, truth, 95).mean);
});

test('spoofed / moved beacon far from the walk is gated, the track is not pulled', () => {
  const sc = { seconds: 140, gpsUntilS: 45, beaconFromS: 40, spoof: true };
  const { raw, truth } = simulate(sc);
  const spoofed = run(raw);
  const clean = run({ ...raw, beacons: raw.beacons!.filter((b) => b.beaconId !== 'spoof') });
  assert.ok((spoofed.s.beacon!.counters.rejected.INNOVATION_GATED ?? 0) > 0);
  const diff = errors(spoofed.final, truth, 115).mean - errors(clean.final, truth, 115).mean;
  assert.ok(diff < 1.5, `spoofing moved the track by ${diff.toFixed(2)} m on average`);
});

test('floor: 2F beacons leaking through the slab do not move XY once 1F is confirmed; outputs carry the floor', () => {
  const { raw, truth } = simulate({ seconds: 140, gpsUntilS: 45, beaconFromS: 40, floorLeak: true });
  const on = run(raw);
  assert.equal(on.s.beacon!.floor.floor, '1F');
  assert.ok((on.s.beacon!.counters.rejected.FLOOR_MISMATCH ?? 0) > 0);
  const tagged = on.final.filter((o) => o.timestamp > T0 + 50_000);
  assert.ok(tagged.length && tagged.every((o) => o.floorLabel === '1F' && o.floorBuildingId === 'B07' && o.floorSource === 'BEACON'));
  // the leak costs little: compared with the same walk without the 2F beacons
  const clean = run({ ...raw, beacons: raw.beacons!.filter((b) => b.floor === '1F') });
  const leak = errors(on.final, truth, 60).mean, base = errors(clean.final, truth, 60).mean;
  assert.ok(leak < base + 1.5, `with leak ${leak.toFixed(2)} m, without ${base.toFixed(2)} m`);
  const off = errors(run(raw, { ...cfg, beaconFusionEnabled: false }).final, truth, 60).mean;
  assert.ok(leak < off, `still better than beacons off (${off.toFixed(2)} m)`);
});

test('stale beacons (older than the state) are skipped and counted; beacons before any GPS can start the frame', () => {
  const { raw } = simulate({ seconds: 60, gpsUntilS: 0, beaconFromS: 0 });
  const on = run(raw);
  assert.ok(on.s.initialized, 'initialized from a near beacon without GPS');
  assert.ok(on.forward.some((o) => o.source === 'BEACON_ANCHORED'));
  const s = createFusionStateV4();
  const late = buildTimeline({ ...raw, motion: raw.motion.slice(0, 500), beacons: [] });
  for (const o of late) processObservationV4(s, o, cfg);
  const old = buildTimeline({ locations: [], motion: [], altimeter: [], pedometer: [], beacons: raw.beacons!.slice(0, 1) })[0];
  processObservationV4(s, old, cfg); // t = 0.2 s < last observation 10 s
  assert.equal(s.beacon!.counters.rejected.STALE, 1);
});
