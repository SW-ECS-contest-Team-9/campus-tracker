import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import { roadHeightContact, type RoadHeightContact, type RoadHeightPoint, type RoadHeightTracker } from '../src/modules/fusion/fusion-road-height.js';
import type { StartHeightRoad } from '../src/geo/start-height-map.js';

const c = { ...cfg, roadHeightAnchorsEnabled: true };
const road = (z = 110, slope = 0, status = 'APPROVED'): StartHeightRoad => ({ id: `r${z}`, status, revision: 1,
  buildingId: null, levelId: `L${z}`, coordinates: [[0, 0, z], [0, 100, z + slope * 100]] });
const point = (i: number, extra: Partial<RoadHeightPoint> = {}): RoadHeightPoint => ({ t: 100000 + i * 500, x: 0.3, y: i * 0.75, z: 0, sigmaXY: 2, headingRad: 0, ...extra });

test('continuous forward/reverse road traversal anchors the Z offset with bounded emission rate', () => {
  for (const reverse of [false, true]) {
    const tracker: RoadHeightTracker = {};
    const contacts: RoadHeightContact[] = [];
    for (let i = 0; i < 40; i++) {
      const k = roadHeightContact(tracker, [road()], point(i, reverse ? { y: 50 - i * 0.75, headingRad: Math.PI } : {}), c);
      if (k) contacts.push(k);
    }
    assert.ok(contacts.length >= 2);
    assert.equal(contacts[0].offset, 111);
    assert.ok(contacts[0].t >= 103000);
    assert.ok(contacts.every((k, i) => !i || k.t - contacts[i - 1].t >= c.roadHeightAnchorIntervalMs));
  }
});

test('one-point proximity, stationary jitter, perpendicular crossing, distance and low position quality do not anchor', () => {
  for (const mode of ['stationary', 'crossing', 'far', 'uncertain', 'missing'] as const) {
    const tracker: RoadHeightTracker = {};
    for (let i = 0; i < 20; i++) {
      const p = point(i, mode === 'stationary' ? { y: 10 + Math.sin(i) * 0.1 }
        : mode === 'crossing' ? { headingRad: Math.PI / 2 }
          : mode === 'far' ? { x: 10 } : mode === 'uncertain' ? { sigmaXY: 30 } : {});
      assert.equal(roadHeightContact(tracker, [road()], mode === 'missing' ? null : p, c), null);
    }
  }
  assert.equal(roadHeightContact({}, [road()], point(0), c), null);
});

test('stacked roads stay ambiguous without a level or decisive independent height reference', () => {
  const roads = [road(110), road(114)];
  for (const mode of ['ambiguous', 'weak', 'hint', 'reference'] as const) {
    const tracker: RoadHeightTracker = {};
    const contacts: RoadHeightContact[] = [];
    for (let i = 0; i < 20; i++) {
      const k = roadHeightContact(tracker, roads, point(i), mode === 'hint' ? { ...c, roadHeightAnchorLevelId: 'L114' } : c,
        mode === 'reference' ? { heightM: 115, sigma: 1 } : mode === 'weak' ? { heightM: 115, sigma: 4 } : null);
      if (k) contacts.push(k);
    }
    if (mode === 'ambiguous' || mode === 'weak') assert.equal(contacts.length, 0);
    else { assert.ok(contacts.length > 0); assert.ok(contacts.every((k) => k.offset === 115)); }
  }
});

test('barometric shape must agree with sloping road height, so adjacent stairs cannot anchor to a flat road', () => {
  const good: RoadHeightTracker = {}, bad: RoadHeightTracker = {};
  let goodCount = 0, badCount = 0;
  for (let i = 0; i < 30; i++) {
    const p = point(i, { z: i * 0.75 * 0.5 });
    if (roadHeightContact(good, [road(110, 0.5)], p, c)) goodCount++;
    if (roadHeightContact(bad, [road()], p, c)) badCount++;
  }
  assert.ok(goodCount > 0);
  assert.equal(badCount, 0);
});

test('gaps/teleports cannot be accumulated into a traversal; draft anchors require their own opt-in', () => {
  const gaps: RoadHeightTracker = {}, jumps: RoadHeightTracker = {};
  for (let i = 0; i < 20; i++) {
    assert.equal(roadHeightContact(gaps, [road()], point(i, { t: 100000 + i * 3000 }), c), null);
    assert.equal(roadHeightContact(jumps, [road()], point(i, { y: i % 2 ? 70 : 5 }), c), null);
  }
  for (const enabled of [false, true]) {
    const tracker: RoadHeightTracker = {};
    let count = 0;
    for (let i = 0; i < 20; i++) if (roadHeightContact(tracker, [road(110, 0, 'DRAFT')], point(i), { ...c, roadHeightAnchorIncludeDrafts: enabled })) count++;
    assert.equal(count > 0, enabled);
  }
});
