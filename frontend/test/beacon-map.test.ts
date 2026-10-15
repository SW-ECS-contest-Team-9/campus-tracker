import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formAtCursor, formPoint, placementAt, type MapBuilding } from '../src/beacon-map.ts';
import { buildCreateRequest, buildEditRequest, emptyForm } from '../src/beacon-scan.ts';

const square = (x: number, y: number, s: number) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
const hall: MapBuilding = { buildingId: 'B07', name: '북악관', polygons: [square(201100, 557250, 40)],
  floorsM: [96, 100, 104.2, 108.4], floorNames: ['B1', '1층', '2F', '3F'] };
const shed: MapBuilding = { buildingId: 'S01', name: null, polygons: [square(201200, 557250, 10)] };

test('placement: building under the point and the floor of its floor table', () => {
  assert.deepEqual(placementAt([201120, 557270, 106.9], [shed, hall]), { buildingId: 'B07', buildingName: '북악관', floor: '2F', floorHeightM: 104.2 });
  assert.equal(placementAt([201120, 557270, 103.95], [hall]).floor, '2F', 'a ceiling beacon just under the next floor surface');
  assert.equal(placementAt([201120, 557270, 103.8], [hall]).floor, '1F', '"1층" -> 1F');
  assert.equal(placementAt([201120, 557270, 96.5], [hall]).floor, 'B1');
  assert.deepEqual(placementAt([201120, 557270, 90], [hall]), { buildingId: 'B07', buildingName: '북악관', floor: null, floorHeightM: null }, 'below the table');
  assert.deepEqual(placementAt([201205, 557255, 50], [hall, shed]), { buildingId: 'S01', buildingName: null, floor: null, floorHeightM: null }, 'no floor table');
  assert.equal(placementAt([201000, 557000, 50], [hall, shed]).buildingId, 'outdoor');
});

test('form at the cursor: grid position, height above the cursor, building and floor from the map; saves as new or edit', () => {
  const base = { ...emptyForm(), uuid: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0', major: '1', minor: '2', latitude: '37.6', longitude: '127' };
  const f = formAtCursor(base, [201120.12345, 557270.5, 104.2], 2.5, placementAt([201120.12345, 557270.5, 104.2], [hall]));
  assert.deepEqual([f.positionMode, f.x, f.y, f.z, f.buildingId, f.floor, f.floorHeightM, f.latitude], ['grid', '201120.123', '557270.5', '106.7', 'B07', '2F', '104.2', '']);
  assert.deepEqual(formPoint(f), [201120.123, 557270.5, 106.7]);
  const created = buildCreateRequest(f) as { body: any };
  assert.deepEqual(created.body.anchor, { buildingId: 'B07', floor: '2F', floorHeightM: 104.2, position: { x: 201120.123, y: 557270.5, z: 106.7 } });
  assert.deepEqual((buildEditRequest(f) as { body: any }).body.anchor, created.body.anchor);
  // outdoors: a typed building is kept, an empty one becomes "outdoor"
  const out = formAtCursor({ ...base, buildingId: 'GATE', floor: '1F' }, [201000, 557000, 60], 0, placementAt([201000, 557000, 60], [hall]));
  assert.deepEqual([out.buildingId, out.floor, out.z], ['GATE', '1F', '60']);
  assert.equal(formAtCursor(base, [201000, 557000, 60], 0, placementAt([201000, 557000, 60], [])).buildingId, 'outdoor');
  // a building without a floor table clears a floor typed for another place
  assert.deepEqual([formAtCursor({ ...base, floor: '3F', floorHeightM: '9' }, [201205, 557255, 50], 0, placementAt([201205, 557255, 50], [shed])).floor,
    formAtCursor({ ...base, floor: '3F', floorHeightM: '9' }, [201205, 557255, 50], 0, placementAt([201205, 557255, 50], [shed])).floorHeightM], ['', '']);
  assert.equal(formPoint({ ...f, positionMode: 'wgs84' }), null);
  assert.equal(formPoint({ ...f, z: '' }), null);
});
