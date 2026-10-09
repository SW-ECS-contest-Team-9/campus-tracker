import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from 'cesium';
import { cursorAxes, xrayAlpha, xrayAppearance } from '../src/editor-visibility.ts';

test('cursor front/right/back/left follow WASD heading without changing height', () => {
  const origin: [number, number, number] = [201100, 557250, 135];
  const north = cursorAxes(origin, 0);
  assert.deepEqual(north.map((a) => a.end), [
    [201100, 557254, 135], [201104, 557250, 135],
    [201100, 557246, 135], [201096, 557250, 135],
  ]);
  const east = cursorAxes(origin, 90);
  assert.deepEqual(east.map((a) => a.end.map(Math.round)), [
    [201104, 557250, 135], [201100, 557246, 135],
    [201096, 557250, 135], [201100, 557254, 135],
  ]);
  assert.deepEqual(origin, [201100, 557250, 135]);
  for (const a of cursorAxes(origin, 37)) {
    assert.ok(Math.abs(Math.hypot(a.end[0] - origin[0], a.end[1] - origin[1]) - 4) < 1e-8);
    assert.equal(a.end[2], origin[2]);
  }
});

test('distant occluded paths remain legible, while explicit isolation stays dim', () => {
  assert.ok(xrayAlpha(0.048, false, false) >= 0.55);
  assert.ok(xrayAlpha(0.048, true, false) >= 0.28);
  assert.ok(xrayAlpha(0.04, true, true) <= 0.04);
  assert.ok(xrayAlpha(0.99, false, false) < 1);
});

test('xray rendering bypasses building and terrain depth, without writing depth', () => {
  const appearance = xrayAppearance(C);
  const state = appearance.getRenderState();
  assert.equal(state.depthTest.enabled, false);
  assert.equal(state.depthMask, false);
  assert.equal(appearance.isTranslucent(), true);
});
