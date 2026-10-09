import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AreaSave, areaPolygon } from '../src/modules/editor/area.dto.js';

const triangle: [number, number][] = [[201000,557000],[201010,557000],[201010,557010]];
const body = { name: '로비', kind: 'lobby', elevationM: 142, coordinates: triangle };
test('area boundary closes once and preserves source vertices', () => {
  assert.equal(areaPolygon(triangle).coordinates[0].length, 4);
  assert.equal(triangle.length, 3);
  assert.equal(areaPolygon([...triangle, triangle[0]]).coordinates[0].length, 4);
});
test('area rejects missing boundary, invalid coordinates and invalid elevation', () => {
  for (const bad of [{...body,coordinates:triangle.slice(0,2)}, {...body,elevationM:NaN},
    {...body,coordinates:[[0,0],[1,0],[1,1]]}, {...body,name:''}]) {
    assert.equal(AreaSave.safeParse(bad).success, false);
  }
  assert.equal(AreaSave.safeParse(body).success, true);
});
