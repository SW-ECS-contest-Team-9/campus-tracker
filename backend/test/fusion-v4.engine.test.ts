// fusion-v4 unit tests on a synthetic walk with known ground truth (no DB).  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { finalizeFusionV4, processObservationV4, type FusionEventV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { createFusionStateV4, type FusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';

const ORIGIN = { latitude: 37.6158, longitude: 127.0118, height: 0 };
const T0 = Date.parse('2026-10-02T06:00:00.000Z');
const THETA_TRUE = 1.0; // device yaw frame is arbitrary: walking direction = -yaw + THETA_TRUE

// deterministic pseudo-random (LCG) + Box-Muller
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

interface Leg { durationS: number; headingDeg: number; walking: boolean; vzMps?: number }
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
        const L = leg.vzMps ? 0.3 : stride;
        x += L * Math.sin(heading); y += L * Math.cos(heading);
        steps++; dist += leg.vzMps ? stride : L; // CMPedometer uses a flat stride even on stairs
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

test('stairs: barometer descent while stepping uses the stair tread, not the flat stride', () => {
  const { obs } = simulate([{ durationS: 20, headingDeg: 0, walking: true }, { durationS: 20, headingDeg: 0, walking: true, vzMps: -0.3 }]);
  const { s } = run(obs);
  const stairs = s.steps.filter((p) => p.stairs);
  assert.ok(stairs.length >= 30, `stair steps ${stairs.length}`);
  assert.ok(stairs.every((p) => p.length === cfg.stairTreadM));
});

test('stride is calibrated from CMPedometer distance per detected level step', () => {
  const { obs } = simulate([{ durationS: 60, headingDeg: 0, walking: true }], { stride: 0.9 });
  const { s } = run(obs);
  const level = s.steps.filter((p) => !p.stairs).at(-1)!;
  assert.ok(Math.abs(level.length - 0.9) < 0.08, `stride ${level.length}`);
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
