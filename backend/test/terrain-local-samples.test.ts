import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinear, buildDem, type ContourRun } from '../src/geo/dem.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { applyLocalSamples, changeStats, mergeLocalSampleInputs, parseLocalSamples, LOCAL_SAMPLE_DEFAULTS, type LocalSampleOptions } from '../src/geo/terrain-local-samples.js';
import { gridDifferences } from '../src/geo/terrain-versions.js';

const grid = { originX: 0, originY: 0, resolution: 2, width: 40, height: 40 };
const flat = () => new Float32Array(1600).fill(100);
const open: LocalSampleOptions = { passes: [[6, 15], [3, 8], [2, 6], [2, 6]], supportM: Infinity, fadeM: 0, minNeighbours: 0, neighbourRadiusM: 0 };
// 5 x 5 block of samples every 2 m around (40, 40), all 4 m above the flat source
const block = () => Array.from({ length: 25 }, (_, i) => ({ x: 36 + 2 * (i % 5), y: 36 + 2 * Math.floor(i / 5), z: 104 }));

test('local samples without taper or guard equal the spot passes of buildDem', () => {
  const contours: ContourRun[] = [
    { height: 100, points: [[1, 1], [1, 79]] },
    { height: 105, points: [[79, 1], [79, 79]] },
  ];
  const spots = [{ x: 15.4, y: 16.7, z: 108 }, { x: 30.2, y: 24.3, z: 101 }, { x: 43.6, y: 40.8, z: 103 }];
  const passes: [number, number][] = [[120, 300], [25, 60]];
  const expected = buildDem(grid, contours, spots.map((s) => ({ x: s.x, y: s.y, height: s.z })), { passes }).heights;
  const source = buildDem(grid, contours, []).heights;
  const before = source.slice();
  const result = applyLocalSamples(grid, source, spots, { ...open, passes });
  assert.deepEqual(source, before);
  assert.deepEqual(result.heights, expected);
  assert.deepEqual(result.skipped, []);
});

test('samples pull the surface to their height and the taper reaches zero outside support + fade', () => {
  const source = flat();
  const samples = block();
  const { heights } = applyLocalSamples(grid, source, samples, { ...open, supportM: 4, fadeM: 4 });
  assert.ok(Math.abs(bilinear(grid, heights, 40, 40)! - 104) < 0.1);
  let untapered = 0;
  const full = applyLocalSamples(grid, source, samples, open).heights;
  for (let iy = 0; iy < 40; iy++) for (let ix = 0; ix < 40; ix++) {
    const i = iy * 40 + ix, x = 2 * ix + 1, y = 2 * iy + 1;
    const d = Math.min(...samples.map((s) => Math.hypot(s.x - x, s.y - y)));
    if (d > 8) assert.equal(heights[i], 100, `cell ${x},${y} at ${d} m`);
    if (d <= 4) assert.equal(heights[i], full[i]);
    if (d > 4 && d < 8) assert.ok(heights[i] >= 100 && heights[i] <= full[i]);
    if (d > 8 && full[i] !== 100) untapered++;
  }
  assert.ok(untapered > 0, 'without the taper the correction spills past 8 m');
});

test('a lone sample is skipped by the neighbour guard and reported', () => {
  const source = flat();
  const lone = { x: 10, y: 10, z: 88 };
  const guard = { ...open, minNeighbours: 3, neighbourRadiusM: 6 };
  const samples = [...block(), lone];
  const unguarded = applyLocalSamples(grid, source, samples, open).heights;
  assert.ok(bilinear(grid, unguarded, 10, 10)! < 95, 'without the guard one sample moves the terrain by metres');
  const guarded = applyLocalSamples(grid, source, samples, guard);
  assert.deepEqual(guarded.skipped, [25]);
  assert.deepEqual(guarded.heights, applyLocalSamples(grid, source, block(), guard).heights);
  assert.equal(bilinear(grid, guarded.heights, 10, 10), 100);
});

test('invalid samples, options and rasters are refused', () => {
  const source = flat();
  assert.throws(() => applyLocalSamples(grid, new Float32Array(3), block(), open));
  assert.throws(() => applyLocalSamples(grid, source, [], open));
  assert.throws(() => applyLocalSamples(grid, source, [{ x: 40, y: 40, z: NaN }], open));
  assert.throws(() => applyLocalSamples(grid, source, [{ x: 500, y: 40, z: 100 }], open));
  assert.throws(() => applyLocalSamples(grid, source, block(), { ...open, passes: [] }));
  assert.throws(() => applyLocalSamples(grid, source, block(), { ...open, fadeM: -1 }));
});

