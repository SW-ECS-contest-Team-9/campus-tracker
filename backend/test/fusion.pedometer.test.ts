// Cumulative pedometer counter (high-water mark) shared by fusion-v2.1 / v3 / v3.1 and the validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPedometerCounter,
  createPedometerCounter,
  restartPedometerCounter,
  type PedometerVerdict,
} from '../src/modules/fusion/fusion.pedometer.js';

/** Feeds [steps, distance] samples; returns verdicts and the distance fusion may use (increases above the maximum). */
function feed(samples: [number | null, number | null][]) {
  const c = createPedometerCounter();
  const verdicts: PedometerVerdict[] = [];
  let walked = 0;
  restartPedometerCounter(c, samples[0][0], samples[0][1]);
  for (const [steps, distance] of samples.slice(1)) {
    const before = c.maxDistance ?? 0;
    const v = checkPedometerCounter(c, steps, distance);
    verdicts.push(v);
    if (v === 'OK' && distance !== null) walked += distance - before;
  }
  return { verdicts, walked: Math.round(walked * 100) / 100 };
}

test('interleaved 0 sample (real upload: 158, 0, 158) is ignored, never a reset', () => {
  const r = feed([[151, 124.39], [157, 129.19], [158, 129.98], [0, 0], [158, 129.98], [160, 131.5]]);
  assert.deepEqual(r.verdicts, ['OK', 'OK', 'BELOW_HIGH_WATER', 'OK', 'OK']);
  assert.equal(r.walked, 7.11); // 124.39 -> 131.5, nothing added twice
});

test('repeated 0 samples while stationary, then the old total continues (89013bdb pattern)', () => {
  const r = feed([[64, 50], [0, 0], [0, 0], [0, 0], [64, 50], [0, 0], [82, 64], [86, 67]]);
  assert.ok(!r.verdicts.includes('COUNTER_RESTARTED'));
  assert.equal(r.walked, 17);
});

test('a counter that really restarted (keeps counting up from 0) becomes the new baseline', () => {
  const r = feed([[150, 120], [0, 0], [5, 4], [10, 8], [15, 12]]);
  assert.deepEqual(r.verdicts, ['BELOW_HIGH_WATER', 'BELOW_HIGH_WATER', 'COUNTER_RESTARTED', 'OK']);
  assert.equal(r.walked, 4); // only 8 -> 12 after the restart was confirmed: no lump of the steps before it
});

test('restart while stationary: zeros do not confirm it, walking afterwards does', () => {
  const r = feed([[150, 120], [0, 0], [0, 0], [0, 0], [4, 3], [9, 7], [14, 11]]);
  assert.deepEqual(r.verdicts, ['BELOW_HIGH_WATER', 'BELOW_HIGH_WATER', 'BELOW_HIGH_WATER', 'BELOW_HIGH_WATER', 'COUNTER_RESTARTED', 'OK']);
  assert.equal(r.walked, 4);
});

test('steps only (distance missing) use the same rule', () => {
  const r = feed([[10, null], [12, null], [0, null], [14, null]]);
  assert.deepEqual(r.verdicts, ['OK', 'BELOW_HIGH_WATER', 'OK']);
});

test('a slightly lower re-estimated distance is ignored and not counted twice', () => {
  const r = feed([[100, 80], [100, 79.9], [102, 81.5]]);
  assert.deepEqual(r.verdicts, ['BELOW_HIGH_WATER', 'OK']);
  assert.equal(r.walked, 1.5);
});
