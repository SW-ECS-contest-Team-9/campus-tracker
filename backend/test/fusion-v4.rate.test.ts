// fusion-v4 step detection against the sensor's real sample rate (rev 7, stepTimeBased). Synthetic input, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../src/modules/fusion/fusion.timeline.js';
import { processObservationV4, type FusionEventV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { createFusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { fusionConfigV4, type FusionConfigV4 } from '../src/modules/fusion/fusion.config.js';

const T0 = Date.parse('2026-10-13T12:54:00.000Z');
const legacy: FusionConfigV4 = fusionConfigV4;
const timeBased: FusionConfigV4 = { ...fusionConfigV4, stepTimeBased: true };

function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

interface MotionOpts {
  hz: number;
  seconds: number;
  /** vertical acceleration amplitude in g at 2 steps/s; 0 = standing */
  amplitude?: number;
  /** each interval is hz period x (1 +- jitter) */
  jitter?: number;
  /** every n-th sample is sent twice with the same timestamp */
  duplicateEvery?: number;
  /** no samples in [from, to) seconds */
  gap?: [number, number];
  /** sensor segment id from this second on */
  segmentAt?: number;
  /** yaw rate in rad/s (walking a circle) */
  yawRate?: number;
}

/** Motion samples whose values are the continuous signal sampled at their own timestamps (as a real sensor does). */
function motion(o: MotionOpts): Observation[] {
  const r = rng(11);
  const out: Observation[] = [];
  const period = 1 / o.hz;
  let seq = 0;
  for (let t = 0; t < o.seconds; t += period * (1 + (o.jitter ?? 0) * (2 * r.u() - 1))) {
    if (o.gap && t >= o.gap[0] && t < o.gap[1]) continue;
    const az = (o.amplitude ?? 0.2) * Math.sin(2 * Math.PI * 2 * t) + 0.005 * r.n();
    const sample: Observation = {
      kind: 'motion', t: T0 + Math.round(t * 1000), seq: seq++, yaw: (o.yawRate ?? 0) * t, ax: 0.005 * r.n(), ay: 0.005 * r.n(), az,
      gx: 0, gy: 0, gz: -1, segment: o.segmentAt !== undefined && t >= o.segmentAt ? 'B' : 'A',
    };
    out.push(sample);
    if (o.duplicateEvery && seq % o.duplicateEvery === 0) out.push({ ...sample, seq: seq++ });
  }
  return out;
}

function run(obs: Observation[], c: FusionConfigV4) {
  const s = createFusionStateV4();
  const events: FusionEventV4[] = [];
  for (const o of obs) events.push(...processObservationV4(s, o, c).events);
  return { s, events };
}
const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} (expected ${expected} +- ${tolerance})`);

test('rev 6 defect: a 20 Hz stream loses every step, 50 Hz finds them (2 steps/s, 0.20 g, 60 s)', () => {
  near(run(motion({ hz: 50, seconds: 60 }), legacy).s.steps.length, 120, 4, '50 Hz');
  assert.equal(run(motion({ hz: 20, seconds: 60 }), legacy).s.steps.length, 0);
});

for (const hz of [10, 20, 50, 100]) {
  test(`time based: ${hz} Hz walking gives the same step count`, () => {
    near(run(motion({ hz, seconds: 60 }), timeBased).s.steps.length, 120, 4, `${hz} Hz`);
  });
}

test('time based: 30 % timestamp jitter at 20 and 50 Hz', () => {
  near(run(motion({ hz: 20, seconds: 60, jitter: 0.3 }), timeBased).s.steps.length, 120, 5, '20 Hz');
  near(run(motion({ hz: 50, seconds: 60, jitter: 0.3 }), timeBased).s.steps.length, 120, 5, '50 Hz');
});

test('time based: samples repeated with the same timestamp change nothing', () => {
  const clean = run(motion({ hz: 20, seconds: 60 }), timeBased).s.steps;
  const dup = run(motion({ hz: 20, seconds: 60, duplicateEvery: 3 }), timeBased).s.steps;
  assert.deepEqual(dup.map((p) => p.t), clean.map((p) => p.t));
});

test('time based: standing still is stationary with no steps, at 10 Hz too', () => {
  for (const hz of [10, 20, 50]) {
    const { s } = run(motion({ hz, seconds: 30, amplitude: 0 }), timeBased);
    assert.equal(s.steps.length, 0, `${hz} Hz steps`);
    assert.equal(s.stationary, true, `${hz} Hz stationary`);
  }
  // rev 6 needs 20 samples inside its 2 s window: at 10 Hz the count sits on that limit and flips with the timestamps
  assert.ok(run(motion({ hz: 5, seconds: 30, amplitude: 0 }), legacy).s.stationary === false);
});

test('time based: walking a circle keeps the step count and each step carries the yaw of its own time', () => {
  const { s } = run(motion({ hz: 20, seconds: 60, yawRate: 0.2 }), timeBased);
  near(s.steps.length, 120, 4, 'steps');
  const first = s.steps[10];
  const last = s.steps.at(-1)!;
  near(first.rel - last.rel, 0.2 * (last.t - first.t) / 1000, 0.02, 'relative heading change');
});

test('time based: a long motion gap starts a new heading segment and the detector primes again', () => {
  const { s, events } = run(motion({ hz: 20, seconds: 60, gap: [20, 41.6] }), timeBased);
  assert.equal(s.segments.length, 2);
  assert.equal(events.filter((e) => e.type === 'heading-segment' && e.reason === 'MOTION_GAP').length, 1);
  assert.equal(s.steps.filter((p) => p.t > T0 + 20_000 && p.t < T0 + 41_600).length, 0, 'no steps invented inside the gap');
  near(s.steps.length, 2 * (20 + 18.4), 8, 'steps outside the gap');
});

test('time based: a short dropout (0.5 s) restarts the filter only: same segment, walking continues', () => {
  const { s } = run(motion({ hz: 20, seconds: 60, gap: [30, 30.5] }), timeBased);
  assert.equal(s.segments.length, 1);
  near(s.steps.length, 120, 6, 'steps');
});

test('time based: a new sensor segment id is a new heading segment at any rate', () => {
  const { s } = run(motion({ hz: 10, seconds: 40, segmentAt: 20 }), timeBased);
  assert.deepEqual(s.segments.map((g) => g.reason), ['START', 'MOTION_SEGMENT']);
  near(s.steps.length, 80, 6, 'steps');
});

test('time based: below the step band (4 Hz samples) no steps are invented', () => {
  assert.equal(run(motion({ hz: 4, seconds: 60 }), timeBased).s.steps.length, 0);
});

test('regression: on an exact 50 Hz stream the time-based detector finds the rev 6 steps', () => {
  const obs = motion({ hz: 50, seconds: 120, yawRate: 0.05 });
  const a = run(obs, legacy).s.steps;
  const b = run(obs, timeBased).s.steps;
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i].t - b[i].t) <= 20, `step ${i} time`);
    assert.ok(Math.abs(a[i].rel - b[i].rel) < 1e-3, `step ${i} heading`);
  }
});