test('samples file: provenance is required and --areas filters groups', () => {
  const group = (area: string, points: unknown[]) => ({ area, source: 'smap-elevation-query', collected: '2026-10-10', originalFile: 'a.json', points });
  const file = { crs: 'EPSG:5186', reason: 'test', groups: [group('field', [[1, 2, 3], [4, 5, 6]]), group('s06', [[7, 8, 9]])] };
  assert.equal(parseLocalSamples(file).samples.length, 3);
  const field = parseLocalSamples(file, ['field']);
  assert.deepEqual(field.samples, [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
  assert.deepEqual(field.groups.map((g) => [g.area, g.count]), [['field', 2]]);
  assert.throws(() => parseLocalSamples(file, ['corridor']));
  assert.throws(() => parseLocalSamples({ ...file, crs: 'EPSG:4326' }));
  assert.throws(() => parseLocalSamples({ ...file, reason: ' ' }));
  assert.throws(() => parseLocalSamples({ ...file, groups: [group('field', [[1, 2, 'x']])] }));
  assert.throws(() => parseLocalSamples({ ...file, groups: [{ ...group('field', [[1, 2, 3]]), originalFile: '' }] }));
  assert.throws(() => parseLocalSamples({ ...file, groups: [] }));
});

test('change stats count changed cells by size and new steep cells', () => {
  const g = { originX: 0, originY: 0, resolution: 2, width: 4, height: 4 };
  const before = new Float32Array(16).fill(100);
  const after = before.slice();
  after[5] = 100.3; after[6] = 95;
  const s = changeStats(g, before, after);
  assert.equal(s.changedCells, 2);
  assert.equal(s.minDelta, -5);
  assert.ok(Math.abs(s.maxDelta - 0.3) < 1e-4);
  assert.equal(s.areaM2ByAbsDelta['0.1-0.5m'], 4);
  assert.equal(s.areaM2ByAbsDelta['2-5m'], 4);
  assert.equal(s.steepCellsBefore, 0);
  assert.ok(s.steepCellsAfter > 0);
});

test('terrain versions are switchable only on the same grid, datum and geoid', () => {
  const a = { srid: 5186, verticalDatum: 'KVD_INCHEON_MSL', geoidSeparationM: 23.5, originX: 200668, originY: 556798, resolutionM: 2, width: 450, height: 464 };
  assert.deepEqual(gridDifferences(a, { ...a }), []);
  assert.deepEqual(gridDifferences(a, { ...a, width: 451, originX: 200670 }), ['originX', 'width']);
  assert.deepEqual(gridDifferences(a, { ...a, verticalDatum: 'OTHER' }), ['verticalDatum']);
});

test('several samples files join into one input and a single file stays untouched', () => {
  const group = (area: string, points: number[][]) => ({ area, source: 's', collected: '2026-10-10', originalFile: 'f', points });
  const a = { crs: 'EPSG:5186', reason: 'first', note: 'kept only when alone', groups: [group('field', [[1, 2, 3]])] };
  const b = { crs: 'EPSG:5186', reason: ' second ', groups: [group('gate_road', [[4, 5, 6], [7, 8, 9]])] };
  assert.equal(mergeLocalSampleInputs([a]), a);
  const merged = mergeLocalSampleInputs([a, b]);
  assert.deepEqual(merged, { crs: 'EPSG:5186', reason: 'first + second', groups: [...a.groups, ...b.groups] });
  assert.equal(parseLocalSamples(merged, ['field', 'gate_road']).samples.length, 3);
  assert.throws(() => parseLocalSamples(a, ['gate_road']));
  assert.throws(() => mergeLocalSampleInputs([]));
  assert.throws(() => mergeLocalSampleInputs([a, { ...b, crs: 'EPSG:4326' }]));
});

test('committed samples: the first file is unchanged (announced candidate ids hash it) and the road areas are dense enough', () => {
  const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../data/terrain/samples/${name}`, import.meta.url), 'utf8'));
  const first = read('smap_samples_5186.json'), roads = read('smap_samples_roads_5186.json');
  // local-samples-7e415b29668b2f62 (field) and -09eca6c203f338b0 (field,s06) were announced with this input hash
  assert.equal(createHash('sha256').update(JSON.stringify(first)).digest('hex'), '233b848a4ef0d75efc300e743f32361e0067d642f0fbbefea1bdabdfd3fddc2c');
  assert.deepEqual([...new Set(first.groups.map((g: any) => g.area))].sort(), ['corridor', 'field', 's06']);
  assert.deepEqual([...new Set(roads.groups.map((g: any) => g.area))].sort(), ['gate_road', 'turnaround']);
  const { samples, groups } = parseLocalSamples(mergeLocalSampleInputs([first, roads]), ['field', 's06', 'gate_road', 'turnaround']);
  assert.equal(samples.length, 3326);
  assert.equal(groups.filter((g) => g.area === 'gate_road' || g.area === 'turnaround').reduce((n, g) => n + g.count, 0), 1033);
  // with S06 next to it no road sample is dropped by the lone-sample guard
  const near = LOCAL_SAMPLE_DEFAULTS.neighbourRadiusM ** 2;
  const road = parseLocalSamples(roads).samples;
  for (const s of road) {
    let n = 0;
    for (const o of samples) if (o !== s && (o.x - s.x) ** 2 + (o.y - s.y) ** 2 <= near && !(o.x === s.x && o.y === s.y && o.z === s.z) && ++n >= LOCAL_SAMPLE_DEFAULTS.minNeighbours) break;
    assert.ok(n >= LOCAL_SAMPLE_DEFAULTS.minNeighbours, `sample ${s.x},${s.y} has ${n} neighbours`);
  }
});
