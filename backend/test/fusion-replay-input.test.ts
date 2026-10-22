// Replay input boundary, order independence and stage separation (pure pipeline, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, type RawSamples } from '../src/modules/fusion/fusion.timeline.js';
import { FUSION_ALGORITHMS } from '../src/modules/fusion/fusion.algorithms.js';
import { countOutOfOrderBatches, replayAsReceived, replayInMemory } from '../src/modules/fusion/fusion.pipeline.js';
import { cutRawSamples, inputStats, summarizeReplayInput, trackStats } from '../src/modules/fusion/fusion.replay-input.js';
import { batch, shuffled, T0, walk } from './helpers/walk.js';

const algo = FUSION_ALGORITHMS['fusion-v4'];
const iso = (ms: number) => new Date(ms).toISOString();

const raw = walk(120);
const smoothed = (rows: RawSamples) => replayInMemory(algo, buildTimeline(rows), { finalize: true });

test('SENSOR_TIME FINAL does not depend on the order the raw rows arrived or were read in', () => {
  const a = smoothed(raw);
  const b = smoothed(shuffled(raw, 99));
  assert.equal(b.outputs.length, a.outputs.length);
  a.outputs.forEach((o, i) => {
    assert.equal(b.outputs[i].timestamp, o.timestamp);
    assert.ok(Math.hypot(b.outputs[i].x - o.x, b.outputs[i].y - o.y) < 1e-6, `output ${i}`);
  });
  assert.equal(summarizeReplayInput(shuffled(raw, 99), null).hash, summarizeReplayInput(raw, null).hash);
});

test('input identity: the hash changes with the rows fusion reads, the cutoff keeps earlier rows only', () => {
  const cutoff = T0 + 60_000;
  const cut = cutRawSamples(raw, cutoff);
  assert.ok(cut.motion.length > 0 && cut.motion.every((m) => Date.parse(m.timestamp as string) <= cutoff));
  assert.equal(cut.motion.length, 3001); // 60 s x 50 Hz, cutoff inclusive
  const a = summarizeReplayInput(cut, cutoff);
  assert.equal(a.cutoff, iso(cutoff));
  assert.deepEqual(a.counts, { locations: cut.locations.length, motion: 3001, altimeter: cut.altimeter.length, pedometer: cut.pedometer.length });
  assert.notEqual(a.hash, summarizeReplayInput(raw, null).hash);
  const changed = { ...cut, motion: cut.motion.map((m, i) => (i === 10 ? { ...m, az: 0.5 } : m)) };
  assert.notEqual(summarizeReplayInput(changed, cutoff).hash, a.hash);
  assert.equal(cutRawSamples(raw, null), raw);
});

test('a cutoff run is the prefix of the full forward pass, but its FINAL is its own (the smoother reads the future)', () => {
  const cutoff = T0 + 60_000;
  const full = smoothed(raw);
  const part = smoothed(cutRawSamples(raw, cutoff));
  const prefix = full.forward.filter((o) => o.timestamp < cutoff);
  // forward is causal: same outputs up to the cutoff (the cut run only adds its final flush tick)
  prefix.forEach((o, i) => assert.ok(Math.hypot(part.forward[i].x - o.x, part.forward[i].y - o.y) < 1e-9, `forward ${i}`));
  const finalPrefix = full.outputs.filter((o) => o.timestamp <= cutoff);
  const moved = finalPrefix.map((o, i) => Math.hypot((part.outputs[i]?.x ?? o.x) - o.x, (part.outputs[i]?.y ?? o.y) - o.y));
  assert.ok(Math.max(...moved) > 0.01, 'slicing a longer smoothed run is not the smoothed result at the cutoff');
});

test('forward-only experiment (smooth: false) stores the forward pass as its result; a live handover is not flushed', () => {
  const timeline = buildTimeline(raw);
  const forwardOnly = replayInMemory(algo, timeline, { finalize: true, smooth: false });
  const full = replayInMemory(algo, timeline, { finalize: true });
  const live = replayInMemory(algo, timeline, { finalize: false });
  assert.equal(forwardOnly.outputs, forwardOnly.forward);
  assert.notEqual(full.outputs, full.forward);
  assert.deepEqual(forwardOnly.forward.map((o) => o.timestamp), full.forward.map((o) => o.timestamp));
  assert.ok(live.forward.length <= forwardOnly.forward.length);
  assert.equal(live.outputs, live.forward);
  // the smoother found a heading for (nearly) the whole walk; the forward pass waited for the shape fit
  const f = trackStats(full.forward), s = trackStats(full.outputs);
  assert.ok(f.headingUnknownOutputs > s.headingUnknownOutputs, `${f.headingUnknownOutputs} vs ${s.headingUnknownOutputs}`);
  assert.ok(f.firstHeadingAt! > s.firstHeadingAt!);
});

