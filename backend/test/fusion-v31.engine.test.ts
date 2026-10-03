// fusion-v3.1 unit tests (pure engine, no DB).  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processObservationV31, type FusionEventV31 } from '../src/modules/fusion/fusion-v31.engine.js';
import { createFusionStateV31, type FusionStateV31 } from '../src/modules/fusion/fusion-state-v31.js';
import type { Observation } from '../src/modules/fusion/fusion.timeline.js';

const T0 = Date.parse('2026-10-02T03:00:00.000Z');
let seq = 0;
const at = (s: number) => T0 + Math.round(s * 1000);
const ped = (tS: number, distance: number | null, steps: number | null): Observation => ({ kind: 'pedometer', t: at(tS), seq: ++seq, distance, steps });

function run(obs: Observation[]): { s: FusionStateV31; events: FusionEventV31[] } {
  const s = createFusionStateV31();
  const events: FusionEventV31[] = [];
  for (const o of obs) events.push(...processObservationV31(s, o).events);
  return { s, events };
}
const pedReasons = (events: FusionEventV31[]) => events.flatMap((e) => (e.type === 'pedometer-delta' ? [e.reason] : []));

test('interleaved 0 pedometer sample is ignored: no phantom distance, no speed clamp', () => {
  const r = run([ped(1, 0, 0), ped(3, 2.5, 3), ped(5, 5, 6), ped(6, 0, 0), ped(7, 5, 6), ped(9, 7.5, 9)]);
  assert.ok(Math.abs(r.s.pedometerTotal - 7.5) < 1e-9, `walked ${r.s.pedometerTotal} m`);
  const reasons = pedReasons(r.events);
  assert.ok(reasons.includes('BELOW_HIGH_WATER'));
  assert.ok(!reasons.includes('WALKING_SPEED_CLAMPED') && !reasons.includes('NEGATIVE_DELTA'), reasons.join(','));
});

test('a 0 sample after a pause is not the rebase point (gap rule rebases at the next valid sample)', () => {
  const r = run([ped(1, 0, 0), ped(3, 2.5, 3), ped(20, 0, 0), ped(21, 20, 25), ped(23, 22.5, 28)]);
  // 2.5 before the pause; the walk during the pause is not applied in a lump; +2.5 after it
  assert.ok(Math.abs(r.s.pedometerTotal - 5) < 1e-9, `walked ${r.s.pedometerTotal} m`);
  assert.equal(r.events.filter((e) => e.type === 'sensor-gap').length, 1);
});

test('steps-only fallback ignores a lower step count as well', () => {
  const r = run([ped(1, null, 10), ped(2, null, 12), ped(3, null, 0), ped(4, null, 14)]);
  assert.ok(pedReasons(r.events).includes('BELOW_HIGH_WATER'));
  assert.equal(r.s.fallbackStepDistance, 4 * 0.72); // 10 -> 12 -> 14 steps, 0.72 m stride
});
