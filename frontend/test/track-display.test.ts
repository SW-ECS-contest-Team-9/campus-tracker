import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFusedHeight, describeHeading, fusedDisplayHeight, publishedStage, relativeAltitudeLabel, runStage, sessionStateLines, splitByAbsoluteHeight } from '../src/track-display.ts';

const scene = (e: number) => e - 23.4;

test('height: only a point with a vertical datum is an absolute height; the rest is a drawing height', () => {
  assert.deepEqual(fusedDisplayHeight({ ellipsoidalAltitude: 123.4, terrainHeight: 90 }, 0, scene), { h: 100, kind: 'ABSOLUTE' });
  assert.deepEqual(fusedDisplayHeight({ ellipsoidalAltitude: null, terrainHeight: 90 }, 55, scene), { h: 91, kind: 'GROUND_PROJECTED' });
  assert.deepEqual(fusedDisplayHeight({ ellipsoidalAltitude: null, terrainHeight: null }, 55, scene), { h: 55, kind: 'FALLBACK' });
});

test('height: no datum => "미확정", no floor, and the relative Z is not presented as raw for v4', () => {
  const none = describeFusedHeight({ ellipsoidalAltitude: null, terrainHeight: 90, zDatumSource: 'NONE', relativeAltitude: 12 });
  assert.equal(none.kind, 'GROUND_PROJECTED');
  assert.equal(none.floorAllowed, false);
  assert.match(none.status, /미확정/);
  assert.match(none.status, /투영/);
  const terrain = describeFusedHeight({ ellipsoidalAltitude: 120, zDatumSource: 'TERRAIN', zDatumSigma: 1.1 });
  assert.equal(terrain.floorAllowed, true);
  assert.match(terrain.datum, /TERRAIN/);
  assert.match(describeFusedHeight({ ellipsoidalAltitude: 120, zDatumSource: 'GPS', zDatumSigma: 3 }).datum, /GPS/);
  assert.match(relativeAltitudeLabel('fusion-v4'), /구간 연결/);
  assert.match(relativeAltitudeLabel('fusion-v2.1'), /원시/);
});

test('height: a track is split where the datum appears, without a hole in the line', () => {
  const p = (e: number | null) => ({ ellipsoidalAltitude: e, terrainHeight: 90 });
  const runs = splitByAbsoluteHeight([p(null), p(null), p(100), p(101), p(null)]);
  assert.deepEqual(runs.map((r) => [r.absolute, r.points.length]), [[false, 2], [true, 3], [false, 2]]);
  assert.equal(runs[1].points[0], runs[0].points[1]);
  assert.deepEqual(splitByAbsoluteHeight([]), []);
  // C04 case: every point without a datum is one projected run
  assert.deepEqual(splitByAbsoluteHeight([p(null), p(null), p(null)]).map((r) => r.absolute), [false]);
});

test('heading: UNKNOWN is shown as unknown, CONTINUITY as an assumption', () => {
  assert.equal(describeHeading({ heading: null, headingSource: 'UNKNOWN' }).known, false);
  assert.equal(describeHeading({ heading: 90, headingSource: 'UNKNOWN' }).known, false);
  assert.match(describeHeading({ heading: 90, headingSource: 'CONTINUITY' }).text, /가정/);
  assert.match(describeHeading({ heading: 90, headingSource: 'GPS_SHAPE_FIT' }).text, /90°.*맞춤/);
});

test('stage: forward and smoothed runs are told apart, old runs by what they stored', () => {
  assert.equal(runStage({ mode: 'AS_RECEIVED' }), 'FORWARD_AS_RECEIVED');
  assert.equal(runStage({ mode: 'SENSOR_TIME', metrics: { replay: { finalizeApplied: true } } }), 'FINAL_SMOOTHED');
  assert.equal(runStage({ mode: 'SENSOR_TIME', metrics: { replay: { finalizeApplied: false }, terrain: null } }), 'FORWARD_SENSOR_TIME');
  assert.equal(runStage({ mode: 'SENSOR_TIME', trigger: 'api', metrics: { terrain: null } }), 'FORWARD_SENSOR_TIME'); // C04 22:13 run
  assert.equal(runStage({ mode: 'SENSOR_TIME', trigger: 'auto-finalize', metrics: { terrain: { datumSource: 'TERRAIN' } } }), 'FINAL_SMOOTHED'); // C02
  const active = publishedStage({ status: 'ACTIVE' }, { mode: 'SENSOR_TIME', metrics: { terrain: null } }, false);
  assert.equal(active.stage, 'FORWARD_SENSOR_TIME');
  assert.match(active.note, /직접 비교 불가/);
  assert.equal(publishedStage({ status: 'ACTIVE' }, null, false).stage, 'REALTIME');
});

test('session: ACTIVE with no recent data is not shown as finished, and the unknown is stated', () => {
  const now = Date.parse('2026-10-13T16:00:00Z');
  const c04 = sessionStateLines({ status: 'ACTIVE', syncState: 'OFFLINE', finishRequestedAt: null, lastReceivedAt: '2026-10-13T13:06:10Z', outOfOrderBatches: 263, fusionState: 'CLEAN', needsReprocess: false, finalizedAt: null, raw: { syncManifest: null } }, now);
  const by = Object.fromEntries(c04.map((l) => [l.label, l]));
  assert.match(by['수집'].text, /ACTIVE · 최근 수신 없음/);
  assert.match(by['수집'].text, /종료가 아님/);
  assert.match(by['종료 요청'].text, /받지 못함/);
  assert.match(by['동기화'].text, /알 수 없음/);
  assert.doesNotMatch(by['동기화'].text, /0개/);
  assert.match(by['수신 순서'].text, /263/);
  assert.match(by['융합'].text, /최종화 전/);

  const c02 = sessionStateLines({ status: 'FINISHED', syncState: 'FINALIZED', finishRequestedAt: '2026-10-13T13:16:09Z', finalizedAt: '2026-10-13T13:16:10Z', fusionState: 'CLEAN',
    raw: { syncManifest: { synchronized: true, streams: { motion: { expected: 63786, server: 63786, synchronized: true } } } } }, now);
  assert.equal(c02.find((l) => l.label === '동기화')!.tone, 'ok');
  const behind = sessionStateLines({ status: 'FINISHED', finishRequestedAt: '2026-10-13T13:16:09Z', raw: { syncManifest: { synchronized: false, streams: { motion: { expected: 100, server: 80, synchronized: false } } } } }, now);
  assert.match(behind.find((l) => l.label === '동기화')!.text, /motion 80\/100/);
  // list view (no raw statistics loaded): no claim about the manifest at all
  assert.equal(sessionStateLines({ status: 'ACTIVE', syncState: 'LIVE' }, now).some((l) => l.label === '동기화'), false);
});