test('AS_RECEIVED: a backlog that arrives after newer data is lost to the realtime result, and the loss is counted', () => {
  // 0-40 s live, then 60-120 s live while 40-60 s sits on the phone and arrives last
  const inOrder = [batch(raw, 0, 40), batch(raw, 40, 60), batch(raw, 60, 120)].map((b) => buildTimeline(b));
  const late = [batch(raw, 0, 40), batch(raw, 60, 120), batch(raw, 40, 60)].map((b) => buildTimeline(b));
  const a = replayAsReceived(algo, inOrder, 3500);
  const b = replayAsReceived(algo, late, 3500);
  assert.equal(a.skippedLate, 0);
  assert.equal(countOutOfOrderBatches(inOrder), 0);
  assert.equal(countOutOfOrderBatches(late), 1);
  assert.equal(b.skippedLate, late[2].length, 'every observation of the late batch was skipped');
  const steps = (r: { state: unknown }) => (r.state as { steps: unknown[] }).steps.length;
  assert.ok(steps(a) - steps(b) >= 35, `steps ${steps(a)} vs ${steps(b)}`); // ~20 s x 2 steps/s never reached the live state
  // the same rows in sensor-time order lose nothing, whatever the arrival order was
  assert.equal((smoothed(raw).state as { skippedLateObservations: number }).skippedLateObservations, 0);
  // (a batch delivered twice never reaches fusion: the batch gate answers it as a duplicate before any processing)
});

test('track statistics describe the stage, not its accuracy', () => {
  const s = trackStats(smoothed(raw).outputs);
  assert.equal(s.outputs > 100, true);
  assert.ok(s.pathLengthM > 100 && s.pathLengthM < 260, `path ${s.pathLengthM}`);
  assert.equal(s.absoluteHeightOutputs + (s.zDatumSources.NONE ?? 0), s.outputs);
  assert.equal(Object.values(s.headingSources).reduce((a, b) => a + b, 0), s.outputs);
  assert.deepEqual(trackStats([]).pathLengthM, 0);
});

test('input statistics: real rate per sensor segment, gaps, duplicates and receive delay with their denominators', () => {
  const twoSegments: RawSamples = {
    ...raw,
    motion: [
      ...raw.motion.filter((m) => m.sequence < 2000), // 40 s at 50 Hz
      // 21.6 s nothing, then a new sensor segment at 20 Hz with one repeated timestamp
      ...Array.from({ length: 400 }, (_, i) => ({ sequence: 10_000 + i, timestamp: iso(T0 + 40_000 + 21_600 + (i === 7 ? 6 : i) * 50), az: 0, segment: 'B' })),
    ],
  };
  const receivedAt = { motion: twoSegments.motion.map((m, i) => iso(Date.parse(m.timestamp as string) + (i < 2000 ? 2000 : 200_000))) };
  const s = inputStats(twoSegments, { receivedAt, sessionStartedAt: iso(T0) });
  assert.equal(s.motionSamples, 2400);
  assert.deepEqual(s.segments.map((g) => [g.segment, g.samples, g.medianHz]), [['A', 2000, 50], ['B', 400, 20]]);
  assert.equal(s.segments[1].duplicateTimestamps, 1);
  assert.equal(s.motionGaps.length, 1);
  assert.ok(Math.abs(s.motionGaps[0].ms - 21_620) <= 20 && s.motionGaps[0].segmentChanged);
  assert.deepEqual(s.receiveDelayS.motion, { rows: 2400, p50: 2, p95: 200, max: 200 });
  assert.equal(s.receiveDelayS.locations, null, 'no receive times given: unknown, not zero');
  assert.equal(s.gps.reportedAccuracyM.p50, 10);
});
