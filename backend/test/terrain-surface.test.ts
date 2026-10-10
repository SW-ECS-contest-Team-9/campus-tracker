import test from 'node:test';
import assert from 'node:assert/strict';
import { applySurface, parseSurface, surfaceHeight } from '../src/geo/terrain-surface.js';
import { applyRecipe, parseRecipe, recipeFiles } from '../src/geo/terrain-recipe.js';
import { polygonsMask } from '../src/geo/terrain-corridor.js';

const grid = { originX: 0, originY: 0, resolution: 2, width: 40, height: 40 };
const source = () => Float32Array.from({ length: 1600 }, (_, i) => 100 + 0.3 * Math.sin(i / 7) + 0.05 * (i % 40));
const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (name: string, ring: [number, number][], props: object) => ({ type: 'Feature', properties: { name, srid: 5186, reason: 'test', ...props }, geometry: { type: 'Polygon', coordinates: [ring] } });
const ramp = { origin: [10, 0], direction: [2, 0], points: [[0, 100], [20, 102], [50, 108]] };
const file = () => ({ type: 'FeatureCollection', features: [
  feature('ramp', square(10, 20, 60, 40), { profile: ramp }),
  feature('terrace', square(30, 40, 50, 52), { heightM: 106 }),
] });
const at = (h: Float32Array, x: number, y: number) => h[Math.floor(y / 2) * 40 + Math.floor(x / 2)];

test('surface: a ramp is flat across and linear along, a platform is flat, edges are hard', () => {
  const src = source(), before = src.slice();
  const h = applySurface(grid, src, parseSurface(file()));
  assert.deepEqual(src, before);
  for (const y of [21, 29, 39]) {
    assert.equal(at(h, 21, y), Math.fround(101.1)); // s = 11 on the first facet
    assert.equal(at(h, 41, y), Math.fround(102 + 6 * 11 / 30)); // s = 31 on the second facet
  }
  assert.equal(at(h, 41, 41), 106); // the terrace starts in the next row of cells: a 2.2 m wall, no slope
  assert.equal(at(h, 41, 51), 106);
  for (const [x, y] of [[41, 53], [9, 30], [61, 30], [29, 45], [51, 45], [41, 19]]) assert.equal(at(h, x, y), at(src, x, y)); // nothing outside changes
  let changed = 0;
  for (let i = 0; i < h.length; i++) if (h[i] !== src[i]) changed++;
  assert.equal(changed, 25 * 10 + 10 * 6);
});

test('surface: no cell inside a patch lies below its plane (no grooves), kept cells stay', () => {
  const src = source(), patches = parseSurface(file());
  const keep = polygonsMask(grid, [[square(20, 24, 26, 30)]]);
  const h = applySurface(grid, src, patches, keep);
  const inRamp = polygonsMask(grid, [patches[0].rings]);
  for (let i = 0; i < h.length; i++) {
    const x = (i % 40) * 2 + 1, y = Math.floor(i / 40) * 2 + 1;
    if (keep[i]) assert.equal(h[i], src[i]);
    else if (inRamp[i]) assert.equal(h[i], Math.fround(surfaceHeight(patches[0], x, y)));
  }
});

test('surface: later patch wins on overlap, profile is constant beyond its ends', () => {
  const f = file();
  f.features.push(feature('landing', square(10, 20, 14, 40), { heightM: 99.5 }));
  const h = applySurface(grid, source(), parseSurface(f));
  assert.equal(at(h, 11, 30), 99.5);
  assert.equal(surfaceHeight(parseSurface(f)[0], 0, 0), 100);
  assert.equal(surfaceHeight(parseSurface(f)[0], 500, 0), 108);
});

test('surface: invalid input is refused', () => {
  const bad = (props: object) => () => parseSurface({ type: 'FeatureCollection', features: [feature('x', square(0, 0, 10, 10), props)] });
  assert.throws(bad({}), /heightM or profile/);
  assert.throws(bad({ heightM: 1, profile: ramp }), /heightM or profile/);
  assert.throws(bad({ profile: { ...ramp, points: [[0, 1], [0, 2]] } }), /heightM or profile/);
  assert.throws(bad({ profile: { ...ramp, direction: [0, 0] } }), /heightM or profile/);
  assert.throws(bad({ heightM: 1, srid: 4326 }), /srid=5186/);
  assert.throws(() => applySurface(grid, new Float32Array(3), parseSurface(file())), /dimensions/);
});

test('recipe: a surface step runs after the others, keeps building cells and lists its file', () => {
  const recipe = parseRecipe({ crs: 'EPSG:5186', reason: 'test', protectBuildings: true, steps: [{ type: 'surface', file: 'g.geojson' }] });
  assert.deepEqual(recipeFiles(recipe), ['g.geojson']);
  const buildings: [number, number][][][] = [[square(20, 24, 26, 30)]];
  const src = source();
  const { heights, steps } = applyRecipe(grid, src, recipe, { 'g.geojson': file() }, buildings);
  assert.deepEqual(heights, applySurface(grid, src, parseSurface(file()), polygonsMask(grid, buildings)));
  assert.equal(steps[0].type, 'surface');
  assert.throws(() => parseRecipe({ crs: 'EPSG:5186', reason: 't', protectBuildings: true, steps: [{ type: 'surface', file: 'g.geojson', noBlend: 'x' }] }), /Invalid recipe step/);
});
