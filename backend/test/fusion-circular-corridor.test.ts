import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularCorridorAnchors, circularFootprintAxis } from '../src/modules/fusion/fusion-circular-corridor.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import type { StepV4 } from '../src/modules/fusion/fusion-state-v4.js';
import type { Vec3 } from '../src/modules/fusion/fusion-v4.smoother.js';

const axis = { buildingId: 'round', x: 201000, y: 557000, footprintRadiusM: 8 };
const c = { ...cfg, circularCorridorEnabled: true, circularCorridorBuildingId: 'round' };
const origin = { x: 200980, y: 556980 };
function loop(offsetT: number, z: number, reverse = false) {
  return Array.from({ length: 65 }, (_, i): StepV4 => ({ t: offsetT + i * 500, rel: (reverse ? -1 : 1) * i * 2 * Math.PI / 64,
    length: 6 * 2 * Math.PI / 64, stairs: false, segment: 0, z }));
}
const points = (s: StepV4[]) => s.map((p) => ({ t: p.t, x: [30, 25, 0] as Vec3 }));

test('circular footprint supplies a stable projected centre; irregular or underspecified geometry is rejected', () => {
  const ring = Array.from({ length: 24 }, (_, i): [number, number] => [axis.x + 8 * Math.cos(i * Math.PI / 12), axis.y + 8 * Math.sin(i * Math.PI / 12)]);
  ring.push(ring[0]);
  const fit = circularFootprintAxis('round', ring)!;
  assert.ok(Math.hypot(fit.x - axis.x, fit.y - axis.y) < 1e-6);
  assert.ok(Math.abs(fit.footprintRadiusM - 8) < 1e-6);
  assert.equal(circularFootprintAxis('few', ring.slice(0, 4)), null);
  assert.equal(circularFootprintAxis('rectangle', [[0, 0], [5, 0], [10, 0], [10, 1], [10, 2], [5, 2], [0, 2], [0, 1]]), null);
});

test('opposite-direction loops on different floors share the given centre and one inferred radius', () => {
  const s = [...loop(100000, 10), ...loop(150000, 14, true)];
  const r = circularCorridorAnchors(s, [{ theta: 0.4 }], points(s), axis, origin, 10, c);
  assert.equal(r.summary.reason, 'APPLIED');
  assert.equal(r.summary.runs.length, 2);
  assert.ok(Math.abs(r.summary.radiusM! - 6) < 1e-6);
  for (const a of r.anchors) if (a.kind === 'fix') assert.ok(Math.abs(Math.hypot(a.x - 20, a.y - 20) - 6) < 1e-6);
  assert.ok(r.anchors.every((a, i) => a.kind === 'fix' && a.index === 10 + i));
});

test('disabled mode, missing axis, straight paths, stairs, climbing and unknown heading do not make circles', () => {
  const full = loop(100000, 0);
  assert.equal(circularCorridorAnchors(full, [{ theta: 0 }], points(full), axis, origin, 0, cfg).anchors.length, 0);
  assert.equal(circularCorridorAnchors(full, [{ theta: 0 }], points(full), null, origin, 0, c).summary.reason, 'AXIS_UNAVAILABLE');
  for (const mode of ['straight', 'stairs', 'climbing', 'unknown', 'short', 'far'] as const) {
    const s = full.map((p, i) => ({ ...p, ...(mode === 'straight' ? { rel: 0 } : {}), ...(mode === 'stairs' ? { stairs: true } : {}), ...(mode === 'climbing' ? { z: i * 0.3 } : {}) })).slice(0, mode === 'short' ? 10 : undefined);
    const xy = points(s).map((p) => mode === 'far' ? { ...p, x: [100, 100, 0] as Vec3 } : p);
    assert.equal(circularCorridorAnchors(s, [{ theta: mode === 'unknown' ? null : 0 }], xy, axis, origin, 0, c).anchors.length, 0, mode);
  }
});
