import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { burnCorridors, polygonsMask } from '../src/geo/terrain-corridor.js';
import { applyLocalSamples } from '../src/geo/terrain-local-samples.js';
import { applyPlateau } from '../src/geo/terrain-plateau.js';
import { applyRecipe, parseCorridors, parsePolygons, parseRecipe, recipeFiles, recipeId, PLATEAU_EDGE_DEFAULTS, type Recipe } from '../src/geo/terrain-recipe.js';

const grid = { originX: 0, originY: 0, resolution: 2, width: 60, height: 60 };
const source = () => Float32Array.from({ length: 3600 }, (_, i) => 100 + 0.05 * (i % 60) + 0.1 * Math.floor(i / 60));
const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const inputs = () => ({
  's.json': { crs: 'EPSG:5186', reason: 'samples', groups: [{ area: 'a', source: 't', collected: '2026-10-11', originalFile: 't',
    points: Array.from({ length: 25 }, (_, i) => [40 + 2 * (i % 5), 40 + 2 * Math.floor(i / 5), 108]) }] },
  'p.geojson': { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'yard', srid: 5186, heightM: 104, reason: 'flat yard' }, geometry: { type: 'Polygon', coordinates: [square(60, 60, 90, 90)] } }] },
  'c.json': { crs: 'EPSG:5186', reason: 'road', lines: [{ name: 'R', halfWidthM: 3, points: [[20, 20, 101], [75, 75, 104]] }, { name: 'X', halfWidthM: 3, points: [[20, 100, 101], [40, 100, 104]] }] },
});
const recipe = (): Recipe => parseRecipe({ crs: 'EPSG:5186', reason: 'test', protectBuildings: true, steps: [
  { type: 'local-samples', files: ['s.json'], areas: ['a'] },
  { type: 'plateau', file: 'p.geojson' },
  { type: 'corridor', file: 'c.json', lines: ['R'], keep: 'p.geojson' },
] });
const buildings: [number, number][][][] = [[square(84, 84, 100, 100)]];

test('recipe runs the steps in order with the same functions, masks included', () => {
  const src = source(), before = src.slice(), inp = inputs();
  const { heights, steps } = applyRecipe(grid, src, recipe(), inp, buildings);
  assert.deepEqual(src, before);
  const building = polygonsMask(grid, buildings);
  const yard = inp['p.geojson'].features[0].geometry.coordinates;
  const a = applyLocalSamples(grid, src, inp['s.json'].groups[0].points.map(([x, y, z]) => ({ x, y, z }))).heights;
  const b = applyPlateau(grid, a, yard, 104, { ...PLATEAU_EDGE_DEFAULTS, keep: building });
  const keep = polygonsMask(grid, [yard]);
  for (let i = 0; i < keep.length; i++) if (building[i]) keep[i] = 1;
  const c = burnCorridors(grid, b, [inp['c.json'].lines[0] as any], undefined, { keep });
  assert.deepEqual(heights, c);
  assert.deepEqual(steps.map((s) => s.type), ['local-samples', 'plateau', 'corridor']);
  assert.ok(steps.every((s) => s.changedCells > 0));
  // the yard stays flat although the road runs into it, and building cells kept the result of the sample step
  const inYard = polygonsMask(grid, [yard]);
  let flat = 0;
  for (let i = 0; i < keep.length; i++) {
    if (building[i]) assert.equal(heights[i], a[i]);
    else if (inYard[i]) { flat++; assert.equal(heights[i], 104); }
  }
  assert.ok(flat > 150);
});

test('recipe id depends on base, recipe, input contents and protected footprints only', () => {
  const id = recipeId('base-1', recipe(), inputs(), buildings);
  assert.match(id, /^recipe-[0-9a-f]{16}$/);
  assert.equal(recipeId('base-1', recipe(), JSON.parse(JSON.stringify(inputs())), buildings), id); // same content, new objects
  assert.notEqual(recipeId('base-2', recipe(), inputs(), buildings), id);
  const moved = inputs(); moved['p.geojson'].features[0].properties.heightM = 104.1;
  assert.notEqual(recipeId('base-1', recipe(), moved, buildings), id);
  const other = recipe(); (other.steps[2] as any).blendM = 2;
  assert.notEqual(recipeId('base-1', other, inputs(), buildings), id);
  assert.notEqual(recipeId('base-1', recipe(), inputs(), []), id);
  const open = { ...recipe(), protectBuildings: false };
  assert.equal(recipeId('base-1', open, inputs(), buildings), recipeId('base-1', open, inputs(), [])); // footprints not used, not hashed
});

test('recipe parsing refuses bad steps, missing inputs and unknown names', () => {
  assert.deepEqual(recipeFiles(recipe()), ['s.json', 'p.geojson', 'c.json']);
  assert.throws(() => parseRecipe({ crs: 'EPSG:5186', reason: 'x', protectBuildings: true, steps: [] }));
  assert.throws(() => parseRecipe({ crs: 'EPSG:5186', reason: 'x', steps: [{ type: 'plateau', file: 'p' }] }));
  assert.throws(() => parseRecipe({ crs: 'EPSG:5186', reason: 'x', protectBuildings: false, steps: [{ type: 'dig', file: 'p' }] }));
  assert.throws(() => parseRecipe({ crs: 'EPSG:5186', reason: 'x', protectBuildings: false, steps: [{ type: 'corridor', file: 'c', blendM: -1 }] }));
  assert.throws(() => applyRecipe(grid, source(), recipe(), { 's.json': inputs()['s.json'] }, buildings), /not loaded/);
  assert.throws(() => parseCorridors(inputs()['c.json'], ['nope']), /No corridor line/);
  const bare = { type: 'Feature', properties: { srid: 5186, reason: 'r' }, geometry: { type: 'Polygon', coordinates: [square(0, 0, 4, 4)] } };
  assert.throws(() => parsePolygons(bare, true));
  assert.equal(parsePolygons(bare).length, 1);
});

test('the T06 recipe file parses and its inputs have the stated shapes', () => {
  const dir = path.resolve(import.meta.dirname, '../data/terrain/recipes');
  const read = (f: string) => JSON.parse(fs.readFileSync(path.resolve(dir, f), 'utf8'));
  const r = parseRecipe(read('t06-smooth-ground.json'));
  const inp = Object.fromEntries(recipeFiles(r).map((f) => [f, read(f)]));
  const plateaus = parsePolygons(inp['t06-plateaus.geojson'], true);
  assert.deepEqual(plateaus.map((p) => [p.name, p.heightM]), [['plaza', 130.6], ['field', 148.9]]);
  assert.equal(parsePolygons(inp['t06-no-blend.geojson']).length, 3);
  const corridor = r.steps.find((s) => s.type === 'corridor') as { lines: string[] };
  assert.ok(!corridor.lines.includes('U1')); // the upper branch would drop the ground under two buildings by 5-12 m
  const lines = parseCorridors(inp['t06-road-corridors.json'], corridor.lines);
  assert.equal(lines.length, 8);
  assert.equal(lines.find((l) => l.name === 'V4b')!.points.at(-1)![2], 130.6); // the road meets the plaza at the plaza height
});
